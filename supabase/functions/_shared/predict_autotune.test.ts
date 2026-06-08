// Unit tests for the proactive-prediction + autotune pure helpers.
// Run: node --test supabase/functions/_shared/predict_autotune.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectGlucose, predictiveAdvice } from "./doseGuard.ts";
import { suggestRatios } from "./autotune.ts";

const NOW = 1_700_000_000_000;
const min = (m: number) => NOW + m * 60_000;

test("projectGlucose: rising series projects upward with positive slope", () => {
  const r = [{ ts: min(-20), value: 120 }, { ts: min(0), value: 160 }];
  const p = projectGlucose(r, NOW, 30);
  assert.ok(p.slopePerMin > 0);
  assert.ok((p.projectedMgdl ?? 0) > 160);
  assert.equal(p.current, 160);
});

test("projectGlucose: single point -> no slope, projected = current", () => {
  const p = projectGlucose([{ ts: min(0), value: 100 }], NOW, 30);
  assert.equal(p.slopePerMin, 0);
  assert.equal(p.projectedMgdl, 100);
});

test("predictiveAdvice: falling toward a hypo -> watch_fall (NEVER pre-emptive 'eat sugar')", () => {
  // low_soon is gone: resugar happens ONLY below 70 (the dose guard). Falling = "keep sugar nearby".
  const r = [{ ts: min(-20), value: 96 }, { ts: min(0), value: 78 }];
  const p = predictiveAdvice(r, NOW, 30);
  assert.equal(p.kind, "watch_fall");
});

test("predictiveAdvice: falling but still mid-range (120->110) -> NONE (the user's fix)", () => {
  // In-range drift must stay silent: "falling, keep sugar nearby" only fires below 90.
  const r = [{ ts: min(-20), value: 120 }, { ts: min(0), value: 110 }];
  assert.equal(predictiveAdvice(r, NOW, 30).kind, "none");
});

test("predictiveAdvice: falling into the 80s -> watch_fall (below 90)", () => {
  const r = [{ ts: min(-20), value: 100 }, { ts: min(0), value: 85 }];
  assert.equal(predictiveAdvice(r, NOW, 30).kind, "watch_fall");
});

test("predictiveAdvice: rising above 160 toward 180 -> high_soon", () => {
  const r = [{ ts: min(-20), value: 150 }, { ts: min(0), value: 170 }]; // slope +1/min, cur 170 > 160
  assert.equal(predictiveAdvice(r, NOW, 30).kind, "high_soon");
});

test("predictiveAdvice: rising but still under 160 -> NONE (the user's fix)", () => {
  // A rise only warrants a heads-up above 160; 150 is still well in range.
  const r = [{ ts: min(-20), value: 130 }, { ts: min(0), value: 150 }];
  assert.equal(predictiveAdvice(r, NOW, 30).kind, "none");
});

test("predictiveAdvice: rising above 160 but not hitting 180 soon -> watch_rise", () => {
  const r = [{ ts: min(-20), value: 157 }, { ts: min(0), value: 165 }]; // slope +0.4/min, cur 165
  assert.equal(predictiveAdvice(r, NOW, 30).kind, "watch_rise");
});

test("predictiveAdvice: flat in-range -> none", () => {
  const r = [{ ts: min(-20), value: 120 }, { ts: min(0), value: 121 }];
  const p = predictiveAdvice(r, NOW, 30);
  assert.equal(p.kind, "none");
});

test("suggestRatios: profile TDD only -> 500/1800 rule, profile_tdd reason", () => {
  const out = suggestRatios({
    insulin: [],
    readings: [],
    profile: { carbRatio: null, correctionFactor: null, rapidUnitsPerDay: 20, basalUnitsPerDay: 20 },
    nowMs: NOW,
  });
  assert.equal(out.reason, "profile_tdd");
  assert.equal(out.tdd, 40);
  assert.equal(out.suggestedCarbRatio, Math.round(500 / 40)); // ~13 (no current to clamp against)
  assert.equal(out.suggestedCorrectionFactor, Math.round(1800 / 40)); // ~45
});

test("suggestRatios: measured TDD from logged doses, clamped vs current ±25%", () => {
  const doses = Array.from({ length: 12 }, (_, i) => ({ ts: min(-i * 240), units: 4, kind: "rapid" }));
  const out = suggestRatios({
    insulin: doses,
    readings: [{ ts: min(0), value: 200 }, { ts: min(-60), value: 60 }],
    profile: { carbRatio: 10, correctionFactor: 50, basalUnitsPerDay: 10 },
    nowMs: NOW,
  });
  assert.equal(out.reason, "measured_tdd");
  assert.ok(out.tdd && out.tdd > 0);
  // clamp keeps it within ±25% of current 10 / 50
  assert.ok(out.suggestedCarbRatio! >= 8 && out.suggestedCarbRatio! <= 13);
  assert.ok(out.suggestedCorrectionFactor! >= 38 && out.suggestedCorrectionFactor! <= 63);
  assert.ok(["low", "medium", "high"].includes(out.confidence!));
});

test("suggestRatios: no data -> insufficient_data", () => {
  const out = suggestRatios({ insulin: [], readings: [], profile: null, nowMs: NOW });
  assert.equal(out.reason, "insufficient_data");
  assert.equal(out.suggestedCarbRatio, null);
});

test("suggestRatios: sparse logging (4 doses, <2 days) leans on profile TDD, no inflated ratio", () => {
  // 4 rapid doses over ~4.5h — far from a full day. Trusting them would undercount the TDD and
  // push the ratio too HIGH (the 14 -> 18 bug). We must anchor on the profile's stated daily insulin.
  const doses = Array.from({ length: 4 }, (_, i) => ({ ts: min(-i * 90), units: 4, kind: "rapid" }));
  const out = suggestRatios({
    insulin: doses,
    readings: [{ ts: min(0), value: 120 }],
    profile: { carbRatio: 14, correctionFactor: 51, rapidUnitsPerDay: 20, basalUnitsPerDay: 15 },
    nowMs: NOW,
  });
  assert.equal(out.reason, "profile_tdd");      // NOT measured_tdd
  assert.equal(out.tdd, 35);                      // 20 + 15, not the undercounted ~16
  assert.equal(out.confidence, "low");
  assert.equal(out.suggestedCarbRatio, 14);       // 500/35 ≈ 14 -> equals current
  assert.equal(out.same, true);                   // no spurious "change"
});

test("suggestRatios: enough logged doses (>=8 over >=2 days) DO drive a measured suggestion", () => {
  // 10 rapid doses of 5u spread over ~3 days -> measured TDD trusted.
  const doses = Array.from({ length: 10 }, (_, i) => ({ ts: min(-i * 420), units: 5, kind: "rapid" }));
  const out = suggestRatios({
    insulin: doses,
    readings: [{ ts: min(0), value: 200 }],
    profile: { carbRatio: 14, correctionFactor: 51, rapidUnitsPerDay: 20, basalUnitsPerDay: 15 },
    nowMs: NOW,
  });
  assert.equal(out.reason, "measured_tdd");
  assert.equal(out.confidence, "medium");
});
