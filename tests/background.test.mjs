import { test } from "node:test";
import assert from "node:assert/strict";
import { load, sleep } from "./harness.mjs";

test("interval below minimum is clamped to 30s; alarm created", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 5 });
  const s = await h.state();
  assert.strictEqual(s.timers[1].intervalSeconds, 30);
  assert.ok(h.alarms.has("reload-1"));
});

test("alarm reloads tab, reschedules, honours bypassCache", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("UPDATE_SETTINGS", { settings: { bypassCache: true } });
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  const before = (await h.state()).timers[1].nextReloadAt;
  await sleep(20);
  await h.fireAlarm(1); await sleep(30);
  assert.strictEqual(h.reloads.length, 1);
  assert.strictEqual(h.reloads[0].props.bypassCache, true);
  const after = (await h.state()).timers[1].nextReloadAt;
  assert.ok(after > before);
  assert.ok(h.alarms.has("reload-1"));
});

test("the page-load event caused by our own reload does NOT reset the timer", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("UPDATE_SETTINGS", { settings: {} });
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "a.com", matchType: "contains", intervalSeconds: 60 } });
  const t0 = (await h.state()).timers[1].nextReloadAt;
  await sleep(30);
  await h.loaded(1);
  assert.strictEqual((await h.state()).timers[1].nextReloadAt, t0);
});

test("pause stores remaining; resume re-arms alarm; 0 remaining no longer restarts full interval", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 120 });
  await h.send("PAUSE_TIMER", { tabId: 1 });
  let s = await h.state();
  assert.strictEqual(s.timers[1].status, "paused");
  assert.ok(!h.alarms.has("reload-1"));
  // force remaining = 0
  h.store.timers[1].remainingSeconds = 0;
  await h.send("RESUME_TIMER", { tabId: 1 });
  s = await h.state();
  assert.strictEqual(s.timers[1].status, "active");
  const secs = s.timers[1].nextReloadAt - Date.now() / 1000;
  assert.ok(secs > 25 && secs <= 31, "expected ~30s, got " + secs);
  assert.ok(h.alarms.has("reload-1"));
});

test("per-tab badge: ON when active, II when paused, cleared when stopped", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  assert.strictEqual(h.badges.get(1).text, "ON");
  await h.send("PAUSE_TIMER", { tabId: 1 });
  assert.strictEqual(h.badges.get(1).text, "II");
  await h.send("STOP_TIMER", { tabId: 1 });
  assert.strictEqual(h.badges.get(1).text, "");
});

test("closing a tab removes its timer and alarm", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  h.tabs.delete(1);
  await h.chrome.tabs.onRemoved.fire(1);
  await sleep(30);
  assert.deepStrictEqual((await h.state()).timers, {});
  assert.ok(!h.alarms.has("reload-1"));
});

test("alarm for a vanished tab cleans up instead of throwing", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  h.tabs.delete(1);
  await h.fireAlarm(1); await sleep(30);
  assert.deepStrictEqual((await h.state()).timers, {});
});

test("tab replaced (ID change) carries the timer across", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  h.tabs.set(2, { ...h.tabs.get(1), id: 2 }); h.tabs.delete(1);
  await h.chrome.tabs.onReplaced.fire(2, 1); await sleep(30);
  const s = await h.state();
  assert.ok(s.timers[2] && !s.timers[1] && s.timers[2].tabId === 2);
  assert.ok(h.alarms.has("reload-2") && !h.alarms.has("reload-1"));
});

test("skipFocusedTab postpones reload when tab is active in focused window", async () => {
  const h = load(); h.addTab(1, "https://a.com/", { active: true });
  await h.send("UPDATE_SETTINGS", { settings: { skipFocusedTab: true } });
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  h.setFocused(true);
  await h.fireAlarm(1); await sleep(30);
  assert.strictEqual(h.reloads.length, 0);
  h.setFocused(false);
  await h.fireAlarm(1); await sleep(30);
  assert.strictEqual(h.reloads.length, 1);
});
test("badge text/colour by time left: ON blue until 5s, then 5..1 in red", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  const loading = () => h.chrome.tabs.onUpdated.fire(1, { status: "loading" }, { ...h.tabs.get(1) });
  h.setRemaining(1, 30);  await loading();
  assert.deepStrictEqual([h.badges.get(1).text, h.badges.get(1).color], ["ON", "#0078ff"]);
  h.setRemaining(1, 5.0); await loading();
  assert.deepStrictEqual([h.badges.get(1).text, h.badges.get(1).color], ["5", "#d93025"]);
  h.setRemaining(1, 3.2); await loading();
  assert.strictEqual(h.badges.get(1).text, "4");
  h.setRemaining(1, 0.4); await loading();
  assert.strictEqual(h.badges.get(1).text, "1");
  h.setRemaining(1, 5.6); await loading();
  assert.strictEqual(h.badges.get(1).text, "ON", "6th second is not yet part of the countdown");
});

test("long interval: a wake-up alarm is set ~6s before the reload; short interval: none needed", async () => {
  const h = load(); h.addTab(1, "https://a.com/"); h.addTab(2, "https://b.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 120 });
  await h.send("START_TIMER", { tabId: 2, intervalSeconds: 30 });
  const s = await h.state();
  const warn = h.alarms.get("warn-1");
  assert.ok(warn, "expected warn-1 alarm");
  assert.ok(Math.abs(warn.when - (s.timers[1].nextReloadAt - 6) * 1000) < 5, "wake-up should be at nextReloadAt - 6s");
  assert.ok(!h.alarms.has("warn-2"), "30s interval can't use a wake-up alarm; it counts down from the worker");
});

test("pause / stop / rule changes remove the wake-up alarm", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 120 });
  assert.ok(h.alarms.has("warn-1"));
  await h.send("PAUSE_TIMER", { tabId: 1 });
  assert.ok(!h.alarms.has("warn-1") && !h.alarms.has("reload-1"));
  await h.send("RESUME_TIMER", { tabId: 1 });
  assert.ok(h.alarms.has("warn-1"));
  await h.send("STOP_TIMER", { tabId: 1 });
  assert.ok(!h.alarms.has("warn-1"));
});

test("a late reload alarm after the countdown already reloaded does NOT reload twice", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  h.setRemaining(1, 0.3);
  await h.fireWarn(1);
  await sleep(700);
  assert.strictEqual(h.reloads.length, 1);
  await h.chrome.alarms.onAlarm.fire({ name: "reload-1" });   // stale alarm arrives late (not made due)
  await sleep(50);
  assert.strictEqual(h.reloads.length, 1);
});

test("20 concurrent starts on different tabs all persist (no lost updates)", async () => {
  const h = load();
  for (let i = 1; i <= 20; i++) h.addTab(i, "https://a.com/" + i);
  await Promise.all(Array.from({ length: 20 }, (_, i) => h.send("START_TIMER", { tabId: i + 1, intervalSeconds: 60 })));
  const s = await h.state();
  assert.strictEqual(Object.keys(s.timers).length, 20);
  assert.strictEqual([...h.alarms.keys()].filter(k => k.startsWith("reload-")).length, 20);
});

test("simultaneous alarms for several tabs all reschedule", async () => {
  const h = load();
  for (let i = 1; i <= 8; i++) { h.addTab(i, "https://a.com/" + i); }
  await Promise.all([...Array(8)].map((_, i) => h.send("START_TIMER", { tabId: i + 1, intervalSeconds: 60 })));
  await sleep(20);
  const before = (await h.state()).timers;
  await Promise.all([...Array(8)].map((_, i) => h.fireAlarm(i + 1)));
  await sleep(100);
  const after = (await h.state()).timers;
  assert.strictEqual(h.reloads.length, 8);
  for (let i = 1; i <= 8; i++) assert.ok(after[i].nextReloadAt > before[i].nextReloadAt, "tab " + i);
});
test("new rule attaches to already-open matching tabs immediately", async () => {
  const h = load(); h.addTab(1, "https://example.com/x"); h.addTab(2, "https://other.org/");
  const r = await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  assert.ok(r.ok, r.error);
  const s = await h.state();
  assert.ok(s.timers[1] && s.timers[1].isAuto && s.timers[1].ruleId === "r1");
  assert.ok(!s.timers[2]);
});

test("paused timer on a matching tab is NOT revived by a page load", async () => {
  const h = load(); h.addTab(1, "https://example.com/");
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  await h.send("PAUSE_TIMER", { tabId: 1 });
  await h.loaded(1); await sleep(30);
  assert.strictEqual((await h.state()).timers[1].status, "paused");
});

test("manual timer on a matching tab is not replaced by an auto timer", async () => {
  const h = load(); h.addTab(1, "https://example.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 90 });
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  await h.loaded(1); await sleep(30);
  const t = (await h.state()).timers[1];
  assert.strictEqual(t.isAuto, false); assert.strictEqual(t.intervalSeconds, 90);
});

test("pausing a rule pauses its live timers; activating resumes them", async () => {
  const h = load(); h.addTab(1, "https://example.com/");
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  await h.send("UPDATE_RULE", { rule: { id: "r1", status: "paused" } });
  let s = await h.state();
  assert.strictEqual(s.rules[0].status, "paused"); assert.strictEqual(s.timers[1].status, "paused");
  assert.ok(!h.alarms.has("reload-1"));
  await h.loaded(1); await sleep(30);
  assert.strictEqual((await h.state()).timers[1].status, "paused", "page load must not revive it");
  await h.send("UPDATE_RULE", { rule: { id: "r1", status: "active" } });
  s = await h.state();
  assert.strictEqual(s.timers[1].status, "active"); assert.ok(h.alarms.has("reload-1"));
});

test("changing a rule's interval updates live timers and alarms", async () => {
  const h = load(); h.addTab(1, "https://example.com/");
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  await h.send("UPDATE_RULE", { rule: { id: "r1", intervalSeconds: 300 } });
  const t = (await h.state()).timers[1];
  assert.strictEqual(t.intervalSeconds, 300);
  assert.ok(t.nextReloadAt - Date.now() / 1000 > 290);
});

test("deleting a rule removes its timers and alarms", async () => {
  const h = load(); h.addTab(1, "https://example.com/");
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  const r = await h.send("DELETE_RULE", { ruleId: "r1" });
  assert.ok(r.ok);
  const s = await h.state();
  assert.deepStrictEqual(s.rules, []); assert.deepStrictEqual(s.timers, {}); assert.strictEqual(h.alarms.size, 0);
});

test("auto timer detaches when the tab navigates away from the rule's URLs", async () => {
  const h = load(); h.addTab(1, "https://example.com/");
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  h.tabs.get(1).url = "https://elsewhere.org/"; await h.loaded(1); await sleep(30);
  assert.deepStrictEqual((await h.state()).timers, {});
});

test("match types: contains is case-insensitive and literal; glob anchors; regex works", async () => {
  const h = load(); h.addTab(1, "https://exampleXcom/"); h.addTab(2, "https://Example.com/Page");
  h.addTab(3, "https://site.io/a/1"); h.addTab(4, "https://site.io/b/1"); h.addTab(5, "https://r.net/item/42"); h.addTab(6, "https://r.net/item/abc");
  await h.send("UPDATE_RULE", { rule: { id: "c", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  await h.send("UPDATE_RULE", { rule: { id: "g", pattern: "https://site.io/a/*", matchType: "glob", intervalSeconds: 60 } });
  await h.send("UPDATE_RULE", { rule: { id: "x", pattern: "item/\\d+$", matchType: "regex", intervalSeconds: 60 } });
  const t = (await h.state()).timers;
  assert.ok(!t[1], "dot must be literal in contains mode");
  assert.ok(t[2] && t[3] && !t[4] && t[5] && !t[6]);
});

test("validation: bad regex, non-http URL, URL not matching pattern, empty pattern", async () => {
  const h = load();
  const base = { id: "r", matchType: "regex", intervalSeconds: 60 };
  assert.ok(!(await h.send("UPDATE_RULE", { rule: { ...base, pattern: "(" } })).ok);
  assert.ok(!(await h.send("UPDATE_RULE", { rule: { ...base, matchType: "contains", pattern: "a.com", url: "javascript:alert(1)" } })).ok);
  assert.ok(!(await h.send("UPDATE_RULE", { rule: { ...base, matchType: "contains", pattern: "a.com", url: "https://b.com/" } })).ok);
  assert.ok(!(await h.send("UPDATE_RULE", { rule: { ...base, pattern: "  " } })).ok);
  assert.strictEqual((await h.state()).rules.length, 0);
});

test("OPEN_AUTO_TAB opens the URL and starts an auto timer", async () => {
  const h = load();
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60, url: "https://example.com/dash" } });
  const r = await h.send("OPEN_AUTO_TAB", { ruleId: "r1" });
  assert.ok(r.ok);
  const t = Object.values((await h.state()).timers)[0];
  assert.ok(t && t.isAuto && t.ruleId === "r1");
});
test("onInstalled (update) does NOT wipe existing timers, rules or settings", async () => {
  const h = load(); h.addTab(1, "https://example.com/");
  await h.send("UPDATE_RULE", { rule: { id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60 } });
  await h.send("UPDATE_SETTINGS", { settings: { theme: "dark" } });
  await h.chrome.runtime.onInstalled.fire({ reason: "update" }); await sleep(60);
  const s = await h.state();
  assert.strictEqual(s.rules.length, 1); assert.strictEqual(s.settings.theme, "dark"); assert.ok(s.timers[1]);
});

test("after update, missing alarms are rebuilt and dead tabs dropped; legacy 'not-open' entries purged", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  h.store.timers = {
    1: { tabId: 1, status: "active", intervalSeconds: 60, nextReloadAt: Date.now()/1000 + 30, isAuto: false },
    99: { tabId: 99, status: "active", intervalSeconds: 60, nextReloadAt: Date.now()/1000 + 30, isAuto: false },
    "rule-1": { tabId: null, status: "not-open", isAuto: true, ruleId: "rule-1" }
  };
  await h.chrome.runtime.onInstalled.fire({ reason: "update" }); await sleep(60);
  const s = await h.state();
  assert.deepStrictEqual(Object.keys(s.timers), ["1"]);
  assert.ok(h.alarms.has("reload-1") && !h.alarms.has("reload-99"));
});

test("browser startup discards stale tab IDs and re-attaches rules to open tabs", async () => {
  const h = load(); h.addTab(7, "https://example.com/");
  h.store.autoRules = [{ id: "r1", pattern: "example.com", matchType: "contains", intervalSeconds: 60, status: "active" }];
  h.store.timers = { 3: { tabId: 3, status: "active", intervalSeconds: 60, nextReloadAt: Date.now()/1000 + 30, isAuto: false } };
  await h.chrome.runtime.onStartup.fire(); await sleep(60);
  const s = await h.state();
  assert.deepStrictEqual(Object.keys(s.timers), ["7"]);
  assert.ok(s.timers[7].isAuto);
});

test("STOP_ALL clears every timer and alarm; PAUSE_ALL pauses them", async () => {
  const h = load(); h.addTab(1, "https://a.com/"); h.addTab(2, "https://b.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 }); await h.send("START_TIMER", { tabId: 2, intervalSeconds: 60 });
  await h.send("PAUSE_ALL");
  let s = await h.state(); assert.ok(Object.values(s.timers).every(t => t.status === "paused")); assert.strictEqual(h.alarms.size, 0);
  await h.send("STOP_ALL"); s = await h.state(); assert.deepStrictEqual(s.timers, {});
});

test("settings update is whitelisted (junk keys / bad theme ignored)", async () => {
  const h = load();
  await h.send("UPDATE_SETTINGS", { settings: { theme: "<script>", evil: true, developerMode: true } });
  const s = (await h.state()).settings;
  assert.strictEqual(s.theme, "default"); assert.strictEqual(s.developerMode, true); assert.ok(!("evil" in s));
});

test("messages from another sender are ignored", async () => {
  const h = load();
  const res = await Promise.race([
    new Promise(r => { const ret = h.chrome.runtime.onMessage.listeners[0]({ type: "STOP_ALL" }, { id: "someone-else" }, r); if (ret === false) r("ignored"); }),
    new Promise(r => setTimeout(() => r("timeout"), 50))
  ]);
  assert.strictEqual(res, "ignored");
});

