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
  // Migrate: add new keys on update without overwriting existing
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

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "clipboard_event") {
    handleClipboardEvent(msg, sender);
  }

  if (msg.type === "allow_once") {
    allowOnceHosts[msg.host] = Date.now() + 30000; // 30s window
    // Notify all tabs on this host to temporarily allow
    notifyAllowOnce(msg.host);
  }

  if (msg.type === "check_allow_once") {
    const entry = allowOnceHosts[msg.host];
    const allowed = entry && Date.now() < entry;
    if (allowed) {
      // Consume the allow-once token
      delete allowOnceHosts[msg.host];
    }
    sendResponse({ allowed: !!allowed });
    return true;
  }

  if (msg.type === "get_status") {
    const tabUrl = msg.url || "";
    let host = "";
    try { host = new URL(tabUrl).hostname.toLowerCase(); } catch {}

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
        overrides[msg.host] = msg.mode;
        chrome.storage.local.set({ siteOverrides: overrides });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "clear_site_override") {
    chrome.storage.local.get(["siteOverrides"], (data) => {
      const overrides = data.siteOverrides || {};
      delete overrides[msg.host];
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
      if (!list.includes(msg.host)) {
        list.push(msg.host);
        chrome.storage.local.set({ allowlist: list });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "remove_allowlist") {
    chrome.storage.local.get(["allowlist"], (data) => {
      const list = (data.allowlist || []).filter((h) => h !== msg.host);
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
        const tabHost = new URL(tab.url).hostname.toLowerCase();
        if (tabHost === host) {
          chrome.tabs.sendMessage(tab.id, { type: "allow_once_granted", host });
        }
      } catch {}
    }
  });
}

function handleClipboardEvent(msg, sender) {
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
  };

  // Store full payload if enabled
  if (msg.fullText) {
    chrome.storage.local.get(["logFullPayload"], (data) => {
      if (data.logFullPayload) {
        entry.fullText = msg.fullText;
      }
    });
  }

  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.pop();

  if (msg.action === "block") {
    blockCount++;
    updateBadge(blockCount);

    chrome.storage.local.get(["showNotifications"], (data) => {
      if (data.showNotifications !== false) {
        showNotification(entry);
      }
    });
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
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "PasteGuard \u2014 Blocked",
    message: `Blocked suspicious clipboard content from ${getDomain(entry.url)}: ${entry.descriptions.join(", ")}`,
  });
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function hostMatches(host, pattern) {
  pattern = pattern.toLowerCase();
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith("." + suffix);
  }
  return host === pattern || host.endsWith("." + pattern);
}

// Initialize badge
updateBadge(0);
