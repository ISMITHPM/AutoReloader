import { test } from "node:test";
import assert from "node:assert/strict";
import { load, sleep } from "../harness.mjs";

test("REAL TIME: warn alarm -> 5,4,3,2,1 in red -> reload at 0 -> back to blue ON (~7s)", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  h.setRemaining(1, 6.5);
  h.badgeLog.length = 0;
  await h.fireWarn(1);
  await sleep(7600);
  const texts = h.badgeLog.filter(e => e.tabId === 1).map(e => e.text);
  const dedup = texts.filter((x, i) => x !== texts[i - 1]);
  assert.deepStrictEqual(dedup.slice(0, 6), ["5", "4", "3", "2", "1", "ON"], "badge sequence was " + JSON.stringify(dedup));
  for (const e of h.badgeLog) {
    if (/^[1-5]$/.test(e.text)) assert.strictEqual(e.color, "#d93025", `digit ${e.text} not red`);
    if (e.text === "ON") assert.strictEqual(e.color, "#0078ff");
  }
  // each number was on screen for about a second
  const first = h.badgeLog.find(e => e.text === "5"), last = h.badgeLog.find(e => e.text === "1");
  const span = (last.at - first.at) / 1000;
  assert.ok(span > 3.5 && span < 4.5, "5->1 should take ~4s, took " + span);
  assert.strictEqual(h.reloads.length, 1, "exactly one reload (no double fire from alarm + countdown)");
  assert.ok((await h.state()).timers[1].nextReloadAt - Date.now() / 1000 > 50, "next cycle scheduled");
  assert.ok(h.alarms.has("warn-1"), "next cycle's wake-up alarm armed");
});

test("REAL TIME: pausing mid-countdown stops it: no more digits, no reload, badge shows II (~8s)", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 60 });
  h.setRemaining(1, 6.5);
  await h.fireWarn(1);
  await sleep(2300);   // showing 4 by now
  assert.ok(/^[1-5]$/.test(h.badges.get(1).text), "countdown should be visible, got " + h.badges.get(1).text);
  await h.send("PAUSE_TIMER", { tabId: 1 });
  const mark = h.badgeLog.length;
  await sleep(5000);
  assert.strictEqual(h.reloads.length, 0);
  assert.strictEqual(h.badges.get(1).text, "II");
  assert.ok(h.badgeLog.slice(mark).every(e => !/^[1-5]$/.test(e.text)), "no digits after pause");
});

test("REAL TIME: short (30s) interval: after a reload the worker counts down on its own, no alarm needed (~30s)", async () => {
  const h = load(); h.addTab(1, "https://a.com/");
  await h.send("START_TIMER", { tabId: 1, intervalSeconds: 30 });
  // Pretend the cycle is nearly over; the in-worker chain started by START_TIMER is superseded
  // by re-arming via a due reload, exactly like a real cycle boundary.
  await h.fireAlarm(1);
  await sleep(50);
  assert.strictEqual(h.reloads.length, 1);
  h.badgeLog.length = 0;
  await sleep(29600);   // just short of the end of the 30s cycle
  const texts = h.badgeLog.filter(e => e.tabId === 1).map(e => e.text).filter((x, i, a) => x !== a[i - 1]);
  assert.deepStrictEqual(texts.slice(0, 6), ["ON", "5", "4", "3", "2", "1"], "sequence was " + JSON.stringify(texts));
  assert.strictEqual(h.reloads.length, 1, "the next reload hasn't happened yet");
});
