// Tests for the deterministic dose guard. Run with Node 24+ (native TS):
//   node --test supabase/functions/_shared/doseGuard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeGuard,
  trendFromReadings,
  recentHypoFrom,
  minutesSinceLastRescue,
  isHypoRescue,
  clampInsulin,
  mealBolusUnits,
  activeIob,
  insulinActionMinutes,
  iobStatusPhrase,
  iobSystemLine,
  combinedActionLine,
  stripInsulinNumbers,
  noDoseDue,
  softenCorrectionTalk,
  sugarTimingFact,
  hypoIobWarning,
  mealCarbSpeed,
  carbSpeedAdvice,
  carbsCubesPhrase,
  starchyCarbNote,
  findUncoveredMeal,
  uncoveredMealWarning,
  inRangeActionLine,
  plannedMealNote,
  carbEstimationRules,
  planMealDose,
  mealPlanLine,
  mealTimingLine,
  carbsOnBoard,
  mealBolusPlan,
  actionLine,
  unusualDoseNote,
  enforceInsulinCeiling,
  overCeilingUnits,
  pendingDropMgdl,
  mealBolusHeldByIob,
  mealBolusHeldLine,
  eatenToTreatALow,
  speakable,
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

test("minutesSinceLastRescue: most recent EATEN rescue, planned ignored", () => {
  const now = 1_000_000_000_000;
  const sugar = (min: number, planned = false) => ({ ts: now - min * 60000, planned, description: "3 sucres" });
  assert.equal(minutesSinceLastRescue([], now), null);
  assert.equal(minutesSinceLastRescue([sugar(8)], now), 8);
  assert.equal(minutesSinceLastRescue([sugar(-3, true)], now), null); // still ahead: not on board
  assert.equal(minutesSinceLastRescue([sugar(3, true)], now), 3);     // its time has passed: it is
  // picks the most recent eaten one
  assert.equal(minutesSinceLastRescue([sugar(40), sugar(6)], now), 6);
});

test("a MEAL is not a rescue: rice 10 min before a low never holds the sugar (WP-0)", () => {
  const now = 1_000_000_000_000;
  const rice = [{ ts: now - 10 * 60000, planned: false, description: "riz", carbs_g: 80 }];
  assert.equal(minutesSinceLastRescue(rice, now), null);
  // ...so the guard still treats the low instead of answering "you already took sugar, wait"
  const g = computeGuard({
    ...base, glucoseMgdl: 65, trend: "stable", minSinceRescue: minutesSinceLastRescue(rice, now),
  });
  assert.equal(g.kind, "sugar");
  assert.ok(g.sugarGrams > 0);
});

test("isHypoRescue: narrow by words, capped by carbs", () => {
  assert.equal(isHypoRescue("3 sucres", null), true);           // no gram figure: the words decide
  assert.equal(isHypoRescue("jus d'orange", 15), true);         // small fast carb with a known figure
  assert.equal(isHypoRescue("jus d'orange", null), false);      // unknown size: not assumed a rescue
  assert.equal(isHypoRescue("sucre", 80), false);               // meal-sized, whatever it is called
  assert.equal(isHypoRescue("pâtes", 60), false);
  assert.equal(isHypoRescue("", null), false);
  assert.equal(isHypoRescue("resucrage", null), true);
});

test("a real rescue still holds a mild low (rule of 15 kept)", () => {
  const now = 1_000_000_000_000;
  const cubes = [{ ts: now - 8 * 60000, planned: false, description: "3 sucres" }];
  const g = computeGuard({
    ...base, glucoseMgdl: 66, trend: "stable", minSinceRescue: minutesSinceLastRescue(cubes, now),
  });
  assert.equal(g.reason, "sugar_recent");
});

test("a severe low is re-treated even after a real rescue", () => {
  const now = 1_000_000_000_000;
  const cubes = [{ ts: now - 5 * 60000, planned: false, description: "sucre" }];
  const g = computeGuard({
    ...base, glucoseMgdl: 48, trend: "stable", minSinceRescue: minutesSinceLastRescue(cubes, now),
  });
  assert.equal(g.kind, "sugar");
});

test("carbSpeedAdvice: the SPOKEN variant names no food (WP-1 'pain blanc')", () => {
  const FOODS = /pain blanc|pan blanco|baguette|jus|zumo|bonbon|dulces|pâtes|pasta|légumineuse|legumbre|integral/i;
  for (const lang of ["fr", "es"]) {
    for (const planned of [false, true]) {
      const spoken = carbSpeedAdvice("fast", lang, planned, true);
      assert.ok(spoken.length > 0);
      assert.ok(!FOODS.test(spoken), `spoken fast advice names a food: ${spoken}`);
      // ...while the on-screen variant keeps the examples, which are useful when read.
      assert.ok(FOODS.test(carbSpeedAdvice("fast", lang, planned, false)));
    }
    const slow = carbSpeedAdvice("slow", lang, false, true);
    assert.ok(!FOODS.test(slow), `spoken slow advice names a food: ${slow}`);
    assert.ok(FOODS.test(carbSpeedAdvice("slow", lang, false, false)));
  }
});

test("carbsCubesPhrase: spoken variant is readable aloud", () => {
  assert.equal(carbsCubesPhrase(32, "fr", true), "environ 8 sucres");
  assert.equal(carbsCubesPhrase(4, "fr", true), "environ 1 sucre");
  assert.equal(carbsCubesPhrase(4, "es", true), "un terrón de azúcar");
  assert.ok(!/[≈()]/.test(carbsCubesPhrase(32, "es", true)));
  assert.equal(carbsCubesPhrase(32, "fr"), "≈ 8 sucre(s)"); // on-screen form unchanged
  assert.equal(carbsCubesPhrase(0, "fr", true), "");
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

// ---- Uncovered-meal (Carbs-On-Board) — the potato-dinner case ----
const NOW = 1_700_000_000_000;
const minAgo = (n: number) => new Date(NOW - n * 60000).toISOString();

test("findUncoveredMeal: flags a substantial recent meal with no bolus near it", () => {
  const meals = [{ ts: minAgo(120), carbs_g: 30, description: "poulet rôti avec pommes de terre" }];
  const doses = [{ ts: minAgo(300), units: 6.5, kind: "rapid" }]; // 5 h ago → unrelated to this meal
  const m = findUncoveredMeal(meals, doses, NOW, prof);
  assert.ok(m);
  assert.equal(m?.carbsG, 30);
  assert.equal(m?.speed, "slow"); // potatoes = slow carbs (late peak)
});

test("findUncoveredMeal: a bolus near the meal carrying ~half the need = covered, no warning", () => {
  const meals = [{ ts: minAgo(90), carbs_g: 30, description: "pâtes" }];
  const doses = [{ ts: minAgo(95), units: 2, kind: "rapid" }]; // 2 u vs need 30/12=2.5, within 45 min
  assert.equal(findUncoveredMeal(meals, doses, NOW, prof), null);
});

test("findUncoveredMeal: ignores not-yet-eaten, snack-size (<15 g) and fully-digested meals", () => {
  // Announced for LATER: nothing to cover yet.
  assert.equal(findUncoveredMeal([{ ts: minAgo(-30), carbs_g: 40, description: "pizza", planned: true }], [], NOW, prof), null);
  // ...but once its time has PASSED it is an ordinary uncovered meal, whatever the stale flag says.
  assert.equal(
    findUncoveredMeal([{ ts: minAgo(30), carbs_g: 40, description: "pizza", planned: true }], [], NOW, prof)?.carbsG,
    40,
  );
  assert.equal(findUncoveredMeal([{ ts: minAgo(20), carbs_g: 12, description: "3 sucres" }], [], NOW, prof), null);
  assert.equal(findUncoveredMeal([{ ts: minAgo(300), carbs_g: 30, description: "riz" }], [], NOW, prof), null); // 5 h > normal window
});

test("uncoveredMealWarning: explains dip-then-rebound above target, FR + ES; empty when none", () => {
  const meals = [{ ts: minAgo(120), carbs_g: 30, description: "poulet rôti avec pommes de terre" }];
  const fr = uncoveredMealWarning(meals, [], NOW, prof, "fr");
  assert.match(fr, /n'a pas été couvert/);
  assert.match(fr, /glucides lents/);     // speed-aware (potatoes)
  assert.match(fr, /plafonne au-dessus de la cible \(110\)/); // names the configured target
  const es = uncoveredMealWarning(meals, [], NOW, prof, "es");
  assert.match(es, /no se cubrió/);
  assert.equal(uncoveredMealWarning([], [], NOW, prof, "fr"), ""); // nothing logged → silent
});

// ---- inRangeActionLine: the in-range action (meal coverage / drift watch / monitor) -------------
const flat = (v: number) => [{ ts: NOW - 20 * 60000, value: v }, { ts: NOW, value: v }];
const fallingTo = (v: number) => [{ ts: NOW - 20 * 60000, value: v + 18 }, { ts: NOW, value: v }];

test("inRangeActionLine: a just-logged uncovered meal → 'cover it' with the carb amount", () => {
  const meals = [{ ts: minAgo(5), carbs_g: 20, description: "2 saucisses" }];
  const fr = inRangeActionLine(meals, [], flat(112), NOW, prof, "fr");
  assert.match(fr, /pas encore couvert/);
  assert.match(fr, /20 g/);
  assert.match(fr, /bolus repas/);
});

test("inRangeActionLine: a meal already covered by a nearby dose → no meal nag, just 'in range'", () => {
  const meals = [{ ts: minAgo(10), carbs_g: 20, description: "2 saucisses" }];
  const doses = [{ ts: minAgo(8), units: 2, kind: "rapid" }];
  const fr = inRangeActionLine(meals, doses, flat(112), NOW, prof, "fr");
  assert.doesNotMatch(fr, /pas encore couvert/);
  assert.match(fr, /dans la cible/);
});

test("inRangeActionLine: low-and-falling + a fresh meal → eat, cover, keep sugar handy (the 84-with-sausages case)", () => {
  const meals = [{ ts: minAgo(3), carbs_g: 20, description: "2 saucisses" }];
  const fr = inRangeActionLine(meals, [], fallingTo(84), NOW, prof, "fr");
  assert.match(fr, /commence à manger/);
  assert.match(fr, /sucre à portée/);
});

test("inRangeActionLine: falling toward the low end, no meal → keep sugar nearby", () => {
  const fr = inRangeActionLine([], [], fallingTo(82), NOW, prof, "fr");
  assert.match(fr, /garde du sucre à portée/);
  assert.doesNotMatch(fr, /couvert/);
});

test("inRangeActionLine: stable in range, nothing pending → 'rien à corriger', ES mirrors", () => {
  assert.match(inRangeActionLine([], [], flat(120), NOW, prof, "fr"), /rien à corriger/);
  assert.match(inRangeActionLine([], [], flat(120), NOW, prof, "es"), /nada que corregir/);
});

// ---- The analysis must never contradict its own action line -------------------------------------
// Reported: "bonne journée mais une chute rapide à corriger" printed directly above
// "Action : dans la cible (70-180), rien à corriger". The narrative was talking about the past day
// and the action about now, but together they just contradict each other — and the action, being
// code-computed, is the one to trust.

test("noDoseDue: true when nothing is to be injected or eaten, false for a real dose", () => {
  assert.equal(noDoseDue(computeGuard({ ...base, glucoseMgdl: 120, trend: "stable" })), true);
  const hypo = computeGuard({ ...base, glucoseMgdl: 55, trend: "falling" });
  assert.equal(hypo.sugarGrams > 0, true);
  assert.equal(noDoseDue(hypo), false);
  const high = computeGuard({ ...base, glucoseMgdl: 280, trend: "rising" });
  assert.equal(high.insulinUnits > 0, true);
  assert.equal(noDoseDue(high), false);
});

test("softenCorrectionTalk: the observation survives, the pending-action reading does not", () => {
  const fr = softenCorrectionTalk("Bonne journée, mais une chute rapide à corriger.", "fr");
  assert.match(fr, /une chute rapide à surveiller/);
  assert.doesNotMatch(fr, /à corriger/);
  assert.match(fr, /Bonne journée/); // nothing else touched
  const es = softenCorrectionTalk("Buen día, pero una bajada rápida a corregir.", "es");
  assert.match(es, /una bajada rápida a vigilar/);
  assert.doesNotMatch(es, /a corregir/);
});

test("softenCorrectionTalk: narrative + in-range action no longer contradict each other", () => {
  const action = inRangeActionLine([], [], flat(120), NOW, prof, "fr");
  const narrative = softenCorrectionTalk("Journée correcte, un pic à corriger ce soir.", "fr");
  const shown = `${narrative}\n\nAction : ${action}`;
  // Exactly one "corriger" left in the whole analysis: the code-owned "rien à corriger".
  assert.equal(shown.match(/corriger/g)?.length, 1);
  assert.match(shown, /rien à corriger/);
});

// ---- Planned (announced) meal: the bolus happens AT EATING TIME, never "now" --------------------

test("planned meal in range → meal units AT EATING TIME, never 'maintenant'", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 120, trend: "stable" });
  const line = combinedActionLine(g, 4, "fr", prof, true);
  assert.match(line, /AU MOMENT de manger/);
  assert.match(line, /4 u/);
  assert.doesNotMatch(line, /maintenant/);
});

test("planned meal + correction needed → two-part line (correction now, meal at eating time)", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 220, trend: "rising" }); // (220-110)/50 = 2.2 → 2 u
  const line = combinedActionLine(g, 4, "fr", prof, true);
  assert.match(line, /maintenant : 2 u/);
  assert.match(line, /au moment de manger : 4 u/);
});

test("planned meal during a hypo → sugar action only, never a meal bolus while low", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 60, trend: "falling" });
  const line = combinedActionLine(g, 4, "fr", prof, true);
  assert.match(line, /sucre/);
  assert.doesNotMatch(line, /repas/);
});

test("planned meal, ES wording mirrors (al comer / EN EL MOMENTO de comer)", () => {
  const inRange = computeGuard({ ...base, glucoseMgdl: 120, trend: "stable" });
  assert.match(combinedActionLine(inRange, 4, "es", prof, true), /EN EL MOMENTO de comer/);
  const high = computeGuard({ ...base, glucoseMgdl: 220, trend: "rising" });
  assert.match(combinedActionLine(high, 4, "es", prof, true), /al comer: 4 u/);
});

test("plannedMealNote without a recent dose says PLAINLY that insulin will be needed (the McDo ask)", () => {
  const n = plannedMealNote(70, false, "fr");
  assert.match(n, /AU MOMENT de manger/);
  assert.match(n, /aucune insuline enregistrée/i);
  assert.match(n, /70 g/);
});

test("plannedMealNote with a recent dose asks to check coverage instead of re-dosing", () => {
  const n = plannedMealNote(70, true, "fr");
  assert.match(n, /dose récente est déjà enregistrée/);
  assert.doesNotMatch(n, /aucune insuline/i);
});

test("plannedMealNote without carbs still works (no grams shown)", () => {
  const n = plannedMealNote(null, false, "fr");
  assert.match(n, /Repas prévu : il faudra le couvrir/);
  assert.doesNotMatch(n, /~.*g de glucides/);
});

test("carbSpeedAdvice planned fatty meal times the split bolus at eating time, not now", () => {
  const adv = carbSpeedAdvice("fatty", "fr", true);
  assert.match(adv, /au moment de manger/);
  assert.doesNotMatch(adv, /maintenant/);
});

test("carbSpeedAdvice planned fast sugar advises the pre-bolus for THIS meal", () => {
  const adv = carbSpeedAdvice("fast", "fr", true);
  assert.match(adv, /AVANT de commencer/);
});

test("carbSpeedAdvice default (eaten) wording unchanged by the planned param", () => {
  assert.equal(carbSpeedAdvice("fatty", "fr"), carbSpeedAdvice("fatty", "fr", false));
  assert.match(carbSpeedAdvice("fatty", "fr"), /une partie maintenant/);
});

// ---- Carb-estimation calibration (the "2 saucisses = 4 sucres" / "pain au chocolat" fixes) ------

test("carb rules pin zero-carb foods at ~0 and anchor common portions", () => {
  const fr = carbEstimationRules("fr");
  assert.match(fr, /2 saucisses ≈ 0-2 g/);
  assert.match(fr, /pain au chocolat ≈ 30 g/);
  const es = carbEstimationRules("es");
  assert.match(es, /2 salchichas ≈ 0-2 g/);
});

// ---- Future (planned) insulin dose: inert until its time ----------------------------------------

test("activeIob ignores a FUTURE (planned) dose until its time arrives", () => {
  const now = 1_750_000_000_000;
  const iob = activeIob([{ ts: now + 30 * 60000, units: 4, kind: "rapid", insulin_name: "Fiasp" }], now);
  assert.equal(iob, 0);
});

test("activeIob counts the same dose once its time has passed", () => {
  const now = 1_750_000_000_000;
  const iob = activeIob([{ ts: now - 60 * 60000, units: 4, kind: "rapid", insulin_name: "Fiasp" }], now);
  assert.ok(iob > 2.9 && iob < 3.1); // 4 u, 1 h into a 4 h decay → ~3 u
});

test("iobStatusPhrase: three honest tiers — 0 says TERMINÉE, never 'presque'", () => {
  assert.match(iobStatusPhrase(1.62, "fr"), /≈ 1,6 u encore active/);
  assert.match(iobStatusPhrase(2, "fr"), /≈ 2 u encore active/);
  assert.match(iobStatusPhrase(0.05, "fr"), /presque épuisée/);
  assert.match(iobStatusPhrase(0, "fr"), /terminée — n'agit plus/);
  assert.doesNotMatch(iobStatusPhrase(0, "fr"), /presque/);
  assert.match(iobStatusPhrase(0, "es"), /terminada/);
  assert.match(iobStatusPhrase(1.5, "es"), /≈ 1,5 u aún activa/);
});

test("iobSystemLine: authoritative system value the model must repeat, not estimate", () => {
  assert.match(iobSystemLine(0, "fr"), /calculée par le système/);
  assert.match(iobSystemLine(0, "fr"), /terminée/);
  assert.match(iobSystemLine(1.5, "fr"), /1,5 u/);
  assert.match(iobSystemLine(1.5, "fr"), /n'estime JAMAIS/);
  assert.match(iobSystemLine(0.8, "es"), /calculada por el sistema/);
});

// ── Prospective meal dosing: "if I eat THIS, how much insulin?" ──────────────────────────────────

test("planMealDose: 30 sugars announced -> the dose is ready BEFORE the meal (the user's case)", () => {
  // 30 sugar cubes ≈ 120 g on a 12 ICR / 50 ISF profile.
  const plan = planMealDose({
    glucoseMgdl: 120, trend: "stable", staleMin: 2, iobUnits: 0,
    carbsG: 120, description: "30 sucres", minutesUntilMeal: 10, profile: prof,
  });
  assert.equal(plan.mealUnits, 10);            // 120 / 12
  assert.equal(plan.correctionUnits, 0);       // 120 mg/dL is in range
  assert.equal(plan.totalUnits, 10);
  assert.equal(plan.expectedRiseMgdl, 500);    // (120/12) × 50 — why reacting afterwards can't work
  assert.equal(plan.projectedUncoveredMgdl, 600); // clamped at PROJECTION_MAX_MGDL
  assert.equal(plan.timing, "prebolus");       // fast carbs
  assert.equal(plan.minutesUntilMeal, 10);
  const line = mealPlanLine(plan, "fr", prof);
  assert.match(line, /10 u/);
  assert.match(line, /avant/i);
});

test("mealTimingLine: an announced meal times the pre-bolus from the STATED moment", () => {
  const soon = mealTimingLine("prebolus", "fr", 10);   // eating in 10 min, lead is 15
  assert.match(soon, /15 min AVANT/);
  const later = mealTimingLine("prebolus", "fr", 45);  // eating in 45 min -> inject in ~30
  assert.match(later, /dans environ 30 min/);
  assert.match(mealTimingLine("at_meal", "es", 20), /dentro de 20 min/);
});

test("planMealDose: a high before the meal adds a correction, hypo blocks everything", () => {
  const high = planMealDose({
    glucoseMgdl: 250, trend: "stable", staleMin: 2, iobUnits: 0,
    carbsG: 60, description: "pâtes", profile: prof,
  });
  assert.equal(high.mealUnits, 5);
  assert.ok(high.correctionUnits > 0);
  assert.equal(high.totalUnits, high.mealUnits + high.correctionUnits);
  assert.equal(high.timing, "split"); // slow carbs

  const low = planMealDose({
    glucoseMgdl: 58, trend: "stable", staleMin: 2, iobUnits: 0,
    carbsG: 60, description: "pâtes", profile: prof,
  });
  assert.equal(low.reason, "hypo_first");
  assert.equal(low.totalUnits, 0, "nothing is injected while treating a low");
  assert.equal(low.timing, "after_meal");
  assert.match(mealPlanLine(low, "fr", prof), /sucre/i);
});

test("planMealDose: insulin still working defers the meal bolus instead of stacking", () => {
  // 100 mg/dL with 3 u on board = ~150 mg/dL of drop still owed.
  const plan = planMealDose({
    glucoseMgdl: 100, trend: "falling", staleMin: 2, iobUnits: 3,
    carbsG: 60, description: "pâtes", profile: prof,
  });
  assert.equal(plan.lowBeforeMeal, true);
  assert.equal(plan.timing, "after_meal");
  assert.equal(plan.pendingDropMgdl, 150);
  assert.match(mealPlanLine(plan, "fr", prof), /⚠️/);
});

test("planMealDose: no carb ratio -> no number invented", () => {
  const plan = planMealDose({
    glucoseMgdl: 150, trend: "stable", staleMin: 2, iobUnits: 0,
    carbsG: 60, description: "pâtes", profile: { ...prof, carbRatio: 0 },
  });
  assert.equal(plan.reason, "no_ratios");
  assert.equal(plan.mealUnits, 0);
  assert.match(mealPlanLine(plan, "fr", prof), /ratio/);
});

test("planMealDose: stale data still covers the meal but never corrects", () => {
  const plan = planMealDose({
    glucoseMgdl: 250, trend: "stable", staleMin: 60, iobUnits: 0,
    carbsG: 60, description: "pâtes", profile: prof,
  });
  assert.equal(plan.reason, "stale_no_correction");
  assert.equal(plan.correctionUnits, 0, "no correction off an out-of-date value");
  assert.equal(plan.mealUnits, 5);
});

test("carbsOnBoard: decays per carb speed, and an announced meal joins once its time passes", () => {
  const now = 1_700_000_000_000;
  const at = (min: number) => now - min * 60000;
  // Juice (fast, 120 min window) 60 min ago -> half absorbed.
  assert.equal(Math.round(carbsOnBoard([{ ts: at(60), carbs_g: 20, description: "jus d'orange" }], now)), 10);
  // Pasta (slow, 240 min window) 60 min ago -> three quarters still to come.
  assert.equal(Math.round(carbsOnBoard([{ ts: at(60), carbs_g: 20, description: "pâtes" }], now)), 15);
  // Announced for later: not on board.
  assert.equal(carbsOnBoard([{ ts: at(-30), carbs_g: 40, planned: true, description: "pizza" }], now), 0);
  // Same row once the moment has passed: on board, despite the flag nobody ever clears.
  assert.ok(carbsOnBoard([{ ts: at(30), carbs_g: 40, planned: true, description: "pizza" }], now) > 0);
});

test("mealBolusPlan: an uncovered eaten meal outranks an announced one", () => {
  const now = 1_700_000_000_000;
  const at = (min: number) => new Date(now - min * 60000).toISOString();
  const eaten = { ts: at(30), carbs_g: 60, description: "pâtes" };
  const announced = { ts: at(-20), carbs_g: 40, planned: true, description: "pizza" };
  const plan = mealBolusPlan([eaten, announced], [], now, prof);
  assert.equal(plan.planned, false);
  assert.equal(plan.carbsG, 60);
  assert.equal(plan.units, 5);
  // With nothing eaten to cover, the announced meal is dosed for eating time.
  const ahead = mealBolusPlan([announced], [], now, prof);
  assert.equal(ahead.planned, true);
  assert.equal(ahead.carbsG, 40);
});

test("a rescue is never treated as a meal to bolus", () => {
  const now = 1_700_000_000_000;
  const at = (min: number) => new Date(now - min * 60000).toISOString();
  // 20 g of sugar taken to stop a fall must not come back as "1,5 u for the meal".
  assert.equal(findUncoveredMeal([{ ts: at(20), carbs_g: 20, description: "4 sucres" }], [], now, prof), null);
});

// ─── Trend robustness. All three regressions below were measured on a real device: a child climbing
// 190 -> 237 mg/dL was told "aucune insuline" twice on the way UP, because the old two-point slope
// read sensor noise as a direction and a sensor gap as an emergency stop. ────────────────────────

const T0 = 1_700_000_000_000;
/** One reading a minute, oldest first, ending now. */
const perMinute = (vals: number[]) => vals.map((value, i) => ({ ts: T0 + i * 60_000, value }));
const lastTs = (r: { ts: number }[]) => r[r.length - 1].ts;

test("sensor noise inside a climb must not read as falling (the child's real series)", () => {
  // The measured shape: a slow climb around 230 with one high sample among flat ones. The old
  // two-point slope fitted 234 -> 232 and answered "falling", which BLOCKS the correction — on a
  // glucose that was on its way up from 190.
  const r = perMinute([230, 231, 231, 232, 234, 238, 233, 233, 234, 234, 235, 236, 236, 237, 238]);
  const trend = trendFromReadings(r, lastTs(r));
  assert.notEqual(trend, "falling");
  assert.notEqual(trend, "falling_fast");
  const g = computeGuard({ ...base, glucoseMgdl: 238, trend });
  assert.equal(g.kind, "correction");
  assert.ok(g.insulinUnits > 0);
});

test("a genuine ramp is still detected, despiking must not flatten it", () => {
  const r = perMinute([150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200, 205]);
  assert.equal(trendFromReadings(r, lastTs(r)), "rising_fast");
});

test("a real fall is still detected", () => {
  const r = perMinute([200, 195, 190, 185, 180, 175, 170, 165, 160, 155, 150, 145]);
  assert.equal(trendFromReadings(r, lastTs(r)), "falling_fast");
});

test("a time base under 10 minutes claims no direction at all", () => {
  // Readings resuming dense after a blackout describe nothing yet. "unknown" blocks the correction,
  // which is the honest answer — the coach merges stored history so this stays rare.
  const r = perMinute([237, 235, 233, 231, 229]);
  assert.equal(trendFromReadings(r, lastTs(r)), "unknown");
});

test("a recent crash is not averaged away by the rest of the window", () => {
  // Flat for fifteen minutes, then 40 mg/dL gone in five. A fit over the whole window calls that a
  // gentle slope; the person is crashing. Falls are judged on the most alarming evidence available.
  const r = perMinute([220, 220, 220, 220, 220, 220, 220, 220, 220, 220, 220, 212, 204, 196, 188, 180]);
  assert.equal(trendFromReadings(r, lastTs(r)), "falling_fast");
});

test("15-minute cloud buckets: a real drop in the last bucket still reads as falling", () => {
  // The followed patient's shape. Widening the window to 45 min averaged this away and handed back a
  // correction the old code blocked — the regression this guards against.
  const r = [
    { ts: T0, value: 280 },
    { ts: T0 + 15 * 60_000, value: 275 },
    { ts: T0 + 30 * 60_000, value: 274 },
    { ts: T0 + 45 * 60_000, value: 250 },
  ];
  const trend = trendFromReadings(r, lastTs(r));
  assert.ok(trend === "falling" || trend === "falling_fast", `expected a fall, got ${trend}`);
  assert.equal(computeGuard({ ...base, glucoseMgdl: 250, trend }).maxInsulinUnits, 0);
});

test("a line is never drawn across a long sensor gap", () => {
  // 150 forty minutes ago, then a dense burst in the 230s that is coming DOWN. Fitting through the
  // hole produced "rising_fast" and offered insulin during a fall.
  const r = [
    { ts: T0, value: 150 },
    { ts: T0 + 38 * 60_000, value: 231.5 },
    { ts: T0 + 39 * 60_000, value: 231 },
    { ts: T0 + 40 * 60_000, value: 230 },
  ];
  const trend = trendFromReadings(r, lastTs(r));
  assert.notEqual(trend, "rising");
  assert.notEqual(trend, "rising_fast");
  assert.equal(computeGuard({ ...base, glucoseMgdl: 230, trend }).maxInsulinUnits, 0);
});

test("a dose the text merely REPORTS is not treated as one it proposes", () => {
  // The prompt itself tells the model to quote the active insulin in units, and active insulin is
  // routinely larger than the correction left after subtracting it. Judged against the bare guard
  // ceiling, a compliant sentence came out gutted.
  const g = computeGuard({ ...base, glucoseMgdl: 250, trend: "stable", iobUnits: 2 });
  const txt = "l'insuline encore active (≈ 2 u) va en absorber une partie.";
  const ceiling = { ...g, maxInsulinUnits: g.maxInsulinUnits + 2 }; // + what the context legitimately holds
  assert.equal(enforceInsulinCeiling(txt, ceiling), txt);
  // An invented, larger dose is still removed.
  assert.ok(!enforceInsulinCeiling("prends plutôt 12 u tout de suite.", ceiling).includes("12"));
});

test("the dose sniffer knows the French medical 'UI'", () => {
  const g = { kind: "correction", reason: "high_correction", insulinUnits: 2, maxInsulinUnits: 2, sugarGrams: 0, sugarCubes: 0 } as const;
  assert.ok(!enforceInsulinCeiling("fais 6 UI maintenant.", g).includes("6"));
  assert.equal(overCeilingUnits("fais 6 UI maintenant.", 2), 6);
  // ...and does not mistake carbs, hours or weights for doses.
  assert.equal(overCeilingUnits("45 g de glucides, dans 2 h, 38 kg", 2), null);
});

test("a reading isolated by a sensor gap has no knowable direction", () => {
  const t0 = 1_700_000_000_000;
  const readings = [
    { ts: t0, value: 190 },
    { ts: t0 + 56 * 60_000, value: 234 }, // 56-minute hole, measured on the device
  ];
  assert.equal(trendFromReadings(readings, readings[1].ts), "unknown");
});

test("the trend reads every point in the window, not just the two ends", () => {
  // Ends identical, middle sagging: a two-point slope calls this flat. A fit sees the shape.
  const t0 = 1_700_000_000_000;
  const readings = [200, 180, 160, 140, 130, 120].map((value, i) => ({ ts: t0 + i * 3 * 60_000, value }));
  const trend = trendFromReadings(readings, readings[5].ts);
  assert.ok(trend === "falling" || trend === "falling_fast", `expected a fall, got ${trend}`);
});

// ─── The action line must say WHY nothing is due. Six guard states used to collapse into two
// sentences, so "you are in target" and "I cannot see your glucose" looked identical on screen. ───

test("the three no-insulin reasons no longer share one sentence", () => {
  const inRange = computeGuard({ ...base, glucoseMgdl: 120, trend: "stable" });
  const falling = computeGuard({ ...base, glucoseMgdl: 250, trend: "falling" });
  const covered = computeGuard({ ...base, glucoseMgdl: 250, trend: "stable", iobUnits: 10 });
  assert.equal(inRange.reason, "in_range");
  assert.equal(falling.reason, "falling");
  assert.equal(covered.reason, "covered_by_iob");
  const lines = [inRange, falling, covered].map((g) => actionLine(g, "fr", prof));
  assert.equal(new Set(lines).size, 3, `expected 3 distinct sentences, got ${JSON.stringify(lines)}`);
  assert.match(lines[1], /redescend/i);
  assert.match(lines[2], /encore active/i);
});

test("the three recheck reasons no longer share one sentence", () => {
  const noReading = computeGuard({ ...base, glucoseMgdl: null, trend: "stable" });
  const stale = computeGuard({ ...base, glucoseMgdl: 250, trend: "stable", staleMin: 40 });
  const unknown = computeGuard({ ...base, glucoseMgdl: 250, trend: "unknown" });
  const lines = [noReading, stale, unknown].map((g) => actionLine(g, "fr", prof));
  assert.equal(new Set(lines).size, 3, `expected 3 distinct sentences, got ${JSON.stringify(lines)}`);
  assert.match(lines[2], /trou de capteur/i);
});

test("every no-dose state still refuses insulin while explaining itself", () => {
  for (const g of [
    computeGuard({ ...base, glucoseMgdl: 120, trend: "stable" }),
    computeGuard({ ...base, glucoseMgdl: 250, trend: "falling" }),
    computeGuard({ ...base, glucoseMgdl: 250, trend: "unknown" }),
    computeGuard({ ...base, glucoseMgdl: 250, trend: "stable", staleMin: 40 }),
  ]) {
    assert.equal(g.maxInsulinUnits, 0);
    for (const lang of ["fr", "es"]) assert.ok(actionLine(g, lang, prof).length > 0);
  }
});

// ─── NO CEILING. Owner's explicit decision: the arithmetic is always carried out in full and always
// shown. A big carb load needs a big bolus, and a clipped number is indistinguishable from a computed
// one. The only thing a large dose earns is an informational note that leaves it untouched. ────────

test("a big meal gets its whole bolus — nothing is clipped", () => {
  // 45 sugar cubes ≈ 180 g of carbs. At 1 u per 12 g that is 15 u, and 15 u is the answer.
  assert.equal(mealBolusUnits(180, prof), 15);
  // Even an extreme figure comes back whole.
  assert.equal(mealBolusUnits(300, { ...prof, carbRatio: 2 }), 150);
});

test("a large correction is still computed and still shown in full", () => {
  const broken = { ...prof, correctionFactor: 5, weightKg: 75 };
  const g = computeGuard({ ...base, profile: broken, glucoseMgdl: 300, trend: "stable" });
  assert.equal(g.kind, "correction");
  assert.equal(g.insulinUnits, 38); // (300-110)/5
  assert.equal(g.maxInsulinUnits, 38);
  assert.match(actionLine(g, "fr", broken), /38 u/);
});

test("an unusually large dose is annotated, never reduced", () => {
  const broken = { ...prof, correctionFactor: 5, weightKg: 75 };
  const g = computeGuard({ ...base, profile: broken, glucoseMgdl: 300, trend: "stable" });
  const line = actionLine(g, "fr", broken);
  assert.match(line, /38 u/);                    // the number survives untouched...
  assert.match(line, /inhabituellement élevée/i); // ...and carries a check-your-ratios note
  assert.ok(unusualDoseNote(38, broken, "es").length > 0);
});

test("an ordinary dose carries no note at all", () => {
  const g = computeGuard({ ...base, glucoseMgdl: 212, trend: "stable" });
  assert.equal(g.kind, "correction");
  assert.equal(g.insulinUnits, 2); // (212-110)/50 = 2.04 -> 2
  assert.equal(unusualDoseNote(g.insulinUnits, prof, "fr"), "");
  assert.doesNotMatch(actionLine(g, "fr", prof), /inhabituellement/i);
  assert.equal(mealBolusUnits(60, prof), 5); // 60 / 12
});

// ─── The dinner incident, 30 July 2026. A child's 50 g meal, pre-bolused correctly with 5.5 u twenty
// minutes beforehand, was still answered with "3 u de Fiasp au moment de manger" an hour and forty
// minutes later — at 85 mg/dL, with 3.4 u still active. He went to 63. ─────────────────────────────

const ryan = { carbRatio: 16, correctionFactor: 58, targetMgdl: 120, weightKg: 40, rapidInsulin: "Fiasp" };
const DINNER = new Date("2026-07-30T19:40:27Z").getTime();
const NOW_AFTER = new Date("2026-07-30T21:23:00Z").getTime();      // 103 min later
const dinnerMeal = [{ ts: "2026-07-30T19:40:27+00:00", description: "entrecôte avec frites", carbs_g: 50, planned: true }];
const preBolus = [
  { ts: "2026-07-30T19:19:23+00:00", units: 5.5, kind: "rapid", insulin_name: "Fiasp" },
  { ts: "2026-07-30T18:45:41+00:00", units: 2, kind: "rapid", insulin_name: "Fiasp" },
];

test("a meal whose time has PASSED is never announced again", () => {
  // `planned` is written once and nothing ever clears it, so the announced branch must go by the
  // clock. It used to accept anything less than three hours old — i.e. re-announce every eaten meal.
  const plan = mealBolusPlan(dinnerMeal as any, preBolus as any, NOW_AFTER, ryan);
  assert.equal(plan.units, 0);
  assert.equal(plan.planned, false);
});

test("...while a meal genuinely still ahead is announced", () => {
  const beforeDinner = DINNER - 20 * 60_000; // 20 min before the stated time
  const plan = mealBolusPlan(dinnerMeal as any, [], beforeDinner, ryan);
  assert.equal(plan.planned, true);
  assert.equal(plan.units, 3); // 50 / 16
});

test("a covered meal leaves nothing to inject", () => {
  assert.equal(findUncoveredMeal(dinnerMeal as any, preBolus as any, NOW_AFTER, ryan), null);
});

test("no meal bolus while the insulin already in is about to take you low", () => {
  const iob = activeIob(preBolus as any, NOW_AFTER, 240);
  assert.ok(iob > 3, `expected insulin still active, got ${iob}`); // 3.36 u on the night
  // 85 - 3.4*58 is far under 70: three more units here is not a meal bolus, it is a hypo.
  assert.equal(mealBolusHeldByIob(85, iob, ryan), true);
  assert.match(mealBolusHeldLine(85, iob, ryan, "fr"), /aucune insuline pour le repas/i);
  // ...and it does not fire on an ordinary in-range value with nothing on board.
  assert.equal(mealBolusHeldByIob(120, 0, ryan), false);
});

test("in range is not the same as safe: the pending drop outranks 'rien à corriger'", () => {
  const iob = activeIob(preBolus as any, NOW_AFTER, 240);
  const readings = [{ ts: NOW_AFTER - 10 * 60_000, value: 95 }, { ts: NOW_AFTER, value: 85 }];
  const line = inRangeActionLine(dinnerMeal as any, preBolus as any, readings, NOW_AFTER, ryan, "fr", iob);
  assert.match(line, /sous 70/i);          // where it lands, not just "a fall is owed"
  assert.match(line, /tu es à 85 mg\/dL/); // ...from the value actually on the meter
  assert.match(line, /sucre à portée/i);
  assert.doesNotMatch(line, /rien à corriger/i);
});

test("the label outranks our own reference table, and no drink has a single global figure", () => {
  // The 7UP report: the app answered 35 g for a 33 cl can whose label said 16 g. The model was
  // obeying us — "1 canette de soda 33 cl ≈ 35 g" was written into these very rules. A brand's sugar
  // varies up to twofold by country and by reformulation, so a single number can only ever be wrong
  // somewhere, and being wrong HIGH means injecting too much.
  for (const lang of ["fr", "es"]) {
    const r = carbEstimationRules(lang);
    assert.doesNotMatch(r, /33 cl ≈ 35 g/, `${lang}: the flat soda figure is back`);
    assert.match(r, /100 ml/, `${lang}: drinks must be counted per 100 ml from the label`);
    assert.match(r, lang === "fr" ? /ÉTIQUETTE FAIT FOI/ : /ETIQUETA MANDA/);
    assert.match(r, lang === "fr" ? /4,8 g\/100 ml/ : /4,8 g\/100 ml/); // the reformulated case is named
    assert.match(r, lang === "fr" ? /BAS de la fourchette/ : /parte BAJA/); // unknown -> under, not over
  }
});

test("the action line NAMES the meal it is dosing", () => {
  // 23:59, reported live. The app said "1 u de Fiasp pour le repas"; the parent thought of the
  // dinner three hours earlier and concluded the app was broken. It meant a can of 7up drunk 22
  // minutes before, and it was right — it just never said which meal. A dose you cannot attach to a
  // specific food is a dose you cannot check.
  const child = { carbRatio: 16, correctionFactor: 58, targetMgdl: 120, weightKg: 40, rapidInsulin: "Fiasp" };
  const now = new Date("2026-07-30T22:59:00Z").getTime();
  const twoMeals = [
    { ts: "2026-07-30T19:40:27+00:00", description: "entrecôte avec frites", carbs_g: 50, planned: true },
    { ts: "2026-07-30T22:37:35+00:00", description: "canette 7up", carbs_g: 16, planned: false },
  ];
  const covered = [{ ts: "2026-07-30T19:19:23+00:00", units: 5.5, kind: "rapid", insulin_name: "Fiasp" }];
  const plan = mealBolusPlan(twoMeals as any, covered as any, now, child);
  // It picks the UNCOVERED one — the drink — not the dinner that was pre-bolused.
  assert.equal(plan.units, 1);
  assert.equal(plan.description, "canette 7up");
  assert.equal(plan.carbsG, 16);

  const g = computeGuard({ glucoseMgdl: 150, trend: "rising", staleMin: 1, iobUnits: 0, recentHypo: false, profile: child });
  const line = combinedActionLine(g, plan.units, "fr", child, plan.planned,
    { description: plan.description, carbsG: plan.carbsG, minutesAgo: plan.minutesAgo });
  assert.match(line, /canette 7up/);
  assert.match(line, /16 g/);
  assert.match(line, /il y a \d+ min/);
  assert.doesNotMatch(line, /pour le repas\./); // the anonymous wording is gone
});

test("an unidentified meal still gets a sentence", () => {
  const g = computeGuard({ glucoseMgdl: 150, trend: "rising", staleMin: 1, iobUnits: 0, recentHypo: false, profile: prof });
  assert.match(combinedActionLine(g, 2, "fr", prof, false, null), /pour le repas/);
  assert.match(combinedActionLine(g, 2, "es", prof, false, null), /para la comida/);
});

// ─── The 7up incident, 31 July 2026. A child fell to 57 mg/dL at 23:11; the can of 7up drunk to
// climb out of it was read as a meal and answered with 1 u of rapid insulin. isHypoRescue knows
// "soda", "coca" and "limonade" — it did not know "7up". Brand vocabulary is never complete. ───────

test("food eaten to climb out of a low is never answered with insulin", () => {
  const child = { carbRatio: 16, correctionFactor: 58, targetMgdl: 120, weightKg: 40, rapidInsulin: "Fiasp" };
  const T = new Date("2026-07-30T22:37:00Z").getTime();   // the can
  const now = T + 21 * 60_000;
  // The real curve: 81 -> 57 -> back up, with the drink logged during the climb.
  const curve: { ts: number; value: number }[] = [];
  [[-32, 81], [-30, 73], [-28, 63], [-26, 57], [-22, 57], [-18, 64], [-12, 71], [-6, 78], [0, 74], [8, 90], [16, 111]]
    .forEach(([m, v]) => curve.push({ ts: T + (m as number) * 60_000, value: v as number }));
  const meal = [{ ts: "2026-07-30T22:37:00+00:00", description: "canette 7up", carbs_g: 16, planned: false }];

  // The word list alone does NOT catch it — which is exactly why the curve has to.
  assert.equal(isHypoRescue("canette 7up", 16), false);
  assert.equal(eatenToTreatALow(T, curve), true);

  assert.equal(findUncoveredMeal(meal as any, [], now, child, curve), null);
  const plan = mealBolusPlan(meal as any, [], now, child, 180, curve);
  assert.equal(plan.units, 0, "no insulin for a rescue");
});

test("the same drink at a normal glucose IS a meal to cover", () => {
  const child = { carbRatio: 16, correctionFactor: 58, targetMgdl: 120, weightKg: 40, rapidInsulin: "Fiasp" };
  const T = new Date("2026-07-30T15:00:00Z").getTime();
  const flat = [-30, -20, -10, 0, 10].map((m) => ({ ts: T + m * 60_000, value: 140 }));
  const meal = [{ ts: "2026-07-30T15:00:00+00:00", description: "canette 7up", carbs_g: 16, planned: false }];
  assert.equal(eatenToTreatALow(T, flat), false);
  assert.equal(mealBolusPlan(meal as any, [], T + 20 * 60_000, child, 180, flat).units, 1);
});

test("no readings at all: the curve cannot overrule, and nothing changes", () => {
  assert.equal(eatenToTreatALow(Date.now(), []), false);
  assert.equal(eatenToTreatALow(Date.now(), null), false);
});

// ─── The McDonald's incident, 31 July 2026. At 80 mg/dL the user logged a "Maxi Best Of Royal
// Cheese" (~110 g, 28 sugar cubes), jumped to 130 within minutes and asked for an analysis. It came
// back: "l'insuline encore active a ~154 mg/dL de baisse à délivrer — tu vas vers une hypo […] et
// aucune insuline en plus (repas compris)". Two independent faults, both reproduced below: the menu
// was filed as a HYPO RESCUE because the glucose happened to be 80 when it was logged, and the
// trajectory counted the insulin on board while ignoring the 110 g of carbs on board. ─────────────

const mcdo = { carbRatio: 12, correctionFactor: 40, targetMgdl: 110, weightKg: 60, rapidInsulin: "Fiasp" };
const MC_T = new Date("2026-07-31T15:04:00Z").getTime();   // the menu, 16 min before the analysis
const MC_NOW = MC_T + 16 * 60_000;
// 80 at the moment of eating, then the climb the user described.
const mcCurve = [[-20, 84], [-10, 82], [0, 80], [6, 98], [11, 118], [16, 121]]
  .map(([m, v]) => ({ ts: MC_T + (m as number) * 60_000, value: v as number }));
const mcMeal = [{
  ts: "2026-07-31T15:04:00+00:00", carbs_g: 112, planned: false,
  description: "Maxi Best Of Royal Cheese (menu McDonald)",
}];
// 12 u three hours earlier on a 4 h decay -> ~3.9 u left, i.e. ~154 mg/dL still owed at ISF 40.
const mcDoses = [{ ts: MC_NOW - 163 * 60_000, units: 12, kind: "rapid", insulin_name: "Fiasp" }];

test("a whole menu eaten at 80 mg/dL is a MEAL, not a hypo rescue", () => {
  // Nobody treats a low with a Maxi Best Of. The curve rule owns rescue-SIZED food only.
  assert.equal(eatenToTreatALow(MC_T, mcCurve, 112), false);
  assert.equal(eatenToTreatALow(MC_T, mcCurve, 16), true); // a can at the same moment still is one
  const un = findUncoveredMeal(mcMeal as any, [], MC_NOW, mcdo, mcCurve);
  assert.ok(un, "the menu must surface as an uncovered meal");
  assert.equal(un!.carbsG, 112);
  assert.equal(mealBolusPlan(mcMeal as any, [], MC_NOW, mcdo, 180, mcCurve).units, 9.5); // 112 / 12
});

test("the carbs on board are weighed against the insulin on board", () => {
  const iob = activeIob(mcDoses as any, MC_NOW, 240);
  assert.ok(iob > 3.8 && iob < 3.9, `expected the report's ~4 u still active, got ${iob}`);
  assert.equal(Math.round((pendingDropMgdl(iob, mcdo) ?? 0)), 154); // the "154" of the screenshot
  const cob = carbsOnBoard(mcMeal as any, MC_NOW);
  assert.ok(cob > 100, `expected the menu still digesting, got ${cob}`);
  // Insulin alone: 121 - 154 < 70 -> "a fall is coming". With the food: it is a climb.
  assert.equal(mealBolusHeldByIob(121, iob, mcdo, 0), true);
  assert.equal(mealBolusHeldByIob(121, iob, mcdo, cob), false);
  // ...and nothing changed when there is genuinely no food on board.
  assert.equal(mealBolusHeldByIob(85, iob, mcdo, 0), true);
});

test("the analysis no longer announces a hypo 16 min into a 28-sugar-cube menu", () => {
  const iob = activeIob(mcDoses as any, MC_NOW, 240);
  const line = inRangeActionLine(mcMeal as any, mcDoses as any, mcCurve, MC_NOW, mcdo, "fr", iob);
  assert.doesNotMatch(line, /vers une hypo/i);
  assert.doesNotMatch(line, /aucune insuline en plus/i);
  assert.match(line, /121 mg\/dL/);        // the value on the meter is named...
  assert.match(line, /en digestion/);      // ...and so is the food it is racing
  assert.match(line, /recontrôle dans 15 min/);
  const es = inRangeActionLine(mcMeal as any, mcDoses as any, mcCurve, MC_NOW, mcdo, "es", iob);
  assert.match(es, /digiriendo/);
  assert.doesNotMatch(es, /hacia una hipoglucemia/i);
});

test("a REAL incoming hypo still says so — and says what the numbers mean", () => {
  const iob = activeIob(mcDoses as any, MC_NOW, 240); // ~3.9 u -> ~154 mg/dL owed
  const quiet = [[-20, 130], [-10, 125], [0, 121]].map(([m, v]) => ({ ts: MC_NOW + (m as number) * 60_000, value: v as number }));
  const line = inRangeActionLine([], mcDoses as any, quiet, MC_NOW, mcdo, "fr", iob); // nothing eaten
  assert.match(line, /vers une hypo|sous 70/i);
  assert.match(line, /121 mg\/dL/);                 // "154" was read as a glucose value: name the real one
  assert.match(line, /~154 mg\/dL de baisse/);      // and say what 154 actually is
  assert.match(line, /sucre à portée MAINTENANT/);
});

test("mealBolusHeldLine names the current glucose next to the pending drop", () => {
  const iob = activeIob(mcDoses as any, MC_NOW, 240);
  const fr = mealBolusHeldLine(85, iob, mcdo, "fr");
  assert.match(fr, /tu es à 85 mg\/dL/);
  assert.match(fr, /~154 mg\/dL de baisse/);
  assert.match(fr, /sous 70/);
  assert.match(mealBolusHeldLine(85, iob, mcdo, "es"), /estás a 85 mg\/dL/);
});

test("planMealDose: earlier carbs still landing lift the floor the meal bolus is judged against", () => {
  const iob = activeIob(mcDoses as any, MC_NOW, 240);
  const bare = planMealDose({ glucoseMgdl: 121, trend: "rising", staleMin: 2, iobUnits: iob, carbsG: 40, profile: mcdo });
  assert.equal(bare.lowBeforeMeal, true);          // insulin alone: 121 - 154 = -33
  const withFood = planMealDose({
    glucoseMgdl: 121, trend: "rising", staleMin: 2, iobUnits: iob, carbsG: 40,
    cobGrams: carbsOnBoard(mcMeal as any, MC_NOW), profile: mcdo,
  });
  assert.equal(withFood.lowBeforeMeal, false);
  assert.ok((withFood.floorMgdl as number) > 70);
  assert.equal(withFood.mealUnits, 3.5);           // the carb maths itself is untouched
});

test("balanced on paper, but low on the meter → the sugar stays within reach", () => {
  const iob = 1.2;                                   // ~48 mg/dL owed at ISF 40
  const meal = [{ ts: MC_NOW - 30 * 60_000, carbs_g: 30, description: "sandwich" }];
  const low = [[-20, 92], [-10, 88], [0, 84]].map(([m, v]) => ({ ts: MC_NOW + (m as number) * 60_000, value: v as number }));
  const line = inRangeActionLine(meal as any, [], low, MC_NOW, mcdo, "fr", iob);
  assert.match(line, /garde quand même du sucre à portée/);
  assert.doesNotMatch(line, /pas besoin de sucre/);
});

test("a slow or fatty food is never a rescue, whatever the glucose was when it was logged", () => {
  // "Fais qu'il remarque si c'est un repas ou pas": the size ceiling alone still let a small plate
  // through — a slice of pizza logged at 79 mg/dL was filed as treatment for that low. Nothing slow
  // or fatty lifts a low inside the quarter of an hour a rescue is judged on; that is what makes it
  // a meal. The curve keeps the last word only over food that could plausibly have been the cure.
  const T = MC_T;
  const lowCurve = [[-10, 78], [0, 76], [8, 84]].map(([m, v]) => ({ ts: T + (m as number) * 60_000, value: v as number }));
  assert.equal(eatenToTreatALow(T, lowCurve, 24, "part de pizza"), false);
  assert.equal(eatenToTreatALow(T, lowCurve, 20, "pâtes"), false);
  assert.equal(eatenToTreatALow(T, lowCurve, 22, "cheeseburger"), false);
  // ...while a real rescue is untouched, by word or by speed.
  assert.equal(eatenToTreatALow(T, lowCurve, 15, "3 sucres"), true);
  assert.equal(eatenToTreatALow(T, lowCurve, 16, "canette 7up"), true);
  assert.equal(eatenToTreatALow(T, lowCurve, 20, "jus d'orange"), true);
});

test("even a 'rescue' this big cannot mean a coming hypo: sugar on board is sugar on board", () => {
  // The user's own objection: "si c'est un resucrage de 28 sucres il ne peut toujours pas dire que
  // je vais vers une hypo". carbsOnBoard counts every gram eaten, rescue or meal — the projection
  // must never look at the insulin alone again, whatever the food was filed as.
  const rescue = [{ ts: MC_T, carbs_g: 112, planned: false, description: "3 sucres" }];
  assert.equal(isHypoRescue("3 sucres", 112), false);             // 112 g is not a rescue either
  const cob = carbsOnBoard(rescue as any, MC_NOW);
  assert.ok(cob > 90, `rescue carbs must still count as sugar on board, got ${cob}`);
  const iob = activeIob(mcDoses as any, MC_NOW, 240);
  assert.equal(mealBolusHeldByIob(121, iob, mcdo, cob), false);
  const line = inRangeActionLine(rescue as any, mcDoses as any, mcCurve, MC_NOW, mcdo, "fr", iob);
  assert.doesNotMatch(line, /vers une hypo/i);
  assert.match(line, /en digestion/);
});

test("an announced slow/fatty meal keeps its hour: the split bolus is due AT the meal, not now", () => {
  const fr = mealTimingLine("split", "fr", 20);
  assert.match(fr, /dans 20 min/);
  assert.match(fr, /1-2 h après/);
  assert.match(mealTimingLine("split", "es", 20), /dentro de 20 min/);
  // Eating now: no phantom delay.
  assert.doesNotMatch(mealTimingLine("split", "fr", 0), /dans \d+ min/);
});

// ─── Review findings, 31 July 2026. The meal-vs-rescue veto added above was itself too broad, and
// three prospective-plan sentences dropped something the reactive one had always said. ────────────

test("a MEASURED low outranks the size of what was eaten: a can of cola at 57 is still a rescue", () => {
  // 33 cl of classic cola is 35 g — over the rescue ceiling — so the size veto alone re-opened the
  // 7up incident: insulin advised twenty minutes after a 57 mg/dL. Under 70 there is nothing to
  // infer, the low is measured, and whatever was eaten was the treatment.
  const T = new Date("2026-07-30T22:37:00Z").getTime();
  const curve = [[-10, 73], [-4, 57], [4, 64], [12, 88]]
    .map(([m, v]) => ({ ts: T + (m as number) * 60_000, value: v as number }));
  assert.equal(eatenToTreatALow(T, curve, 35, "canette de coca"), true);
  // A whole menu at 57 is NOT treatment, though — it is a meal eaten at a bad moment. Filing it as
  // a rescue would leave 120 g uncovered; planMealDose answers it correctly with "sugar first, the
  // meal's insulin only once you are back up".
  assert.equal(eatenToTreatALow(T, curve, 120, "menu McDonald"), false)
  const child = { carbRatio: 12, correctionFactor: 50, targetMgdl: 120, weightKg: 40, rapidInsulin: "Fiasp" };
  const meal = [{ ts: new Date(T).toISOString(), description: "canette de coca", carbs_g: 35, planned: false }];
  assert.equal(mealBolusPlan(meal as any, [], T + 22 * 60_000, child, 180, curve).units, 0);
  // ...while at a merely low-ISH 78, with no low ever measured, the size still decides (the McDo).
  const lowish = [[-10, 80], [0, 78], [10, 96]].map(([m, v]) => ({ ts: T + (m as number) * 60_000, value: v as number }));
  assert.equal(eatenToTreatALow(T, lowish, 35, "canette de coca"), false);
  assert.equal(eatenToTreatALow(T, lowish, 16, "canette de coca"), true);
});

test("a missing glucose carries the same caveat as a stale one", () => {
  // computeGuard tests the absent value BEFORE staleness and answers "no_reading", so a plan built
  // with no glucose at all used to print no warning — less than a five-minute-old reading gets.
  const noRead = planMealDose({ glucoseMgdl: null, trend: "unknown", staleMin: 999, iobUnits: 0, carbsG: 60, profile: prof });
  assert.equal(noRead.reason, "stale_no_correction");
  assert.match(mealPlanLine(noRead, "fr", prof), /mesure ta glycémie/);
  assert.match(mealPlanLine(noRead, "es", prof), /mide la glucosa/);
  assert.equal(noRead.mealUnits, 5); // the carb maths is untouched: 60 / 12
});

test("a missing carb ratio costs the MEAL half only, never the correction the guard authorised", () => {
  const noIcr = { carbRatio: null as any, correctionFactor: 50, targetMgdl: 110, weightKg: 38, rapidInsulin: "NovoRapid" };
  const p = planMealDose({ glucoseMgdl: 300, trend: "rising", staleMin: 1, iobUnits: 0, carbsG: 40, profile: noIcr });
  assert.equal(p.reason, "no_ratios");
  assert.ok(p.correctionUnits > 0, "a 300 rising must still be corrected");
  const fr = mealPlanLine(p, "fr", noIcr);
  assert.match(fr, new RegExp(`${String(p.correctionUnits).replace(".", ",")} u`)); // the correction is named
  assert.match(fr, /ratio glucides manque/);
  assert.match(mealPlanLine(p, "es", noIcr), /ratio de carbohidratos/);
});

test("nothing to inject → the REASON, not a zero-unit dose instruction", () => {
  // Two sausages (~2 g) photographed while the guard blocks insulin. "0 u pour le repas" replaced
  // the sentence that said why nothing is due and when to recheck.
  const falling = planMealDose({ glucoseMgdl: 240, trend: "falling", staleMin: 1, iobUnits: 0, carbsG: 2, profile: prof });
  assert.equal(falling.totalUnits, 0);
  const fr = mealPlanLine(falling, "fr", prof);
  assert.doesNotMatch(fr, /0 u/);
  assert.match(fr, /redescend déjà toute seule/);
  const covered = planMealDose({ glucoseMgdl: 200, trend: "stable", staleMin: 1, iobUnits: 4, carbsG: 2, profile: prof });
  assert.equal(covered.totalUnits, 0);
  assert.match(mealPlanLine(covered, "fr", prof), /couvre déjà cette glycémie/);
});

// ─── Second review pass: the fixes above needed fixes of their own. ───────────────────────────────

test("a low that was already treated does not turn the next meal into a rescue", () => {
  // Hypo at noon, resucrage, back to 118 by 12:38, lunch at 12:40. The measured-low exemption used
  // to reach back 45 min with no ceiling, so the lunch was filed as treatment for a low that was
  // over — and 110 g then went uncovered for ever.
  const LUNCH = new Date("2026-07-31T12:40:00Z").getTime();
  const curve = [[-40, 65], [-34, 78], [-20, 101], [-2, 118], [10, 140]]
    .map(([m, v]) => ({ ts: LUNCH + (m as number) * 60_000, value: v as number }));
  assert.equal(eatenToTreatALow(LUNCH, curve, 110, "menu McDonald"), false);
  const un = findUncoveredMeal(
    [{ ts: new Date(LUNCH).toISOString(), carbs_g: 110, description: "menu McDonald" }] as any,
    [], LUNCH + 20 * 60_000, mcdo, curve,
  );
  assert.ok(un, "the lunch after a resolved low still needs covering");
  // ...and a rescue-sized food at that same moment is still a rescue, by the low-ish rule.
  assert.equal(eatenToTreatALow(LUNCH, [{ ts: LUNCH, value: 74 }], 15, "3 sucres"), true);
});

test("over-treating a low is still treatment, but a dinner served at 64 is still dinner", () => {
  const T = new Date("2026-07-31T20:00:00Z").getTime();
  const low = [{ ts: T - 4 * 60_000, value: 64 }, { ts: T + 8 * 60_000, value: 88 }];
  assert.equal(eatenToTreatALow(T, low, 35, "canette de coca"), true);   // a whole can
  assert.equal(eatenToTreatALow(T, low, 45, "jus + biscuits"), true);    // over-treated, still a rescue
  assert.equal(eatenToTreatALow(T, low, 90, "assiette de pâtes"), false); // a plate is a meal
  // The meal at a low is not answered with insulin NOW — it is answered with sugar first.
  const p = planMealDose({ glucoseMgdl: 64, trend: "falling", staleMin: 1, iobUnits: 0, carbsG: 90, description: "pâtes", profile: mcdo });
  assert.equal(p.reason, "hypo_first");
  assert.equal(p.totalUnits, 0);
  assert.match(mealPlanLine(p, "fr", mcdo), /sucre rapide/);
  assert.match(mealPlanLine(p, "fr", mcdo), /seulement APRÈS être remonté/);
});

test("nothing to inject → ONE sentence, never a dose instruction bolted onto it", () => {
  for (const input of [
    { glucoseMgdl: 240, trend: "falling" as const, staleMin: 1, iobUnits: 0 },
    { glucoseMgdl: 200, trend: "stable" as const, staleMin: 1, iobUnits: 4 },
    { glucoseMgdl: null, trend: "unknown" as const, staleMin: 999, iobUnits: 0 },
    { glucoseMgdl: 250, trend: "stable" as const, staleMin: 40, iobUnits: 0 },
    { glucoseMgdl: 100, trend: "stable" as const, staleMin: 1, iobUnits: 3 },
  ]) {
    for (const lang of ["fr", "es"]) {
      const line = mealPlanLine(planMealDose({ ...input, carbsG: 2, profile: prof }), lang, prof);
      assert.ok(line.trim().length > 0, `empty line for ${JSON.stringify(input)}`);
      assert.doesNotMatch(line, /Fais l'insuline|Pon la insulina|Bolus étalé|Bolo dividido/,
        `a when-to-inject instruction next to a zero dose: "${line}"`);
      assert.doesNotMatch(line, /cette dose|esta dosis/, `names a dose that does not exist: "${line}"`);
      assert.doesNotMatch(line, /0 u/);
    }
  }
});

test("a missing carb ratio during a HYPO still leads with the sugar", () => {
  const noIcr = { carbRatio: null as any, correctionFactor: 50, targetMgdl: 110, weightKg: 38, rapidInsulin: "NovoRapid" };
  const p = planMealDose({ glucoseMgdl: 45, trend: "falling", staleMin: 1, iobUnits: 2, carbsG: 40, profile: noIcr });
  assert.equal(p.reason, "no_ratios");
  const fr = mealPlanLine(p, "fr", noIcr);
  assert.match(fr, /sucre rapide/);          // the rescue the guard computed is named FIRST
  assert.match(fr, /ratio glucides manque/); // ...and the meal half still explains itself
});

test("a computable meal with no correction factor says the correction is missing", () => {
  const noIsf = { carbRatio: 10, correctionFactor: null as any, targetMgdl: null as any, weightKg: 60, rapidInsulin: "Fiasp" };
  const p = planMealDose({ glucoseMgdl: 300, trend: "rising", staleMin: 1, iobUnits: 0, carbsG: 60, profile: noIsf });
  assert.equal(p.mealUnits, 6);
  const fr = mealPlanLine(p, "fr", noIsf);
  assert.match(fr, /6 u/);
  assert.match(fr, /CORRECTION/);
  assert.match(mealPlanLine(p, "es", noIsf), /CORRECCIÓN/);
});

test("speakable: what the engine writes is not what the TTS should read", () => {
  const p = planMealDose({ glucoseMgdl: 120, trend: "stable", staleMin: 1, iobUnits: 0, carbsG: 36, description: "jus d'orange", profile: prof });
  const written = mealPlanLine(p, "fr", prof);
  assert.match(written, /≈ 9 sucre\(s\)/);          // the written form keeps the compact notation
  const spoken = speakable(written, "fr");
  assert.doesNotMatch(spoken, /sucre\(s\)|≈|⚠️/);
  assert.match(spoken, /environ 9 sucres/);
  const warned = speakable("⚠️ L'insuline déjà active va encore faire baisser", "fr");
  assert.doesNotMatch(warned, /⚠️/);
  assert.match(speakable("Para ~36 g, ≈ 9 terrón(es): 3 u", "es"), /unos 9 terrones de azúcar/);
});
