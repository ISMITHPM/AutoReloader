// Auto Reloader – background service worker (Manifest V3)
//
// Storage layout (chrome.storage.local):
//   timers    { [tabId]: Timer }   live timers only (status "active" | "paused")
//   autoRules Rule[]               automation rules (persist across sessions)
//   settings  Settings
//
// A rule that has no live timer is simply "not loaded"; no placeholder timers
// are stored for closed tabs.

const TIMERS_KEY = "timers";
const RULES_KEY = "autoRules";
const SETTINGS_KEY = "settings";

const STATUS_ACTIVE = "active";
const STATUS_PAUSED = "paused";

// Chrome enforces a 30 s minimum on alarms for packed/published extensions.
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

// Badge: the last COUNTDOWN_SECONDS of each cycle count down in red.
const COUNTDOWN_SECONDS = 5;
const COUNTDOWN_COLOR = "#d93025";
const ACTIVE_COLOR = "#0078ff";
const PAUSED_COLOR = "#888888";
// A wake-up alarm must be at least this far away to be honoured (Chrome's 30 s floor + margin).
const ALARM_SAFE_SECONDS = 31;

const MATCH_TYPES = ["contains", "glob", "regex"];
const THEMES = ["default", "dark", "blue"];

const DEFAULT_SETTINGS = {
  theme: "default",
  developerMode: false,
  bypassCache: false,
  skipFocusedTab: false,
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const nowSec = () => Date.now() / 1000;

function clampInterval(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return MIN_INTERVAL_SECONDS;
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, n));
}

function safeFavicon(url) {
  return typeof url === "string" && url.length <= 2000 && /^(https?:\/\/|data:image\/)/i.test(url)
    ? url
    : "";
}

function parseHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* State access – every write goes through one serialized queue        */
/* ------------------------------------------------------------------ */

async function readState() {
  const data = await chrome.storage.local.get([TIMERS_KEY, RULES_KEY, SETTINGS_KEY]);
  const timers = data[TIMERS_KEY];
  return {
    timers: timers && typeof timers === "object" && !Array.isArray(timers) ? timers : {},
    rules: Array.isArray(data[RULES_KEY]) ? data[RULES_KEY] : [],
    settings: { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) },
  };
}

let queue = Promise.resolve();

/**
 * Run fn(state) with exclusive access to stored state. fn may mutate
 * state.timers / state.rules / state.settings; changes are persisted after fn
 * resolves. If fn throws, nothing is written. The queue never rejects, so one
 * failure can't wedge later operations.
 */
function mutate(fn) {
  const run = async () => {
    const state = await readState();
    const snapshot = JSON.stringify(state);
    const beforeKeys = Object.keys(state.timers);

    const result = await fn(state);

    if (JSON.stringify(state) !== snapshot) {
      await chrome.storage.local.set({
        [TIMERS_KEY]: state.timers,
        [RULES_KEY]: state.rules,
        [SETTINGS_KEY]: state.settings,
      });
      await syncBadges(beforeKeys, state.timers);
    }
    return result;
  };

  const p = queue.then(run);
  queue = p.catch((err) => console.error("AutoReloader state update failed:", err));
  return p;
}

/* ------------------------------------------------------------------ */
/* Alarms, countdown & badges                                          */
/* ------------------------------------------------------------------ */

const alarmName = (tabId) => `reload-${tabId}`;
const warnAlarmName = (tabId) => `warn-${tabId}`;

// tabId -> setTimeout handle for the in-worker end-of-cycle countdown.
const countdowns = new Map();

function cancelCountdown(tabId) {
  clearTimeout(countdowns.get(tabId));
  countdowns.delete(tabId);
}

function scheduleAlarm(tabId, nextReloadAt) {
  return chrome.alarms.create(alarmName(tabId), {
    when: Math.max(Date.now(), nextReloadAt * 1000),
  });
}

// Clears everything scheduled for a tab: reload alarm, wake-up alarm, countdown timer.
async function clearAlarm(tabId) {
  cancelCountdown(tabId);
  await Promise.all([
    chrome.alarms.clear(alarmName(tabId)),
    chrome.alarms.clear(warnAlarmName(tabId)),
  ]);
}

// Schedule the reload and the badge countdown for a live (active) timer.
async function armTimer(t) {
  await scheduleAlarm(t.tabId, t.nextReloadAt);
  await armCountdown(t);
}

async function armCountdown(t) {
  cancelCountdown(t.tabId);
  await chrome.alarms.clear(warnAlarmName(t.tabId));

  const wakeAt = t.nextReloadAt - (COUNTDOWN_SECONDS + 1);
  if (wakeAt - nowSec() >= ALARM_SAFE_SECONDS) {
    // Far enough away: let the worker sleep and wake it just before the countdown.
    await chrome.alarms.create(warnAlarmName(t.tabId), { when: wakeAt * 1000 });
  } else {
    // Too close for an alarm (short intervals): the worker is awake right now,
    // so count down from here.
    runCountdown(t.tabId, t.nextReloadAt);
  }
}

/**
 * Tick the badge once per second for the last COUNTDOWN_SECONDS, then trigger the
 * reload at zero. Each tick reads storage (an extension API call), which also resets
 * the worker's 30 s idle timer, and waits are capped at 20 s so the worker never
 * idles out mid-countdown. A superseded countdown (timer paused, stopped or
 * rescheduled) notices on its next tick and ends.
 */
function runCountdown(tabId, nextReloadAt) {
  cancelCountdown(tabId);

  const tick = async () => {
    countdowns.delete(tabId);
    try {
      const s = await readState();
      const t = s.timers[tabId];
      if (!t || t.status !== STATUS_ACTIVE || t.nextReloadAt !== nextReloadAt) return;

      const left = Math.ceil(nextReloadAt - nowSec());
      if (left <= 0) {
        await reloadTab(tabId);
        return;
      }
      await setBadge(tabId, t);

      // Next tick: when the displayed number changes, or when the countdown begins.
      const nextAt =
        left > COUNTDOWN_SECONDS ? nextReloadAt - COUNTDOWN_SECONDS : nextReloadAt - (left - 1);
      const delayMs = Math.min(20000, Math.max(20, nextAt * 1000 - Date.now()));
      countdowns.set(tabId, setTimeout(tick, delayMs));
    } catch (err) {
      console.error("countdown tick failed:", err);
    }
  };

  const firstDelay = Math.min(
    20000,
    Math.max(0, (nextReloadAt - COUNTDOWN_SECONDS) * 1000 - Date.now())
  );
  countdowns.set(tabId, setTimeout(tick, firstDelay));
}

// What the toolbar badge should show for a timer right now.
function badgeFor(timer) {
  if (!timer) return null;
  if (timer.status !== STATUS_ACTIVE) return { text: "II", color: PAUSED_COLOR };

  const left = Math.ceil(timer.nextReloadAt - nowSec());
  if (left >= 1 && left <= COUNTDOWN_SECONDS) {
    return { text: String(left), color: COUNTDOWN_COLOR };
  }
  return { text: "ON", color: ACTIVE_COLOR };
}

async function setBadge(tabId, timer) {
  try {
    const badge = badgeFor(timer);
    if (!badge) {
      await chrome.action.setBadgeText({ tabId, text: "" });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    await chrome.action.setBadgeText({ tabId, text: badge.text });
  } catch {
    // Tab no longer exists – nothing to update.
  }
}

async function syncBadges(beforeKeys, timers) {
  const keys = new Set([...beforeKeys, ...Object.keys(timers)]);
  await Promise.all([...keys].map((k) => setBadge(Number(k), timers[k])));
}

/* ------------------------------------------------------------------ */
/* Timer helpers (operate on a state object inside mutate)             */
/* ------------------------------------------------------------------ */

function makeTimer(tab, { intervalSeconds, isAuto = false, ruleId = null }) {
  return {
    tabId: tab.id,
    status: STATUS_ACTIVE,
    title: tab.title || "Untitled",
    faviconUrl: safeFavicon(tab.favIconUrl),
    intervalSeconds,
    nextReloadAt: nowSec() + intervalSeconds,
    remainingSeconds: null,
    isAuto,
    ruleId,
  };
}

async function pauseTimer(t) {
  if (t.status !== STATUS_ACTIVE) return;
  t.remainingSeconds = Math.max(0, Math.floor(t.nextReloadAt - nowSec()));
  t.status = STATUS_PAUSED;
  t.nextReloadAt = null;
  await clearAlarm(t.tabId);
}

async function resumeTimer(t) {
  if (t.status !== STATUS_PAUSED) return;
  // Alarms can't fire sooner than the minimum, so never promise less.
  const secs = Math.max(MIN_INTERVAL_SECONDS, t.remainingSeconds ?? t.intervalSeconds);
  t.status = STATUS_ACTIVE;
  t.nextReloadAt = nowSec() + secs;
  t.remainingSeconds = null;
  await armTimer(t);
}

async function removeTimer(s, tabId) {
  delete s.timers[tabId];
  await clearAlarm(tabId);
}

const timersForRule = (s, ruleId) =>
  Object.values(s.timers).filter((t) => t.isAuto && t.ruleId === ruleId);

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function urlMatchesRule(url, rule) {
  if (!rule.pattern || !url) return false;
  // Rules saved by older versions have no matchType and were treated as regex.
  const type = rule.matchType || "regex";
  try {
    if (type === "contains") return url.toLowerCase().includes(rule.pattern.toLowerCase());
    if (type === "glob") return globToRegExp(rule.pattern).test(url);
    return new RegExp(rule.pattern, "i").test(url);
  } catch {
    return url.toLowerCase().includes(rule.pattern.toLowerCase());
  }
}

function sanitizeRule(input) {
  if (!input || typeof input !== "object") return { error: "Invalid rule." };

  const id = typeof input.id === "string" ? input.id.slice(0, 64) : "";
  if (!id) return { error: "Rule is missing an id." };

  const pattern = typeof input.pattern === "string" ? input.pattern.trim().slice(0, 500) : "";
  if (!pattern) return { error: "Pattern is required." };

  const matchType = MATCH_TYPES.includes(input.matchType) ? input.matchType : "regex";
  if (matchType === "regex") {
    try {
      new RegExp(pattern, "i");
    } catch {
      return { error: "That isn't a valid regular expression." };
    }
  }

  let url = null;
  if (input.url) {
    url = parseHttpUrl(input.url);
    if (!url) return { error: "URL must be a valid http(s) address." };
  }

  const rule = {
    id,
    pattern,
    matchType,
    intervalSeconds: clampInterval(input.intervalSeconds),
    url,
    status: input.status === STATUS_PAUSED ? STATUS_PAUSED : STATUS_ACTIVE,
    title: typeof input.title === "string" && input.title ? input.title.slice(0, 200) : pattern,
    faviconUrl: safeFavicon(input.faviconUrl),
  };

  // An "Open" URL that the rule wouldn't match would be detached right away.
  if (url && !urlMatchesRule(url, rule)) {
    return { error: "The URL doesn't match the pattern." };
  }
  return { rule };
}

/**
 * Make one tab consistent with the rules:
 *  - refresh stored title/favicon of an existing timer
 *  - detach an auto timer whose tab no longer matches its rule
 *  - attach the first active matching rule if the tab has no timer
 * Manual timers are never touched.
 */
async function applyRulesToTab(s, tab) {
  if (!tab || tab.id == null || !tab.url) return;

  const existing = s.timers[tab.id];
  if (existing) {
    if (tab.title && existing.title !== tab.title) existing.title = tab.title;
    const icon = safeFavicon(tab.favIconUrl);
    if (icon && existing.faviconUrl !== icon) existing.faviconUrl = icon;

    if (!existing.isAuto) return;
    const owner = s.rules.find((r) => r.id === existing.ruleId);
    if (owner && urlMatchesRule(tab.url, owner)) return;

    await removeTimer(s, tab.id); // navigated away from the rule's pages
  }

  const rule = s.rules.find((r) => r.status === STATUS_ACTIVE && urlMatchesRule(tab.url, r));
  if (!rule) return;

  const timer = makeTimer(tab, {
    intervalSeconds: rule.intervalSeconds,
    isAuto: true,
    ruleId: rule.id,
  });
  if (!tab.title && rule.title) timer.title = rule.title;
  if (!timer.faviconUrl) timer.faviconUrl = rule.faviconUrl || "";

  s.timers[tab.id] = timer;
  await armTimer(timer);
}

async function applyRulesToOpenTabs(s) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.status === "loading") continue; // onUpdated will handle it on completion
    await applyRulesToTab(s, tab);
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

// After an install/update/reload, make stored timers consistent with reality:
// drop timers whose tab is gone and re-create any missing alarms.
async function reconcile() {
  await mutate(async (s) => {
    for (const [key, t] of Object.entries(s.timers)) {
      const live = t && (t.status === STATUS_ACTIVE || t.status === STATUS_PAUSED);
      let tabExists = false;
      if (live && Number.isInteger(t.tabId)) {
        try {
          await chrome.tabs.get(t.tabId);
          tabExists = true;
        } catch {
          tabExists = false;
        }
      }

      if (!tabExists) {
        delete s.timers[key];
        if (t && Number.isInteger(t.tabId)) await clearAlarm(t.tabId);
        continue;
      }
      if (t.status === STATUS_ACTIVE) {
        // An overdue timer simply fires as soon as possible.
        if (!t.nextReloadAt) t.nextReloadAt = nowSec();
        await armTimer(t);
      }
    }
  });
}

// Tab IDs are not stable across browser restarts, so stored timers are
// meaningless at startup. Start clean and let the rules re-attach to open tabs.
async function resetForStartup() {
  await chrome.alarms.clearAll();
  await mutate(async (s) => {
    s.timers = {};
    await applyRulesToOpenTabs(s);
  });
}

// Fires on install AND on update. Never overwrite existing user data here;
// readState() already fills in defaults for anything missing.
chrome.runtime.onInstalled.addListener(() => {
  reconcile().catch((err) => console.error("reconcile failed:", err));
});

chrome.runtime.onStartup.addListener(() => {
  resetForStartup().catch((err) => console.error("startup reset failed:", err));
});

/* ------------------------------------------------------------------ */
/* Reload + alarm handler                                              */
/* ------------------------------------------------------------------ */

// Performs a due reload and schedules the next cycle. Both the reload alarm and the
// badge countdown can call this; whichever arrives second finds the timer no longer
// due and does nothing.
function reloadTab(tabId) {
  return mutate(async (s) => {
    const t = s.timers[tabId];
    if (!t || t.status !== STATUS_ACTIVE) return;
    if (t.nextReloadAt - nowSec() > 1.5) return; // already handled

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      await removeTimer(s, tabId); // tab vanished
      return;
    }

    // Optional: don't reload a tab the user is looking at right now.
    if (s.settings.skipFocusedTab && tab.active) {
      try {
        const win = await chrome.windows.get(tab.windowId);
        if (win.focused) {
          t.nextReloadAt = nowSec() + MIN_INTERVAL_SECONDS;
          await armTimer(t);
          return;
        }
      } catch {
        // fall through and reload
      }
    }

    try {
      await chrome.tabs.reload(tabId, { bypassCache: !!s.settings.bypassCache });
    } catch (err) {
      console.warn(`Reload of tab ${tabId} failed:`, err);
    }

    t.nextReloadAt = nowSec() + t.intervalSeconds;
    await armTimer(t);
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const match = /^(reload|warn)-(\d+)$/.exec(alarm.name);
  if (!match) return;
  const tabId = Number(match[2]);

  if (match[1] === "reload") {
    reloadTab(tabId).catch((err) => console.error("alarm handler failed:", err));
    return;
  }

  // "warn": a few seconds before the reload – wake up and start the badge countdown.
  readState()
    .then((s) => {
      const t = s.timers[tabId];
      if (t && t.status === STATUS_ACTIVE) runCountdown(tabId, t.nextReloadAt);
    })
    .catch((err) => console.error("countdown wake-up failed:", err));
});

/* ------------------------------------------------------------------ */
/* Tab events                                                          */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  mutate(async (s) => {
    if (s.timers[tabId]) await removeTimer(s, tabId);
  }).catch((err) => console.error("onRemoved failed:", err));
});

// A tab can be swapped for another (e.g. prerender activation), changing its ID.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  mutate(async (s) => {
    const t = s.timers[removedTabId];
    if (!t) return;
    delete s.timers[removedTabId];
    await clearAlarm(removedTabId);
    t.tabId = addedTabId;
    s.timers[addedTabId] = t;
    if (t.status === STATUS_ACTIVE) await armTimer(t);
  }).catch((err) => console.error("onReplaced failed:", err));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.status) return;
  try {
    const s = await readState();

    // Tab-specific badge text can be reset by navigation; re-apply it.
    await setBadge(tabId, s.timers[tabId]);

    if (changeInfo.status !== "complete" || !tab.url) return;

    // Skip the write path entirely for tabs no rule or timer cares about.
    const relevant = s.timers[tabId] || s.rules.some((r) => r.status === STATUS_ACTIVE);
    if (!relevant) return;

    await mutate((st) => applyRulesToTab(st, tab));
  } catch (err) {
    console.error("onUpdated failed:", err);
  }
});

/* ------------------------------------------------------------------ */
/* Message handlers                                                    */
/* ------------------------------------------------------------------ */

const handlers = {
  GET_STATE: async () => {
    const s = await readState();
    return { timers: s.timers, rules: s.rules, settings: s.settings };
  },

  // Manual timer for a tab (replaces any existing timer on that tab).
  START_TIMER: ({ tabId, intervalSeconds }) =>
    mutate(async (s) => {
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return { ok: false, error: "Tab not found." };
      }
      const timer = makeTimer(tab, { intervalSeconds: clampInterval(intervalSeconds) });
      s.timers[tab.id] = timer;
      await armTimer(timer);
      return { ok: true };
    }),

  STOP_TIMER: ({ tabId }) =>
    mutate(async (s) => {
      if (!s.timers[tabId]) return { ok: false };
      await removeTimer(s, tabId);
      return { ok: true };
    }),

  PAUSE_TIMER: ({ tabId }) =>
    mutate(async (s) => {
      const t = s.timers[tabId];
      if (!t || t.status !== STATUS_ACTIVE) return { ok: false };
      await pauseTimer(t);
      return { ok: true };
    }),

  RESUME_TIMER: ({ tabId }) =>
    mutate(async (s) => {
      const t = s.timers[tabId];
      if (!t || t.status !== STATUS_PAUSED) return { ok: false };
      await resumeTimer(t);
      return { ok: true };
    }),

  PAUSE_ALL: () =>
    mutate(async (s) => {
      for (const t of Object.values(s.timers)) await pauseTimer(t);
      return { ok: true };
    }),

  // Note: a stopped auto timer re-attaches the next time the page loads.
  // To switch automation off for good, pause or delete the rule.
  STOP_ALL: () =>
    mutate(async (s) => {
      for (const key of Object.keys(s.timers)) await removeTimer(s, key);
      return { ok: true };
    }),

  UPDATE_SETTINGS: ({ settings }) =>
    mutate(async (s) => {
      if (!settings || typeof settings !== "object") return { ok: false };
      if (THEMES.includes(settings.theme)) s.settings.theme = settings.theme;
      for (const key of ["developerMode", "bypassCache", "skipFocusedTab"]) {
        if (typeof settings[key] === "boolean") s.settings[key] = settings[key];
      }
      return { ok: true };
    }),

  // Create or update a rule and bring live timers in line with it.
  UPDATE_RULE: ({ rule: incoming }) =>
    mutate(async (s) => {
      const idx = s.rules.findIndex((r) => r.id === incoming?.id);
      const prev = idx >= 0 ? s.rules[idx] : null;

      const result = sanitizeRule({ ...prev, ...incoming });
      if (result.error) return { ok: false, error: result.error };
      const rule = result.rule;

      if (prev) s.rules[idx] = rule;
      else s.rules.push(rule);

      const live = timersForRule(s, rule.id);

      if (rule.status === STATUS_PAUSED) {
        for (const t of live) await pauseTimer(t);
      } else {
        if (prev && prev.status === STATUS_PAUSED) {
          for (const t of live) await resumeTimer(t);
        }
        if (prev && prev.intervalSeconds !== rule.intervalSeconds) {
          for (const t of live) {
            t.intervalSeconds = rule.intervalSeconds;
            if (t.status === STATUS_ACTIVE) {
              t.nextReloadAt = nowSec() + rule.intervalSeconds;
              await armTimer(t);
            } else {
              t.remainingSeconds = null;
            }
          }
        }
      }

      // Attach to already-open matching tabs, detach from ones that no longer match.
      await applyRulesToOpenTabs(s);
      return { ok: true };
    }),

  DELETE_RULE: ({ ruleId }) =>
    mutate(async (s) => {
      if (!s.rules.some((r) => r.id === ruleId)) return { ok: false };
      for (const t of timersForRule(s, ruleId)) await removeTimer(s, t.tabId);
      s.rules = s.rules.filter((r) => r.id !== ruleId);
      return { ok: true };
    }),

  OPEN_AUTO_TAB: ({ ruleId }) =>
    mutate(async (s) => {
      const rule = s.rules.find((r) => r.id === ruleId);
      if (!rule || !rule.url) return { ok: false };

      const tab = await chrome.tabs.create({ url: rule.url });
      if (rule.status === STATUS_ACTIVE) {
        const timer = makeTimer(tab, {
          intervalSeconds: rule.intervalSeconds,
          isAuto: true,
          ruleId: rule.id,
        });
        if (!tab.title) timer.title = rule.title || "Untitled";
        timer.faviconUrl = timer.faviconUrl || rule.faviconUrl || "";
        s.timers[tab.id] = timer;
        await armTimer(timer);
      }
      return { ok: true };
    }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof msg.type !== "string" || !Object.hasOwn(handlers, msg.type)) return false;

  Promise.resolve()
    .then(() => handlers[msg.type](msg.payload || {}))
    .then(sendResponse)
    .catch((err) => {
      console.error(`Handler ${msg.type} failed:`, err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });

  return true; // keep the channel open for the async response
});
