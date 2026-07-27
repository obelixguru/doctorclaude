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
  iobStatusPhrase,
  iobSystemLine,
  combinedActionLine,
  stripInsulinNumbers,
  sugarTimingFact,
  hypoIobWarning,
  mealCarbSpeed,
  carbSpeedAdvice,
  starchyCarbNote,
  findUncoveredMeal,
  mealBolusPlan,
  isHypoRescue,
  carbsOnBoard,
  planMealDose,
  mealPlanLine,
  uncoveredMealWarning,
  inRangeActionLine,
  plannedMealNote,
  carbEstimationRules,
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

test("findUncoveredMeal: ignores planned, snack-size (<15 g) and fully-digested meals", () => {
  assert.equal(findUncoveredMeal([{ ts: minAgo(30), carbs_g: 40, description: "pizza", planned: true }], [], NOW, prof), null);
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

// ---- Regression: FOOD must be dosed even when the glucose is IN RANGE ---------------------------
// The reported failure: ~120 g of carbs ("30 sucres") logged at 175 mg/dL came back "attends d'être
// au-dessus de 180" — no dose anywhere. Two causes, both in the CALLERS, not in the math: the coach
// passed mealUnits = 0 unconditionally, and ask only computed a bolus when the model tagged the carbs
// basis:"stated". The guard still owns the CORRECTION half (still none at 175, unchanged below); what
// was missing is the MEAL bolus, which carb counting owes whatever the current glucose is.

test("mealBolusPlan: uncovered eaten meal is dosed NOW, even with the glucose in range", () => {
  const meals = [{ ts: minAgo(20), carbs_g: 120, description: "30 sucres" }];
  const plan = mealBolusPlan(meals, [], NOW, prof);
  assert.equal(plan.planned, false);
  assert.equal(plan.units, 10); // 120 / 12
  assert.equal(plan.carbsG, 120);
  const g = computeGuard({ glucoseMgdl: 175, trend: "stable", staleMin: 2, iobUnits: 0, recentHypo: false, profile: prof });
  assert.equal(g.reason, "in_range");      // no CORRECTION at 175 — that invariant is untouched
  assert.equal(g.maxInsulinUnits, 0);      // …and the guard still authorises no correction insulin
  assert.equal(combinedActionLine(g, plan.units, "fr", prof, plan.planned), "10 u de NovoRapid pour le repas.");
});

test("mealBolusPlan: announced future meal is dosed AT EATING TIME, never now", () => {
  const meals = [{ ts: new Date(NOW + 40 * 60000).toISOString(), carbs_g: 60, description: "McDo", planned: true }];
  const plan = mealBolusPlan(meals, [], NOW, prof);
  assert.equal(plan.planned, true);
  assert.equal(plan.units, 5); // 60 / 12
  const g = computeGuard({ glucoseMgdl: 140, trend: "stable", staleMin: 2, iobUnits: 0, recentHypo: false, profile: prof });
  assert.match(combinedActionLine(g, plan.units, "fr", prof, plan.planned), /5 u de NovoRapid AU MOMENT de manger/);
});

test("mealBolusPlan: an uncovered EATEN meal outranks an announced one (never two boluses at once)", () => {
  const meals = [
    { ts: minAgo(30), carbs_g: 48, description: "riz" },
    { ts: new Date(NOW + 60 * 60000).toISOString(), carbs_g: 60, description: "McDo", planned: true },
  ];
  const plan = mealBolusPlan(meals, [], NOW, prof);
  assert.equal(plan.planned, false);
  assert.equal(plan.units, 4); // 48 / 12 — the eaten one, due now
});

test("mealBolusPlan: nothing to cover / already covered / no carb ratio -> no units", () => {
  assert.deepEqual(mealBolusPlan([], [], NOW, prof), { units: 0, planned: false, carbsG: null });
  const eaten = [{ ts: minAgo(30), carbs_g: 48, description: "riz" }];
  assert.equal(mealBolusPlan(eaten, [{ ts: minAgo(30), units: 4, kind: "rapid" }], NOW, prof).units, 0);
  // Announced meal, no ratios: carbs are known but no number may be invented — the caller then falls
  // back to plannedMealNote's dose-free wording.
  const p = mealBolusPlan([{ ts: new Date(NOW + 30 * 60000).toISOString(), carbs_g: 60, planned: true }], [], NOW, { weightKg: 38 });
  assert.equal(p.units, 0);
  assert.equal(p.planned, true);
  assert.equal(p.carbsG, 60);
});

test("mealBolusPlan: an announced meal older than the window is ignored", () => {
  assert.equal(mealBolusPlan([{ ts: minAgo(300), carbs_g: 60, description: "McDo", planned: true }], [], NOW, prof).units, 0);
});

test("meal bolus never overrides a hypo: sugar first, no units while low", () => {
  const plan = mealBolusPlan([{ ts: minAgo(20), carbs_g: 120, description: "30 sucres" }], [], NOW, prof);
  const g = computeGuard({ glucoseMgdl: 58, trend: "falling", staleMin: 2, iobUnits: 0, recentHypo: true, profile: prof });
  const line = combinedActionLine(g, plan.units, "fr", prof, plan.planned);
  assert.match(line, /sucre rapide/);
  assert.doesNotMatch(line, /u de NovoRapid/);
});

// ---- PROSPECTIVE dosing: "if I eat this, how much?" ---------------------------------------------
// The deeper report: reacting to the CURRENT glucose is useless day to day. 30 sucres (~120 g) is a
// +500 mg/dL load on this profile — you have to know the dose BEFORE eating, not discover 350 after.

const planBase = { trend: "stable" as const, staleMin: 2, iobUnits: 0, profile: prof };

test("planMealDose: 120 g at 175 -> 10 u, and names the +500 mg/dL it would cause uncovered", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 175, carbsG: 120, description: "30 sucres" });
  assert.equal(p.mealUnits, 10);          // 120 / 12
  assert.equal(p.correctionUnits, 0);     // 175 is in range — no correction, invariant untouched
  assert.equal(p.totalUnits, 10);
  assert.equal(p.expectedRiseMgdl, 500);  // (120/12) * 50
  assert.equal(p.projectedUncoveredMgdl, 600); // 175 + 500, clamped at the projection ceiling
  assert.equal(p.speed, "fast");
  assert.equal(p.timing, "prebolus");
  const line = mealPlanLine(p, "fr", prof);
  assert.match(line, /10 u de NovoRapid pour le repas/);
  assert.match(line, /environ 500 mg\/dL/);
  assert.match(line, /au-delà de 600/);
  assert.match(line, /15 min AVANT/);
});

test("planMealDose: meal + a real high sums into ONE total, correction from the guard", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 250, carbsG: 60, description: "riz" });
  assert.equal(p.mealUnits, 5);        // 60 / 12
  assert.equal(p.correctionUnits, 3);  // (250-110)/50 = 2.8 -> 3
  assert.equal(p.totalUnits, 8);
  assert.match(mealPlanLine(p, "fr", prof), /8 u de NovoRapid au total \(5 u pour le repas \+ 3 u de correction\)/);
});

test("planMealDose: insulin on board is deducted from the correction, never from the meal", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 250, carbsG: 60, description: "riz", iobUnits: 2 });
  assert.equal(p.mealUnits, 5);        // food still needs its full cover
  assert.equal(p.correctionUnits, 1);  // 2.8 - 2 = 0.8 -> 1
  assert.equal(p.totalUnits, 6);
});

test("planMealDose: falling glucose -> no correction and NEVER a pre-bolus", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 250, trend: "falling", carbsG: 40, description: "jus d'orange" });
  assert.equal(p.correctionUnits, 0);   // guard: falling -> none
  assert.equal(p.totalUnits, p.mealUnits);
  assert.equal(p.timing, "at_meal");    // fast carbs, but falling -> no pre-bolus
});

test("planMealDose: hypo first — nothing to inject, the meal dose is deferred", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 58, trend: "falling", carbsG: 60, description: "pâtes" });
  assert.equal(p.reason, "hypo_first");
  assert.equal(p.totalUnits, 0);        // never inject while low
  assert.equal(p.timing, "after_meal");
  const line = mealPlanLine(p, "fr", prof);
  assert.match(line, /^11 g de sucre rapide/); // the GRAMS lead — that is the number that matters now
  assert.match(line, /APRÈS être remonté/);
  assert.equal(line.match(/APRÈS/g)?.length, 1); // said once — the head owns it, no timing echo
});

test("planMealDose: slow / fatty meals get a split bolus, not a pre-bolus", () => {
  assert.equal(planMealDose({ ...planBase, glucoseMgdl: 140, carbsG: 70, description: "pâtes complètes" }).timing, "split");
  assert.equal(planMealDose({ ...planBase, glucoseMgdl: 140, carbsG: 90, description: "McDo" }).timing, "split");
});

test("planMealDose: stale data -> meal bolus still allowed, correction withheld", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 250, staleMin: 40, carbsG: 60, description: "riz" });
  assert.equal(p.reason, "stale_no_correction");
  assert.equal(p.correctionUnits, 0);
  assert.equal(p.totalUnits, 5); // food is still food
  assert.match(mealPlanLine(p, "fr", prof), /sans correction/);
});

test("planMealDose: no carb ratio -> no invented number, says what's missing", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 175, carbsG: 120, profile: { weightKg: 38 } });
  assert.equal(p.reason, "no_ratios");
  assert.equal(p.totalUnits, 0);
  assert.match(mealPlanLine(p, "fr", { weightKg: 38 }), /ratio glucides manque/);
});

test("planMealDose: no carbs given -> asks what the meal is, no dose", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 175, carbsG: null });
  assert.equal(p.reason, "no_carbs");
  assert.equal(p.totalUnits, 0);
  assert.match(mealPlanLine(p, "fr", prof), /Dis-moi ce que tu vas manger/);
});

test("planMealDose: ES wording mirrors FR", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 175, carbsG: 120, description: "30 terrones" });
  const es = mealPlanLine(p, "es", prof);
  assert.match(es, /10 u de NovoRapid para la comida/);
  assert.match(es, /~500 mg\/dL/);
  assert.match(es, /15 min ANTES/);
});

test("planMealDose: falling FAST on fast carbs -> dose still given, but cautioned", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 250, trend: "falling_fast", carbsG: 40, description: "jus d'orange" });
  assert.equal(p.fastFallCaution, true);
  assert.equal(p.mealUnits, 3.5); // a real meal on a fast fall still needs cover — we warn, not hide
  assert.match(mealPlanLine(p, "fr", prof), /descends VITE.*ne le couvre pas/s);
  // …and not raised for a slow meal or a steady glucose
  assert.equal(planMealDose({ ...planBase, glucoseMgdl: 250, trend: "falling_fast", carbsG: 70, description: "pâtes" }).fastFallCaution, false);
  assert.equal(planMealDose({ ...planBase, glucoseMgdl: 250, carbsG: 40, description: "jus d'orange" }).fastFallCaution, false);
});

test("planMealDose: during a hypo the projection is dropped — 'sugar first' must not compete", () => {
  const line = mealPlanLine(planMealDose({ ...planBase, glucoseMgdl: 58, trend: "falling", carbsG: 70, description: "pâtes" }), "fr", prof);
  assert.match(line, /g de sucre rapide/);
  assert.doesNotMatch(line, /fait monter d'environ/);
});

// ---- Heading LOW before the meal can act --------------------------------------------------------
// The gap this closes: 100 mg/dL falling with 3 u still on board is ~150 mg/dL of drop still to come.
// The meal bolus was correct for the carbs and stated with no caveat — a right number at a wrong
// moment. The dose stays; the TIMING moves to after the rise, and the pending drop is named.

test("planMealDose: insulin on board dragging under 70 -> defer the bolus, name the floor", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 100, trend: "falling", iobUnits: 3, carbsG: 120, description: "30 sucres" });
  assert.equal(p.lowBeforeMeal, true);
  assert.equal(p.floorMgdl, -50);      // 100 − 3×50: the drop still owed, unclamped on purpose
  assert.equal(p.timing, "after_meal");
  assert.equal(p.mealUnits, 10);       // the carbs still need their full cover — only the timing moves
  assert.equal(p.pendingDropMgdl, 150); // 3 u x 50 — shown instead of the nonsensical -50 floor
  const line = mealPlanLine(p, "fr", prof);
  assert.match(line, /va encore faire baisser d'environ 150 mg\/dL/);
  assert.match(line, /mange d'abord/);
  assert.doesNotMatch(line, /-50/);                       // never print a negative glucose
  assert.equal(line.match(/mange d'abord/g)?.length, 1);  // instruction stated once, not twice
});

test("planMealDose: already low-ish AND falling, no IOB -> eat first, inject after the rise", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 90, trend: "falling", carbsG: 120, description: "30 sucres" });
  assert.equal(p.lowBeforeMeal, true);
  assert.equal(p.timing, "after_meal");
  assert.match(mealPlanLine(p, "fr", prof), /bas et en train de descendre/);
});

test("planMealDose: falling but comfortably in range -> normal at-meal timing, no scare", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 150, trend: "falling", carbsG: 120, description: "30 sucres" });
  assert.equal(p.lowBeforeMeal, false);
  assert.equal(p.timing, "at_meal");
  assert.doesNotMatch(mealPlanLine(p, "fr", prof), /⚠️/);
});

test("planMealDose: a real hypo still takes priority over the low-before-meal path", () => {
  const p = planMealDose({ ...planBase, glucoseMgdl: 60, trend: "falling", iobUnits: 3, carbsG: 120, description: "30 sucres" });
  assert.equal(p.reason, "hypo_first");
  assert.equal(p.lowBeforeMeal, false); // hypo wording owns the message, no competing warning
  assert.equal(p.totalUnits, 0);
});

// ---- Audit findings: a RESCUE is not a MEAL ----------------------------------------------------
// Both directions were wrong. 15 g of sugar taken to stop a fall came back as "1,5 u for the meal"
// (insulin advised to cover a hypo treatment), and 80 g of rice eaten 10 min before a 65 mg/dL
// triggered the rule-of-15 hold ("you already took sugar, wait") — rice lifts nothing in 15 min.

test("isHypoRescue: small fast sugar yes, a plate no, unknown quantity assumed yes", () => {
  assert.equal(isHypoRescue({ carbs_g: 15, description: "3 sucres" }), true);
  assert.equal(isHypoRescue({ carbs_g: 20, description: "jus d'orange" }), true);
  assert.equal(isHypoRescue({ carbs_g: 80, description: "riz poulet" }), false);
  assert.equal(isHypoRescue({ carbs_g: 40, description: "3 sucres" }), false); // too big to be a rescue
  assert.equal(isHypoRescue({ carbs_g: 20, description: "pâtes" }), false);    // small but SLOW
  assert.equal(isHypoRescue({ description: "quelque chose" }), true);          // unknown → safe side
});

test("a real MEAL does not trigger the rule-of-15 hold on a hypo", () => {
  const meals = [{ ts: NOW - 10 * 60000, carbs_g: 80, description: "riz poulet", planned: false }];
  assert.equal(minutesSinceLastRescue(meals, NOW), null); // rice is not a rescue
  const g = computeGuard({ ...base, glucoseMgdl: 65, trend: "falling", minSinceRescue: minutesSinceLastRescue(meals, NOW) });
  assert.equal(g.kind, "sugar"); // sugar IS given — the old code said "wait, you already ate"
  // …while an actual rescue still holds
  const rescue = [{ ts: NOW - 5 * 60000, carbs_g: 15, description: "3 sucres", planned: false }];
  assert.equal(minutesSinceLastRescue(rescue, NOW), 5);
});

test("a hypo rescue is never advised a meal bolus", () => {
  const rescue = [{ ts: minAgo(5), carbs_g: 15, description: "3 sucres" }];
  assert.equal(findUncoveredMeal(rescue, [], NOW, prof), null);
  assert.equal(mealBolusPlan(rescue, [], NOW, prof).units, 0); // used to advise 1,5 u for the sugar
});

// ---- Audit findings: in range is not always safe -----------------------------------------------

test("in range but insulin on board heads under 70 -> warn instead of 'nothing to correct'", () => {
  const doses = [{ ts: minAgo(30), units: 3.5, kind: "rapid" }];
  const fr = inRangeActionLine([], doses, flat(90), NOW, prof, "fr");
  assert.match(fr, /insuline active/);
  assert.match(fr, /sous 70/);
  assert.doesNotMatch(fr, /rien à corriger/);
});

test("a meal bolus taken WITH its meal must NOT read as an incoming hypo (no crying wolf)", () => {
  // 2 u for 20 g eaten 10 min ago: balanced. Netting the carbs off is what keeps this quiet.
  const meals = [{ ts: minAgo(10), carbs_g: 20, description: "2 saucisses" }];
  const doses = [{ ts: minAgo(8), units: 2, kind: "rapid" }];
  assert.match(inRangeActionLine(meals, doses, flat(112), NOW, prof, "fr"), /dans la cible/);
});

test("carbsOnBoard: decays over the carb-speed window, ignores planned meals", () => {
  assert.equal(Math.round(carbsOnBoard([{ ts: minAgo(0), carbs_g: 60, description: "riz" }], NOW)), 60);
  assert.equal(Math.round(carbsOnBoard([{ ts: minAgo(90), carbs_g: 60, description: "riz" }], NOW)), 30); // 180 min window
  assert.equal(carbsOnBoard([{ ts: minAgo(300), carbs_g: 60, description: "riz" }], NOW), 0);
  assert.equal(carbsOnBoard([{ ts: minAgo(10), carbs_g: 60, description: "riz", planned: true }], NOW), 0);
});
