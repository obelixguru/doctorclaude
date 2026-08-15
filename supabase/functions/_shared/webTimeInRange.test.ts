// The time-in-range figure the family reads exists twice: `tirSplit` in the phone's
// ui/HistoryScreen.kt:410, and `timeInRange` in web/js/zones.js for the iPhone client. Kotlin cannot
// be imported here, so the Kotlin original stays prose-checked and the WEB port — the one that
// drifted — is pinned down by these cases.
//
// It drifted twice at once, and both faults pushed the number the same way: down. The web copy
// counted READINGS instead of weighting by time, and it called anything above 170 "haut" when the
// app rings at 180. A parent reading "66 % dans la cible" on the iPhone and a different figure on
// the phone for the same child is the failure this file exists to prevent.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore — the web client is plain JS on purpose (no build step, so it can be hosted anywhere).
import { timeInRange } from "../../../web/js/zones.js";

/** Readings every `stepMin` minutes, in order, starting at an arbitrary fixed epoch. */
function series(values: number[], stepMin = 5) {
  const t0 = 1_700_000_000_000;
  return values.map((value, i) => ({ ts: t0 + i * stepMin * 60_000, value }));
}

test("a flat in-range window is 100% in range", () => {
  assert.deepEqual(timeInRange(series([120, 120, 120, 120])), { low: 0, inRange: 100, high: 0 });
});

test("the amber high band (171-180) counts as IN range, not high", () => {
  // The exact regression the family hit: every reading in this band was charged against them.
  assert.deepEqual(timeInRange(series([175, 175, 175, 175])), { low: 0, inRange: 100, high: 0 });
});

test("boundaries match what the app rings for: out is < 70 and > 180", () => {
  assert.deepEqual(timeInRange(series([70, 70])), { low: 0, inRange: 100, high: 0 });
  assert.deepEqual(timeInRange(series([69, 69])), { low: 100, inRange: 0, high: 0 });
  assert.deepEqual(timeInRange(series([180, 180])), { low: 0, inRange: 100, high: 0 });
  assert.deepEqual(timeInRange(series([181, 181])), { low: 0, inRange: 0, high: 100 });
});

test("weighted by TIME, not by number of readings", () => {
  // Three highs five minutes apart (15 min of high), then two hours in range covered by three
  // readings thirty minutes apart (60 min of in-range weight).
  const t0 = 1_700_000_000_000;
  const min = (m: number) => t0 + m * 60_000;
  const r = timeInRange([
    { ts: min(0), value: 250 },
    { ts: min(5), value: 250 },
    { ts: min(10), value: 250 },
    { ts: min(15), value: 120 },
    { ts: min(45), value: 120 },
    { ts: min(75), value: 120 },
  ]);
  // Counting readings would call this 50% high (3 of 6). By time it is 15 of 75 minutes.
  assert.deepEqual(r, { low: 0, inRange: 80, high: 20 });
});

test("a long gap is capped at 30 minutes so it cannot swallow the window", () => {
  const t0 = 1_700_000_000_000;
  const min = (m: number) => t0 + m * 60_000;
  const r = timeInRange([
    { ts: min(0), value: 250 },   // sensor drops out for ten hours
    { ts: min(600), value: 120 },
    { ts: min(605), value: 120 },
  ]);
  // Uncapped, the single high reading would hold for 600 of 605 minutes and report 99% high.
  assert.deepEqual(r, { low: 0, inRange: 14, high: 86 });
});

test("readings arriving out of order are sorted first", () => {
  const ordered = timeInRange(series([250, 250, 120, 120]));
  const shuffled = timeInRange([...series([250, 250, 120, 120])].reverse());
  assert.deepEqual(shuffled, ordered);
});

test("too little data reports zeros rather than a fabricated percentage", () => {
  assert.deepEqual(timeInRange([]), { low: 0, inRange: 0, high: 0 });
  assert.deepEqual(timeInRange(series([120])), { low: 0, inRange: 0, high: 0 });
  assert.deepEqual(timeInRange(null), { low: 0, inRange: 0, high: 0 });
});

test("junk rows are dropped instead of poisoning the total", () => {
  const good = timeInRange(series([120, 120, 120]));
  const withJunk = timeInRange([
    ...series([120, 120, 120]),
    { ts: NaN, value: 120 },
    { ts: 1_700_000_000_000, value: null as unknown as number },
  ]);
  assert.deepEqual(withJunk, good);
});
