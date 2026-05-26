// Popup script — manages the current-tab session toggle and the permanent
// trusted domains list. Session state lives in chrome.storage.session;
// trusted hosts live in chrome.storage.local. The background service worker
// picks up changes to either and re-registers the content script.

const STORAGE_KEY = "trustedHosts";
const SESSION_KEY = "sessionDisabledHosts";

const els = {
  row: document.getElementById("current-site-row"),
  host: document.getElementById("current-host"),
  state: document.getElementById("current-state"),
  toggle: document.getElementById("site-toggle"),
  restricted: document.getElementById("restricted-msg"),
  reloadHint: document.getElementById("reload-hint"),
  reloadBtn: document.getElementById("reload-btn"),
  list: document.getElementById("trusted-list"),
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
  h = h.replace(/^\*\./, "");          // strip leading *. — wildcard already applied
  h = h.replace(/[/?#].*$/, "");       // strip path, query, fragment
  h = h.replace(/:\d+$/, "");          // strip port
  return h;
}

function isValidHost(h) {
  return typeof h === "string" && h.length > 0 && /^[a-z0-9.\-]+$/i.test(h);
}

async function getTrustedHosts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const hosts = result[STORAGE_KEY];
  return Array.isArray(hosts) ? hosts.slice() : [];
}

async function setTrustedHosts(hosts) {
  const cleaned = Array.from(
    new Set(hosts.map((h) => String(h).toLowerCase().trim()).filter(Boolean)),
  ).sort();
  await chrome.storage.local.set({ [STORAGE_KEY]: cleaned });
}

async function getSessionDisabledHosts() {
  const result = await chrome.storage.session.get(SESSION_KEY);
  const hosts = result[SESSION_KEY];
  return Array.isArray(hosts) ? hosts.slice() : [];
}

async function setSessionDisabledHosts(hosts) {
  const cleaned = Array.from(
    new Set(hosts.map((h) => String(h).toLowerCase().trim()).filter(Boolean)),
  ).sort();
  await chrome.storage.session.set({ [SESSION_KEY]: cleaned });
}

// Returns true if host matches a trusted entry (exact or subdomain of entry).
function isTrustedHost(host, trustedHosts) {
  return trustedHosts.some(
    (h) => host === h || host.endsWith("." + h),
  );
}

function renderCurrentSite(host, trusted, sessionDisabled) {
  if (!host) {
    els.row.hidden = true;
    els.restricted.hidden = false;
    return;
  }
  els.restricted.hidden = true;
  els.row.hidden = false;
  els.host.textContent = host;

  if (trusted) {
    els.toggle.checked = false;
    els.toggle.disabled = true;
    els.state.textContent = "Trusted domain";
    els.state.className = "site-state";
  } else if (sessionDisabled) {
    els.toggle.checked = false;
    els.toggle.disabled = false;
    els.state.textContent = "Paused this session";
    els.state.className = "site-state";
  } else {
    els.toggle.checked = true;
    els.toggle.disabled = false;
    els.state.textContent = "Active here";
    els.state.className = "site-state state-on";
  }
}

function renderList(hosts) {
  els.list.innerHTML = "";
  if (!hosts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No trusted domains.";
    els.list.appendChild(empty);
    return;
  }
  for (const host of hosts) {
    const row = document.createElement("div");
    row.className = "trusted-item";

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
    btn.addEventListener("click", () => removeTrustedHost(host));
    row.appendChild(btn);

    els.list.appendChild(row);
  }
}

async function refresh() {
  const [trusted, session] = await Promise.all([
    getTrustedHosts(),
    getSessionDisabledHosts(),
  ]);
  renderList(trusted);
  renderCurrentSite(
    currentHost,
    currentHost ? isTrustedHost(currentHost, trusted) : false,
    currentHost ? session.includes(currentHost) : false,
  );
}

async function onToggle() {
  if (!currentHost) return;
  const wantActive = els.toggle.checked;
  const hosts = await getSessionDisabledHosts();
  const idx = hosts.indexOf(currentHost);
  if (wantActive && idx !== -1) {
    hosts.splice(idx, 1);
  } else if (!wantActive && idx === -1) {
    hosts.push(currentHost);
  } else {
    return;
  }
  await setSessionDisabledHosts(hosts);
  els.reloadHint.classList.add("visible");
  await refresh();
}

async function removeTrustedHost(host) {
  const hosts = await getTrustedHosts();
  await setTrustedHosts(hosts.filter((h) => h !== host));
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
  const hosts = await getTrustedHosts();
  if (!hosts.includes(host)) {
    hosts.push(host);
    await setTrustedHosts(hosts);
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
