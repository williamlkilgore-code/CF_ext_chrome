/**
 * PasteGuard — Service Worker (Background)
 * Manages settings, event log, badge, notifications, and allow-once state.
 */

// --- Default settings ---
const DEFAULTS = {
  globalMode: "normal",     // "normal" | "strict" | "off"
  siteOverrides: {},        // { "example.com": "strict" }
  allowlist: [],            // ["trusted.com", "*.safe.org"]
  logFullPayload: false,    // privacy: off by default
  intentWindowMs: 1200,     // strict mode user-intent window
  showNotifications: true,  // browser notifications on block
  showBanner: true,         // on-page warning banner
};

// --- Initialize storage on install ---
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set(DEFAULTS);
  }
  if (details.reason === "update") {
    chrome.storage.local.get(null, (data) => {
      const patch = {};
      for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!(k in data)) patch[k] = v;
      }
      if (Object.keys(patch).length) chrome.storage.local.set(patch);
    });
  }
});

// --- In-memory state ---
let eventLog = [];
const MAX_LOG = 100;
let blockCount = 0;
let allowOnceHosts = {};     // { "host": expiryTimestamp }

// --- Restore persisted log on startup ---
chrome.storage.local.get(["eventLog", "blockCount"], (data) => {
  if (Array.isArray(data.eventLog)) eventLog = data.eventLog;
  if (typeof data.blockCount === "number") blockCount = data.blockCount;
  updateBadge(blockCount);
});

function persistLog() {
  chrome.storage.local.set({ eventLog, blockCount });
}

// --- Punycode / IDN normalization ---
// Simple ASCII-based normalization for hostname matching.
// Browsers already give us punycode-encoded hostnames from URL objects,
// so we normalize to lowercase and ensure consistency.
function normalizeHost(host) {
  if (!host) return "";
  try {
    // Use URL constructor to get punycode-normalized hostname
    const u = new URL("http://" + host);
    return u.hostname.toLowerCase();
  } catch {
    return host.toLowerCase();
  }
}

// --- SHA-256 hashing for privacy-preserving logs ---
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "clipboard_event") {
    handleClipboardEvent(msg, sender);
  }

  if (msg.type === "allow_once") {
    const host = normalizeHost(msg.host);
    allowOnceHosts[host] = Date.now() + 30000;
    notifyAllowOnce(host);
  }

  if (msg.type === "check_allow_once") {
    const host = normalizeHost(msg.host);
    const entry = allowOnceHosts[host];
    const allowed = entry && Date.now() < entry;
    if (allowed) {
      delete allowOnceHosts[host];
    }
    sendResponse({ allowed: !!allowed });
    return true;
  }

  if (msg.type === "get_status") {
    const tabUrl = msg.url || "";
    let host = "";
    try { host = new URL(tabUrl).hostname.toLowerCase(); } catch {}
    host = normalizeHost(host);

    chrome.storage.local.get(["globalMode", "siteOverrides", "allowlist"], (data) => {
      const overrides = data.siteOverrides || {};
      const allowlist = data.allowlist || [];
      let mode = overrides[host] || data.globalMode || "normal";

      if (allowlist.some((entry) => hostMatches(host, entry))) {
        mode = "off";
      }

      sendResponse({
        mode,
        host,
        blockCount,
        recentEvents: eventLog.slice(0, 10),
      });
    });

    return true;
  }

  if (msg.type === "set_mode") {
    chrome.storage.local.get(["siteOverrides"], (data) => {
      const overrides = data.siteOverrides || {};
      if (msg.scope === "global") {
        chrome.storage.local.set({ globalMode: msg.mode });
      } else {
        const host = normalizeHost(msg.host);
        overrides[host] = msg.mode;
        chrome.storage.local.set({ siteOverrides: overrides });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "clear_site_override") {
    chrome.storage.local.get(["siteOverrides"], (data) => {
      const overrides = data.siteOverrides || {};
      delete overrides[normalizeHost(msg.host)];
      chrome.storage.local.set({ siteOverrides: overrides });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "get_all_overrides") {
    chrome.storage.local.get(["siteOverrides"], (data) => {
      sendResponse({ overrides: data.siteOverrides || {} });
    });
    return true;
  }

  if (msg.type === "add_allowlist") {
    chrome.storage.local.get(["allowlist"], (data) => {
      const list = data.allowlist || [];
      const host = normalizeHost(msg.host);
      if (!list.includes(host)) {
        list.push(host);
        chrome.storage.local.set({ allowlist: list });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "remove_allowlist") {
    chrome.storage.local.get(["allowlist"], (data) => {
      const target = normalizeHost(msg.host);
      const list = (data.allowlist || []).filter((h) => normalizeHost(h) !== target);
      chrome.storage.local.set({ allowlist: list });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "get_allowlist") {
    chrome.storage.local.get(["allowlist"], (data) => {
      sendResponse({ allowlist: data.allowlist || [] });
    });
    return true;
  }

  if (msg.type === "get_settings") {
    chrome.storage.local.get(null, (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (msg.type === "update_settings") {
    chrome.storage.local.set(msg.settings, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "get_full_log") {
    sendResponse({ log: eventLog });
    return true;
  }

  if (msg.type === "clear_log") {
    eventLog = [];
    blockCount = 0;
    updateBadge(0);
    persistLog();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "export_log") {
    sendResponse({ log: eventLog, exportedAt: Date.now() });
    return true;
  }
});

function notifyAllowOnce(host) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      try {
        const tabHost = normalizeHost(new URL(tab.url).hostname);
        if (tabHost === host) {
          chrome.tabs.sendMessage(tab.id, { type: "allow_once_granted", host });
        }
      } catch {}
    }
  });
}

async function handleClipboardEvent(msg, sender) {
  const entry = {
    action: msg.action,
    risk: msg.risk,
    categories: msg.categories,
    descriptions: msg.descriptions,
    preview: msg.preview,
    textLength: msg.textLength,
    url: msg.url,
    api: msg.api,
    userIntent: msg.userIntent,
    mode: msg.mode,
    timestamp: msg.timestamp || Date.now(),
    frameId: msg.frameId || 0,
    frameUrl: msg.frameUrl || msg.url,
  };

  // Privacy-preserving hash of content (always stored)
  if (msg.text) {
    entry.contentHash = await sha256(msg.text);
  }

  // Store full payload only if enabled
  const data = await chrome.storage.local.get(["logFullPayload"]);
  if (data.logFullPayload && msg.fullText) {
    entry.fullText = msg.fullText;
  }

  // User intent element metadata
  if (msg.intentElement) {
    entry.intentElement = msg.intentElement;
  }

  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.pop();

  if (msg.action === "block") {
    blockCount++;
    updateBadge(blockCount);

    const notifData = await chrome.storage.local.get(["showNotifications"]);
    if (notifData.showNotifications !== false) {
      showNotification(entry);
    }
  }

  persistLog();
}

function updateBadge(count) {
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({
    color: count > 0 ? "#ef4444" : "#6b7280",
  });
}

function showNotification(entry) {
  const frameInfo = entry.frameId > 0 ? ` (iframe: ${getDomain(entry.frameUrl)})` : "";
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "PasteGuard \u2014 Blocked",
    message: `Blocked suspicious clipboard content from ${getDomain(entry.url)}${frameInfo}: ${entry.descriptions.join(", ")}`,
  });
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function hostMatches(host, pattern) {
  host = normalizeHost(host);
  pattern = normalizeHost(pattern);
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith("." + suffix);
  }
  return host === pattern || host.endsWith("." + pattern);
}

// Initialize badge
updateBadge(0);
