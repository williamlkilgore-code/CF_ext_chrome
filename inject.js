/**
 * PasteGuard — Page-World Injected Script
 * Runs in the page's JS context to monkey-patch clipboard APIs.
 * Communicates with the content script via window.postMessage.
 */

(() => {
  const MSG_PREFIX = "__pasteguard__";

  // --- Current mode (received from content script) ---
  let currentMode = "normal";

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === `${MSG_PREFIX}mode_update`) {
      currentMode = e.data.mode;
    }
  });

  // --- Lightweight inline detector for synchronous copy event blocking ---
  // (Full analysis happens in content script; this catches the obvious cases synchronously)
  const SYNC_HIGH_PATTERNS = [
    /powershell[^|]*(-enc\b|-encodedcommand\b)/i,
    /\b(iex|invoke-expression)\b/i,
    /powershell[\s\S]{0,80}(downloadstring|invoke-webrequest|start-bitstransfer|iwr\b|irm\b)/i,
    /\b(mshta|rundll32|regsvr32|certutil|bitsadmin)\b[\s\S]{0,40}(https?:|\\\\|\/\/)/i,
    /\b(curl|wget)\b.{0,80}\|\s*(ba)?sh\b/i,
    /python[23]?\s+-c\b[\s\S]{0,120}(urllib|requests|socket|exec|eval)/i,
  ];

  const SYNC_MED_PATTERNS = [
    /\bfetch\s*\([\s\S]{0,80}\b(eval|Function|atob)\s*\(/,
    /^javascript:/i,
  ];

  function quickRisk(text) {
    if (!text || text.length < 10) return 0;
    for (const p of SYNC_HIGH_PATTERNS) {
      if (p.test(text)) return 3; // HIGH
    }
    for (const p of SYNC_MED_PATTERNS) {
      if (p.test(text)) return 2; // MED
    }
    return 0;
  }

  // Store originals
  const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
  const origExecCommand = document.execCommand.bind(document);

  /**
   * Send a clipboard write attempt to the content script and wait for a decision.
   */
  function requestDecision(text, api) {
    return new Promise((resolve) => {
      const id = `${MSG_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2)}`;

      function onResponse(e) {
        if (
          e.data &&
          e.data.type === `${MSG_PREFIX}response` &&
          e.data.id === id
        ) {
          window.removeEventListener("message", onResponse);
          resolve(e.data);
        }
      }

      window.addEventListener("message", onResponse);

      window.postMessage(
        {
          type: `${MSG_PREFIX}request`,
          id,
          text,
          api,
          url: location.href,
          timestamp: Date.now(),
        },
        "*"
      );

      // Timeout fallback — allow after 3s if no response
      setTimeout(() => {
        window.removeEventListener("message", onResponse);
        resolve({ action: "allow" });
      }, 3000);
    });
  }

  // --- Patch navigator.clipboard.writeText ---
  navigator.clipboard.writeText = async function (text) {
    if (currentMode === "off") {
      return origWriteText(text);
    }

    const decision = await requestDecision(text, "writeText");

    if (decision.action === "block") {
      return Promise.resolve();
    }
    if (decision.action === "quarantine") {
      return origWriteText(
        "[PasteGuard] Blocked suspicious clipboard content. Check the extension for details."
      );
    }
    return origWriteText(text);
  };

  // --- Patch document.execCommand ---
  document.execCommand = function (command, ...args) {
    // Copy blocking for execCommand is handled by the copy event listener below
    return origExecCommand(command, ...args);
  };

  // --- Intercept copy event at capture phase ---
  // This runs synchronously, so we use the lightweight inline detector
  document.addEventListener(
    "copy",
    (e) => {
      if (currentMode === "off") return;

      // Check both selection and any clipboardData being set
      const selection = window.getSelection();
      const text = selection ? selection.toString() : "";

      // Also check if the page is setting clipboardData directly
      // (some ClickFix attacks use this to override what the user thinks they copied)
      let clipText = "";
      try {
        clipText = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
      } catch {}

      const textToCheck = clipText || text;
      if (!textToCheck) return;

      const risk = quickRisk(textToCheck);
      const shouldBlock =
        (currentMode === "normal" && risk >= 3) ||
        (currentMode === "strict" && risk >= 2);

      if (shouldBlock) {
        e.preventDefault();
        e.clipboardData.setData(
          "text/plain",
          "[PasteGuard] Blocked suspicious clipboard content."
        );
      }

      // Notify content script for logging
      window.postMessage(
        {
          type: `${MSG_PREFIX}copy_event`,
          text: textToCheck,
          blocked: shouldBlock,
          url: location.href,
          timestamp: Date.now(),
        },
        "*"
      );
    },
    true
  );
})();
