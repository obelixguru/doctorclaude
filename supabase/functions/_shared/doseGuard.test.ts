// Tests for the deterministic dose guard. Run with Node 24+ (native TS):
//   node --test supabase/functions/_shared/doseGuard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeGuard,
  trendFromReadings,
  recentHypoFrom,
  minutesSinceLastRescue,
  clampInsulin,
  mealBolusUnits,
  activeIob,
  insulinActionMinutes,
  combinedActionLine,
  stripInsulinNumbers,
  sugarTimingFact,
  hypoIobWarning,
  mealCarbSpeed,
  carbSpeedAdvice,
  starchyCarbNote,
} from "./doseGuard.ts";

const prof = { carbRatio: 12, correctionFactor: 50, targetMgdl: 110, weightKg: 38, rapidInsulin: "NovoRapid" };
const base = { staleMin: 2, iobUnits: 0, recentHypo: false, profile: prof };

test("131 mg/dL falling -> NO insulin (the historical bug)", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 131, trend: "falling" });
  assert.equal(g.kind, "none");
  assert.equal(g.maxInsulinUnits, 0);
});

test("237 rising after a hypo, no IOB -> CORRECTION (hyper=insulin; the user's call)", () => {
  // We no longer hard-block a high as a "post-hypo rebound": a high that is rising gets corrected.
  const g = computeGuard({ ...base, glucoseMgdl: 237, trend: "rising", recentHypo: true });
  assert.equal(g.kind, "correction");
  assert.equal(g.reason, "high_correction");
  assert.equal(g.insulinUnits, 2.5); // (237-110)/50 = 2.54 -> 2.5
});

test("237 rising after a hypo but 3 u IOB -> covered by IOB, NONE (no stacking)", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 237, trend: "rising", recentHypo: true, iobUnits: 3 });
  assert.equal(g.kind, "none");
  assert.equal(g.reason, "covered_by_iob"); // 2.54 - 3 < 0 -> nothing extra
});

test("237 falling after a hypo -> NONE (already coming down, don't pile on)", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 237, trend: "falling", recentHypo: true });
  assert.equal(g.kind, "none");
  assert.equal(g.reason, "falling");
});

test("stale data (>15 min) at 250 rising -> WAIT, no insulin", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 250, trend: "rising", staleMin: 22 });
  assert.equal(g.kind, "wait");
  assert.equal(g.reason, "stale_data");
  assert.equal(g.maxInsulinUnits, 0);
});

test("60 mg/dL -> SUGAR by weight (0.3 g/kg), no insulin", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 60, trend: "falling" });
  assert.equal(g.kind, "sugar");
  assert.equal(g.sugarGrams, 11); // round(0.3 * 38)
  assert.equal(g.sugarCubes, 3);  // ceil(11/4)
  assert.equal(g.maxInsulinUnits, 0);
});

test("66 mg/dL but sugar taken 8 min ago -> WAIT (sugar_recent), no MORE sugar", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 66, trend: "falling", minSinceRescue: 8 });
  assert.equal(g.kind, "wait");
  assert.equal(g.reason, "sugar_recent");
  assert.equal(g.sugarGrams, 0);
  assert.equal(g.maxInsulinUnits, 0);
});

test("66 mg/dL with sugar taken 20 min ago -> SUGAR again (window passed)", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 66, trend: "falling", minSinceRescue: 20 });
  assert.equal(g.kind, "sugar");
  assert.equal(g.reason, "hypo");
});

test("hypo with NO insulin on board -> plain 0.3 g/kg rescue, reason 'hypo'", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 60, trend: "falling", iobUnits: 0 });
  assert.equal(g.kind, "sugar");
  assert.equal(g.reason, "hypo");
  assert.equal(g.sugarGrams, 11); // round(0.3 * 38)
});

test("hypo with 3.8 u insulin still active -> BIGGER rescue + 'hypo_iob' (the 6.5u Fiasp case)", () => {
  // 38 kg, ICR 12: base 11.4 + 3.8*12*0.3=13.7 = 25.1, capped at 0.6*38=22.8 -> 23 g (≈6 sucres)
  const g = computeGuard({ ...base, glucoseMgdl: 60, trend: "falling", iobUnits: 3.8 });
  assert.equal(g.kind, "sugar");
  assert.equal(g.reason, "hypo_iob");
  assert.ok(g.sugarGrams >= 20, `expected a bumped rescue, got ${g.sugarGrams}`);
  assert.ok(g.sugarGrams <= 23, `capped near 0.6 g/kg, got ${g.sugarGrams}`);
  assert.ok(g.sugarCubes >= 5);
});

test("starchyCarbNote: explains starch≠sugar for potatoes/bread, empty for sweets/blank", () => {
  assert.match(starchyCarbNote("un peu de pommes de terre avec poulet", "fr"), /pas sucrés mais riches/i);
  assert.match(starchyCarbNote("pan con pollo", "es"), /no son dulces/i);
  assert.equal(starchyCarbNote("bonbons", "fr"), ""); // candy isn't a starchy staple
  assert.equal(starchyCarbNote("", "fr"), "");
});

test("hypoIobWarning: warns at >= 1 u active, silent below", () => {
  assert.match(hypoIobWarning(3.8, "fr"), /insuline rapide active/);
  assert.match(hypoIobWarning(3.8, "es"), /insulina rápida activa/);
  assert.equal(hypoIobWarning(0.4, "fr"), "");
  assert.equal(hypoIobWarning(0, "es"), "");
});

test("48 mg/dL (SEVERE) with sugar taken 5 min ago -> SUGAR, never 'wait' on a deep low", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 48, trend: "falling", minSinceRescue: 5 });
  assert.equal(g.kind, "sugar");
  assert.equal(g.reason, "hypo");
  assert.equal(g.maxInsulinUnits, 0);
});

test("sugarTimingFact: states ~15 min (rule of 15) and forbids invented durations", () => {
  for (const l of ["fr", "es"]) {
    assert.match(sugarTimingFact(l), /15 min/);
    assert.match(sugarTimingFact(l), /26 min/); // it explicitly names the bogus number to forbid it
  }
});

test("sugar_recent action line: tells to wait, never a meal bolus", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 66, trend: "falling", minSinceRescue: 5 });
  const fr = combinedActionLine(g, 2, "fr", prof); // even with a meal, don't bolus while low
  assert.match(fr, /déjà pris du sucre/);
  assert.doesNotMatch(fr, /\bu de\b/); // no "X u de NovoRapid"
});

test("minutesSinceLastRescue: most recent EATEN meal, planned ignored", () => {
  const now = 1_000_000_000_000;
  assert.equal(minutesSinceLastRescue([], now), null);
  assert.equal(minutesSinceLastRescue([{ ts: now - 8 * 60000, planned: false }], now), 8);
  assert.equal(minutesSinceLastRescue([{ ts: now - 3 * 60000, planned: true }], now), null); // future/planned doesn't count
  // picks the most recent eaten one
  assert.equal(minutesSinceLastRescue([
    { ts: now - 40 * 60000, planned: false },
    { ts: now - 6 * 60000, planned: false },
  ], now), 6);
});

test("150 mg/dL in range -> NONE", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 150, trend: "stable" });
  assert.equal(g.kind, "none");
  assert.equal(g.reason, "in_range");
});

test("250 stable, no IOB -> correction 3 u", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 250, trend: "stable" });
  assert.equal(g.kind, "correction");
  assert.equal(g.insulinUnits, 3); // (250-110)/50 = 2.8 -> 3.0
  assert.equal(g.maxInsulinUnits, 3);
});

test("250 stable, 2 u IOB -> correction reduced to 1 u", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 250, trend: "stable", iobUnits: 2 });
  assert.equal(g.kind, "correction");
  assert.equal(g.insulinUnits, 1); // 2.8 - 2 = 0.8 -> 1.0
});

test("200 stable, 3 u IOB -> covered by IOB, NONE", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 200, trend: "stable", iobUnits: 3 });
  assert.equal(g.kind, "none");
  assert.equal(g.reason, "covered_by_iob");
});

test("250 rising but no ratios -> NO_RATIOS, never invent units", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 250, trend: "rising", profile: { weightKg: 38 } });
  assert.equal(g.kind, "no_ratios");
  assert.equal(g.maxInsulinUnits, 0);
});

test("250 unknown trend -> WAIT (don't correct without a trend)", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 250, trend: "unknown" });
  assert.equal(g.kind, "wait");
  assert.equal(g.reason, "trend_unknown");
});

test("trendFromReadings: a 30 mg/dL drop in 15 min is falling_fast", () => {
  const now = 1_000_000_000_000;
  const t = trendFromReadings([{ ts: now - 15 * 60000, value: 180 }, { ts: now, value: 150 }], now);
  assert.equal(t, "falling_fast");
});

test("trendFromReadings: a slow drift reads stable", () => {
  const now = 1_000_000_000_000;
  const t = trendFromReadings([{ ts: now - 20 * 60000, value: 150 }, { ts: now, value: 155 }], now);
  assert.equal(t, "stable");
});

test("recentHypoFrom: a sub-70 reading in the last 75 min is detected", () => {
  const now = 1_000_000_000_000;
  assert.equal(recentHypoFrom([{ ts: now - 30 * 60000, value: 65 }], now), true);
  assert.equal(recentHypoFrom([{ ts: now - 30 * 60000, value: 90 }], now), false);
});

test("clampInsulin caps a model dose above the guard ceiling", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 250, trend: "stable" }); // ceiling 3
  assert.deepEqual(clampInsulin(8, g), { units: 3, overridden: true });
  assert.deepEqual(clampInsulin(2, g), { units: 2, overridden: false });
});

test("clampInsulin forces 0 when the guard forbids insulin", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 131, trend: "falling" }); // ceiling 0
  assert.deepEqual(clampInsulin(2, g), { units: 0, overridden: true });
});

test("mealBolusUnits = carbs / carb-ratio rounded to 0.5", () => {
  assert.equal(mealBolusUnits(36, prof), 3);   // 36/12
  assert.equal(mealBolusUnits(30, prof), 2.5); // 30/12 = 2.5
  assert.equal(mealBolusUnits(0, prof), 0);
  assert.equal(mealBolusUnits(36, { weightKg: 38 }), 0); // no carb ratio
});

test("activeIob: linear ~4h decay, basal ignored", () => {
  const now = 1_000_000_000_000;
  const doses = [
    { ts: now - 120 * 60000, units: 4, kind: "rapid" }, // half-elapsed -> 2 u
    { ts: now - 300 * 60000, units: 5, kind: "rapid" }, // expired -> 0
    { ts: now - 10 * 60000, units: 10, kind: "basal" }, // basal -> ignored
  ];
  assert.equal(activeIob(doses, now), 2);
});

test("insulinActionMinutes: Fiasp/rapid analogs = 4h, regular = 6h, inhaled = 3h, unknown = null", () => {
  assert.equal(insulinActionMinutes("Fiasp"), 240);
  assert.equal(insulinActionMinutes("NovoRapid"), 240);
  assert.equal(insulinActionMinutes("Humalog"), 240);
  assert.equal(insulinActionMinutes("Lyumjev"), 240);
  assert.equal(insulinActionMinutes("Actrapid"), 360);
  assert.equal(insulinActionMinutes("Humulin R"), 360);
  assert.equal(insulinActionMinutes("Afrezza"), 180);
  assert.equal(insulinActionMinutes("Lantus"), null); // basal name unknown to rapid map
  assert.equal(insulinActionMinutes(""), null);
  assert.equal(insulinActionMinutes(null), null);
});

test("activeIob: per-dose insulin type drives the decay window", () => {
  const now = 1_000_000_000_000;
  // 300 min elapsed: under 4h (Fiasp) the dose is fully expired (0); under 6h (regular) it's still
  // partly active (5 u * (1 - 300/360) = 5/6 ≈ 0.833).
  assert.equal(activeIob([{ ts: now - 300 * 60000, units: 5, kind: "rapid", name: "Fiasp" }], now), 0);
  assert.equal(
    Math.round(activeIob([{ ts: now - 300 * 60000, units: 5, kind: "rapid", name: "Actrapid" }], now) * 1000),
    833,
  );
  // No name → falls back to the passed default (here 6h), so the same dose stays partly active.
  assert.equal(
    Math.round(activeIob([{ ts: now - 300 * 60000, units: 5, kind: "rapid" }], now, 360) * 1000),
    833,
  );
});

test("combinedActionLine: meal + correction sum, with breakdown", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 250, trend: "stable" }); // correction 3
  const line = combinedActionLine(g, 3, "fr", prof); // meal 3 + corr 3 = 6
  assert.match(line, /6 u de NovoRapid maintenant/);
  assert.match(line, /3 u pour le repas \+ 3 u de correction/);
});

test("combinedActionLine: meal only when in range (no correction)", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 150, trend: "stable" }); // none
  assert.equal(combinedActionLine(g, 2.5, "fr", prof), "2,5 u de NovoRapid pour le repas.");
});

test("combinedActionLine: hypo dominates, sugar not bolus", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 60, trend: "falling" });
  const line = combinedActionLine(g, 3, "fr", prof); // meal ignored during a low
  assert.match(line, /sucre rapide/);
  assert.doesNotMatch(line, /u de NovoRapid/);
});

test("stripInsulinNumbers removes any sneaked insulin dose", () => {
  assert.doesNotMatch(stripInsulinNumbers("Prends 2 u maintenant"), /\d/);
  assert.doesNotMatch(stripInsulinNumbers("fais 1,5 unités de Fiasp"), /\d/);
  assert.doesNotMatch(stripInsulinNumbers("ponte 3 unidades"), /\d/);
  // leaves non-dose text intact
  assert.match(stripInsulinNumbers("Tu es à 95, tout va bien"), /tout va bien/);
});

test("mealCarbSpeed: fast = simple sugar / sugary drink / refined starch", () => {
  assert.equal(mealCarbSpeed("jus d'orange"), "fast");
  assert.equal(mealCarbSpeed("un grand verre de soda"), "fast");
  assert.equal(mealCarbSpeed("bonbons"), "fast");
  assert.equal(mealCarbSpeed("pain blanc"), "fast");
  assert.equal(mealCarbSpeed("zumo de manzana"), "fast"); // es
});

test("mealCarbSpeed: slow = pasta / legumes / whole grain (the user's 'pâtes' case)", () => {
  assert.equal(mealCarbSpeed("assiette de pâtes"), "slow");
  assert.equal(mealCarbSpeed("spaghetti"), "slow");
  assert.equal(mealCarbSpeed("lentilles"), "slow");
  assert.equal(mealCarbSpeed("pain complet"), "slow"); // NOT fast — slow is checked before fast
  assert.equal(mealCarbSpeed("quinoa"), "slow");
  assert.equal(mealCarbSpeed("pasta integral"), "slow"); // es
});

test("mealCarbSpeed: fat dominates (delayed rise); normal = no carb-speed signal", () => {
  assert.equal(mealCarbSpeed("pizza"), "fatty");
  assert.equal(mealCarbSpeed("pâtes au fromage"), "fatty"); // cheese → fat wins over the pasta
  assert.equal(mealCarbSpeed("blanc de poulet"), "normal");
  assert.equal(mealCarbSpeed(""), "normal");
  assert.equal(mealCarbSpeed(null), "normal");
});

test("carbSpeedAdvice: fast=pre-bolus, slow=late peak, fatty=split bolus, normal=empty", () => {
  assert.match(carbSpeedAdvice("fast", "fr"), /pré-bolus/);
  assert.match(carbSpeedAdvice("fast", "fr"), /AVANT de manger/);
  assert.match(carbSpeedAdvice("fast", "es"), /pre-bolo/);
  assert.match(carbSpeedAdvice("slow", "fr"), /2-3 h/);
  assert.match(carbSpeedAdvice("slow", "es"), /2-3 h/);
  assert.match(carbSpeedAdvice("fatty", "fr"), /bolus étalé/); // reuses fattyMealAdvice
  assert.equal(carbSpeedAdvice("normal", "fr"), "");
  assert.equal(carbSpeedAdvice("normal", "es"), "");
});
