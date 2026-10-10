// A minimal in-memory mock of the chrome.* APIs used by background.js.
// It loads the REAL service worker source into a sandbox, so the tests exercise the
// actual extension logic without needing a browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const BACKGROUND_PATH = fileURLToPath(new URL("../background.js", import.meta.url));

function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    fire: (...args) => Promise.all(listeners.map((listener) => listener(...args))),
    listeners,
  };
}

// Responses cross the vm boundary; normalise them so deep-equality assertions work.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function makeChrome() {
  const store = {};
  const alarms = new Map();
  const tabs = new Map();
  const reloads = [];
  const badges = new Map();
  const badgeLog = [];
  let nextTabId = 100;
  let windowFocused = false;

  const chrome = {
    runtime: {
      id: "test-ext",
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onMessage: makeEvent(),
    },
    storage: {
      local: {
        async get(keys) {
          await Promise.resolve();
          const out = {};
          for (const key of [].concat(keys)) {
            if (key in store) out[key] = JSON.parse(JSON.stringify(store[key]));
          }
          return out;
        },
        async set(obj) {
          // A small random delay makes any lost-update race show up reliably.
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
          for (const [key, value] of Object.entries(obj)) {
            store[key] = JSON.parse(JSON.stringify(value));
          }
        },
      },
    },
    alarms: {
      async create(name, info) {
        alarms.set(name, info);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      async clearAll() {
        alarms.clear();
      },
      onAlarm: makeEvent(),
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id ${id}`);
        return { ...tabs.get(id) };
      },
      async query() {
        return [...tabs.values()].map((tab) => ({ ...tab }));
      },
      async reload(id, props) {
        if (!tabs.has(id)) throw new Error("no tab");
        reloads.push({ id, props });
      },
      async create({ url }) {
        const tab = { id: nextTabId++, url, title: "", status: "loading", active: false, windowId: 1 };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      onRemoved: makeEvent(),
      onReplaced: makeEvent(),
      onUpdated: makeEvent(),
    },
    windows: {
      async get() {
        return { focused: windowFocused };
      },
    },
    action: {
      async setBadgeText({ tabId, text }) {
        badges.set(tabId, { ...badges.get(tabId), text });
        badgeLog.push({ tabId, ...badges.get(tabId), at: Date.now() });
      },
      async setBadgeBackgroundColor({ tabId, color }) {
        badges.set(tabId, { ...badges.get(tabId), color });
      },
    },
  };

  return {
    chrome,
    store,
    alarms,
    tabs,
    reloads,
    badges,
    badgeLog,
    setFocused: (value) => {
      windowFocused = value;
    },
  };
}

export function load() {
  const env = makeChrome();
  const code = readFileSync(BACKGROUND_PATH, "utf8");

  const sandbox = {
    chrome: env.chrome,
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Promise,
    Number,
    Set,
    Map,
    URL,
    RegExp,
    String,
    Error,
    // Timers started by the worker must not keep the test process alive.
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const send = (type, payload) =>
    new Promise((resolve) => {
      env.chrome.runtime.onMessage.listeners[0]({ type, payload }, { id: "test-ext" }, (res) =>
        resolve(plain(res))
      );
    });

  const addTab = (id, url, extra = {}) => {
    env.tabs.set(id, {
      id,
      url,
      title: `Tab ${id}`,
      status: "complete",
      active: false,
      windowId: 1,
      ...extra,
    });
  };

  // Simulate "the page finished loading".
  const loaded = (id) =>
    env.chrome.tabs.onUpdated.fire(id, { status: "complete" }, { ...env.tabs.get(id) });

  // Reload alarms only act on a timer that is due, so make it due first (like real time passing).
  const makeDue = (tabId) => {
    const timer = env.store.timers?.[tabId];
    if (timer && timer.status === "active") timer.nextReloadAt = Date.now() / 1000 - 0.1;
  };
  const fireAlarm = (tabId) => {
    makeDue(tabId);
    return env.chrome.alarms.onAlarm.fire({ name: `reload-${tabId}` });
  };
  const fireWarn = (tabId) => env.chrome.alarms.onAlarm.fire({ name: `warn-${tabId}` });
  const setRemaining = (tabId, seconds) => {
    env.store.timers[tabId].nextReloadAt = Date.now() / 1000 + seconds;
  };

  return {
    ...env,
    send,
    addTab,
    loaded,
    fireAlarm,
    fireWarn,
    setRemaining,
    state: () => send("GET_STATE"),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
