// Popup script — reads the active tab, lets the user toggle the
// extension on/off for that site, and manages the list of disabled
// sites. Writes go to chrome.storage.local; the service worker picks
// up the change and re-registers the content script.

const STORAGE_KEY = "disabledHosts";

const els = {
  row: document.getElementById("current-site-row"),
  host: document.getElementById("current-host"),
  state: document.getElementById("current-state"),
  toggle: document.getElementById("site-toggle"),
  restricted: document.getElementById("restricted-msg"),
  reloadHint: document.getElementById("reload-hint"),
  reloadBtn: document.getElementById("reload-btn"),
  list: document.getElementById("disabled-list"),
};

let currentTab = null;
let currentHost = null;

function hostnameFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname || null;
  } catch (_) {
    return null;
  }
}

async function getDisabledHosts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const hosts = result[STORAGE_KEY];
  return Array.isArray(hosts) ? hosts.slice() : [];
}

async function setDisabledHosts(hosts) {
  // Normalize: lowercase, dedupe, sorted.
  const cleaned = Array.from(
    new Set(hosts.map((h) => String(h).toLowerCase().trim()).filter(Boolean)),
  ).sort();
  await chrome.storage.local.set({ [STORAGE_KEY]: cleaned });
}

function renderCurrentSite(host, isDisabled) {
  if (!host) {
    els.row.hidden = true;
    els.restricted.hidden = false;
    return;
  }
  els.restricted.hidden = true;
  els.row.hidden = false;
  els.host.textContent = host;
  els.toggle.checked = !isDisabled; // toggle = "active on this site"
  els.state.textContent = isDisabled ? "Disabled here" : "Active here";
  els.state.classList.toggle("state-on", !isDisabled);
}

function renderList(hosts) {
  els.list.innerHTML = "";
  if (!hosts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "None — the extension runs everywhere.";
    els.list.appendChild(empty);
    return;
  }
  for (const host of hosts) {
    const row = document.createElement("div");
    row.className = "disabled-item";

    const hostLabel = `*.${host}/*`;
    const label = document.createElement("span");
    label.className = "host";
    label.textContent = hostLabel;
    label.title = hostLabel;
    row.appendChild(label);

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.type = "button";
    btn.textContent = "×";
    btn.title = `Re-enable on ${hostLabel}`;
    btn.setAttribute("aria-label", `Re-enable on ${hostLabel}`);
    btn.addEventListener("click", () => removeHost(host));
    row.appendChild(btn);

    els.list.appendChild(row);
  }
}

async function refresh() {
  const hosts = await getDisabledHosts();
  renderList(hosts);
  const isDisabled = currentHost ? hosts.includes(currentHost) : false;
  renderCurrentSite(currentHost, isDisabled);
}

async function onToggle() {
  if (!currentHost) return;
  const wantActive = els.toggle.checked;
  const hosts = await getDisabledHosts();
  const idx = hosts.indexOf(currentHost);
  if (wantActive && idx !== -1) {
    hosts.splice(idx, 1);
  } else if (!wantActive && idx === -1) {
    hosts.push(currentHost);
  } else {
    return; // no change
  }
  await setDisabledHosts(hosts);
  els.reloadHint.classList.add("visible");
  await refresh();
}

async function removeHost(host) {
  const hosts = await getDisabledHosts();
  const filtered = hosts.filter((h) => h !== host);
  await setDisabledHosts(filtered);
  if (host === currentHost) {
    els.reloadHint.classList.add("visible");
  }
  await refresh();
}

async function init() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  currentTab = tab || null;
  currentHost = tab ? hostnameFromUrl(tab.url || "") : null;

  els.toggle.addEventListener("change", onToggle);
  els.reloadBtn.addEventListener("click", () => {
    if (currentTab && currentTab.id != null) {
      chrome.tabs.reload(currentTab.id);
      window.close();
    }
  });

  // Disable the toggle on restricted pages.
  if (!currentHost) {
    els.toggle.disabled = true;
  }

  await refresh();
}

init();
