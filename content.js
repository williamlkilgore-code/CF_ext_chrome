/**
 * PasteGuard — Content Script
 * Bridges between the page-world inject.js and the extension service worker.
 * Tracks user intent signals and injects the page-world script.
 */

(() => {
  const MSG_PREFIX = "__pasteguard__";

  // --- User Intent Tracking ---
  const intent = {
    lastClick: 0,
    lastCopyKey: 0,
    lastSelection: 0,
    lastContextMenu: 0,
  };

  let intentWindowMs = 1200;

  // Load configurable intent window
  chrome.storage.local.get(["intentWindowMs"], (data) => {
    if (typeof data.intentWindowMs === "number") {
      intentWindowMs = data.intentWindowMs;
    }
  });

  document.addEventListener("click", () => {
    intent.lastClick = Date.now();
  }, true);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      intent.lastCopyKey = Date.now();
    }
  }, true);

  document.addEventListener("selectionchange", () => {
    intent.lastSelection = Date.now();
  });

  document.addEventListener("contextmenu", () => {
    intent.lastContextMenu = Date.now();
  }, true);

  function hasRecentUserIntent() {
    const now = Date.now();
    return (
      now - intent.lastClick < intentWindowMs ||
      now - intent.lastCopyKey < intentWindowMs ||
      now - intent.lastContextMenu < intentWindowMs
    );
  }

  // --- Allow-once state ---
  let allowOnceActive = false;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "allow_once_granted" && msg.host === getHostname()) {
      allowOnceActive = true;
      // Auto-expire after 30s in case it's never consumed
      setTimeout(() => { allowOnceActive = false; }, 30000);
    }
  });

  // --- Site settings cache ---
  let siteMode = "normal";
  let showBanner = true;

  function getHostname() {
    try { return location.hostname.toLowerCase(); } catch { return ""; }
  }

  function loadSiteSettings() {
    const host = getHostname();
    chrome.storage.local.get(
      ["globalMode", "siteOverrides", "allowlist", "intentWindowMs", "showBanner"],
      (data) => {
        const overrides = data.siteOverrides || {};
        const allowlist = data.allowlist || [];

        if (overrides[host]) {
          siteMode = overrides[host];
        } else if (allowlist.some((entry) => hostMatches(host, entry))) {
          siteMode = "off";
        } else {
          siteMode = data.globalMode || "normal";
        }

        if (typeof data.intentWindowMs === "number") {
          intentWindowMs = data.intentWindowMs;
        }
        if (typeof data.showBanner === "boolean") {
          showBanner = data.showBanner;
        }

        // Notify inject.js of current mode so it can do synchronous copy blocking
        window.postMessage({ type: `${MSG_PREFIX}mode_update`, mode: siteMode }, "*");
      }
    );
  }

  function hostMatches(host, pattern) {
    pattern = pattern.toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return host === suffix || host.endsWith("." + suffix);
    }
    return host === pattern || host.endsWith("." + pattern);
  }

  loadSiteSettings();

  // Reload settings when storage changes
  chrome.storage.onChanged.addListener(() => {
    loadSiteSettings();
  });

  // --- SPA Navigation Handling ---
  let lastUrl = location.href;

  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      loadSiteSettings();
    }
  }

  // Catch pushState/replaceState and popstate
  window.addEventListener("popstate", checkUrlChange);
  window.addEventListener("hashchange", checkUrlChange);

  // Poll for pushState changes (no native event fires for these)
  setInterval(checkUrlChange, 1000);

  // --- Inject page-world script ---
  function injectPageScript() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  injectPageScript();

  // --- Handle messages from inject.js ---
  window.addEventListener("message", (e) => {
    if (!e.data || typeof e.data.type !== "string") return;
    if (!e.data.type.startsWith(MSG_PREFIX)) return;

    if (e.data.type === `${MSG_PREFIX}request`) {
      handleClipboardRequest(e.data);
    }

    if (e.data.type === `${MSG_PREFIX}copy_event`) {
      handleCopyEvent(e.data);
    }
  });

  function handleClipboardRequest(msg) {
    // If mode is off, allow everything
    if (siteMode === "off") {
      respond(msg.id, "allow");
      return;
    }

    // Check allow-once before analyzing
    if (allowOnceActive) {
      allowOnceActive = false;
      respond(msg.id, "allow");
      // Still log it
      const result = PasteGuardDetector.analyze(msg.text);
      if (result.risk >= PasteGuardDetector.RISK.MED) {
        chrome.runtime.sendMessage({
          type: "clipboard_event",
          action: "allow_once",
          risk: result.risk,
          categories: result.categories,
          descriptions: result.descriptions,
          preview: PasteGuardDetector.preview(msg.text),
          textLength: msg.text.length,
          url: msg.url,
          api: msg.api,
          userIntent: hasRecentUserIntent(),
          mode: siteMode,
          timestamp: msg.timestamp,
        });
      }
      return;
    }

    const result = PasteGuardDetector.analyze(msg.text);
    const userIntent = hasRecentUserIntent();

    let action = "allow";

    if (siteMode === "normal") {
      if (result.risk >= PasteGuardDetector.RISK.HIGH) {
        action = "block";
      }
    } else if (siteMode === "strict") {
      if (result.risk >= PasteGuardDetector.RISK.MED) {
        action = "block";
      } else if (!userIntent) {
        action = "block";
      }
    }

    // Notify background service worker
    if (result.risk >= PasteGuardDetector.RISK.MED || action === "block") {
      chrome.runtime.sendMessage({
        type: "clipboard_event",
        action,
        risk: result.risk,
        categories: result.categories,
        descriptions: result.descriptions,
        preview: PasteGuardDetector.preview(msg.text),
        textLength: msg.text.length,
        url: msg.url,
        api: msg.api,
        userIntent,
        mode: siteMode,
        timestamp: msg.timestamp,
      });
    }

    // Show on-page warning for blocks
    if (action === "block" && showBanner) {
      showWarningBanner(result, msg.id);
    }

    respond(msg.id, action);
  }

  function handleCopyEvent(msg) {
    if (siteMode === "off") return;

    const result = PasteGuardDetector.analyze(msg.text);
    if (result.risk >= PasteGuardDetector.RISK.MED) {
      chrome.runtime.sendMessage({
        type: "clipboard_event",
        action: msg.blocked ? "block" : "warn",
        risk: result.risk,
        categories: result.categories,
        descriptions: result.descriptions,
        preview: PasteGuardDetector.preview(msg.text),
        textLength: msg.text.length,
        url: msg.url,
        api: "copyEvent",
        userIntent: hasRecentUserIntent(),
        mode: siteMode,
        timestamp: msg.timestamp,
      });

      if (msg.blocked && showBanner) {
        showWarningBanner(result, null);
      }
    }
  }

  function respond(id, action) {
    window.postMessage(
      { type: `${MSG_PREFIX}response`, id, action },
      "*"
    );
  }

  // --- On-page warning banner ---
  function showWarningBanner(result, requestId) {
    const existing = document.getElementById("pasteguard-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "pasteguard-banner";
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      background: #1e1e2e; color: #e5e7eb; font-family: system-ui, sans-serif;
      font-size: 14px; padding: 12px 20px; display: flex; align-items: center;
      gap: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); border-bottom: 3px solid #ef4444;
    `;

    const icon = document.createElement("span");
    icon.textContent = "\u26A0";
    icon.style.cssText = "font-size: 20px; flex-shrink: 0;";

    const text = document.createElement("span");
    text.style.cssText = "flex: 1;";
    text.textContent = `PasteGuard blocked a suspicious clipboard write: ${result.descriptions.join(", ")}`;

    const allowBtn = document.createElement("button");
    allowBtn.textContent = "Allow once";
    allowBtn.style.cssText = `
      background: #374151; color: #e5e7eb; border: 1px solid #6b7280;
      padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px;
      white-space: nowrap;
    `;
    allowBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "allow_once", host: getHostname() });
      banner.remove();
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "\u2715";
    dismissBtn.style.cssText = `
      background: none; color: #9ca3af; border: none; font-size: 18px;
      cursor: pointer; padding: 4px 8px;
    `;
    dismissBtn.addEventListener("click", () => banner.remove());

    banner.append(icon, text, allowBtn, dismissBtn);
    document.documentElement.appendChild(banner);

    setTimeout(() => {
      if (banner.parentNode) banner.remove();
    }, 10000);
  }
})();
