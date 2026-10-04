const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

const PATTERN_PLACEHOLDERS = {
  contains: "e.g. example.com",
  glob: "e.g. https://example.com/*",
  regex: "e.g. ^https://example\\.com/.*"
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        console.warn("Message failed:", chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(res);
    });
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });
}

// Read an interval field, clamp it to the allowed range, and write the
// corrected value back so the user sees what will actually be used.
function readInterval(input) {
  let n = parseInt(input.value, 10);
  if (!Number.isFinite(n)) n = MIN_INTERVAL_SECONDS;
  n = Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, n));
  input.value = n;
  return n;
}

// Favicons are page-controlled URLs, so render them via <img>, not CSS url().
function setFavicon(container, url) {
  container.textContent = "";
  if (!/^(https?:\/\/|data:image\/)/i.test(url || "")) return;
  const img = document.createElement("img");
  img.alt = "";
  img.src = url;
  img.addEventListener("error", () => img.remove());
  container.appendChild(img);
}

function makeFavicon(url) {
  const el = document.createElement("div");
  el.className = "timer-favicon";
  setFavicon(el, url);
  return el;
}

// "<status> • Interval: Ns • Remaining: <live countdown>" built without innerHTML.
function buildMeta(el, { statusClass, statusLabel, intervalSeconds, countdownKey, prefix }) {
  el.textContent = "";

  const status = document.createElement("span");
  status.className = statusClass;
  status.textContent = statusLabel;
  el.appendChild(status);

  const parts = [];
  if (prefix) parts.push(prefix);
  parts.push(`Interval: ${intervalSeconds}s`);
  el.appendChild(document.createTextNode(` • ${parts.join(" • ")}`));

  if (countdownKey != null) {
    el.appendChild(document.createTextNode(" • Remaining: "));
    const countdown = document.createElement("span");
    countdown.dataset.countdown = String(countdownKey);
    el.appendChild(countdown);
  }
}

const isLive = (t) => t && (t.status === "active" || t.status === "paused");

function computeRemaining(timer) {
  if (!isLive(timer)) return null;

  if (timer.status === "paused") {
    return timer.remainingSeconds != null ? timer.remainingSeconds : timer.intervalSeconds;
  }
  if (!timer.nextReloadAt) return null;

  return Math.max(0, Math.floor(timer.nextReloadAt - Date.now() / 1000));
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let state = {
  timers: {},
  rules: [],
  settings: { theme: "default", developerMode: false, bypassCache: false, skipFocusedTab: false }
};

let currentTabId = null;
let lastStructureSig = null;

async function refreshState() {
  const res = await sendMessage({ type: "GET_STATE" });
  if (!res) return;
  state.timers = res.timers || {};
  state.rules = res.rules || [];
  state.settings = { ...state.settings, ...(res.settings || {}) };
}

document.addEventListener("DOMContentLoaded", async () => {
  const tab = await getActiveTab();
  if (tab) {
    currentTabId = tab.id;
    setFavicon(document.getElementById("currentFavicon"), tab.favIconUrl);
    document.getElementById("currentTitle").textContent = tab.title || "Current tab";
  }

  wireNavigation();
  wireCurrentPanel();
  wireTimersPanel();
  wireAutomationPanel();
  wireOptionsPanel();

  await refreshState();
  renderAll(true);

  // Per-second updates touch only countdown text; lists are rebuilt on change.
  setInterval(tick, 1000);

  chrome.storage.onChanged.addListener(async () => {
    await refreshState();
    renderAll();
  });
});

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function wireNavigation() {
  const tabs = Array.from(document.querySelectorAll(".nav-tab"));
  const panels = Array.from(document.querySelectorAll(".panel"));

  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.panel;
      tabs.forEach((b) => b.classList.toggle("active", b === btn));
      panels.forEach((p) => {
        p.classList.toggle("active", p.classList.contains(`panel-${target}`));
      });
    });
  });
}

async function act(msg) {
  const res = await sendMessage(msg);
  await refreshState();
  renderAll();
  return res;
}

function wireCurrentPanel() {
  const startStopBtn = document.getElementById("startStopBtn");
  const pauseResumeBtn = document.getElementById("pauseResumeBtn");
  const intervalInput = document.getElementById("intervalInput");

  startStopBtn.addEventListener("click", async () => {
    if (currentTabId == null) return;

    if (!isLive(state.timers[currentTabId])) {
      await act({
        type: "START_TIMER",
        payload: { tabId: currentTabId, intervalSeconds: readInterval(intervalInput) }
      });
    } else {
      await act({ type: "STOP_TIMER", payload: { tabId: currentTabId } });
    }
  });

  pauseResumeBtn.addEventListener("click", async () => {
    const timer = state.timers[currentTabId];
    if (!isLive(timer)) return;

    await act({
      type: timer.status === "active" ? "PAUSE_TIMER" : "RESUME_TIMER",
      payload: { tabId: currentTabId }
    });
  });
}

function wireTimersPanel() {
  document.getElementById("pauseAllBtn").addEventListener("click", () => act({ type: "PAUSE_ALL" }));
  document.getElementById("stopAllBtn").addEventListener("click", () => act({ type: "STOP_ALL" }));
}

function wireAutomationPanel() {
  const matchTypeSelect = document.getElementById("ruleMatchType");
  const patternInput = document.getElementById("rulePatternInput");
  const intervalInput = document.getElementById("ruleIntervalInput");
  const urlInput = document.getElementById("ruleUrlInput");
  const errorEl = document.getElementById("ruleError");

  const updatePlaceholder = () => {
    patternInput.placeholder = PATTERN_PLACEHOLDERS[matchTypeSelect.value] || "";
  };
  matchTypeSelect.addEventListener("change", updatePlaceholder);
  updatePlaceholder();

  document.getElementById("addRuleBtn").addEventListener("click", async () => {
    errorEl.textContent = "";

    const pattern = patternInput.value.trim();
    const matchType = matchTypeSelect.value;
    const intervalSeconds = readInterval(intervalInput);
    const url = urlInput.value.trim();

    if (!pattern) {
      errorEl.textContent = "Enter a pattern first.";
      return;
    }

    const existing = state.rules.find(
      (r) =>
        r.pattern === pattern &&
        (r.matchType || "regex") === matchType &&
        (!url || r.url === url)
    );

    const rule = {
      id: existing ? existing.id : `rule-${Date.now()}`,
      pattern,
      matchType,
      intervalSeconds,
      url: url || null,
      status: existing ? existing.status : "active",
      title: existing ? existing.title : pattern,
      faviconUrl: existing ? existing.faviconUrl : ""
    };

    const res = await act({ type: "UPDATE_RULE", payload: { rule } });
    if (!res || !res.ok) {
      errorEl.textContent = (res && res.error) || "Couldn't save the rule.";
    }
  });
}

function wireOptionsPanel() {
  document.getElementById("themeSelect").addEventListener("change", (e) => {
    applyTheme(e.target.value); // instant feedback; storage change confirms it
    act({ type: "UPDATE_SETTINGS", payload: { settings: { theme: e.target.value } } });
  });

  const toggles = [
    ["bypassCacheToggle", "bypassCache"],
    ["skipFocusedToggle", "skipFocusedTab"],
    ["developerModeToggle", "developerMode"]
  ];
  toggles.forEach(([id, key]) => {
    document.getElementById(id).addEventListener("change", (e) => {
      if (key === "developerMode") applyDeveloperMode(e.target.checked);
      act({ type: "UPDATE_SETTINGS", payload: { settings: { [key]: e.target.checked } } });
    });
  });
}

function applyTheme(theme) {
  const body = document.body;
  body.classList.remove("theme-default", "theme-dark", "theme-blue");
  body.classList.add(theme === "dark" || theme === "blue" ? `theme-${theme}` : "theme-default");

  // Cached so theme-init.js can apply it before first paint next time.
  try {
    localStorage.setItem("arTheme", theme);
  } catch {
    // ignore – storage unavailable
  }
}

function applyDeveloperMode(enabled) {
  document.getElementById("debugPanel").style.display = enabled ? "block" : "none";
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

// Rebuild the lists/options only when something other than a countdown changed.
function renderAll(force = false) {
  const sig = JSON.stringify(state, (key, value) => (key === "nextReloadAt" ? undefined : value));
  if (force || sig !== lastStructureSig) {
    lastStructureSig = sig;
    renderTimersPanel();
    renderAutomationPanel();
    renderOptionsPanel();
  }
  tick();
}

function tick() {
  renderCurrentPanel();
  document.querySelectorAll("[data-countdown]").forEach((el) => {
    const remaining = computeRemaining(state.timers[el.dataset.countdown]);
    el.textContent = remaining != null ? `${remaining}s` : "";
  });
}

function renderCurrentPanel() {
  const timer = currentTabId != null ? state.timers[currentTabId] : null;
  const ringValue = document.getElementById("ringValue");
  const summaryEl = document.getElementById("currentSummary");
  const startStopBtn = document.getElementById("startStopBtn");
  const pauseResumeBtn = document.getElementById("pauseResumeBtn");

  if (!isLive(timer)) {
    startStopBtn.textContent = "Start";
    pauseResumeBtn.textContent = "Pause";
    pauseResumeBtn.disabled = true;
    ringValue.textContent = "0s";
    summaryEl.textContent = "No active timer on this tab.";
    return;
  }

  startStopBtn.textContent = "Stop";
  pauseResumeBtn.textContent = timer.status === "active" ? "Pause" : "Activate";
  pauseResumeBtn.disabled = false;

  const remaining = computeRemaining(timer) ?? timer.intervalSeconds;
  ringValue.textContent = `${remaining}s`;
  summaryEl.textContent =
    `Status: ${timer.status} • Interval: ${timer.intervalSeconds}s • Remaining: ${remaining}s`;
}

function renderTimersPanel() {
  const listEl = document.getElementById("timersList");
  const navTimers = document.getElementById("navTimers");
  const panelTimers = document.getElementById("panelTimers");

  const timers = Object.values(state.timers).filter(isLive);

  if (timers.length === 0) {
    navTimers.style.display = "none";
    listEl.textContent = "";

    // If the user is looking at the (now empty) Timers tab, send them back to Current.
    const activeTab = document.querySelector(".nav-tab.active");
    if (activeTab?.dataset.panel === "timers") {
      const currentBtn = document.querySelector('.nav-tab[data-panel="current"]');
      const currentPanel = document.querySelector(".panel-current");
      document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("active", b === currentBtn));
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p === currentPanel));
    }
    panelTimers.classList.remove("active");
    return;
  }

  navTimers.style.display = "inline-block";
  listEl.textContent = "";

  timers.forEach((t) => {
    const item = document.createElement("div");
    item.className = "timer-item";

    const main = document.createElement("div");
    main.className = "timer-main";

    const title = document.createElement("div");
    title.className = "timer-title";
    title.textContent = t.title || `Tab ${t.tabId}`;

    const meta = document.createElement("div");
    meta.className = "timer-meta";
    buildMeta(meta, {
      statusClass: "timer-status",
      statusLabel: t.status === "active" ? "Active" : "Paused",
      intervalSeconds: t.intervalSeconds,
      countdownKey: t.tabId
    });

    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "timer-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "secondary-btn";
    toggleBtn.textContent = t.status === "active" ? "Pause" : "Activate";
    toggleBtn.addEventListener("click", () =>
      act({
        type: t.status === "active" ? "PAUSE_TIMER" : "RESUME_TIMER",
        payload: { tabId: t.tabId }
      })
    );

    const stopBtn = document.createElement("button");
    stopBtn.className = "secondary-btn";
    stopBtn.textContent = "Stop";
    stopBtn.addEventListener("click", () =>
      act({ type: "STOP_TIMER", payload: { tabId: t.tabId } })
    );

    actions.appendChild(toggleBtn);
    actions.appendChild(stopBtn);

    item.appendChild(makeFavicon(t.faviconUrl));
    item.appendChild(main);
    item.appendChild(actions);
    listEl.appendChild(item);
  });
}

function loadRuleIntoForm(rule) {
  document.getElementById("ruleMatchType").value = rule.matchType || "regex";
  document.getElementById("ruleMatchType").dispatchEvent(new Event("change"));
  document.getElementById("rulePatternInput").value = rule.pattern;
  document.getElementById("ruleIntervalInput").value = rule.intervalSeconds;
  document.getElementById("ruleUrlInput").value = rule.url || "";
  document.getElementById("ruleError").textContent = "";
}

function renderAutomationPanel() {
  const listEl = document.getElementById("rulesList");
  listEl.textContent = "";

  state.rules.forEach((rule) => {
    const live = Object.values(state.timers).filter((t) => isLive(t) && t.isAuto && t.ruleId === rule.id);
    const primary = live.find((t) => t.status === "active") || live[0] || null;

    let status;
    if (rule.status === "paused") status = "paused";
    else if (!primary) status = "not-loaded";
    else status = primary.status;

    const item = document.createElement("div");
    item.className = "rule-item";

    const main = document.createElement("div");
    main.className = "rule-main";

    const titleEl = document.createElement("div");
    titleEl.className = "rule-title";
    titleEl.textContent = (primary && primary.title) || rule.title || rule.pattern;
    titleEl.title = `${rule.matchType || "regex"}: ${rule.pattern} (click to edit)`;
    titleEl.addEventListener("click", () => loadRuleIntoForm(rule));

    const meta = document.createElement("div");
    meta.className = "rule-meta";
    buildMeta(meta, {
      statusClass: "rule-status",
      statusLabel: status,
      intervalSeconds: rule.intervalSeconds,
      countdownKey: primary ? primary.tabId : null,
      prefix: live.length > 1 ? `${live.length} tabs` : null
    });

    main.appendChild(titleEl);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "rule-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "secondary-btn";
    const nextStatus = rule.status === "paused" ? "active" : "paused";
    toggleBtn.textContent = rule.status === "paused" ? "Activate" : "Pause";
    toggleBtn.addEventListener("click", () =>
      act({ type: "UPDATE_RULE", payload: { rule: { ...rule, status: nextStatus } } })
    );
    actions.appendChild(toggleBtn);

    if (rule.url && live.length === 0) {
      const openBtn = document.createElement("button");
      openBtn.className = "secondary-btn";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", () =>
        act({ type: "OPEN_AUTO_TAB", payload: { ruleId: rule.id } })
      );
      actions.appendChild(openBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "secondary-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () =>
      act({ type: "DELETE_RULE", payload: { ruleId: rule.id } })
    );
    actions.appendChild(deleteBtn);

    item.appendChild(makeFavicon((primary && primary.faviconUrl) || rule.faviconUrl));
    item.appendChild(main);
    item.appendChild(actions);
    listEl.appendChild(item);
  });
}

function renderOptionsPanel() {
  const s = state.settings;

  document.getElementById("themeSelect").value = s.theme || "default";
  document.getElementById("bypassCacheToggle").checked = !!s.bypassCache;
  document.getElementById("skipFocusedToggle").checked = !!s.skipFocusedTab;
  document.getElementById("developerModeToggle").checked = !!s.developerMode;

  applyTheme(s.theme || "default");
  applyDeveloperMode(!!s.developerMode);

  document.getElementById("debugOutput").textContent = s.developerMode
    ? JSON.stringify(state, null, 2)
    : "";
}
