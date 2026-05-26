// Service worker for Free the Right-Click.
//
// Owns the dynamic content-script registration. Reads the list of
// per-site disabled hostnames from chrome.storage.local and (re)registers
// the unblocker with excludeMatches set accordingly.

const SCRIPT_ID = "ftrc-unblocker";
const STORAGE_KEY = "disabledHosts";

async function getDisabledHosts() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const hosts = result[STORAGE_KEY];
    if (!Array.isArray(hosts)) return [];
    // Sanity filter — only well-formed hostnames.
    return hosts.filter(
      (h) => typeof h === "string" && /^[a-z0-9.\-]+$/i.test(h),
    );
  } catch (_) {
    return [];
  }
}

function hostToExcludePatterns(host) {
  return [`*://${host}/*`, `*://*.${host}/*`];
}

async function syncRegistration() {
  const hosts = await getDisabledHosts();
  const excludeMatches = hosts.flatMap(hostToExcludePatterns);

  const scriptDef = {
    id: SCRIPT_ID,
    matches: ["<all_urls>"],
    ...(excludeMatches.length ? { excludeMatches } : {}),
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
    // If update fails for any reason, fall back to unregister + register.
    console.warn("[FTRC] update failed, retrying with fresh register", e);
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    } catch (_) {}
    try {
      await chrome.scripting.registerContentScripts([scriptDef]);
    } catch (e2) {
      console.error("[FTRC] registration ultimately failed", e2);
    }
  }
}

const DEFAULT_TRUSTED_HOSTS = ["google.com", "wisc.edu"];

async function initDefaultHosts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  if (!Array.isArray(result[STORAGE_KEY])) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_TRUSTED_HOSTS });
  }
}

// Re-sync on the lifecycle events that matter.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await initDefaultHosts();
  }
  syncRegistration();
});
chrome.runtime.onStartup.addListener(syncRegistration);

// Re-sync whenever the disabled list changes (popup writes to storage).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    syncRegistration();
  }
});
