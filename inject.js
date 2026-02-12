/**
 * PasteGuard — Page-World Injected Script
 * Runs in the page's JS context to monkey-patch clipboard APIs.
 * Communicates with the content script via window.postMessage.
 */

(() => {
  const MSG_PREFIX = "__pasteguard__";

  // Store originals
  const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
  const origExecCommand = document.execCommand.bind(document);

  /**
   * Send a clipboard write attempt to the content script and wait for a decision.
   * Returns a Promise that resolves to { action: "allow"|"block"|"quarantine" }
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
    const decision = await requestDecision(text, "writeText");

    if (decision.action === "block") {
      return Promise.resolve(); // silently swallow
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
    if (command.toLowerCase() === "copy") {
      // For execCommand("copy"), we can't easily intercept the text synchronously.
      // Instead, we'll rely on the copy event listener below.
      // Still let it through — the copy event handler will do the real check.
    }
    return origExecCommand(command, ...args);
  };

  // --- Intercept copy event at capture phase ---
  document.addEventListener(
    "copy",
    (e) => {
      const selection = window.getSelection();
      const text = selection ? selection.toString() : "";

      if (!text) return; // nothing to check

      // Post the copy event data to content script for logging/analysis
      // We can't block synchronously here in a useful way for execCommand,
      // but we CAN replace the clipboard data if the clipboardData API is available
      window.postMessage(
        {
          type: `${MSG_PREFIX}copy_event`,
          text,
          url: location.href,
          timestamp: Date.now(),
        },
        "*"
      );
    },
    true
  );
})();
