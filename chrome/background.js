// Service worker for Free the Right-Click.
//
// Owns the dynamic content-script registration. Reads trusted hosts from
// chrome.storage.local and session-disabled hosts from chrome.storage.session,
// then registers the unblocker with excludeMatches covering both.

const SCRIPT_ID = "ftrc-unblocker";
const STORAGE_KEY = "trustedHosts";
const SESSION_KEY = "sessionDisabledHosts";

async function getTrustedHosts() {
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

async function getSessionDisabledHosts() {
  try {
    const result = await chrome.storage.session.get(SESSION_KEY);
    const hosts = result[SESSION_KEY];
    if (!Array.isArray(hosts)) return [];
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
  const [trusted, session] = await Promise.all([
    getTrustedHosts(),
    getSessionDisabledHosts(),
  ]);
  const allExcluded = [...new Set([...trusted, ...session])];
  const excludeMatches = allExcluded.flatMap(hostToExcludePatterns);

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

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await initDefaultHosts();
  }
  syncRegistration();
});
chrome.runtime.onStartup.addListener(syncRegistration);

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    (area === "local" && changes[STORAGE_KEY]) ||
    (area === "session" && changes[SESSION_KEY])
  ) {
    syncRegistration();
  }
});
