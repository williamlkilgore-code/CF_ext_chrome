/**
 * PasteGuard — Detection Engine
 * Analyzes clipboard text for ClickFix-style attack patterns.
 * Shared between content script and injected page-world script.
 */

const PasteGuardDetector = (() => {
  // Risk levels
  const RISK = { NONE: 0, LOW: 1, MED: 2, HIGH: 3 };

  // Zero-width and bidi characters that can hide malicious intent
  const INVISIBLE_CHARS = /[\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD]/;

  // --- HIGH confidence patterns ---

  const HIGH_PATTERNS = [
    {
      name: "powershell-encoded",
      desc: "PowerShell encoded command",
      test: (t) => /powershell[^|]*(-enc\b|-encodedcommand\b)/i.test(t),
    },
    {
      name: "powershell-download",
      desc: "PowerShell download cradle",
      test: (t) =>
        /powershell/i.test(t) &&
        /(downloadstring|invoke-webrequest|start-bitstransfer|iwr\b|irm\b)/i.test(t),
    },
    {
      name: "invoke-expression",
      desc: "PowerShell Invoke-Expression",
      test: (t) => /\b(iex|invoke-expression)\b/i.test(t),
    },
    {
      name: "lolbin",
      desc: "Windows LOLBin execution",
      test: (t) =>
        /\b(mshta|rundll32|regsvr32|certutil|bitsadmin|wmic|cmstp|msiexec)\b/i.test(t) &&
        /(https?:|\\\\|\/\/)/i.test(t),
    },
    {
      name: "curl-pipe-sh",
      desc: "Download and execute via shell",
      test: (t) => /\b(curl|wget)\b.{0,80}\|\s*(ba)?sh\b/i.test(t),
    },
    {
      name: "python-exec-fetch",
      desc: "Python remote code execution",
      test: (t) =>
        /python[23]?\s+-c\b/i.test(t) &&
        /(urllib|requests|socket|exec|eval)/i.test(t),
    },
    {
      name: "base64-long-blob",
      desc: "Suspicious base64 payload",
      test: (t) => {
        const b64 = t.match(/[A-Za-z0-9+/=]{100,}/);
        if (!b64) return false;
        // Must also appear near a decode/exec context
        return /(base64|decode|atob|-enc|encodedcommand)/i.test(t);
      },
    },
  ];

  // --- MEDIUM confidence patterns ---

  const MED_PATTERNS = [
    {
      name: "js-eval-fetch",
      desc: "JavaScript fetch + eval pattern",
      test: (t) =>
        /\bfetch\s*\(/.test(t) &&
        /\b(eval|Function|atob)\s*\(/.test(t),
    },
    {
      name: "javascript-uri",
      desc: "JavaScript URI with payload",
      test: (t) => /^javascript:/i.test(t.trim()) && t.length > 60,
    },
    {
      name: "run-dialog-prompt",
      desc: "Instructs user to use Run dialog",
      test: (t) => /win\s*\+\s*r/i.test(t) && t.length > 20,
    },
    {
      name: "paste-terminal-prompt",
      desc: "Instructs user to paste in terminal",
      test: (t) =>
        /(paste\s+(this\s+)?(in|into)\s+(terminal|powershell|cmd|command\s*prompt))/i.test(t),
    },
    {
      name: "hidden-unicode",
      desc: "Contains hidden Unicode characters",
      test: (t) => {
        const matches = t.match(new RegExp(INVISIBLE_CHARS.source, "g"));
        return matches && matches.length >= 3;
      },
    },
    {
      name: "heavy-obfuscation",
      desc: "Heavy string obfuscation detected",
      test: (t) => {
        // Count concatenation operators and escape chars
        const concats = (t.match(/["`']\s*\+\s*["`']/g) || []).length;
        const carets = (t.match(/\^/g) || []).length;
        const backticks = (t.match(/`/g) || []).length;
        return concats + carets + backticks > 10;
      },
    },
  ];

  /**
   * Analyze text and return a risk assessment.
   * @param {string} text - The clipboard text to analyze
   * @returns {{ risk: number, categories: string[], descriptions: string[] }}
   */
  function analyze(text) {
    if (!text || typeof text !== "string") {
      return { risk: RISK.NONE, categories: [], descriptions: [] };
    }

    const categories = [];
    const descriptions = [];
    let risk = RISK.NONE;

    // Check HIGH patterns
    for (const p of HIGH_PATTERNS) {
      if (p.test(text)) {
        categories.push(p.name);
        descriptions.push(p.desc);
        risk = RISK.HIGH;
      }
    }

    // Check MEDIUM patterns
    for (const p of MED_PATTERNS) {
      if (p.test(text)) {
        categories.push(p.name);
        descriptions.push(p.desc);
        if (risk < RISK.MED) risk = RISK.MED;
      }
    }

    return { risk, categories, descriptions };
  }

  /**
   * Strip invisible characters for safe display.
   */
  function sanitizeForDisplay(text) {
    return text.replace(new RegExp(INVISIBLE_CHARS.source, "g"), "\u2422");
  }

  /**
   * Create a short safe preview of the text.
   */
  function preview(text, maxLen = 40) {
    const clean = sanitizeForDisplay(text);
    if (clean.length <= maxLen) return clean;
    return clean.slice(0, maxLen) + "\u2026";
  }

  return { RISK, analyze, sanitizeForDisplay, preview };
})();

// Make available in different contexts
if (typeof globalThis !== "undefined") {
  globalThis.PasteGuardDetector = PasteGuardDetector;
}
