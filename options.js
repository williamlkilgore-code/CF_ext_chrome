/**
 * PasteGuard — Options Page
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Elements ---
const globalModeButtons = $$(".mode-buttons button");
const intentWindowSlider = $("#intentWindow");
const intentWindowValue = $("#intentWindowValue");
const showNotificationsToggle = $("#showNotifications");
const showBannerToggle = $("#showBanner");
const logFullPayloadToggle = $("#logFullPayload");
const allowlistContainer = $("#allowlistContainer");
const allowlistEmpty = $("#allowlistEmpty");
const allowlistInput = $("#allowlistInput");
const overridesContainer = $("#overridesContainer");
const overridesEmpty = $("#overridesEmpty");
const logBody = $("#logBody");
const logEmpty = $("#logEmpty");
const logTable = $("#logTable");
const saveBar = $("#saveBar");

let dirty = false;
let currentSettings = {};

// --- Init ---
function init() {
  // Show version
  const manifest = chrome.runtime.getManifest();
  $("#version").textContent = `v${manifest.version}`;

  loadSettings();
  loadAllowlist();
  loadOverrides();
  loadLog();

  // Event handlers
  for (const btn of globalModeButtons) {
    btn.addEventListener("click", () => {
      for (const b of globalModeButtons) b.classList.remove("active");
      btn.classList.add("active");
      currentSettings.globalMode = btn.dataset.mode;
      markDirty();
    });
  }

  intentWindowSlider.addEventListener("input", () => {
    const val = parseInt(intentWindowSlider.value);
    intentWindowValue.textContent = `${val}ms`;
    currentSettings.intentWindowMs = val;
    markDirty();
  });

  showNotificationsToggle.addEventListener("change", () => {
    currentSettings.showNotifications = showNotificationsToggle.checked;
    markDirty();
  });

  showBannerToggle.addEventListener("change", () => {
    currentSettings.showBanner = showBannerToggle.checked;
    markDirty();
  });

  logFullPayloadToggle.addEventListener("change", () => {
    currentSettings.logFullPayload = logFullPayloadToggle.checked;
    markDirty();
  });

  allowlistInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btnAddAllowlist").click();
  });

  $("#btnAddAllowlist").addEventListener("click", addAllowlistEntry);
  $("#btnRefreshLog").addEventListener("click", loadLog);
  $("#btnExportLog").addEventListener("click", exportLog);
  $("#btnClearLog").addEventListener("click", clearLog);
  $("#btnSave").addEventListener("click", saveSettings);
}

function loadSettings() {
  chrome.runtime.sendMessage({ type: "get_settings" }, (data) => {
    currentSettings = { ...data };

    // Global mode
    for (const btn of globalModeButtons) {
      btn.classList.toggle("active", btn.dataset.mode === (data.globalMode || "normal"));
    }

    // Intent window
    const iw = data.intentWindowMs || 1200;
    intentWindowSlider.value = iw;
    intentWindowValue.textContent = `${iw}ms`;

    // Toggles
    showNotificationsToggle.checked = data.showNotifications !== false;
    showBannerToggle.checked = data.showBanner !== false;
    logFullPayloadToggle.checked = !!data.logFullPayload;
  });
}

function markDirty() {
  dirty = true;
  saveBar.classList.add("visible");
}

function saveSettings() {
  const settings = {
    globalMode: currentSettings.globalMode,
    intentWindowMs: currentSettings.intentWindowMs,
    showNotifications: currentSettings.showNotifications,
    showBanner: currentSettings.showBanner,
    logFullPayload: currentSettings.logFullPayload,
  };

  chrome.runtime.sendMessage({ type: "update_settings", settings }, () => {
    dirty = false;
    saveBar.classList.remove("visible");
    showToast("Settings saved");
  });
}

// --- Allowlist ---
function loadAllowlist() {
  chrome.runtime.sendMessage({ type: "get_allowlist" }, (resp) => {
    const list = resp?.allowlist || [];
    renderAllowlist(list);
  });
}

function renderAllowlist(list) {
  // Remove old entries (keep the empty message)
  allowlistContainer.querySelectorAll(".list-entry").forEach((el) => el.remove());

  if (list.length === 0) {
    allowlistEmpty.style.display = "";
    return;
  }

  allowlistEmpty.style.display = "none";

  for (const host of list) {
    const entry = document.createElement("div");
    entry.className = "list-entry";

    const hostSpan = document.createElement("span");
    hostSpan.className = "entry-host";
    hostSpan.textContent = host;

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.textContent = "\u2715";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "remove_allowlist", host }, () => {
        loadAllowlist();
      });
    });

    entry.append(hostSpan, removeBtn);
    allowlistContainer.appendChild(entry);
  }
}

function addAllowlistEntry() {
  const val = allowlistInput.value.trim().toLowerCase();
  if (!val) return;

  // Basic validation
  if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(val)) {
    showToast("Invalid domain format");
    return;
  }

  chrome.runtime.sendMessage({ type: "add_allowlist", host: val }, () => {
    allowlistInput.value = "";
    loadAllowlist();
  });
}

// --- Site Overrides ---
function loadOverrides() {
  chrome.runtime.sendMessage({ type: "get_all_overrides" }, (resp) => {
    const overrides = resp?.overrides || {};
    renderOverrides(overrides);
  });
}

function renderOverrides(overrides) {
  overridesContainer.querySelectorAll(".list-entry").forEach((el) => el.remove());

  const entries = Object.entries(overrides);
  if (entries.length === 0) {
    overridesEmpty.style.display = "";
    return;
  }

  overridesEmpty.style.display = "none";

  for (const [host, mode] of entries) {
    const entry = document.createElement("div");
    entry.className = "list-entry";

    const left = document.createElement("div");
    const hostSpan = document.createElement("span");
    hostSpan.className = "entry-host";
    hostSpan.textContent = host;

    const modeBadge = document.createElement("span");
    modeBadge.className = `entry-mode ${mode}`;
    modeBadge.textContent = mode;

    left.append(hostSpan, modeBadge);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.textContent = "\u2715";
    removeBtn.title = "Reset to global default";
    removeBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "clear_site_override", host }, () => {
        loadOverrides();
      });
    });

    entry.append(left, removeBtn);
    overridesContainer.appendChild(entry);
  }
}

// --- Event Log ---
function loadLog() {
  chrome.runtime.sendMessage({ type: "get_full_log" }, (resp) => {
    const log = resp?.log || [];
    renderLog(log);
  });
}

function renderLog(log) {
  if (!log || log.length === 0) {
    logTable.style.display = "none";
    logEmpty.style.display = "";
    return;
  }

  logTable.style.display = "";
  logEmpty.style.display = "none";

  const riskLabels = { 0: "none", 1: "low", 2: "med", 3: "high" };

  logBody.innerHTML = log
    .map((ev) => {
      const time = new Date(ev.timestamp).toLocaleString();
      const riskClass = `risk-${riskLabels[ev.risk] || "none"}`;
      const riskText = (riskLabels[ev.risk] || "none").toUpperCase();
      let domain = "";
      try { domain = new URL(ev.url).hostname; } catch { domain = ev.url || ""; }

      return `<tr>
        <td style="white-space:nowrap">${escapeHtml(time)}</td>
        <td><span class="action-badge ${ev.action}">${ev.action}</span></td>
        <td><span class="${riskClass}">${riskText}</span></td>
        <td>${escapeHtml(ev.descriptions?.join(", ") || "\u2014")}</td>
        <td>${escapeHtml(ev.api || "")}</td>
        <td title="${escapeHtml(ev.url || "")}">${escapeHtml(domain)}</td>
        <td>${ev.userIntent ? "\u2714" : "\u2718"}</td>
      </tr>`;
    })
    .join("");
}

function exportLog() {
  chrome.runtime.sendMessage({ type: "export_log" }, (resp) => {
    const blob = new Blob([JSON.stringify(resp, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pasteguard-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Log exported");
  });
}

function clearLog() {
  if (!confirm("Clear all logged events? This cannot be undone.")) return;
  chrome.runtime.sendMessage({ type: "clear_log" }, () => {
    loadLog();
    showToast("Log cleared");
  });
}

// --- Utilities ---
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function showToast(msg) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);
    background: #22c55e; color: #052e16; padding: 8px 20px; border-radius: 6px;
    font-size: 13px; font-weight: 600; z-index: 200;
    animation: fadeInOut 2s forwards;
  `;

  // Inject animation if not already present
  if (!document.getElementById("toast-style")) {
    const style = document.createElement("style");
    style.id = "toast-style";
    style.textContent = `
      @keyframes fadeInOut {
        0% { opacity: 0; transform: translateX(-50%) translateY(10px); }
        15% { opacity: 1; transform: translateX(-50%) translateY(0); }
        75% { opacity: 1; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

init();
