// Popup script — the extension is off by default; this is where a site gets
// turned on. The toggle adds/removes the current host in `enabledHosts`
// (chrome.storage.local) and the service worker re-registers the content
// script from that list. Enabling also injects the unblocker into the
// current tab right away so it takes effect without a reload.

const STORAGE_KEY = "enabledHosts";

const els = {
  row: document.getElementById("current-site-row"),
  host: document.getElementById("current-host"),
  state: document.getElementById("current-state"),
  toggle: document.getElementById("site-toggle"),
  restricted: document.getElementById("restricted-msg"),
  reloadHint: document.getElementById("reload-hint"),
  reloadBtn: document.getElementById("reload-btn"),
  list: document.getElementById("enabled-list"),
  addBtn: document.getElementById("add-btn"),
  addRow: document.getElementById("add-row"),
  addInput: document.getElementById("add-input"),
  addConfirm: document.getElementById("add-confirm"),
  addCancel: document.getElementById("add-cancel"),
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

function sanitizeHostInput(raw) {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^[a-z*]+:\/\//, ""); // strip protocol (http://, https://, *://)
  h = h.replace(/^\*\./, ""); // strip leading *. — wildcard already applied
  h = h.replace(/[/?#].*$/, ""); // strip path, query, fragment
  h = h.replace(/:\d+$/, ""); // strip port
  return h;
}

function isValidHost(h) {
  return typeof h === "string" && h.length > 0 && /^[a-z0-9.\-]+$/i.test(h);
}

async function getEnabledHosts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const hosts = result[STORAGE_KEY];
  return Array.isArray(hosts) ? hosts.slice() : [];
}

async function setEnabledHosts(hosts) {
  const cleaned = Array.from(
    new Set(hosts.map((h) => String(h).toLowerCase().trim()).filter(Boolean)),
  ).sort();
  await chrome.storage.local.set({ [STORAGE_KEY]: cleaned });
}

// An entry covers a host if it matches exactly or the host is a subdomain of
// it — the same reach as the `*://*.entry/*` match pattern we register.
function coveringEntries(host, enabledHosts) {
  return enabledHosts.filter((h) => host === h || host.endsWith("." + h));
}

function isEnabledHost(host, enabledHosts) {
  return coveringEntries(host, enabledHosts).length > 0;
}

function renderCurrentSite(host, enabled) {
  if (!host) {
    els.row.hidden = true;
    els.restricted.hidden = false;
    return;
  }
  els.restricted.hidden = true;
  els.row.hidden = false;
  els.host.textContent = host;

  els.toggle.checked = enabled;
  els.toggle.disabled = false;
  if (enabled) {
    els.state.textContent = "On for this site";
    els.state.className = "site-state state-on";
  } else {
    els.state.textContent = "Off — click to enable";
    els.state.className = "site-state";
  }
}

function renderList(hosts) {
  els.list.innerHTML = "";
  if (!hosts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No sites enabled yet.";
    els.list.appendChild(empty);
    return;
  }
  for (const host of hosts) {
    const row = document.createElement("div");
    row.className = "enabled-item";

    const label = document.createElement("span");
    label.className = "host";
    label.textContent = host;
    label.title = host;
    row.appendChild(label);

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.type = "button";
    btn.textContent = "×";
    btn.title = `Remove ${host}`;
    btn.setAttribute("aria-label", `Remove ${host}`);
    btn.addEventListener("click", () => removeEnabledHost(host));
    row.appendChild(btn);

    els.list.appendChild(row);
  }
}

async function refresh() {
  const enabled = await getEnabledHosts();
  renderList(enabled);
  renderCurrentSite(
    currentHost,
    currentHost ? isEnabledHost(currentHost, enabled) : false,
  );
}

function showReloadHint(text) {
  els.reloadHint.querySelector("span").textContent = text;
  els.reloadHint.classList.add("visible");
}

// The registered content script only reaches pages loaded after registration,
// so enabling a site would otherwise need a reload. Injecting by hand covers
// the page you're already on: the unblocker's capture-phase listeners on
// `window` still run ahead of the page's own handlers no matter how late they
// are attached, so contextmenu, selection, drag, and clipboard all recover
// immediately. Only inline on* handlers already fired are beyond reach.
async function injectNow() {
  if (currentTab?.id == null) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      files: ["unblocker.js"],
      world: "MAIN",
      injectImmediately: true,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function onToggle() {
  if (!currentHost) return;
  const wantEnabled = els.toggle.checked;
  const hosts = await getEnabledHosts();

  if (wantEnabled) {
    if (!hosts.includes(currentHost)) hosts.push(currentHost);
    await setEnabledHosts(hosts);
    const injected = await injectNow();
    if (!injected) showReloadHint("Reload the page to apply.");
  } else {
    // Drop the exact entry and any parent-domain entry covering this host —
    // leaving `example.com` behind while switching off `sub.example.com`
    // would leave the toggle stuck on.
    const covering = new Set(coveringEntries(currentHost, hosts));
    await setEnabledHosts(hosts.filter((h) => !covering.has(h)));
    showReloadHint("Reload the page to stop unblocking it.");
  }

  await refresh();
}

async function removeEnabledHost(host) {
  const hosts = await getEnabledHosts();
  await setEnabledHosts(hosts.filter((h) => h !== host));
  await refresh();
}

function showAddRow() {
  els.addRow.hidden = false;
  els.addBtn.hidden = true;
  els.addInput.value = currentHost || "";
  els.addInput.classList.remove("invalid");
  els.addInput.focus();
  els.addInput.select();
}

function hideAddRow() {
  els.addRow.hidden = true;
  els.addBtn.hidden = false;
}

async function confirmAdd() {
  const host = sanitizeHostInput(els.addInput.value);
  if (!isValidHost(host)) {
    els.addInput.classList.add("invalid");
    return;
  }
  const hosts = await getEnabledHosts();
  if (!hosts.includes(host)) {
    hosts.push(host);
    await setEnabledHosts(hosts);
  }
  hideAddRow();
  await refresh();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  currentHost = tab ? hostnameFromUrl(tab.url || "") : null;

  if (!currentHost) els.toggle.disabled = true;

  els.toggle.addEventListener("change", onToggle);
  els.reloadBtn.addEventListener("click", () => {
    if (currentTab?.id != null) {
      chrome.tabs.reload(currentTab.id);
      window.close();
    }
  });

  els.addBtn.addEventListener("click", showAddRow);
  els.addConfirm.addEventListener("click", confirmAdd);
  els.addCancel.addEventListener("click", hideAddRow);
  els.addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmAdd();
    if (e.key === "Escape") hideAddRow();
  });
  els.addInput.addEventListener("input", () => {
    els.addInput.classList.remove("invalid");
  });

  await refresh();
}

init();
