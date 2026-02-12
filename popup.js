/**
 * PasteGuard — Popup Script
 */

const $ = (sel) => document.querySelector(sel);

const hostEl = $("#host");
const modeBadge = $("#modeBadge");
const blockCountEl = $("#blockCount");
const logEntriesEl = $("#logEntries");
const btnOff = $("#btnOff");
const btnNormal = $("#btnNormal");
const btnStrict = $("#btnStrict");
const modeButtons = [btnOff, btnNormal, btnStrict];

const allowlistPanel = $("#allowlistPanel");
const allowlistEntries = $("#allowlistEntries");
const allowlistInput = $("#allowlistInput");

let currentHost = "";

// --- Init ---
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  chrome.runtime.sendMessage({ type: "get_status", url }, (resp) => {
    if (!resp) return;

    currentHost = resp.host;
    hostEl.textContent = resp.host || "—";
    setActiveMode(resp.mode);
    blockCountEl.textContent = resp.blockCount;
    renderLog(resp.recentEvents);
  });
}

function setActiveMode(mode) {
  modeBadge.textContent = mode;
  modeBadge.className = `mode-badge ${mode}`;

  for (const btn of modeButtons) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
}

function renderLog(events) {
  if (!events || events.length === 0) {
    logEntriesEl.innerHTML = '<p class="empty">No events yet.</p>';
    return;
  }

  logEntriesEl.innerHTML = events
    .map((ev) => {
      const time = new Date(ev.timestamp).toLocaleTimeString();
      return `
        <div class="log-entry ${ev.action}">
          <span class="entry-action ${ev.action}">${ev.action}</span>
          <div class="entry-desc">${escapeHtml(ev.descriptions?.join(", ") || "—")}</div>
          <div class="entry-meta">${escapeHtml(ev.preview || "")} · ${ev.api} · ${time}</div>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// --- Mode buttons ---
for (const btn of modeButtons) {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    chrome.runtime.sendMessage(
      { type: "set_mode", mode, host: currentHost, scope: "site" },
      () => {
        setActiveMode(mode);
      }
    );
  });
}

// --- Allowlist ---
$("#btnAllowlist").addEventListener("click", () => {
  allowlistPanel.classList.remove("hidden");
  loadAllowlist();
});

$("#btnBackFromAllowlist").addEventListener("click", () => {
  allowlistPanel.classList.add("hidden");
});

$("#btnAddAllowlist").addEventListener("click", () => {
  const val = allowlistInput.value.trim().toLowerCase();
  if (!val) return;
  chrome.runtime.sendMessage({ type: "add_allowlist", host: val }, () => {
    allowlistInput.value = "";
    loadAllowlist();
  });
});

allowlistInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btnAddAllowlist").click();
});

function loadAllowlist() {
  chrome.runtime.sendMessage({ type: "get_allowlist" }, (resp) => {
    const list = resp?.allowlist || [];
    if (list.length === 0) {
      allowlistEntries.innerHTML = '<p class="empty">No entries.</p>';
      return;
    }
    allowlistEntries.innerHTML = list
      .map(
        (h) =>
          `<div class="allowlist-entry">
            <span>${escapeHtml(h)}</span>
            <button data-host="${escapeHtml(h)}" title="Remove">\u2715</button>
          </div>`
      )
      .join("");

    for (const btn of allowlistEntries.querySelectorAll("button")) {
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage(
          { type: "remove_allowlist", host: btn.dataset.host },
          () => loadAllowlist()
        );
      });
    }
  });
}

// --- Clear log ---
$("#btnClearLog").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear_log" }, () => {
    blockCountEl.textContent = "0";
    logEntriesEl.innerHTML = '<p class="empty">No events yet.</p>';
  });
});

init();
