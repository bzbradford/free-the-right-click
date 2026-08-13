// Service worker for Free the Right-Click.
//
// Owns the dynamic content-script registration. The extension is off by
// default: the unblocker is registered only for the hosts the user has
// explicitly enabled, read from chrome.storage.local. With no enabled
// hosts the script isn't registered at all.

const SCRIPT_ID = "ftrc-unblocker";
const STORAGE_KEY = "enabledHosts";
const LEGACY_KEY = "trustedHosts";

async function getEnabledHosts() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const hosts = result[STORAGE_KEY];
    if (!Array.isArray(hosts)) return [];
    return hosts.filter(
      (h) => typeof h === "string" && /^[a-z0-9.\-]+$/i.test(h),
    );
  } catch (_) {
    return [];
  }
}

function hostToMatchPatterns(host) {
  return [`*://${host}/*`, `*://*.${host}/*`];
}

async function unregister() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch (_) {
    // Not registered — nothing to do.
  }
}

async function syncRegistration() {
  const hosts = await getEnabledHosts();
  const matches = [...new Set(hosts)].flatMap(hostToMatchPatterns);

  // registerContentScripts rejects an empty `matches` array, so "no enabled
  // hosts" has to be expressed as "no registration at all".
  if (!matches.length) {
    await unregister();
    return;
  }

  const scriptDef = {
    id: SCRIPT_ID,
    matches,
    js: ["unblocker.js"],
    runAt: "document_start",
    allFrames: true,
    matchOriginAsFallback: true,
    world: "MAIN",
    persistAcrossSessions: true,
  };

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [SCRIPT_ID],
    });
    if (existing.length) {
      await chrome.scripting.updateContentScripts([scriptDef]);
    } else {
      await chrome.scripting.registerContentScripts([scriptDef]);
    }
  } catch (e) {
    console.warn("[FTRC] update failed, retrying with fresh register", e);
    await unregister();
    try {
      await chrome.scripting.registerContentScripts([scriptDef]);
    } catch (e2) {
      console.error("[FTRC] registration ultimately failed", e2);
    }
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "update") {
    // v1 kept an inverted list (hosts to skip). The meaning of the list has
    // flipped, so the old data can't be carried over — drop it.
    try {
      await chrome.storage.local.remove(LEGACY_KEY);
    } catch (_) {}
  }
  syncRegistration();
});
chrome.runtime.onStartup.addListener(syncRegistration);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    syncRegistration();
  }
});
