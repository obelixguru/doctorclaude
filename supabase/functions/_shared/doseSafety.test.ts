// SAFETY PROPERTIES OF THE DOSE ENGINE — swept, not sampled.
//
// Run with Node 24+ (native TS):
//   node --test supabase/functions/_shared/doseSafety.test.ts
//
// WHY THIS FILE EXISTS. On 2026-08-03 the analysis told a 40 kg child to take 4,5 u: 3 u for a meal
// eaten THREE HOURS EARLIER plus 1,5 u of correction. Those carbs were already in the 195 mg/dL on
// screen, so the correction alone covered them; the meal bolus was the same sugar billed twice. An
// hour later he was at 89 and falling with 3 u still working and nothing left to absorb.
//
// The unit tests next door check named cases. That is not enough for a dosing engine: the question
// "are there OTHER mistakes of this kind?" cannot be answered by more examples. What answers it is a
// small set of properties that must hold in EVERY state, checked over a grid of states.
//
// Each property below is a sentence a parent would recognise. When one fails, the message prints the
// exact state so it can be replayed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeGuard,
  combinedActionLine,
  mealBolusPlan,
  mealBolusHeldByIob,
  mealBolusHeldLine,
  planMealDose,
  activityBolusCut,
  carbsOnBoard,
  activeIob,
  pendingDropMgdl,
  pendingRiseMgdl,
  balanceRates,
  glucoseBalance,
  trendFromReadings,
  LOW_MGDL,
  temperatureNote,
  temperatureLowWatchBump,
  TEMP_LOW_WATCH_BUMP,
  type Trend,
  type GuardProfile,
} from "./doseGuard.ts";

// A real child's profile: the one every number in this incident belongs to.
const RYAN: GuardProfile = {
  carbRatio: 16, correctionFactor: 58, targetMgdl: 120, weightKg: 40, rapidInsulin: "Fiasp",
};
// A second, deliberately different shape (adult, stronger ratios) so nothing passes by coincidence.
const ADULT: GuardProfile = {
  carbRatio: 10, correctionFactor: 35, targetMgdl: 100, weightKg: 75, rapidInsulin: "NovoRapid",
};

const NOW = 1_800_000_000_000;
const GLUCOSES = [55, 70, 85, 100, 120, 150, 180, 220, 260, 320];
const TRENDS: Trend[] = ["rising_fast", "rising", "stable", "falling", "falling_fast", "unknown"];
const MEAL_AGES = [0, 20, 60, 120, 180, 235];      // minutes since eating
const MEAL_CARBS = [0, 20, 50, 90];
const FOODS = ["jus d'orange", "riz", "pâtes", "œuf, burrata, tomates et frites"];
const IOBS = [0, 1, 2, 4];

/** Every unit figure the action line actually names. */
function unitsIn(line: string): number[] {
  return [...line.matchAll(/(\d+(?:[.,]\d+)?)\s*u\b/g)].map((m) => Number(m[1].replace(",", ".")));
}

/** The whole engine, driven exactly the way the coach drives it. */
function runEngine(s: {
  profile: GuardProfile; glucose: number; trend: Trend; iob: number;
  carbs: number; food: string; ageMin: number;
}) {
  const mealTs = NOW - s.ageMin * 60000;
  const meals = s.carbs > 0 ? [{ ts: mealTs, carbs_g: s.carbs, description: s.food }] : [];
  const doses = s.iob > 0
    // A dose whose remaining action equals the IOB we want to test with (linear decay, 4 h).
    ? [{ ts: NOW - 60 * 60000, units: s.iob / 0.75, kind: "rapid", insulin_name: s.profile.rapidInsulin }]
    : [];
  // The curve must SPAN the meal: eatenToTreatALow reads the readings around the moment of eating,
  // and with none there it cannot tell a hypo rescue from a meal. A four-hour window covers every
  // meal age in the grid — without it the sweep reported a phantom "the bolus grew with age", which
  // was only the juice ceasing to look like a rescue because no reading existed at its timestamp.
  const readings = Array.from({ length: 49 }, (_, i) => ({
    ts: NOW - (48 - i) * 5 * 60000, value: s.glucose,
  }));
  const iob = doses.length ? activeIob(doses as any, NOW, 240) : 0;
  const cob = carbsOnBoard(meals as any, NOW);
  const plan = mealBolusPlan(meals as any, [], NOW, s.profile, 180, readings);
  const guard = computeGuard({
    glucoseMgdl: s.glucose, trend: s.trend, staleMin: 1, iobUnits: iob,
    recentHypo: false, minSinceRescue: null, profile: s.profile,
  });
  // THE COACH'S ORDER, EXACTLY. It tests mealBolusHeldByIob BEFORE building the action line; a
  // sweep that skips it is not testing the app, it is testing one function. (This harness did skip
  // it at first and reported a "1,5 u at 100 mg/dL with 1 u active" the real pipeline holds.)
  const rates = balanceRates(meals as any, doses as any, NOW, 240);
  if (plan.units > 0 && mealBolusHeldByIob(s.glucose, iob, s.profile, cob, rates)) {
    return { iob, cob, plan, guard, line: mealBolusHeldLine(s.glucose, iob, s.profile, "fr", cob), namedTotal: 0 };
  }
  const line = combinedActionLine(
    guard, plan.units, "fr", s.profile, plan.planned,
    { description: plan.description, carbsG: plan.carbsG, minutesAgo: plan.minutesAgo },
    // Exactly what the coach passes — including the insulin and carbs on board, without which the
    // landing test declines to judge (see combinedActionLine).
    { glucoseMgdl: s.glucose, trend: s.trend, rescueG: plan.rescueG, remainingG: plan.remainingG,
      iobUnits: iob, cobGrams: cob },
  );
  const named = unitsIn(line);
  return { iob, cob, plan, guard, line, namedTotal: named.length ? Math.max(...named) : 0 };
}

function everyState(fn: (s: any, r: ReturnType<typeof runEngine>) => void) {
  for (const profile of [RYAN, ADULT]) {
    for (const glucose of GLUCOSES) {
      for (const trend of TRENDS) {
        for (const iob of IOBS) {
          for (const carbs of MEAL_CARBS) {
            for (const food of (carbs > 0 ? FOODS : [FOODS[0]])) {
              for (const ageMin of (carbs > 0 ? MEAL_AGES : [0])) {
                const s = { profile, glucose, trend, iob, carbs, food, ageMin };
                fn(s, runEngine(s));
              }
            }
          }
        }
      }
    }
  }
}

const show = (s: any) =>
  `ICR${s.profile.carbRatio} g=${s.glucose} ${s.trend} iob=${s.iob} ${s.carbs}g "${s.food}" il y a ${s.ageMin}min`;

// ---- P1 — THE DOSE NEVER SENDS THE GLUCOSE UNDER 70 ---------------------------------------------
// The property tonight's bug broke. Whatever is named, the arithmetic of the app's OWN model must
// land at or above the low threshold: current + what the food still has to give − what the insulin
// (already on board + newly named) will take away.
test("P1 — no named dose lands the glucose below 70 by the engine's own arithmetic", () => {
  everyState((s, r) => {
    if (r.namedTotal <= 0) return;
    const isf = s.profile.correctionFactor as number;
    const icr = s.profile.carbRatio as number;
    // UNDISCOUNTED on purpose: pendingRiseMgdl applies COB_TRUST_FRACTION, a safety discount on the
    // food side. Judging a bolus against the discounted rise would flag every perfectly correct meal
    // dose (the bolus covers 100 % of the carbs, the model only trusts 70 % of them).
    const rise = (r.cob / icr) * isf;
    const drop = (pendingDropMgdl(r.iob, s.profile) ?? 0) + r.namedTotal * isf;
    const landing = s.glucose + rise - drop;
    assert.ok(
      landing >= LOW_MGDL - 1e-6,
      `${show(s)} -> ${r.namedTotal} u lands at ${Math.round(landing)} mg/dL\n   ${r.line}`,
    );
  });
});

// ---- P2 — NO INSULIN INTO A LOW -----------------------------------------------------------------
test("P2 — nothing is ever injected at or below the low threshold", () => {
  everyState((s, r) => {
    if (s.glucose >= LOW_MGDL) return;
    assert.equal(r.namedTotal, 0, `${show(s)} named ${r.namedTotal} u under ${LOW_MGDL}\n   ${r.line}`);
  });
});

// ---- P3 — THE SAME CARBS ARE NEVER BILLED TWICE -------------------------------------------------
// The meal half may only ever cover carbs STILL TO ABSORB. What is already digested has raised the
// glucose that the correction half is computed from — charging both is exactly the 2026-08-03 bug.
test("P3 — the meal half never exceeds the carbs still to be absorbed", () => {
  everyState((s, r) => {
    if (r.plan.units <= 0 || r.plan.planned) return;
    const icr = s.profile.carbRatio as number;
    const maxUnits = (r.plan.remainingG ?? r.plan.carbsG ?? 0) / icr;
    assert.ok(
      r.plan.units <= maxUnits + 0.5, // +0.5 = the half-unit rounding grid
      `${show(s)} -> meal half ${r.plan.units} u for only ${r.plan.remainingG} g left`,
    );
  });
});

// ---- P4 — MORE INSULIN ALREADY WORKING CAN ONLY MEAN LESS NEW INSULIN ---------------------------
test("P4 — insulin on board never increases the dose", () => {
  for (const profile of [RYAN, ADULT]) {
    for (const glucose of GLUCOSES) {
      for (const trend of TRENDS) {
        for (const carbs of MEAL_CARBS) {
          for (const ageMin of (carbs > 0 ? MEAL_AGES : [0])) {
            let prev = Infinity;
            for (const iob of IOBS) {
              const s = { profile, glucose, trend, iob, carbs, food: FOODS[1], ageMin };
              const n = runEngine(s).namedTotal;
              assert.ok(n <= prev + 1e-9, `${show(s)} -> ${n} u with iob=${iob}, but ${prev} u with less`);
              prev = n;
            }
          }
        }
      }
    }
  }
});

// ---- P5 — TIME SINCE A MEAL CAN ONLY MEAN LESS INSULIN FOR IT -----------------------------------
test("P5 — a meal's bolus never grows as the meal gets older", () => {
  for (const profile of [RYAN, ADULT]) {
    for (const glucose of GLUCOSES) {
      for (const food of FOODS) {
        for (const carbs of [20, 50, 90]) {
          let prev = Infinity;
          for (const ageMin of MEAL_AGES) {
            const s = { profile, glucose, trend: "stable" as Trend, iob: 0, carbs, food, ageMin };
            const u = runEngine(s).plan.units;
            assert.ok(u <= prev + 1e-9, `${show(s)} -> meal half ${u} u, larger than ${prev} u when fresher`);
            prev = u;
          }
        }
      }
    }
  }
});

// ---- P6 — A DOSE STAYS INSIDE WHAT A BODY THAT SIZE CAN TAKE ------------------------------------
// Not a clinical cap (the engine deliberately never clips a real carb load) — a sanity rail: no
// state in this grid may produce more than 0.3 u/kg in ONE action line.
test("P6 — no state in the grid produces an implausible dose for the weight", () => {
  everyState((s, r) => {
    const kg = s.profile.weightKg as number;
    assert.ok(
      r.namedTotal <= 0.3 * kg,
      `${show(s)} -> ${r.namedTotal} u = ${(r.namedTotal / kg).toFixed(2)} u/kg\n   ${r.line}`,
    );
  });
});

// ---- P7 — THE SCREEN NEVER CONTRADICTS ITSELF ---------------------------------------------------
// "MANGE d'abord" next to "~48 g encore en digestion" was the 20:51 report. A line that holds a
// bolus must not tell someone who already ate to eat.
test("P7 — 'eat first' is never said about a meal that is already digesting", () => {
  everyState((s, r) => {
    if (s.carbs <= 0 || s.ageMin <= 0) return;
    if (!/MANGE d'abord/.test(r.line)) return;
    assert.fail(`${show(s)} -> told to eat first about a meal eaten ${s.ageMin} min ago\n   ${r.line}`);
  });
});

// ---- P8 — THE BALANCE THE USER READS MATCHES THE DOSE THEY ARE GIVEN ----------------------------
// The analysis prints a landing figure. If it says the glucose is heading under 70 on its own, no
// insulin may be named in the same breath.
test("P8 — a CORRECTION is never named while the printed balance already lands under 70", () => {
  everyState((s, r) => {
    if (r.namedTotal <= 0) return;
    // Scoped to correction-only states: when a fresh meal is being covered, the printed balance is
    // pessimistic by design (COB_TRUST_FRACTION), and a correct meal bolus would trip this.
    if (r.plan.units > 0) return;
    const meals = s.carbs > 0 ? [{ ts: NOW - s.ageMin * 60000, carbs_g: s.carbs, description: s.food }] : [];
    const rates = balanceRates(meals as any, [], NOW, 240);
    const bal = glucoseBalance(s.glucose, r.iob, r.cob, s.profile, rates);
    if (!bal) return;
    assert.ok(
      bal.landingMgdl >= LOW_MGDL,
      `${show(s)} -> balance lands at ${bal.landingMgdl} yet ${r.namedTotal} u are named\n   ${r.line}`,
    );
  });
});

// ---- P9 — THE *OTHER* PATH: "if I eat this, how much?" ------------------------------------------
// planMealDose is a second engine, used by the MEALS screen and by an announced meal. It has its own
// hold (`lowBeforeMeal`) and does NOT go through combinedActionLine, so nothing above tests it. A
// safety property that only covers one of two paths is a false sense of safety.
test("P9 — planMealDose never names a total that lands the glucose under 70", () => {
  for (const profile of [RYAN, ADULT]) {
    const isf = profile.correctionFactor as number;
    const icr = profile.carbRatio as number;
    for (const glucose of GLUCOSES) {
      for (const trend of TRENDS) {
        for (const iob of IOBS) {
          for (const carbs of [20, 50, 90, 140]) {
            for (const food of FOODS) {
              const plan = planMealDose({
                glucoseMgdl: glucose, trend, staleMin: 1, iobUnits: iob,
                carbsG: carbs, description: food, cobGrams: 0, profile,
              });
              if (plan.totalUnits <= 0) continue;
              // The meal about to be eaten IS the rise; the bolus covers it. What is left to judge is
              // the standing insulin and the correction on top.
              const landing = glucose + (carbs / icr) * isf - (iob + plan.totalUnits) * isf;
              // EITHER the dose is safe to take now, OR the plan defers it. A deferred plan still
              // NAMES the units — you need the figure for after the rise — and mealPlanLine words it
              // as "eat first, inject once it climbs". What must never happen is a number presented
              // as due NOW that lands the child under 70.
              assert.ok(
                landing >= LOW_MGDL - 1e-6 || plan.lowBeforeMeal || plan.reason === "hypo_first",
                `ICR${icr} g=${glucose} ${trend} iob=${iob} ${carbs}g "${food}" -> ${plan.totalUnits} u due NOW, lands at ${Math.round(landing)}`,
              );
            }
          }
        }
      }
    }
  }
});

// ---- P10 — SPORT MAY ONLY EVER REDUCE ----------------------------------------------------------
// The activity cut multiplies doses. A sweep that never varies it has not tested the feature that
// changes every number in the app.
test("P10 — a logged activity can only lower a dose, never raise it", () => {
  const SESSIONS = [
    [] as any[],
    [{ ts: NOW + 30 * 60000, description: "foot", intensity: "high", duration_min: 90 }],
    [{ ts: NOW - 20 * 60000, description: "foot", intensity: "high", duration_min: 90 }],
    [{ ts: NOW - 300 * 60000, description: "vélo", intensity: "moderate", duration_min: 60 }],
  ];
  for (const profile of [RYAN, ADULT]) {
    for (const glucose of GLUCOSES) {
      for (const carbs of [20, 50, 90]) {
        const base = planMealDose({
          glucoseMgdl: glucose, trend: "stable", staleMin: 1, iobUnits: 0,
          carbsG: carbs, description: FOODS[1], cobGrams: 0, profile,
        }).totalUnits;
        for (const acts of SESSIONS) {
          const cut = activityBolusCut(acts, NOW);
          const withSport = planMealDose({
            glucoseMgdl: glucose, trend: "stable", staleMin: 1, iobUnits: 0,
            carbsG: carbs, description: FOODS[1], cobGrams: 0, activityCut: cut, profile,
          }).totalUnits;
          assert.ok(
            withSport <= base + 1e-9,
            `g=${glucose} ${carbs}g cut=${cut} -> ${withSport} u, more than the ${base} u without sport`,
          );
        }
      }
    }
  }
});

// ---- P11 — MORE THAN ONE MEAL, AND STALE DATA --------------------------------------------------
// The grid above uses one meal and one dose. Real evenings are not like that: a dinner, then a
// snack, then a sugar; a reading that stopped arriving. Both change which branch runs.
test("P11 — two meals and a stale reading never produce an unsafe dose", () => {
  const profile = RYAN;
  const isf = profile.correctionFactor as number;
  const icr = profile.carbRatio as number;
  for (const glucose of GLUCOSES) {
    for (const stale of [1, 20]) {                 // fresh vs past STALE_MIN
      for (const first of [30, 60, 90]) {
        for (const second of [0, 15, 25]) {
          const meals = [
            { ts: NOW - 150 * 60000, carbs_g: first, description: "pâtes" },
            { ts: NOW - 20 * 60000, carbs_g: second, description: "jus d'orange" },
          ].filter((m) => m.carbs_g > 0);
          const readings = Array.from({ length: 40 }, (_, i) => ({
            ts: NOW - (39 - i) * 6 * 60000, value: glucose,
          }));
          const cob = carbsOnBoard(meals as any, NOW);
          const plan = mealBolusPlan(meals as any, [], NOW, profile, 180, readings);
          const guard = computeGuard({
            glucoseMgdl: glucose, trend: "stable", staleMin: stale, iobUnits: 0,
            recentHypo: false, profile,
          });
          const line = combinedActionLine(
            guard, plan.units, "fr", profile, plan.planned,
            { description: plan.description, carbsG: plan.carbsG, minutesAgo: plan.minutesAgo },
            { glucoseMgdl: glucose, trend: "stable", remainingG: plan.remainingG,
              rescueG: plan.rescueG, iobUnits: 0, cobGrams: cob },
          );
          const named = unitsIn(line);
          if (!named.length) continue;
          const total = Math.max(...named);
          const landing = glucose + (cob / icr) * isf - total * isf;
          assert.ok(
            landing >= LOW_MGDL - 1e-6,
            `g=${glucose} stale=${stale} ${first}g+${second}g -> ${total} u lands at ${Math.round(landing)}\n   ${line}`,
          );
        }
      }
    }
  }
});

// ---- P13 — A HELD BOLUS IS HELD FOR A TRUE REASON ----------------------------------------------
// 2026-08-04, 13:20: "un bolus s'ajouterait à une chute déjà en cours" was printed while the
// glucose climbed 4 mg/dL a minute. Whatever holds a bolus, the sentence may not claim a fall
// that the state does not contain.
test("P13 — no line ever claims a fall while the trend is up", () => {
  everyState((s, r) => {
    if (s.trend !== "rising" && s.trend !== "rising_fast") return;
    assert.doesNotMatch(
      r.line, /chute déjà en cours|ça descend|caída ya en marcha/,
      `${show(s)}\n   ${r.line}`,
    );
  });
});

// ---- P14 — THE FRIES AFTERNOON, REPLAYED THROUGH THE WHOLE PIPELINE ----------------------------
// 4 August 2026: a pre-lunch 5 u at 11:05 UTC crashed 250 → 53; fries+nuggets (55 g) logged 13:10;
// at 13:20 the glucose was 140 climbing ~4 mg/dL a minute with ≈2,2 u still active. The app said
// "no insulin, keep sugar handy" — and 213 came twenty minutes later. Zero was the wrong kind of
// caution: the pipeline must name the landing-capped complement (~1,5 u) instead.
test("P14 — a fast climb through 140 with 55 g ten minutes in gets a capped complement", () => {
  const doses = [{ ts: NOW - 135 * 60000, units: 5, kind: "rapid", insulin_name: "Fiasp" }];
  const meals = [{ ts: NOW - 10 * 60000, carbs_g: 55, description: "patatas fritas y nugets con ketchup" }];
  // The real curve, minute by minute: hypo plateau, recovery, then the climb after the meal.
  const curve: Array<[number, number]> = [
    [-40, 60], [-35, 60], [-30, 66], [-25, 70], [-20, 74], [-15, 83],
    [-11, 100], [-9, 106], [-6, 118], [-4, 127], [-2, 136], [0, 140],
  ];
  const readings = curve.map(([m, v]) => ({ ts: NOW + m * 60000, value: v }));
  const iob = activeIob(doses as any, NOW, 240);
  assert.ok(Math.abs(iob - 2.19) < 0.2, `iob ${iob}`);
  const cob = carbsOnBoard(meals as any, NOW);
  const trend = trendFromReadings(readings, NOW);
  assert.ok(trend === "rising_fast" || trend === "rising", `trend ${trend}`);
  const plan = mealBolusPlan(meals as any, doses as any, NOW, RYAN, 180, readings);
  assert.ok(plan.units >= 3, `plan ${plan.units} u`);
  // The coach's order, exactly: the balance hold first, then the action line.
  const rates = balanceRates(meals as any, doses as any, NOW, 240);
  assert.equal(mealBolusHeldByIob(140, iob, RYAN, cob, rates), false);
  const guard = computeGuard({
    glucoseMgdl: 140, trend, staleMin: 1, iobUnits: iob,
    recentHypo: true, minSinceRescue: null, profile: RYAN,
  });
  const line = combinedActionLine(guard, plan.units, "fr", RYAN, plan.planned,
    { description: plan.description, carbsG: plan.carbsG, minutesAgo: plan.minutesAgo },
    { glucoseMgdl: 140, trend, rescueG: plan.rescueG, remainingG: plan.remainingG,
      iobUnits: iob, cobGrams: cob });
  const named = unitsIn(line);
  assert.ok(named.length, `held instead of capped:\n   ${line}`);
  const total = Math.max(...named);
  assert.ok(total >= 1 && total <= 2, `${total} u named\n   ${line}`);
  const landing = 140 + (cob / 16) * 58 - (iob + total) * 58;
  assert.ok(landing >= 85 - 1e-6 && landing <= 140, `lands at ${Math.round(landing)}`);
  assert.doesNotMatch(line, /chute|aucune insuline/);
});

// ---- P15 — THE JARGON BAN ----------------------------------------------------------------------
// 2026-08-04, user: no more "bolus" — only words anyone understands ("l'insuline du repas",
// "en deux fois", "~15 min avant"). Swept so a new line can never reintroduce it.
test("P15 — no line the user reads ever says 'bolus'", () => {
  everyState((s, r) => {
    assert.doesNotMatch(r.line, /\bbolus\b|\bbolo\b/i, `${show(s)}\n   ${r.line}`);
  });
});

// ---- P12 — THE WEATHER MAY NEVER MOVE A DOSE ---------------------------------------------------
// Temperature earns vigilance, not arithmetic. Unlike sport there is no clinical figure behind it,
// so if it ever changed a number that number would be invented. This is the property that keeps it
// honest, and it is the reason temperature is not plumbed into any dose path at all.
test("P12 — temperature changes vigilance and wording, never a unit", () => {
  for (const profile of [RYAN, ADULT]) {
    for (const glucose of GLUCOSES) {
      for (const carbs of [20, 50, 90]) {
        const plans = [-5, 2, 15, 22, 35, 41].map((t) => ({
          t,
          plan: planMealDose({
            glucoseMgdl: glucose, trend: "stable", staleMin: 1, iobUnits: 0,
            carbsG: carbs, description: FOODS[1], cobGrams: 0, profile,
          }),
        }));
        const ref = plans[0].plan.totalUnits;
        for (const { t, plan } of plans) {
          assert.equal(plan.totalUnits, ref, `temperature ${t} °C moved the dose to ${plan.totalUnits}`);
        }
      }
    }
  }
});

test("P12b — the note is silent in ordinary weather and speaks at the extremes", () => {
  for (const t of [6, 12, 18, 24, 29]) {
    assert.equal(temperatureNote(t, "fr"), "", `${t} °C should say nothing`);
    assert.equal(temperatureLowWatchBump(t), 0);
  }
  assert.match(temperatureNote(34, "fr"), /PLUS VITE/);
  assert.match(temperatureNote(34, "fr"), /La dose ne change pas/);
  assert.equal(temperatureLowWatchBump(34), TEMP_LOW_WATCH_BUMP);
  assert.match(temperatureNote(-2, "fr"), /PLUS LENTEMENT/);
  assert.equal(temperatureLowWatchBump(-2), 0);   // cold is a LATE dose, not a fast one
  // Indoors on a hot day is air conditioning: the weather is stated, the warning is dropped.
  assert.match(temperatureNote(34, "fr", false), /à l'intérieur/);
  assert.doesNotMatch(temperatureNote(34, "fr", false), /PLUS VITE/);
  // No reading at all is not "mild": it is nothing to say.
  assert.equal(temperatureNote(null, "fr"), "");
  assert.equal(temperatureNote(undefined, "fr"), "");
  assert.match(temperatureNote(34, "es"), /MÁS RÁPIDO/);
});
