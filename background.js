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
};

// --- Initialize storage on install ---
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set(DEFAULTS);
  }
});

// --- In-memory state ---
let eventLog = [];           // recent events for popup display
const MAX_LOG = 50;
let blockCount = 0;
let allowOnceHosts = {};     // { "host": expiryTimestamp }

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "clipboard_event") {
    handleClipboardEvent(msg, sender);
  }

  if (msg.type === "allow_once") {
    allowOnceHosts[msg.host] = Date.now() + 30000; // 30s window
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

    return true; // async response
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

  if (msg.type === "clear_log") {
    eventLog = [];
    blockCount = 0;
    updateBadge(0);
    sendResponse({ ok: true });
    return true;
  }
});

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

  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.pop();

  if (msg.action === "block") {
    blockCount++;
    updateBadge(blockCount);
    showNotification(entry);
  }
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
    title: "PasteGuard — Blocked",
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
