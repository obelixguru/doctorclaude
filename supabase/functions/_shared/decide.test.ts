// The one decision: same state in, same answer out, on every surface.
//   node --no-warnings --test supabase/functions/_shared/decide.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anticipate, buildState, carbRoomG, clock, CONFIRM_VALID_MIN, decideAction, decisionHint, decisionPayload, DOSE_FLOOR_MGDL, engineFacts, forecastLine,
  forecastNote, historyLowAhead, insulinKnowledge, INSULIN_MEMORY_MIN, lastCountedDoseMs, openPendingDose,
  PENDING_GRACE_MIN, PENDING_MAX_MIN, projectOnBoard, safeDose, sideNotes, slowInsulinDaysLeft, timedSeries, withVerb,
} from "./decide.ts";
import {
  despikeStream, fitForecastModel, forecastGlucose, gridOf, HARD_HIT_FACTOR, HARD_HIT_MAX, LOWEST_WARN_BELOW, MEASURED_MIN_DAYS,
  REGIME_SETTLED_DAYS, riskCell, scoreDoses, scoreForecasts,
  blindFall,
} from "./forecast.ts";
import { basalNotice, curveOf, fractionRemaining, insulinByName, isBasalInsulin } from "./insulins.ts";
import { doseSaidAgain, mealSaidAgain, mergeReadings, saidBasalDose, saysAnotherDose, saysAnotherPlate, tzOffsetOf } from "./engineData.ts";
import {
  activeIob, dosingIob, eatenAsTreatment, eatenToTreatALow, findUncoveredMeal, mealPlanLine, planMealDose, stripInsulinNumbers, toGuardProfile,
} from "./doseGuard.ts";

const NOW = Date.UTC(2026, 10, 6, 19, 0); // 20:00 in Valencia
const TZ = 60;
const min = (m: number) => NOW + m * 60000;
const RYAN = {
  carb_ratio: 16, correction_factor: 58, target_mgdl: 120, weight_kg: 40,
  rapid_insulin: "Fiasp", basal_insulin: "Lantus",
};
const curve = (pairs: [number, number][]) => pairs.map(([m, v]) => ({ ts: min(m), value: v }));
const flat = (v: number) => curve([[-40, v], [-35, v], [-30, v], [-25, v], [-20, v], [-15, v], [-10, v], [-5, v], [0, v]]);
const rising = (v: number, perMin: number) => [-40, -35, -30, -25, -20, -15, -10, -5, 0].map((m) => ({ ts: min(m), value: v + m * perMin }));
const state = (o: any = {}) => buildState({
  nowMs: NOW, lang: "fr", tzOffsetMin: TZ, profile: { ...RYAN, ...(o.profile ?? {}) },
  readings: o.readings ?? flat(120), insulin: o.insulin ?? [], meals: o.meals ?? [], activity: o.activity ?? [],
  model: o.model ?? null, sensorExpired: o.sensorExpired,
});

test("clock: local hour, not UTC", () => {
  assert.equal(clock(NOW, 60), "20:00");
  assert.equal(clock(NOW, 0), "19:00");
  assert.equal(clock(Date.UTC(2026, 10, 6, 23, 30), 60), "00:30");
});

test("knowing nothing about the last 3 h is not knowing there was nothing", () => {
  assert.equal(insulinKnowledge([], NOW, null), "unknown");
  assert.equal(insulinKnowledge([{ ts: min(-INSULIN_MEMORY_MIN - 1), units: 3, kind: "rapid" }], NOW, null), "unknown");
  assert.equal(insulinKnowledge([{ ts: min(-90), units: 3, kind: "rapid" }], NOW, null), "logged");
  // A basal dose says nothing about the rapid insulin.
  assert.equal(insulinKnowledge([{ ts: min(-30), units: 15, kind: "basal" }], NOW, null), "unknown");
  assert.equal(insulinKnowledge([{ ts: min(-30), units: 15, kind: "rapid", insulin_name: "Tresiba" }], NOW, null), "unknown");
  assert.equal(insulinKnowledge([], NOW, min(-10)), "confirmed_none");
  assert.equal(insulinKnowledge([], NOW, min(-CONFIRM_VALID_MIN - 1)), "unknown");
});

test("a dose told late keeps the last 3 h known from the moment it was told", () => {
  const told = (injected: number, at: number, o: any = {}) => [{ ts: min(injected), created_at: min(at), units: 8, kind: "rapid", ...o }];
  // 7 November: injected at 09:14, dictated at 11:15 as "il y a 2 heures", analysis at 12:46.
  assert.equal(insulinKnowledge(told(-212, -91), NOW, null), "told");
  // Injected inside the window, however late it was told, it is simply on record.
  assert.equal(insulinKnowledge(told(-120, -5), NOW, null), "logged");
  // Saying that nothing was done since is more than a telling.
  assert.equal(insulinKnowledge(told(-212, -91), NOW, min(-10)), "confirmed_none");
  // It lasts three hours from the telling, like a dose logged on the spot.
  assert.equal(insulinKnowledge(told(-299, -INSULIN_MEMORY_MIN + 1), NOW, null), "told");
  assert.equal(insulinKnowledge(told(-301, -INSULIN_MEMORY_MIN - 1), NOW, null), "unknown");
  // "Il y a 3 heures": the model took 12 seconds before the row was written.
  assert.equal(insulinKnowledge(told(-240.2, -60), NOW, null), "told");
  assert.equal(insulinKnowledge(told(-244.5, -60), NOW, null), "told");
  // Told with more than 3 h behind it, a dose is a note in the diary.
  assert.equal(insulinKnowledge(told(-245.5, -60), NOW, null), "unknown");
  assert.equal(insulinKnowledge(told(-900, -30), NOW, null), "unknown");
  // A basal dose still says nothing about the rapid insulin, told late or not.
  assert.equal(insulinKnowledge(told(-212, -91, { kind: "basal" }), NOW, null), "unknown");
  assert.equal(insulinKnowledge(told(-212, -91, { kind: "rapid", insulin_name: "Tresiba" }), NOW, null), "unknown");
  // Looking back at a moment before it was told, nobody knew yet.
  assert.equal(insulinKnowledge(told(-181, 2), NOW, null), "unknown");
  // Told now for later: not injected, it answers nothing.
  assert.equal(insulinKnowledge(told(30, -5), NOW, null), "unknown");
  // A row without the telling keeps the old answer.
  assert.equal(insulinKnowledge([{ ts: min(-212), created_at: null, units: 8, kind: "rapid" }], NOW, null), "unknown");
});

test("told late, the model still hears that nothing is on record for those hours", () => {
  const s = state({ readings: flat(150), insulin: [{ ts: min(-299), created_at: min(-179), units: 8, kind: "rapid" }] });
  assert.equal(s.knowledge, "told");
  const facts = engineFacts(s, decideAction(s), null);
  assert.match(facts, /NE dis PAS qu'il n'y a pas d'insuline active/);
  assert.doesNotMatch(facts, /INCONNUE/);
});

test("a dose told late changes the question, never the figure", () => {
  const readings = rising(155, 1.5);
  const meals = [{ ts: min(-86), description: "tartines", carbs_g: 40, planned: false, carbs_estimated: true }];
  const dose = { ts: min(-212), units: 8, kind: "rapid", insulin_name: "Fiasp" };
  const told = decideAction(state({ readings, meals, insulin: [{ ...dose, created_at: min(-91) }] }), { concise: true });
  const blind = decideAction(state({ readings, meals, insulin: [{ ...dose, created_at: min(-200) }] }), { concise: true });
  assert.equal(blind.kind, "dose_if");
  assert.match(blind.line, /^Si aucune insuline rapide depuis 3 h/);
  assert.equal(told.kind, "dose");
  assert.doesNotMatch(told.line, /depuis 3 h|note-la d'abord/);
  assert.ok(told.units > 0);
  assert.equal(told.units, blind.units);
  assert.match(told.line, /^Si c'est bien ~40 g de glucides : fais /);
});

test("a correction with the last 3 h unknown is conditional, and says what to do otherwise", () => {
  const s = state({ readings: flat(240) });
  const d = decideAction(s);
  assert.equal(d.kind, "dose_if");
  assert.equal(d.units, 1.5);
  assert.match(d.line, /^Si aucune insuline rapide depuis 3 h : fais 1,5 u de Fiasp maintenant\./);
  assert.match(d.line, /note-la d'abord/);
});

test("the same correction with a dose on record, or a stated none, is a firm instruction", () => {
  const logged = decideAction(state({ readings: flat(300), insulin: [{ ts: min(-175), units: 1, kind: "rapid", insulin_name: "Fiasp" }] }));
  assert.equal(logged.kind, "dose");
  assert.match(logged.line, /^Fais \d/);
  const none = decideAction(state({ readings: flat(240), profile: { no_insulin_confirmed_at: new Date(min(-5)).toISOString() } }));
  assert.equal(none.kind, "dose");
  assert.equal(none.units, 1.5);
  assert.match(none.line, /^Fais 1,5 u de Fiasp maintenant\. Pas plus : au-delà, ça pourrait passer sous 100\. Regarde de nouveau à 21:30/);
});

test("a dose to do always has a verb: « 3 u de Fiasp » read as a dose already done", () => {
  assert.equal(withVerb("3 u de Fiasp maintenant.", "fr"), "Fais 3 u de Fiasp maintenant.");
  assert.equal(withVerb("3 u de Fiasp ahora.", "es"), "Pon 3 u de Fiasp ahora.");
  assert.equal(withVerb("2,5 u de Fiasp pour le repas.", "fr"), "Fais 2,5 u de Fiasp pour le repas.");
  assert.equal(
    withVerb("maintenant : 1 u de Fiasp en correction ; au moment de manger : 3 u pour le repas.", "fr"),
    "Maintenant : fais 1 u de Fiasp en correction ; au moment de manger : 3 u pour le repas.",
  );
  assert.equal(
    withVerb("Pour ~60 g de glucides, ≈ 15 sucre(s) : 4 u de Fiasp pour le repas.", "fr"),
    "Pour ~60 g de glucides, ≈ 15 sucre(s) : fais 4 u de Fiasp pour le repas.",
  );
});

test("six analyses in 46 minutes cannot add up: a named dose must be answered first", () => {
  const profile = { no_insulin_confirmed_at: new Date(min(-20)).toISOString(), pending_action: { units: 2, at: min(-15), insulin: "Fiasp" } };
  const d = decideAction(state({ readings: flat(240), profile }));
  assert.equal(d.kind, "ask_done");
  assert.equal(d.units, 0);
  assert.match(d.line, /Les 2 u de Fiasp proposées à 19:45 ont-elles été faites/);
  assert.doesNotMatch(d.line, /^Fais/);
});

test("just named: the same dose stands until there has been time to do it", () => {
  const profile = { no_insulin_confirmed_at: new Date(min(-20)).toISOString(), pending_action: { units: 1.5, at: min(-(PENDING_GRACE_MIN - 1)), insulin: "Fiasp" } };
  const d = decideAction(state({ readings: flat(240), profile }));
  assert.equal(d.kind, "dose");
  assert.equal(d.units, 1.5);
});

test("a dose logged since settles the question, whatever its size", () => {
  const pending = { units: 2, at: min(-30), insulin: "Fiasp" };
  assert.equal(openPendingDose(pending, [{ ts: min(-25), units: 1.5, kind: "rapid" }], NOW), null);
  assert.deepEqual(openPendingDose(pending, [{ ts: min(-200), units: 1.5, kind: "rapid" }], NOW), pending);
  assert.equal(openPendingDose({ units: 2, at: min(-PENDING_MAX_MIN - 1) }, [], NOW), null);
  assert.equal(openPendingDose(null, [], NOW), null);
});

test("a low always answers first, known or not, asked or not", () => {
  const profile = { pending_action: { units: 2, at: min(-30), insulin: "Fiasp" } };
  const d = decideAction(state({ readings: flat(60), profile }));
  assert.equal(d.kind, "sugar");
  assert.ok(d.sugarGrams >= 12);
  assert.match(d.line, /^Prends \d+ g de sucre/);
  assert.equal(d.units, 0);
});

test("no live glucose: no dose, whatever was logged", () => {
  const readings = curve([[-60, 240], [-50, 245], [-40, 250]]);
  const d = decideAction(state({ readings, insulin: [{ ts: min(-100), units: 1, kind: "rapid", insulin_name: "Fiasp" }] }));
  assert.equal(d.kind, "signal");
  assert.equal(d.units, 0);
  assert.match(d.line, /Signal perdu/);
  const expired = decideAction(state({ readings, sensorExpired: true }));
  assert.match(expired.line, /Capteur expiré/);
});

test("in range with nothing happening: nothing to do, in those words", () => {
  const d = decideAction(state({ readings: flat(120) }));
  assert.equal(d.kind, "fine");
  assert.equal(d.units, 0);
  assert.match(d.line, /rien à corriger/);
});

test("a meal announced for later names its dose without making it due", () => {
  const meals = [{ ts: min(30), description: "pâtes", carbs_g: 64, planned: true }];
  const d = decideAction(state({ meals, readings: flat(130) }));
  assert.equal(d.kind, "dose_later");
  assert.equal(d.units, 0);
  assert.equal(d.laterUnits, 1);
  assert.match(d.line, /^Pour ~64 g de glucides : 1 u de Fiasp au moment de manger\./);
});

test("analysis and photo agree on the same plate: the meal just logged and the meal under discussion", () => {
  const plate = { description: "riz et poulet", carbs_g: 48, planned: false, ts: min(-1) };
  const base = { profile: { no_insulin_confirmed_at: new Date(min(-5)).toISOString() }, readings: flat(150) };
  const analysis = decideAction(state({ ...base, meals: [plate] }));
  const photo = decideAction(state(base), { candidate: { carbsG: 48, description: "riz et poulet" } });
  assert.equal(analysis.units, 1.5);
  assert.equal(analysis.units, photo.units);
  assert.equal(analysis.kind, photo.kind);
  assert.equal(analysis.line, photo.line);
});

test("voice and analysis agree: a meal said aloud counts like a meal logged", () => {
  const row = { ts: min(0), description: "pizza", carbs_g: 80, planned: false };
  const known = { no_insulin_confirmed_at: new Date(min(-5)).toISOString() };
  const said = decideAction(state({ meals: [row], profile: known, readings: rising(160, 1) }));
  assert.equal(said.units, 1.5);
  assert.match(said.line, /fais 1,5 u de Fiasp/i);
});

test("a dose reported aloud is counted before the next dose is decided", () => {
  const known = { no_insulin_confirmed_at: new Date(min(-5)).toISOString() };
  const before = decideAction(state({ readings: flat(240), profile: known }));
  assert.equal(before.units, 1.5);
  const after = decideAction(state({
    readings: flat(240), profile: known,
    insulin: [{ ts: min(0), units: 2, kind: "rapid", insulin_name: "Fiasp" }],
  }));
  assert.equal(after.units, 0);
  assert.equal(after.kind, "hold");
});

// ---- Looking ahead ------------------------------------------------------------------------------
test("what is on board and takes him under 70 is said before it happens, with a time", () => {
  const s = state({ readings: flat(200), insulin: [{ ts: min(-30), units: 3, kind: "rapid", insulin_name: "Fiasp" }] });
  const proj = projectOnBoard(s)!;
  assert.ok(proj.underLowAtMin != null);
  const a = anticipate(s, decideAction(s))!;
  assert.equal(a.kind, "insulin_low");
  assert.match(a.line, /sous 70, surtout vers \d\d:\d\d/);
  assert.match(a.line, /Garde du sucre à portée/);
  assert.ok((a.recheckAtMs as number) > NOW);
});

test("when the action already warns of the low, it is not said twice", () => {
  const s = state({ readings: flat(130), insulin: [{ ts: min(-30), units: 3, kind: "rapid", insulin_name: "Fiasp" }] });
  const d = decideAction(s);
  assert.match(d.line, /sous 70/);
  assert.notEqual(anticipate(s, d)?.kind, "insulin_low");
});

test("food on board that covers the insulin stands the warning down", () => {
  const s = state({
    readings: flat(130),
    insulin: [{ ts: min(-30), units: 3, kind: "rapid", insulin_name: "Fiasp" }],
    meals: [{ ts: min(-35), description: "riz", carbs_g: 80, planned: false }],
  });
  const a = anticipate(s, decideAction(s));
  assert.notEqual(a?.kind, "insulin_low");
});

test("rising in range with nothing logged asks about the meal, in the daytime only", () => {
  const s = state({ readings: rising(150, 2) });
  const a = anticipate(s, decideAction(s))!;
  assert.equal(a.kind, "rising_no_meal");
  assert.match(a.line, /monte d'environ 2 mg\/dL par minute sans repas noté/);
});

test("a fatty meal gets its late rise announced, with the hour", () => {
  const meals = [{ ts: min(-100), description: "poulet avec frites et sauce", carbs_g: 60, planned: false }];
  const insulin = [{ ts: min(-90), units: 3.5, kind: "rapid", insulin_name: "Fiasp" }];
  const s = state({ readings: flat(150), meals, insulin });
  const a = anticipate(s, decideAction(s))!;
  assert.equal(a.kind, "fatty_late");
  assert.match(a.line, /Repas gras de 18:20 : la glycémie peut remonter jusque vers 00:20/);
});

test("high with insulin still arriving: no second dose before the hour is named", () => {
  const insulin = [{ ts: min(-40), units: 4, kind: "rapid", insulin_name: "Fiasp" }];
  const s = state({ readings: flat(280), insulin });
  const d = decideAction(s);
  assert.equal(d.units, 0);
  const a = anticipate(s, d)!;
  assert.equal(a.kind, "dont_stack");
  assert.match(a.line, /pas de nouvelle dose avant 21:20/);
});

test("nothing to expect means nothing is invented", () => {
  const s = state({ readings: flat(120) });
  assert.equal(anticipate(s, decideAction(s)), null);
});

test("the evening of 6 November: 198 and rising 18 minutes after a 3 u dose", () => {
  // 19:24 3 u, 20:59 60 g chicken and fries, 22:21 3 u, 22:39 at 198.
  const now = Date.UTC(2026, 10, 6, 21, 39);
  const at = (h: number, m: number) => Date.UTC(2026, 10, 6, h - 1, m);
  const s = buildState({
    nowMs: now, lang: "fr", tzOffsetMin: TZ, profile: RYAN,
    readings: [[-20, 176], [-15, 181], [-10, 187], [-5, 193], [0, 198]].map(([m, v]) => ({ ts: now + m * 60000, value: v })),
    insulin: [
      { ts: at(19, 24), units: 3, kind: "rapid", insulin_name: "Fiasp" },
      { ts: at(22, 21), units: 3, kind: "rapid", insulin_name: "Fiasp" },
    ],
    meals: [{ ts: at(20, 59), description: "poulet avec frites et sauce", carbs_g: 60, planned: false }],
  });
  assert.equal(s.knowledge, "logged");
  assert.ok(s.iob > 3.1 && s.iob < 3.4, `iob ${s.iob}`); // 3 u just in, plus the tail of 19:24
  const d = decideAction(s);
  assert.equal(d.units, 0, d.line); // 3 u just went in: nothing on top
  assert.notEqual(d.kind, "ask_done");
  const a = anticipate(s, d);
  assert.ok(a, "the moment has something to expect");
});

// ---- Same answer in Spanish ---------------------------------------------------------------------
test("Spanish keeps the same decision and its own words", () => {
  const es = buildState({ nowMs: NOW, lang: "es", tzOffsetMin: TZ, profile: RYAN, readings: flat(240), insulin: [], meals: [] });
  const d = decideAction(es);
  assert.equal(d.kind, "dose_if");
  assert.match(d.line, /^Si no se ha puesto insulina rápida en las últimas 3 h: pon 1,5 u de Fiasp ahora\./);
});

// ---- What the model is told ---------------------------------------------------------------------
test("the model is told the time of everything, and not to invent causes", () => {
  const s = state({
    readings: flat(150),
    insulin: [{ ts: min(-40), units: 2, kind: "rapid", insulin_name: "Fiasp" }],
    meals: [{ ts: min(-60), description: "pâtes", carbs_g: 40, planned: false }],
  });
  const line = timedSeries(s);
  assert.match(line, /19:20 150/);
  assert.match(line, /19:20 dose 2 u Fiasp/);
  assert.match(line, /19:00 repas 40 g pâtes/);
  const bare = timedSeries(state({ readings: flat(150) }));
  assert.match(bare, /RIEN de noté/);
  assert.match(bare, /N'ATTRIBUE PAS/);
});

test("unknown insulin reaches the model as unknown, not as zero", () => {
  const s = state({ readings: flat(150) });
  const facts = engineFacts(s, decideAction(s), null);
  assert.match(facts, /INCONNUE/);
  assert.match(facts, /NE dis PAS qu'il n'y a pas d'insuline active/);
});

test("what travels to the app has numbers, not sentences to parse", () => {
  const s = state({ readings: flat(240) });
  const d = decideAction(s);
  const p = decisionPayload(s, d, anticipate(s, d));
  assert.equal(p.kind, "dose_if");
  assert.equal(p.units, 1.5);
  assert.equal(p.capped, true);
  assert.equal(p.knowledge, "unknown");
  assert.equal(p.insulinName, "Fiasp");
});

// ---- Property sweep: whatever the moment, these never break -------------------------------------
test("sweep: no state breaks the contract of the decision", () => {
  const levels = [45, 60, 69, 72, 85, 100, 120, 150, 179, 185, 220, 280, 360];
  const slopes = [-4, -1, 0, 1, 4];
  const doseAges = [null, 5, 30, 90, 150, 170, 200, 300];
  const mealAges = [null, -30, 0, 20, 60, 120, 200];
  const foods = ["riz", "pizza et frites", "jus d'orange"];
  let n = 0;
  for (const g of levels) for (const sl of slopes) for (const da of doseAges) for (const ma of mealAges) for (const food of foods) {
    const insulin = da == null ? [] : [{ ts: min(-da), units: 3, kind: "rapid", insulin_name: "Fiasp" }];
    const meals = ma == null ? [] : [{ ts: min(-ma), description: food, carbs_g: 45, planned: ma < 0 }];
    const s = state({ readings: rising(g, sl).map((r) => ({ ...r, value: Math.max(30, r.value) })), insulin, meals });
    for (const lang of ["fr", "es"]) {
      const ss = { ...s, lang };
      const d = decideAction(ss);
      const a = anticipate(ss, d);
      const ctx = `g=${g} slope=${sl} dose=${da} meal=${ma} ${food} [${lang}]: ${d.line}`;
      n++;
      assert.ok(d.line.length > 0, ctx);
      assert.ok(d.units >= 0 && d.laterUnits >= 0, ctx);
      if (g < 70) {
        assert.equal(d.units, 0, ctx);
        assert.equal(d.laterUnits, 0, ctx);
      }
      if (d.kind === "dose" || d.kind === "dose_if") assert.ok(d.units > 0, ctx);
      if (d.units > 0) assert.ok(d.kind === "dose" || d.kind === "dose_if", ctx);
      // Never firm without knowing the last 3 h.
      if (s.knowledge === "unknown") assert.notEqual(d.kind, "dose", ctx);
      // The number the button would record is the number on the line.
      if (d.units > 0) assert.ok(d.line.includes(`${String(d.units).replace(".", ",")} u de`), ctx);
      assert.doesNotMatch(d.line + (a?.line ?? ""), /bolus|bolo\b/i, ctx);
      assert.doesNotMatch(d.line, /undefined|NaN|null/, ctx);
      if (a) assert.doesNotMatch(a.line, /undefined|NaN|null/, ctx);
      // An anticipation may never name a dose: the action owns the numbers.
      if (a) assert.doesNotMatch(a.line, /\d\s*u\b/, ctx);
    }
  }
  assert.ok(n > 10000, `${n} states`);
});

// ---- The forecast -------------------------------------------------------------------------------
function synthetic(days: number): { ts: number; value: number }[] {
  const out: { ts: number; value: number }[] = [];
  const start = NOW - days * 86400000;
  for (let t = start; t <= NOW; t += 60000) {
    const h = ((t / 3600000) + 1) % 24;
    const meal = Math.exp(-(((h - 13) / 1.2) ** 2)) * 90 + Math.exp(-(((h - 21) / 1.2) ** 2)) * 110;
    out.push({ ts: t, value: Math.round(110 + meal + 12 * Math.sin(t / 2700000)) });
  }
  return out;
}

test("the forecast learns a day's shape, gives a range, and never a figure past the hour", () => {
  const pts = synthetic(30);
  const model = fitForecastModel(pts, NOW, TZ)!;
  assert.ok(model);
  assert.equal(model.version, 1);
  const f = forecastGlucose({ readings: pts, nowMs: NOW, model })!;
  assert.equal(f.source, "learned");
  assert.deepEqual(f.points.map((p) => p.minutes), [30, 60]);
  for (const p of f.points) assert.ok(p.low <= p.mgdl && p.mgdl <= p.high, JSON.stringify(p));
  assert.ok(f.lowRisk60 != null && f.lowRisk60 >= 0 && f.lowRisk60 <= 1);
  // The model must fit in a database row without thinking about it.
  assert.ok(JSON.stringify(model).length < 20000);
});

test("a fresh patient gets a fading trend, and no risk figure it cannot back", () => {
  const f = forecastGlucose({ readings: rising(150, 2), nowMs: NOW, tzOffsetMin: TZ })!;
  assert.equal(f.source, "trend");
  assert.equal(f.lowRisk60, null);
  // Fading: an hour is not twice half an hour.
  const [a, b] = f.points;
  assert.ok(b.mgdl - 150 < 2 * (a.mgdl - 150), JSON.stringify(f.points));
});

test("a hole in the last twenty minutes means no forecast at all", () => {
  const readings = curve([[-60, 150], [-55, 150], [-50, 150], [-45, 150], [-2, 152], [0, 153]]);
  assert.equal(forecastGlucose({ readings, nowMs: NOW, tzOffsetMin: TZ }), null);
});

test("one empty bucket is the monitor's timing, not a hole in the sensor", () => {
  // Five-minute runs, a few seconds early or late: 15.1 minutes ago falls past the bucket before it.
  const readings = curve([[-40, 120], [-35, 120], [-30, 120], [-25, 120], [-20.1, 120], [-15.1, 120], [-9.9, 120], [-5.2, 120], [0, 120]]);
  assert.ok(forecastGlucose({ readings, nowMs: NOW, tzOffsetMin: TZ }));
});

test("a hole between two readings is crossed, and what fell through it shows", () => {
  const flatThenHole = curve([[-40, 120], [-35, 120], [-30, 120], [-25, 120], [-20, 120], [-5, 120], [0, 120]]);
  assert.ok(forecastGlucose({ readings: flatThenHole, nowMs: NOW, tzOffsetMin: TZ }));
  // 7 November: 143, eleven minutes of nothing, then 80 and 73.
  const fell = curve([[-40, 255], [-35, 255], [-30, 250], [-16, 133], [-12, 143], [-1, 80], [0, 73]]);
  const f = forecastGlucose({ readings: fell, nowMs: NOW, tzOffsetMin: TZ });
  assert.ok(f, "this is the moment the forecast went quiet");
  assert.ok(f.points[0].mgdl < 73, JSON.stringify(f.points));
  // Past twenty minutes or so nobody knows what happened in between.
  const tooLong = curve([[-60, 120], [-55, 120], [-50, 120], [-45, 120], [-40, 120], [-5, 120], [0, 120]]);
  assert.equal(forecastGlucose({ readings: tooLong, nowMs: NOW, tzOffsetMin: TZ }), null);
});

test("falling when the readings stopped: only a real fall, only in range, only for a while", () => {
  const fall = (top: number, age: number, perMin = 3) =>
    curve([-15, -12, -9, -6, -3, 0].map((m) => [m - age, top + m * -perMin - 15 * perMin + 15 * perMin]));
  assert.ok(blindFall(fall(150, 12), NOW), "falling at 3 a minute, twelve minutes without news");
  assert.equal(Math.round(blindFall(fall(150, 12), NOW)!.ageMin), 12);
  assert.equal(blindFall(fall(150, 8), NOW), null, "too soon: a reading can be a few minutes late");
  assert.equal(blindFall(fall(150, 40), NOW), null, "too long: that is a sensor question now");
  assert.equal(blindFall(fall(150, 12, 1), NOW), null, "falling slowly");
  assert.equal(blindFall(fall(150, 12, -3), NOW), null, "rising");
  assert.equal(blindFall(fall(240, 12), NOW), null, "from up there there is time");
  assert.equal(blindFall(fall(60, 12), NOW), null, "already low: the zones have it");
  assert.equal(blindFall([], NOW), null);
});

test("the logged insulin only nudges the shape: it counts for a quarter", () => {
  const plain = forecastGlucose({ readings: flat(150), nowMs: NOW, tzOffsetMin: TZ })!;
  const nudged = forecastGlucose({ readings: flat(150), nowMs: NOW, tzOffsetMin: TZ, physics: { "30": -40, "60": -80 } })!;
  assert.equal(plain.points[1].mgdl - nudged.points[1].mgdl, 20);
});

test("forecastLine: a range, and nothing when there is nothing", () => {
  const f = forecastGlucose({ readings: flat(150), nowMs: NOW, tzOffsetMin: TZ })!;
  assert.match(forecastLine(f, "fr"), /^Dans 30 min : ~150 \(\d+-\d+\)\. Dans 1 h : ~150 \(\d+-\d+\)\.$/);
  assert.equal(forecastLine(null, "fr"), "");
});

test("mixed-patient samples never reach the fit, and a real fall survives", () => {
  const mixed: { ts: number; value: number }[] = [];
  for (let m = -40; m <= 0; m++) mixed.push({ ts: min(m), value: m % 2 === 0 ? 138 : 67 });
  // Alternating minute by minute: every point is 30+ away from a median of the same two values.
  assert.ok(despikeStream(mixed).length < mixed.length);
  const fall: { ts: number; value: number }[] = [];
  for (let m = -30; m <= 0; m++) fall.push({ ts: min(m), value: 200 + m * 5 });
  assert.equal(despikeStream(fall).length, fall.length);
});

test("gridOf averages each five minutes and leaves holes as holes", () => {
  const start = Math.floor(NOW / 300000) * 300000;
  const { g } = gridOf([{ ts: start, value: 100 }, { ts: start + 60000, value: 110 }, { ts: start + 900000, value: 120 }]);
  assert.equal(g[0], 105);
  assert.ok(Number.isNaN(g[1]));
  assert.equal(g[3], 120);
});

test("riskCell separates level, direction and block of hours", () => {
  const cells = new Set([riskCell(100, 0, 12), riskCell(200, 0, 12), riskCell(100, -3, 12), riskCell(100, 0, 22)]);
  assert.equal(cells.size, 4);
  assert.ok(riskCell(500, 9, 23.9) < 180);
});

// ---- Every insulin ------------------------------------------------------------------------------
test("every insulin a family may be given is recognised, the way it is typed or said", () => {
  const cases: [string, string, boolean][] = [
    ["Fiasp", "fiasp", false], ["fiasp flextouch", "fiasp", false], ["Lyumjev", "lyumjev", false],
    ["NovoRapid", "novorapid", false], ["Novolog", "novorapid", false], ["Humalog", "humalog", false],
    ["Apidra SoloStar", "apidra", false], ["Actrapid", "actrapid", false], ["Humulin R", "actrapid", false],
    ["Lantus", "lantus", true], ["Abasaglar", "lantus", true], ["Semglee", "lantus", true],
    ["Toujeo", "toujeo", true], ["glargine 300", "toujeo", true], ["Levemir", "levemir", true],
    ["Tresiba", "tresiba", true], ["TRESIBA FlexTouch", "tresiba", true], ["insulina degludec", "tresiba", true],
    ["Humalog Mix25", "premix", false], ["Humulina NPH", "nph", true], ["Optisulin", "toujeo", true], ["Basaglar", "lantus", true],
    ["insuline dégludec", "tresiba", true], ["Awiqli", "awiqli", true], ["Insulatard", "nph", true],
  ];
  for (const [name, id, basal] of cases) {
    assert.equal(insulinByName(name)?.id, id, name);
    assert.equal(isBasalInsulin(name), basal, name);
  }
  assert.equal(insulinByName("eau"), null);
  assert.equal(insulinByName(""), null);
});

test("the unknown curve never understates what is left", () => {
  for (const m of [60, 120, 180]) {
    assert.ok(fractionRemaining(m, curveOf("marque inconnue")) >= fractionRemaining(m, curveOf("Fiasp")), String(m));
  }
});

test("a switch to Tresiba is said for the days it takes to settle, then not", () => {
  const changed = min(-24 * 60);
  const n = basalNotice("Tresiba", null, changed, NOW, "fr")!;
  assert.equal(n.kind, "settling");
  assert.match(n.line, /Nouvelle insuline lente \(Tresiba\) : elle met environ 3 jours à se stabiliser \(reste ~2\)/);
  assert.equal(basalNotice("Tresiba", null, min(-4 * 1440), NOW, "fr"), null);
  assert.match(basalNotice("Tresiba", null, changed, NOW, "es")!.line, /tarda unos 3 días/);
});

test("a late background dose is judged on how long THAT insulin lasts", () => {
  const thirty = min(-30 * 60);
  assert.match(basalNotice("Tresiba", thirty, null, NOW, "fr")!.line, /Elle agit encore/);
  assert.match(basalNotice("Lantus", thirty, null, NOW, "fr")!.line, /ne couvre peut-être plus/);
  assert.equal(basalNotice("Lantus", min(-20 * 60), null, NOW, "fr"), null);
  assert.equal(basalNotice("Fiasp", thirty, null, NOW, "fr"), null);
});

test("the notice reaches the analysis the same way as every other note", () => {
  const s = state({ readings: flat(120), profile: { basal_insulin: "Tresiba", basal_changed_at: new Date(min(-1440)).toISOString() } });
  const notes = sideNotes(s, decideAction(s)).map((n) => n.display);
  assert.ok(notes.some((l) => /Tresiba/.test(l)), notes.join(" | "));
});

// ---- The readings themselves --------------------------------------------------------------------
test("a phone reading that contradicts the monitor belongs to someone else", () => {
  const stored = [{ ts: min(-10), value: 138, source: "monitor" }, { ts: min(-5), value: 140, source: "monitor" }];
  const phone = [{ ts: min(-4), value: 95 }, { ts: min(-3), value: 142 }, { ts: min(-1), value: 141 }];
  const r = mergeReadings(stored, phone, NOW);
  assert.equal(r.rejected, 1);
  assert.deepEqual(r.accepted.map((p) => p.value), [142, 141]);
  assert.ok(!r.series.some((p) => p.value === 95));
});

test("a low on the phone is believed against the monitor, and kept out of the stored history", () => {
  const stored = [{ ts: min(-2), value: 96, source: "monitor" }];
  const r = mergeReadings(stored, [{ ts: min(-1), value: 72 }, { ts: min(0), value: 68 }], NOW);
  assert.equal(r.series[r.series.length - 1].value, 68);
  assert.ok(!r.accepted.some((p) => p.value === 68), "not written back");
  const s = state({ readings: r.series });
  assert.equal(decideAction(s).kind, "sugar");
});

test("with no monitor row nearby the phone is believed: it may be the only source", () => {
  const r = mergeReadings([], [{ ts: min(-1), value: 67 }], NOW);
  assert.equal(r.rejected, 0);
  assert.equal(r.series.length, 1);
});

test("a future or ancient phone timestamp is not a reading", () => {
  const r = mergeReadings([], [{ ts: min(10), value: 100 }, { ts: 1_700_000, value: 100 }], NOW);
  assert.equal(r.series.length, 0);
});

test("local time: the phone first, then what is remembered, then Spain", () => {
  assert.equal(tzOffsetOf({ tzOffsetMin: 120 }, { tz_offset_min: 60 }), 120);
  assert.equal(tzOffsetOf({}, { tz_offset_min: 120 }), 120);
  assert.equal(tzOffsetOf({}, null), 60);
  assert.equal(tzOffsetOf({ tzOffsetMin: 0 }, null), 0);
});

test("stripping a dose leaves no empty shell behind", () => {
  assert.equal(stripInsulinNumbers("L'insuline encore active (environ 2 u) agit."), "L'insuline encore active agit.");
  assert.equal(stripInsulinNumbers("Il reste (≈ 1,5 u) à agir."), "Il reste à agir.");
  assert.equal(stripInsulinNumbers("Il faut environ 3 unités."), "Il faut.");
});

// ---- What the independent safety review found -----------------------------------------------------
const firm = { no_insulin_confirmed_at: new Date(min(-5)).toISOString() };
const unitsIn = (line: string) => Number((/(\d+(?:,\d+)?) u de Fiasp/.exec(line)?.[1] ?? "0").replace(",", "."));

test("a low is never answered without its grams, whatever meal is around", () => {
  const dinner = { ts: min(20), description: "pâtes", carbs_g: 60, planned: true };
  const old = { ts: min(-40), description: "pâtes", carbs_g: 60 };
  const dose = { ts: min(-100), units: 2, kind: "rapid", insulin_name: "Fiasp" };
  const cases = [
    { readings: flat(60), meals: [dinner] },
    { readings: rising(48, -2), meals: [old], insulin: [dose] },
    { readings: flat(66), meals: [old], insulin: [dose] },
    { readings: rising(52, 1), meals: [old, dinner], insulin: [dose] },
  ];
  for (const c of cases) {
    const d = decideAction(state(c));
    assert.equal(d.kind, "sugar", d.line);
    assert.ok(d.sugarGrams > 0);
    assert.match(d.line, new RegExp(`${d.sugarGrams} g de sucre`), d.line);
  }
  // Climbing from 54 up, nothing more to take now, and the grams are there if it turns.
  const climbing = decideAction(state({ readings: rising(55, 1), meals: [old, dinner], insulin: [dose] }));
  assert.equal(climbing.sugarGrams, 0);
  assert.match(climbing.line, /\d+ g de sucre rapide/, climbing.line);
});

test("under 90 no full meal dose is named, whichever way it is going, on any path", () => {
  const logged = (g: any, carbs: number, description: string) => decideAction(state({
    readings: g, meals: [{ ts: min(-3), description, carbs_g: carbs }], profile: firm,
  }));
  for (const d of [logged(flat(85), 60, "riz"), logged(rising(72, 1), 80, "pizza"), logged(rising(80, 1), 90, "pâtes")]) {
    assert.equal(d.units, 0, d.line);
    assert.notEqual(d.kind, "dose");
    assert.match(d.line, /^Aucune insuline maintenant/);
    assert.match(d.line, /redemande-moi/);
  }
  const photo = decideAction(state({ readings: flat(85), profile: firm }), { candidate: { carbsG: 60, description: "riz" } });
  assert.equal(photo.units, 0);
  assert.match(photo.line, /^Aucune insuline maintenant/);
});

test("held, the figure comes last, in the future, and never opens the sentence", () => {
  const prof = toGuardProfile(RYAN);
  const plan = planMealDose({ glucoseMgdl: 85, trend: "stable", staleMin: 1, iobUnits: 0, carbsG: 60, description: "riz", profile: prof });
  assert.equal(plan.lowBeforeMeal, true);
  const line = mealPlanLine(plan, "fr", prof);
  assert.ok(line.indexOf("Aucune insuline") < line.indexOf("demandera"), line);
  assert.doesNotMatch(line, /Sans insuline, ce repas/);
});

test("the dose already counted cannot be the answer: 1 u, then « fais 2 u », then asked, not repeated", () => {
  const known = { ts: min(-22), units: 1, kind: "rapid", insulin_name: "Fiasp" };
  const pending = { units: 2, at: min(-12), insulin: "Fiasp", knownDoseAt: min(-22) };
  assert.deepEqual(openPendingDose(pending, [known], NOW), pending);
  const d = decideAction(state({ readings: flat(300), insulin: [known], profile: { pending_action: pending } }));
  assert.equal(d.kind, "ask_done");
  assert.equal(d.units, 0);
  assert.equal(openPendingDose(pending, [known, { ts: min(-5), units: 2, kind: "rapid" }], NOW), null);
  assert.deepEqual(openPendingDose(pending, [{ ts: min(-175), units: 3, kind: "rapid" }], NOW), pending, "an old dose is not an answer");
});

test("seen again before anyone answered, the dose says it was already proposed", () => {
  const profile = { ...firm, pending_action: { units: 1.5, at: min(-4), insulin: "Fiasp" } };
  const d = decideAction(state({ readings: flat(240), profile }));
  assert.equal(d.kind, "dose");
  assert.match(d.line, /1,5 u déjà proposées à 19:56 : une seule fois/);
});

test("a dose announced for the coming hour counts: nothing is named on top of it", () => {
  const soon = (m: number, units: number) => ({ ts: min(m), units, kind: "rapid", insulin_name: "Fiasp" });
  const s = state({ readings: flat(250), insulin: [soon(30, 3)], profile: firm });
  assert.equal(decideAction(s).units, 0);
  assert.equal(s.iob, 0, "not in the body yet, so not on the screen");
  assert.equal(s.iobDose, 3);
  const meal = { ts: min(-1), description: "riz", carbs_g: 64 };
  assert.equal(decideAction(state({ readings: flat(150), meals: [meal], insulin: [soon(10, 4)], profile: firm })).units, 0);
  assert.ok(decideAction(state({ readings: flat(250), insulin: [soon(90, 3)], profile: firm })).units > 0, "further off, it is a plan");
});

test("a background insulin logged as rapid covers no meal", () => {
  const s = state({
    readings: flat(120), profile: firm,
    insulin: [{ ts: min(-5), units: 14, kind: "rapid", insulin_name: "Lantus" }],
    meals: [{ ts: min(-2), description: "riz", carbs_g: 56 }],
  });
  const d = decideAction(s);
  // 14 u of it would hold every dose back; as it is, only the floor has a say.
  assert.equal(d.units, 1.5, d.line);
});

test("a dose is judged on the larger of the curve and the old line, so v4 never names more than before", () => {
  const dose = (m: number, units: number) => ({ ts: min(m), units, kind: "rapid", insulin_name: "Fiasp" });
  for (const m of [5, 30, 60, 90, 120, 140, 180, 239]) {
    const curve = activeIob([dose(-m, 6)], NOW, "Fiasp");
    const judged = dosingIob([dose(-m, 6)], NOW, "Fiasp");
    assert.ok(judged >= curve - 1e-9);
    assert.ok(judged >= 6 * (1 - m / 240) - 1e-9, `${m} min`);
  }
  const d = decideAction(state({
    readings: flat(181), insulin: [dose(-140, 6)], meals: [{ ts: min(-1), description: "pâtes", carbs_g: 60 }],
  }));
  assert.ok(d.units <= 2, d.line);
  const big = decideAction(state({ readings: flat(300), insulin: [dose(-150, 10)] }));
  assert.equal(big.units, 0, big.line);
  const s = state({ readings: flat(120), insulin: [dose(-140, 6)] });
  assert.ok(s.iob < s.iobDose, "the screen keeps the better estimate");
  assert.equal(decisionPayload(s, decideAction(s), null).iobUnits, Math.round(s.iob * 10) / 10);
});

test("sugar on the way up from a low is treatment, on the photo as in the log", () => {
  const up = curve([[-30, 80], [-25, 65], [-20, 70], [-15, 76], [-10, 82], [-5, 88], [0, 92]]);
  for (const food of [{ carbsG: 12, description: "3 sucres" }, { carbsG: 16, description: "canette 7up" }]) {
    const d = decideAction(state({ readings: up, profile: firm }), { candidate: food });
    assert.equal(d.units, 0, d.line);
    assert.match(d.line, /^Pas d'insuline pour ça : ça sert à remonter/);
  }
  const logged = decideAction(state({ readings: up, profile: firm, meals: [{ ts: min(-1), description: "canette 7up", carbs_g: 16 }] }));
  assert.equal(logged.units, 0, logged.line);
  const meal = decideAction(state({ readings: up, profile: firm }), { candidate: { carbsG: 60, description: "pâtes" } });
  assert.ok(meal.plan, "a real plate after a low is still a meal");
});

test("a dose only covers what it has the units for", () => {
  const prof = toGuardProfile(RYAN);
  const plates = [
    { ts: min(-40), description: "riz", carbs_g: 60 },
    { ts: min(-30), description: "pâtes", carbs_g: 60 },
  ];
  const small = findUncoveredMeal(plates, [{ ts: min(-40), units: 2, kind: "rapid" }], NOW, prof);
  assert.equal(small?.description, "pâtes", "one 2 u dose does not clear two 60 g plates");
  assert.equal(findUncoveredMeal(plates, [{ ts: min(-40), units: 8, kind: "rapid" }], NOW, prof), null, "one dose for both is normal");
  const dessert = [{ ts: min(-40), description: "riz", carbs_g: 40 }, { ts: min(-35), description: "gâteau", carbs_g: 20 }];
  assert.equal(findUncoveredMeal(dessert, [{ ts: min(-40), units: 4, kind: "rapid" }], NOW, prof), null);
});

test("no reading at all is a lost signal, and no dose is named on it", () => {
  const s = state({ readings: [], profile: firm });
  assert.equal(s.signalLost, true);
  assert.equal(decideAction(s).kind, "signal");
  const d = decideAction(s, { candidate: { carbsG: 60, description: "riz" } });
  assert.equal(d.kind, "signal");
  assert.equal(d.units, 0);
});

test("carbs nobody weighed: the figure is said, on condition, in both forms", () => {
  const meal = { ts: min(-1), description: "pizza", carbs_g: 120, carbs_estimated: true };
  const d = decideAction(state({ readings: flat(150), meals: [meal], profile: firm }));
  assert.match(d.line, /^Si c'est bien ~120 g de glucides : fais \d/);
  assert.match(d.line, /corrige-les dans l'onglet Repas/);
  const blind = decideAction(state({ readings: flat(150), meals: [meal] }));
  assert.equal(blind.kind, "dose_if");
  assert.match(blind.line, /depuis 3 h et si c'est bien ~120 g de glucides : fais \d/);
  const later = decideAction(state({
    readings: flat(150), profile: firm, meals: [{ ts: min(30), description: "pizza", carbs_g: 120, planned: true, carbs_estimated: true }],
  }));
  assert.equal(later.kind, "dose_later");
  assert.match(later.line, /^Si c'est bien ~120 g de glucides/);
});

test("the Done button and the sentence say the same figure, with sport and no carb ratio", () => {
  const s = state({
    readings: flat(240), profile: { ...firm, carb_ratio: null },
    activity: [{ ts: min(-30), kind: "foot", intensity: "high", duration_min: 30 }],
  });
  const d = decideAction(s, { candidate: { carbsG: 60, description: "riz" } });
  assert.ok(d.units > 0);
  assert.equal(unitsIn(d.line), d.units, d.line);
});

test("a dose in two parts tells the app so", () => {
  // Small enough that the floor takes nothing off. A dose it did cut is the first part, and no more than that.
  const s = state({ readings: flat(170), profile: firm });
  const d = decideAction(s, { candidate: { carbsG: 15, description: "pizza" } });
  assert.equal(d.split, true);
  assert.equal(d.capped, false);
  assert.equal(decideAction(state({ readings: flat(170), profile: firm }), { candidate: { carbsG: 60, description: "pizza" } }).split, false);
  assert.equal(decisionPayload(s, d, null).split, true);
  assert.equal(decideAction(state({ readings: flat(240), profile: firm })).split, false);
});

test("the newest reading is never removed as a spike: nothing can confirm it yet", () => {
  const pts = [...flat(110).slice(0, 8), { ts: min(0), value: 68 }];
  const kept = despikeStream(pts);
  assert.equal(kept[kept.length - 1].value, 68);
});

test("said again is not eaten again, except sugar taken again after a quarter of an hour", () => {
  const rows = [{ ts: min(-5), description: "Pâtes carbonara", carbs_g: 70 }];
  assert.equal(mealSaidAgain(rows, "des pâtes", 60, NOW), true);
  assert.equal(mealSaidAgain(rows, "une glace", 60, NOW), false);
  assert.equal(mealSaidAgain(rows, "des pâtes", 60, min(30)), false);
  const sugar = [{ ts: min(-15), description: "3 sucres", carbs_g: 12 }];
  assert.equal(mealSaidAgain(sugar, "3 sucres", 12, NOW), false);
  assert.equal(mealSaidAgain([{ ts: min(-3), description: "3 sucres", carbs_g: 12 }], "3 sucres", 12, NOW), true);
  const dose = [{ ts: min(-5), units: 3, kind: "rapid" }];
  assert.equal(doseSaidAgain(dose, 3, NOW), true);
  assert.equal(doseSaidAgain(dose, 2, NOW), false);
  assert.equal(doseSaidAgain(dose, 3, min(30)), false);
});

// ---- What the second safety review found ---------------------------------------------------------
const FIRM = { no_insulin_confirmed_at: new Date(min(-5)).toISOString() };
/** Up from 66, thirty-five minutes ago, to `now`, in steps of five minutes. */
const upFromALow = (now: number) => [
  ...curve([[-45, 64], [-40, 65]]),
  ...[-35, -30, -25, -20, -15, -10, -5, 0].map((m) => ({ ts: min(m), value: Math.round(66 + ((m + 35) / 35) * (now - 66)) })),
];

test("sweet food with no low around is food, and it gets its insulin", () => {
  for (const [description, carbsG] of [["jus d'orange", 20], ["bonbons", 15], ["compote", 25]] as const) {
    const d = decideAction(state({ readings: flat(150), profile: FIRM }), { candidate: { carbsG, description } });
    assert.ok(d.units > 0, `${description}: ${d.line}`);
    assert.equal(d.rescueFood, false);
    assert.doesNotMatch(d.line, /sert à remonter/);
  }
});

test("after a low, what is eaten at 160 is food, and at 92 it is still the treatment", () => {
  assert.equal(eatenToTreatALow(NOW, upFromALow(92), 15, "7up"), true);
  assert.equal(eatenToTreatALow(NOW, upFromALow(160), 25, "sandwich"), false);
  assert.equal(eatenToTreatALow(NOW, upFromALow(160), 24, "2 tartines"), false);
  const d = decideAction(state({ readings: upFromALow(160), profile: FIRM }), { candidate: { carbsG: 25, description: "sandwich" } });
  assert.equal(d.rescueFood, false);
  assert.doesNotMatch(d.line, /sert à remonter/);
  const seven = decideAction(state({ readings: upFromALow(92), profile: FIRM }), { candidate: { carbsG: 15, description: "7up" } });
  assert.equal(seven.rescueFood, true);
  assert.equal(seven.units, 0);
  assert.match(seven.line, /^Pas d'insuline pour ça : ça sert à remonter/);
});

test("with no reading near the food, the low is all there is to go on", () => {
  assert.equal(eatenToTreatALow(NOW, curve([[-40, 64], [-35, 65]]), 15, "7up"), true);
});

test("pasta just after a low gets its plan, and no sentence about sugar", () => {
  const readings = curve([[-30, 68], [-25, 66], [-20, 64], [-15, 64], [-12, 66], [-10, 72], [-5, 80], [0, 90]]);
  for (const [description, carbsG] of [["pâtes", 45], ["burger", 40], ["lentilles", 30]] as const) {
    const d = decideAction(state({ readings, profile: FIRM }), { candidate: { carbsG, description } });
    assert.equal(d.rescueFood, false, description);
    assert.doesNotMatch(d.line, /sert à remonter/);
    assert.ok(d.plan, description);
  }
});

test("the same food, said again, has to be the same plate", () => {
  const row = (description: string, carbs_g: number | null = 60) => [{ ts: min(-5), description, carbs_g }];
  // A repeat, in other words.
  assert.equal(mealSaidAgain(row("pâtes bolognaise"), "des pâtes", 60, NOW), true);
  assert.equal(mealSaidAgain(row("pâtes bolognaise"), "des pâtes", null, NOW), true);
  assert.equal(mealSaidAgain(row("une pâte", 60), "pâtes", 62, NOW), true);
  // Two different things.
  for (const [a, b] of [
    ["tarte aux pommes", "pain aux raisins"], ["riz (100 g)", "pâtes (100 g)"], ["menu enfant", "menu burger"],
    ["jus d'orange", "jus de pomme"], ["petit pain", "petit gâteau"], ["riz au lait", "riz et poulet"],
  ]) assert.equal(mealSaidAgain(row(a), b, 60, NOW), false, `${a} / ${b}`);
  // The same word, another quantity.
  assert.equal(mealSaidAgain(row("riz", 60), "riz", 30, NOW), false);
  // Nothing left to compare.
  assert.equal(mealSaidAgain(row("100 g"), "100 g", 60, NOW), false);
});

test("a second dose: nearly any word will do, a real one must not be lost", () => {
  for (const q of [
    "je viens de refaire 3 u", "j'ai encore fait 3 u", "il a repiqué 3 u", "3 u de plus", "une autre dose",
    "je lui ai rajouté 3 u", "j'ai ajouté 3 u", "il a remis 3 u", "une 2e dose", "me he puesto otra", "3 u más",
    "de nuevo 3 u", "ha vuelto a poner 3 u", "volví a ponerme 3 u", "j'en ai refait une",
    "sa deuxième dose de 3 u", "la seconde dose", "2ème dose", "injection supplémentaire",
    "me he puesto otras 3 unidades", "he repetido la dosis",
  ]) assert.equal(saysAnotherDose(q), true, q);
  for (const q of [
    "j'ai fait 3 u", "me he puesto 3 u de Fiasp", "oui il a fait les 3 u", "j'ai fait 3 u mais il est encore à 250",
    "il monte de plus en plus", "attends une seconde", "une autre question", "",
  ]) assert.equal(saysAnotherDose(q), false, q);
});

test("a second plate: the word has to be about more food, a phantom plate asks for insulin", () => {
  const plate = "pâtes riz gâteau pizza";
  for (const q of [
    "il a repris des pâtes", "il reprend du riz", "encore une part de pizza", "encore des pâtes", "encore un", "encore du riz",
    "une autre part", "une deuxième assiette", "il s'est resservi", "il a remangé", "il a redemandé du gâteau",
    "otra ración", "ha repetido", "il en a repris", "encore un peu de riz",
  ]) assert.equal(saysAnotherPlate(q, plate), true, q);
  for (const q of [
    "il a mangé ses pâtes mais il est encore à 200", "il a encore faim", "il a encore un peu faim", "il monte de plus en plus",
    "il n'a pas encore mangé", "une seconde", "une autre question", "más o menos", "más tarde", "nouvelle aiguille", "",
    "et encore une fois il monte", "il a encore du mal à descendre", "il a encore des cétones", "mais ça reprend",
    "sa glycémie a repris", "il a encore une glycémie à 200", "il fait encore une hyper",
  ]) assert.equal(saysAnotherPlate(q, plate), false, q);
});

test("a dose is a slow insulin only with the word against the figure", () => {
  for (const [q, u] of [
    ["j'ai fait 14 u de lente", 14], ["14 u lente", 14], ["14 de lantus", 14],
    ["14,5 unités de tresiba", 14.5], ["14 unidades de lenta", 14],
  ] as const) assert.equal(saidBasalDose(q, u), true, q);
  for (const [q, u] of [
    ["il a fait 3 u pour le repas, je ferai sa lente ce soir", 3], ["sa lantus c'est ce soir, il a fait 3 u", 3],
    ["ça monte de façon lente, j'ai fait 2 u", 2], ["j'ai fait 3 u de fiasp", 3], ["14 u de lente et 3 u de fiasp", 3], ["", 3],
    ["il a fait 3 u sa lente c'est ce soir", 3], ["j'ai fait sa lente, 3 u pour le repas", 3],
  ] as const) assert.equal(saidBasalDose(q, u), false, q);
});

test("a dose is the same dose only if it is the same insulin", () => {
  const rows = [{ ts: min(-5), units: 4, kind: "basal", insulin_name: "Lantus" }];
  assert.equal(doseSaidAgain(rows, 4, NOW), false);
  assert.equal(doseSaidAgain(rows, 4, NOW, true), true);
  assert.equal(doseSaidAgain([{ ts: min(-5), units: 14, kind: "rapid", insulin_name: "Tresiba" }], 14, NOW, true), true);
});

test("each meal takes the oldest dose that reaches it, and leaves the rest for what came after", () => {
  const s = state({
    readings: flat(160), profile: FIRM,
    meals: [{ ts: min(-75), description: "pâtes", carbs_g: 60 }, { ts: min(-50), description: "crêpe", carbs_g: 20 }],
    insulin: [{ ts: min(-110), units: 5, kind: "rapid", insulin_name: "Fiasp" }, { ts: min(-90), units: 2, kind: "rapid", insulin_name: "Fiasp" }],
  });
  assert.equal(findUncoveredMeal(s.meals, s.insulin, NOW, s.gp, s.readings), null);
  assert.equal(decideAction(s).units, 0);
});

test("a dose only covers what it has the units for, oldest meal first", () => {
  const s = state({
    readings: flat(160), profile: FIRM,
    meals: [{ ts: min(-60), description: "pâtes", carbs_g: 60 }, { ts: min(-40), description: "gâteau", carbs_g: 60 }],
    insulin: [{ ts: min(-60), units: 4, kind: "rapid", insulin_name: "Fiasp" }],
  });
  assert.equal(findUncoveredMeal(s.meals, s.insulin, NOW, s.gp, s.readings)?.description, "gâteau");
});

test("« déjà faite » answers a conditional dose, whenever it was given", () => {
  const dose = [{ ts: min(-35), units: 2, kind: "rapid" }];
  assert.equal(openPendingDose({ units: 2, at: min(-5), conditional: true, knownDoseAt: min(-600) }, dose, NOW), null);
  // A firm dose was worked out knowing the last 3 h: an older dose told afterwards is not its answer.
  assert.ok(openPendingDose({ units: 2, at: min(-5), knownDoseAt: min(-600) }, dose, NOW));
  // The dose that was in the sum says nothing, conditional or not.
  assert.ok(openPendingDose({ units: 2, at: min(-5), conditional: true, knownDoseAt: min(-35) }, dose, NOW));
});

test("a conditional dose ignored for an hour stops holding the others back", () => {
  const raw = { units: 2, at: min(-59), conditional: true };
  assert.ok(openPendingDose(raw, [], NOW));
  assert.equal(openPendingDose({ ...raw, at: min(-61) }, [], NOW), null);
  assert.ok(openPendingDose({ units: 2, at: min(-61) }, [], NOW));
});

test("what the question has to know travels with it", () => {
  const p = openPendingDose({ units: 5, at: min(-12), split: true, conditional: true }, [], NOW)!;
  assert.equal(p.split, true);
  assert.equal(p.conditional, true);
  const s = state({ readings: flat(240), profile: { ...FIRM, pending_action: { units: 5, at: min(-12), split: true } } });
  const d = decideAction(s);
  assert.equal(d.kind, "ask_done");
  assert.equal((decisionPayload(s, d, null).pending as any).split, true);
});

test("a figure nobody weighed stays a guess once it is on record", () => {
  const meal = { ts: min(-3), description: "paella", carbs_g: 120 };
  const on = (m: any) => decideAction(state({ readings: flat(140), meals: [m], profile: FIRM }));
  assert.match(on({ ...meal, carbs_estimated: true }).line, /^Si c'est bien ~120 g de glucides : fais/);
  assert.doesNotMatch(on({ ...meal, carbs_estimated: false }).line, /Si c'est bien/);
  assert.doesNotMatch(on(meal).line, /Si c'est bien/);
});

test("a correction next to a coffee does not hang on the coffee", () => {
  const s = state({ readings: flat(260), meals: [{ ts: min(-2), description: "café", carbs_g: 3, carbs_estimated: true }], profile: FIRM });
  const d = decideAction(s, { estimatedCarbs: 3 });
  assert.equal(d.kind, "dose");
  assert.ok(d.units > 0);
  assert.doesNotMatch(d.line, /Si c'est bien/);
});

test("a dose for later, on a guessed figure, has no verb", () => {
  const d = decideAction(state({ readings: flat(140), profile: FIRM }), {
    candidate: { carbsG: 60, description: "riz", minutesUntil: 120 }, estimatedCarbs: 60,
  });
  assert.equal(d.kind, "dose_later");
  assert.match(d.line, /^Si c'est bien ~60 g de glucides : \d/);
  assert.doesNotMatch(d.line, /fais \d/i);
  const es = decideAction({ ...state({ readings: flat(140), profile: FIRM }), lang: "es" }, {
    candidate: { carbsG: 60, description: "arroz", minutesUntil: 120 }, estimatedCarbs: 60,
  });
  assert.doesNotMatch(es.line, /pon \d/i);
});

test("a meal two hours away gets its plan, whatever the glucose is right now", () => {
  const later = decideAction(state({ readings: flat(85), profile: FIRM }), { candidate: { carbsG: 60, description: "riz", minutesUntil: 120 } });
  assert.equal(later.kind, "dose_later");
  assert.ok(later.laterUnits > 0);
  const soon = decideAction(state({ readings: flat(85), profile: FIRM }), { candidate: { carbsG: 60, description: "riz", minutesUntil: 10 } });
  assert.equal(soon.laterUnits, 0);
});

test("a low is treated against what is really in, and the announced dose waits", () => {
  const plain = state({ readings: flat(62) });
  const announced = state({ readings: flat(62), insulin: [{ ts: min(30), units: 3, kind: "rapid", insulin_name: "Fiasp" }] });
  assert.ok(announced.iobDose > 2.9);
  assert.equal(announced.iobInjected, 0);
  assert.equal(decideAction(announced).sugarGrams, decideAction(plain).sugarGrams);
  const notes = sideNotes(announced, decideAction(announced)).map((n) => n.display).join(" ");
  assert.doesNotMatch(notes, /Il reste/);
  assert.match(notes, /Ne fais pas la dose annoncée/);
  // What is really in still counts.
  const given = state({ readings: flat(62), insulin: [{ ts: min(-20), units: 3, kind: "rapid", insulin_name: "Fiasp" }] });
  assert.equal(given.guard.reason, "hypo_iob");
  assert.equal(plain.guard.reason, "hypo");
  assert.equal(announced.guard.reason, "hypo");
  assert.doesNotMatch(sideNotes(given, decideAction(given)).map((n) => n.display).join(" "), /annoncée/);
});

test("the same dose seen again says once; another figure asks about the first", () => {
  const seen = (units: number) => decideAction(state({
    readings: flat(300), insulin: [{ ts: min(-175), units: 1, kind: "rapid", insulin_name: "Fiasp" }],
    profile: { pending_action: { units, at: min(-5) } },
  }));
  const named = seen(1).units;
  assert.match(seen(named).line, /déjà proposées à 19:55 : une seule fois/);
  assert.match(seen(named + 2).line, new RegExp(`Si les ${named + 2} u proposées à 19:55 ont été faites, note-les d'abord`));
});

// ---- The low warning, a new slow insulin, the live score ----------------------------------------
/** An evening fall from 140 to 60 between 19:30 and 20:30, every day, and back. `NOW` is 20:00. */
function eveningDips(days: number): { ts: number; value: number }[] {
  const out: { ts: number; value: number }[] = [];
  for (let t = NOW - days * 86400000; t <= NOW; t += 60000) {
    const h = (((t / 3600000) + 1) % 24 + 24) % 24;
    const dip = h >= 19.5 && h < 20.5 ? 140 - 80 * (h - 19.5) : h >= 20.5 && h < 21.5 ? 60 + 80 * (h - 20.5) : 140;
    out.push({ ts: t, value: Math.round(dip + 3 * Math.sin(t / 2700000)) });
  }
  return out;
}

test("the lowest of the coming hour is its own model, and it warns on the way down", () => {
  const pts = eveningDips(30);
  const model = fitForecastModel(pts, NOW, TZ)!;
  assert.ok(model.lowest);
  assert.ok(model.lowest!.right != null && model.lowest!.right! > 0.5, JSON.stringify(model.lowest!.right));
  assert.ok(model.lowest!.perDay > 0 && model.lowest!.perDay < 5, String(model.lowest!.perDay));
  // Counting the old data for less does not change how often it would have warned.
  const reweighed = fitForecastModel(eveningDips(60), NOW, TZ, { regimeChangedAt: min(-20 * 1440), settleDays: 3 })!;
  assert.ok(reweighed.lowest!.perDay < 2.5, String(reweighed.lowest!.perDay));
  const f = forecastGlucose({ readings: pts, nowMs: NOW, model })!;
  assert.ok(f.lowest60! < LOWEST_WARN_BELOW, String(f.lowest60));
  assert.equal(f.lowWarning, true);
  assert.equal(f.lowWarningRight, model.lowest!.right);
  // Steady and nowhere near it: nothing to say.
  const calm = forecastGlucose({ readings: flat(140), nowMs: min(-180), model });
  assert.equal(calm, null); // that moment has no readings in its window
  const quiet = pts.filter((p) => p.ts <= min(-180));
  const fq = forecastGlucose({ readings: quiet, nowMs: quiet[quiet.length - 1].ts, model })!;
  assert.equal(fq.lowWarning, false, String(fq.lowest60));
});

test("the low warning is not raised by a climb, nor below 70 where the alarm has it", () => {
  const model = fitForecastModel(eveningDips(30), NOW, TZ)!;
  const always = { ...model, lowest: { ...model.lowest!, w: [...model.lowest!.w.map(() => 0).slice(1), -200] } };
  assert.equal(forecastGlucose({ readings: flat(120), nowMs: NOW, model: always })!.lowWarning, true);
  assert.equal(forecastGlucose({ readings: rising(120, 2), nowMs: NOW, model: always })!.lowWarning, false);
  const below = forecastGlucose({ readings: flat(65), nowMs: NOW, model: always })!;
  assert.equal(below.lowWarning, false);
  assert.equal(below.lowest60, null);
});

test("logged insulin deepens the lowest, a logged meal does not lift it", () => {
  const model = fitForecastModel(eveningDips(30), NOW, TZ)!;
  const at = (physics: Record<string, number>) => forecastGlucose({ readings: flat(140), nowMs: NOW, model, physics })!.lowest60!;
  assert.equal(at({ "30": -40, "60": -80 }), at({}) - 20);
  assert.equal(at({ "30": 40, "60": 80 }), at({}));
});

test("a model from before the warning still works, on the risk table", () => {
  const model = fitForecastModel(eveningDips(30), NOW, TZ)!;
  delete model.lowest;
  const f = forecastGlucose({ readings: flat(120), nowMs: NOW, model })!;
  assert.equal(f.lowest60, null);
  assert.equal(f.lowWarning, false);
  const s = { ...state(), forecast: { ...f, lowRisk60: 0.6 } };
  assert.match(historyLowAhead(s)!.line, /environ 6 fois sur 10/);
});

test("the warning says how often it proved right, and the risk table stops speaking", () => {
  const f = forecastGlucose({ readings: flat(120), nowMs: NOW, tzOffsetMin: TZ })!;
  const warn = { ...state(), forecast: { ...f, lowest60: 68, lowWarning: true, lowWarningRight: 0.49 } };
  const a = anticipate(warn, decideAction(warn))!;
  assert.equal(a.kind, "low_risk");
  assert.match(a.line, /^Tu peux passer sous 70 dans l'heure\. Sur ton historique, cet avertissement se vérifie environ 5 fois sur 10\. Garde du sucre à portée et regarde de nouveau à 20:20\.$/);
  const unsure = { ...warn, forecast: { ...warn.forecast, lowWarningRight: null } };
  assert.match(anticipate(unsure, decideAction(unsure))!.line, /^Tu peux passer sous 70 dans l'heure\. Garde/);
  const es = { ...warn, lang: "es" };
  assert.match(historyLowAhead(es)!.line, /^Puedes bajar de 70 en la próxima hora\. En tu historial, este aviso se cumple unas 5 veces de cada 10\./);
  const calm = { ...state(), forecast: { ...f, lowest60: 95, lowWarning: false, lowRisk60: 0.6 } };
  assert.equal(historyLowAhead(calm), null);
  assert.equal(anticipate(calm, decideAction(calm)), null);
});

test("a warning already in the action line is not said twice", () => {
  const f = forecastGlucose({ readings: flat(120), nowMs: NOW, tzOffsetMin: TZ })!;
  const s = { ...state(), forecast: { ...f, lowest60: 68, lowWarning: true, lowWarningRight: 0.5 } };
  const d = { ...decideAction(s), line: "Ce qu'il reste peut t'emmener sous 70 vers 21:00." };
  assert.equal(anticipate(s, d), null);
});

test("on screen, the insulin on record comes before the history", () => {
  const f = forecastGlucose({ readings: flat(120), nowMs: NOW, tzOffsetMin: TZ })!;
  const s = {
    ...state({ readings: flat(120), insulin: [{ ts: min(-10), units: 4, kind: "rapid", insulin_name: "Fiasp" }] }),
    forecast: { ...f, lowest60: 68, lowWarning: true, lowWarningRight: 0.5 },
  };
  assert.equal(anticipate(s, { ...decideAction(s), line: "Rien à faire." })?.kind, "insulin_low");
});

test("lost signal, nothing to warn about", () => {
  const s = state({ readings: curve([[-60, 90], [-55, 88], [-50, 86]]) });
  assert.equal(s.signalLost, true);
  assert.equal(historyLowAhead(s), null);
});

test("while a new slow insulin settles, the warning does not quote the old one's record", () => {
  const f = forecastGlucose({ readings: flat(120), nowMs: NOW, tzOffsetMin: TZ })!;
  const s = (days: number) => ({
    ...state({ profile: { basal_insulin: "Tresiba", basal_changed_at: new Date(min(-days * 1440)).toISOString() } }),
    forecast: { ...f, lowest60: 68, lowWarning: true, lowWarningRight: 0.5 },
  });
  assert.equal(slowInsulinDaysLeft(s(5)), 12);
  assert.doesNotMatch(historyLowAhead(s(5))!.line, /fois sur 10/);
  assert.equal(slowInsulinDaysLeft(s(18)), null);
  assert.match(historyLowAhead(s(18))!.line, /5 fois sur 10/);
});

test("a new slow insulin changes nothing for two weeks, then the old one counts for a quarter", () => {
  const pts = synthetic(60);
  const plain = fitForecastModel(pts, NOW, TZ)!;
  const day = 1440;
  const early = fitForecastModel(pts, NOW, TZ, { regimeChangedAt: min(-(REGIME_SETTLED_DAYS + 2) * day), settleDays: 3 })!;
  assert.deepEqual(early.horizons["30"].w, plain.horizons["30"].w);
  const late = fitForecastModel(pts, NOW, TZ, { regimeChangedAt: min(-(REGIME_SETTLED_DAYS + 4) * day), settleDays: 3 })!;
  assert.notDeepEqual(late.horizons["30"].w, plain.horizons["30"].w);
  const seen = (m: typeof plain) => m.risk.n.reduce((a, b) => a + b, 0);
  // 42 old days at a quarter, 3 days left out, 15 new days in full: about 25.5 days' worth of 60.
  assert.ok(seen(late) < seen(plain) * 0.5 && seen(late) > seen(plain) * 0.35, `${seen(late)} / ${seen(plain)}`);
  // With too little left once the old insulin counts for less, the plain fit keeps the warning alive.
  const thin = synthetic(30);
  const kept = fitForecastModel(thin, NOW, TZ, { regimeChangedAt: min(-(REGIME_SETTLED_DAYS + 4) * day), settleDays: 3 })!;
  assert.ok(kept.lowest);
  // Older than the window, or a nonsense date: as if nothing had happened.
  const none = fitForecastModel(pts, NOW, TZ, { regimeChangedAt: min(-200 * day) })!;
  assert.deepEqual(none.horizons["30"].w, plain.horizons["30"].w);
  assert.deepEqual(fitForecastModel(pts, NOW, TZ, { regimeChangedAt: Number.NaN })!.horizons["30"].w, plain.horizons["30"].w);
});

test("when the lows come moves with the new insulin", () => {
  // The old insulin went low every afternoon; on the new one the low is in the morning. The forecast of
  // the next hour barely depends on this, what the hours and the risk table remember does.
  const shape = (t: number, lowAt: number) => {
    const h = (((t / 3600000) + 1) % 24 + 24) % 24;
    return Math.round(130 - 80 * Math.exp(-(((h - lowAt) / 1.2) ** 2)));
  };
  const changedAt = min(-20 * 1440);
  const pts: { ts: number; value: number }[] = [];
  for (let t = NOW - 90 * 86400000; t <= NOW; t += 60000) pts.push({ ts: t, value: shape(t, t < changedAt ? 16 : 9) });
  const plain = fitForecastModel(pts, NOW, TZ)!;
  const moved = fitForecastModel(pts, NOW, TZ, { regimeChangedAt: changedAt, settleDays: 3 })!;
  assert.ok(moved.hourLow[9] > plain.hourLow[9], `${moved.hourLow[9]} against ${plain.hourLow[9]}`);
  assert.ok(moved.hourLow[16] < plain.hourLow[16], `${moved.hourLow[16]} against ${plain.hourLow[16]}`);
});

const row = (i: number, t0: number, o: any = {}) => ({
  made_at: t0 + i * 300000, value_mgdl: 120, source: "learned",
  f30: 130, low30: 100, high30: 160, f60: 110, low60: 80, high60: 150, warned: false, ...o,
});

test("the score compares each forecast with what really followed", () => {
  const t0 = NOW - 86400000;
  const series: { ts: number; value: number }[] = [];
  for (let i = 0; i < 288; i++) series.push({ ts: t0 + i * 300000, value: i >= 60 && i < 70 ? 60 : 120 });
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(row(i, t0));
  const s = scoreForecasts(rows, series)!;
  assert.equal(s.h30!.rmse, 10);
  assert.equal(s.h30!.noChange, 0);
  assert.equal(s.h60!.rmse, 10);
  assert.equal(s.h30!.within, 1);
  assert.equal(s.h30!.covered, 1);
  assert.equal(s.h30!.width, 60);
  assert.equal(s.days, 0.1);
  // A fall the forecast missed.
  const miss = scoreForecasts([row(54, t0)], series)!;
  assert.equal(miss.h30!.rmse, 70);
  assert.equal(miss.h30!.covered, 0);
  assert.equal(miss.h30!.within, 0);
});

test("a low counts as warned 10 to 60 minutes ahead, and a warning as right if the low came", () => {
  const t0 = NOW - 86400000;
  const series: { ts: number; value: number }[] = [];
  for (let i = 0; i < 288; i++) series.push({ ts: t0 + i * 300000, value: i >= 60 && i < 70 ? 60 : 120 });
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(row(i, t0, { warned: i === 54 || i === 10 }));
  const s = scoreForecasts(rows, series)!;
  assert.equal(s.lows, 1);
  assert.equal(s.lowsWarned, 1);
  assert.equal(s.leadMin, 30);
  assert.equal(s.warnings, 2);
  assert.equal(s.warningsRight, 1);
  // Five minutes before is an alarm, not a warning.
  const late = scoreForecasts(Array.from({ length: 100 }, (_, i) => row(i, t0, { warned: i === 59 })), series)!;
  assert.equal(late.lowsWarned, 0);
  // A warning whose next hour has not happened yet is not judged.
  const open = scoreForecasts([row(285, t0, { warned: true })], series)!;
  assert.equal(open.warnings, 0);
});

test("one empty bucket before a low does not take it out of the count", () => {
  const t0 = NOW - 86400000;
  const series: { ts: number; value: number }[] = [];
  for (let i = 0; i < 288; i++) if (i !== 57) series.push({ ts: t0 + i * 300000, value: i >= 60 && i < 70 ? 60 : 120 });
  const rows = Array.from({ length: 100 }, (_, i) => row(i, t0));
  assert.equal(scoreForecasts(rows, series)!.lows, 1);
  // Too little known about what came before it to call it a new low.
  const thin = series.filter((p) => p.ts < t0 + 53 * 300000 || p.ts >= t0 + 58 * 300000);
  assert.equal(scoreForecasts(rows, thin)!.lows, 0);
});

test("the fading trend is not the model: it stays out of the score", () => {
  const t0 = NOW - 86400000;
  const series = Array.from({ length: 288 }, (_, i) => ({ ts: t0 + i * 300000, value: 120 }));
  assert.equal(scoreForecasts([row(0, t0, { source: "trend" })], series), null);
  assert.equal(scoreForecasts([], series), null);
  assert.equal(scoreForecasts([row(0, t0)], []), null);
});

const measured = (days: number) => ({
  days,
  h30: { n: 100, rmse: 33.4, noChange: 38.2, within: 0.7, covered: 0.8, width: 80 },
  h60: { n: 100, rmse: 52.1, noChange: 63.4, within: 0.5, covered: 0.8, width: 120 },
  lows: 20, lowsWarned: 15, leadMin: 25, warnings: 40, warningsRight: 20,
});

test("the range says how far to trust it: first a new insulin, then the measured score", () => {
  const f = forecastGlucose({ readings: flat(120), nowMs: NOW, tzOffsetMin: TZ })!;
  assert.equal(forecastNote(state()), null);
  const scored = { ...state(), forecast: { ...f, measured: measured(12) } };
  assert.equal(forecastNote(scored), "Mesuré en vrai sur 12 jours : écart typique 33 mg/dL à 30 min et 52 à 1 h (38 et 63 sans prévision). Hypos annoncées : 8 sur 10.");
  assert.match(forecastNote({ ...scored, lang: "es" })!, /^Medido de verdad en 12 días: error típico 33 mg\/dL a 30 min y 52 a 1 h \(38 y 63 sin previsión\)\. Hipos avisadas: 8 de cada 10\.$/);
  const fewLows = { ...scored, forecast: { ...scored.forecast, measured: { ...measured(12), lows: 2, lowsWarned: 2 } } };
  assert.doesNotMatch(forecastNote(fewLows)!, /Hypos/);
  const changed = { ...scored, profileRow: { ...scored.profileRow, basal_insulin: "Tresiba", basal_changed_at: new Date(min(-5 * 1440)).toISOString() } };
  assert.equal(forecastNote(changed), "Nouvelle insuline lente : la prévision apprend encore, moins sûre pendant environ 12 jours.");
  const settled = { ...changed, profileRow: { ...changed.profileRow, basal_changed_at: new Date(min(-18 * 1440)).toISOString() } };
  assert.match(forecastNote(settled)!, /^Mesuré en vrai/);
  assert.equal(decisionPayload(scored, decideAction(scored), null).forecastNote, forecastNote(scored));
});

test("a score of a few days is not shown", () => {
  const model = fitForecastModel(eveningDips(30), NOW, TZ)!;
  const f = (days: number) => forecastGlucose({ readings: flat(120), nowMs: NOW, model: { ...model, live: measured(days) } })!;
  assert.equal(f(MEASURED_MIN_DAYS - 1).measured, null);
  assert.equal(f(MEASURED_MIN_DAYS).measured!.days, MEASURED_MIN_DAYS);
});

// ---- What the third pass found -------------------------------------------------------------------
test("sugar taken on the way down is stopping a fall, and it gets no insulin", () => {
  for (const [g, perMin] of [[100, -4], [105, -3], [115, -3], [125, -2]] as const) {
    for (const [description, carbsG] of [["3 sucres", 12], ["jus d'orange", 20]] as const) {
      const d = decideAction(state({ readings: rising(g, perMin), profile: FIRM }), { candidate: { carbsG, description } });
      assert.equal(d.units, 0, `${g} ${description}: ${d.line}`);
      assert.equal(d.rescueFood, true, `${g} ${description}`);
    }
  }
});

test("the sugar that treated a low, written down late, stays what it was", () => {
  const readings = curve([[-40, 55], [-35, 55], [-30, 55], [-25, 55], [-20, 55], [-15, 70], [-10, 85], [-5, 100], [0, 115]]);
  for (const [description, carbsG] of [["3 sucres", 12], ["glucose", 15], ["canette 7up", 16], ["jus de pomme", 20]] as const) {
    const d = decideAction(state({ readings, profile: FIRM }), { candidate: { carbsG, description } });
    assert.equal(d.units, 0, `${description}: ${d.line}`);
    const row = decideAction(state({ readings, profile: FIRM, meals: [{ ts: min(-1), description, carbs_g: carbsG }] }));
    assert.equal(row.units, 0, `${description} logged: ${row.line}`);
  }
});

test("one rule for a row and for a food under discussion", () => {
  // Food, with no low around: covered, whichever way it arrives.
  const juice = { ts: min(-1), description: "jus d'orange", carbs_g: 20 };
  const asked = decideAction(state({ readings: flat(150), profile: FIRM }), { candidate: { carbsG: 20, description: juice.description } });
  const logged = decideAction(state({ readings: flat(150), profile: FIRM, meals: [juice] }));
  assert.ok(asked.units > 0, asked.line);
  assert.equal(logged.units, asked.units, logged.line);
  // Called sugar: no dose, whichever way it arrives.
  const sugar = { ts: min(-1), description: "3 sucres", carbs_g: 12 };
  assert.equal(decideAction(state({ readings: flat(150), profile: FIRM }), { candidate: { carbsG: 12, description: sugar.description } }).units, 0);
  assert.equal(decideAction(state({ readings: flat(150), profile: FIRM, meals: [sugar] })).units, 0);
  // With no readings, the words are all there is.
  assert.equal(eatenAsTreatment(NOW, [], 20, "jus d'orange"), true);
  assert.equal(eatenAsTreatment(NOW, null, 60, "riz"), false);
});

test("pasta at a low is a meal: the dose promised for afterwards is still there afterwards", () => {
  const low = curve([[-20, 66], [-15, 64], [-10, 64], [-5, 64], [0, 64]]);
  assert.equal(eatenToTreatALow(NOW, low, 45, "pâtes"), false);
  assert.equal(eatenToTreatALow(NOW, low, 35, "coca"), true, "a can at a low is treatment");
  assert.equal(eatenToTreatALow(NOW, low, 20, "carré de chocolat"), true, "small, whatever it is made of");
  const later = curve([[-45, 66], [-40, 64], [-35, 64], [-30, 64], [-25, 75], [-20, 85], [-15, 95], [-10, 105], [-5, 115], [0, 120]]);
  const d = decideAction(state({ readings: later, profile: FIRM, meals: [{ ts: min(-30), description: "pâtes", carbs_g: 45 }] }));
  assert.ok(d.units > 0, d.line);
});

test("a compote for two hours from now treats nothing", () => {
  const d = decideAction(state({ readings: flat(75), profile: FIRM }), { candidate: { carbsG: 20, description: "compote", minutesUntil: 120 } });
  assert.equal(d.rescueFood, false);
  assert.doesNotMatch(d.line, /sert à remonter/);
});

test("a meal coming soon at 86: judged on when the insulin would go in, not only when the food does", () => {
  const d = decideAction(state({ readings: flat(86), profile: FIRM }), { candidate: { carbsG: 30, description: "bonbons", minutesUntil: 33 } });
  assert.equal(d.laterUnits, 0, d.line);
});

test("a low with an announced dose: the plan's grams are the payload's grams", () => {
  const s = state({ readings: flat(62), insulin: [{ ts: min(30), units: 3, kind: "rapid", insulin_name: "Fiasp" }], profile: FIRM });
  const d = decideAction(s, { candidate: { carbsG: 60, description: "pâtes" } });
  const plain = decideAction(state({ readings: flat(62), profile: FIRM }), { candidate: { carbsG: 60, description: "pâtes" } });
  assert.equal(d.line, plain.line);
  const notes = sideNotes(s, { ...d, kind: "hold" }).map((n) => n.display).join(" ");
  assert.match(notes, /Ne fais pas la dose annoncée/);
});

test("the condition names the food the dose is for", () => {
  const readings = upFromALow(92);
  const meals = [{ ts: min(-3), description: "riz", carbs_g: 60 }];
  const d = decideAction(state({ readings, meals, profile: FIRM }), { candidate: { carbsG: 15, description: "jus" }, estimatedCarbs: 15 });
  assert.doesNotMatch(d.line, /~15 g de glucides/);
});

test("the same word guessed yesterday says nothing about the plate typed today", () => {
  const meals = [
    { ts: min(-1400), description: "riz", carbs_g: 60, carbs_estimated: true },
    { ts: min(-3), description: "riz", carbs_g: 60, carbs_estimated: false },
  ];
  assert.doesNotMatch(decideAction(state({ readings: flat(140), meals, profile: FIRM })).line, /Si c'est bien/);
});

test("a late dose from before the 3 h says nothing about a conditional dose", () => {
  const old = [{ ts: min(-200), units: 2, kind: "rapid" }];
  assert.ok(openPendingDose({ units: 2, at: min(-5), conditional: true, knownDoseAt: min(-600) }, old, NOW));
});

test("what the sum counted includes what was announced", () => {
  const announced = { ts: min(20), units: 1, kind: "rapid", insulin_name: "Fiasp" };
  const s = state({ readings: flat(300), insulin: [announced] });
  assert.equal(lastCountedDoseMs(s), min(20));
  assert.equal(lastCountedDoseMs(state({ insulin: [{ ...announced, ts: min(90) }] })), null);
  assert.equal(lastCountedDoseMs(state()), null);
  // Twenty-five minutes on, that dose is not the answer to the one named on top of it.
  assert.ok(openPendingDose({ units: 2, at: min(-25), knownDoseAt: min(-5) }, [{ ...announced, ts: min(-5) }], NOW));
});

test("repeat words fold, but short ones and brand names stay what they are", () => {
  const row = (description: string) => [{ ts: min(-3), description, carbs_g: 16 }];
  assert.equal(mealSaidAgain(row("jus"), "jus", 16, NOW), true);
  assert.equal(mealSaidAgain(row("7up"), "7up", 16, NOW), true);
  assert.equal(mealSaidAgain(row("jus"), "7up", 16, NOW), false);
  // A model's guess is no evidence against the row.
  const typed = [{ ts: min(-10), description: "pâtes", carbs_g: 60 }];
  assert.equal(mealSaidAgain(typed, "des pâtes", 80, NOW, false), true);
  assert.equal(mealSaidAgain(typed, "des pâtes", 80, NOW, true), false);
});

test("a small sweet thing is covered while it is arriving, not after it has acted", () => {
  const juice = (m: number) => ({ ts: min(m), description: "jus d'orange", carbs_g: 25 });
  assert.ok(decideAction(state({ readings: flat(150), profile: FIRM, meals: [juice(-10)] })).units > 0);
  assert.equal(decideAction(state({ readings: flat(150), profile: FIRM, meals: [juice(-40)] })).units, 0);
  assert.equal(decideAction(state({ readings: flat(90), profile: FIRM, meals: [juice(-40)] })).units, 0);
});

test("a plate eaten at a low waits for the rise before its dose is named", () => {
  const at = (now: number) => [
    ...curve([[-45, 66], [-40, 64], [-35, 64], [-30, 64]]),
    ...[-25, -20, -15, -10, -5, 0].map((m) => ({ ts: min(m), value: Math.round(64 + ((m + 30) / 30) * (now - 64)) })),
  ];
  const meals = [{ ts: min(-30), description: "pâtes", carbs_g: 45 }];
  assert.equal(decideAction(state({ readings: at(90), meals, profile: FIRM })).units, 0);
  assert.ok(decideAction(state({ readings: at(120), meals, profile: FIRM })).units > 0);
});

// ---- What the last check found -------------------------------------------------------------------
test("something that is not sugar does not hold the treatment of a low", () => {
  for (const [description, carbs_g] of [["coca sans sucre", 0], ["yaourt sans sucre", 6], ["un morceau de poulet", 0], ["morceau de pizza", 20]] as const) {
    const d = decideAction(state({ readings: flat(65), meals: [{ ts: min(-3), description, carbs_g }] }));
    assert.equal(d.kind, "sugar", `${description}: ${d.line}`);
    assert.ok(d.sugarGrams > 0, description);
  }
  // Real sugar, a moment ago: let it work.
  for (const description of ["3 sucres", "3 morceaux", "un morceau de sucre"]) {
    const d = decideAction(state({ readings: flat(65), meals: [{ ts: min(-3), description, carbs_g: null }] }));
    assert.equal(d.sugarGrams, 0, description);
  }
});

test("a rescue bigger than a textbook one, written down late, stays a rescue", () => {
  const readings = curve([[-40, 55], [-35, 55], [-30, 55], [-25, 55], [-20, 55], [-15, 70], [-10, 85], [-5, 100], [0, 115]]);
  for (const [description, carbsG] of [["coca", 35], ["canette 7up", 33], ["8 sucres", 32], ["jus d'orange", 30]] as const) {
    assert.equal(decideAction(state({ readings, profile: FIRM }), { candidate: { carbsG, description } }).units, 0, description);
    assert.equal(decideAction(state({ readings, profile: FIRM, meals: [{ ts: min(-1), description, carbs_g: carbsG }] })).units, 0, `${description} logged`);
  }
  // A real sweet thing of 60 g after a low is a meal.
  assert.ok(decideAction(state({ readings, profile: FIRM }), { candidate: { carbsG: 60, description: "gâteau au miel" } }).plan);
});

test("sugar announced for later is never a dose for later", () => {
  const meals = [{ ts: min(40), description: "3 sucres", carbs_g: 12, planned: true }];
  const d = decideAction(state({ readings: flat(120), meals, profile: FIRM }));
  assert.equal(d.laterUnits, 0, d.line);
  const c = decideAction(state({ readings: flat(120), profile: FIRM }), { candidate: { carbsG: 12, description: "3 sucres", minutesUntil: 45 } });
  assert.equal(c.laterUnits, 0, c.line);
  assert.equal(c.units, 0, c.line);
});

test("food dated in the past is judged at the time it was eaten", () => {
  const readings = curve([[-40, 55], [-35, 55], [-30, 55], [-25, 55], [-20, 58], [-15, 66], [-10, 78], [-5, 90], [0, 100]]);
  const d = decideAction(state({ readings, profile: FIRM }), { candidate: { carbsG: 35, description: "coca", eatenAtMs: min(-14) } });
  assert.equal(d.units, 0, d.line);
  assert.equal(d.rescueFood, true);
});

test("under the size a row is covered at, the screen does not name a dose either", () => {
  const d = decideAction(state({ readings: flat(105), profile: FIRM }), { candidate: { carbsG: 12, description: "crêpe" } });
  assert.equal(d.units, 0, d.line);
  assert.equal(decideAction(state({ readings: flat(105), profile: FIRM, meals: [{ ts: min(-1), description: "crêpe", carbs_g: 12 }] })).units, 0);
});

test("an empty row among the meals breaks nothing", () => {
  const meals = [null, undefined, { ts: null, description: null, carbs_g: 60 }, { ts: min(-3), description: "riz", carbs_g: 60 }];
  assert.ok(decideAction(state({ readings: flat(140), meals, profile: FIRM })));
});

// ---- The floor ----------------------------------------------------------------------------------
const known = { no_insulin_confirmed_at: new Date(min(-5)).toISOString() };

test("a correction is what survives a hard hit, and it says when to look again", () => {
  const d = decideAction(state({ readings: flat(240), profile: known }));
  assert.equal(d.units, 1.5);
  assert.equal(d.capped, true);
  assert.match(d.line, /Pas plus : au-delà, ça pourrait passer sous 100\. Regarde de nouveau à 21:30/);
  // Under the point where the two sums cross, the plain correction stands, with nothing added to it.
  const small = decideAction(state({ readings: flat(190), profile: known }));
  assert.equal(small.units, 1);
  assert.equal(small.capped, false);
  assert.equal(small.line, "Fais 1 u de Fiasp maintenant.");
});

test("what 6.5 u at 253 did: 54 at 109 minutes. The floor names a quarter of it", () => {
  const d = decideAction(state({ readings: rising(214, 3), profile: known }));
  assert.ok(d.units <= 1.5, d.line);
});

test("the pizza of 14 July, 5 u at 168 and 53 at 97 minutes: a first part, then a look an hour later", () => {
  const first = decideAction(state({ readings: flat(168), profile: known }), { candidate: { carbsG: 90, description: "pizza" } });
  assert.equal(first.units, 2);
  assert.equal(first.split, false);
  assert.match(first.line, /^Pour ~90 g de glucides : fais 2 u de Fiasp maintenant\. Pas plus/);
  assert.match(first.line, /Regarde de nouveau à 21:00/);
  // An hour on, with that part done and the glucose climbing, the rest comes up on its own.
  const again = decideAction(state({
    readings: rising(210, 1), profile: known,
    insulin: [{ ts: min(-60), units: 2, kind: "rapid", insulin_name: "Fiasp" }],
    meals: [{ ts: min(-60), carbs_g: 90, description: "pizza" }],
  }));
  assert.ok(again.units > 0, again.line);
  assert.ok(again.units <= 2.5, again.line);
});

test("insulin still working counts on the same pessimistic curve: no second dose lands the first one's low", () => {
  const stacked = decideAction(state({
    readings: flat(250), profile: known, insulin: [{ ts: min(-40), units: 3, kind: "rapid", insulin_name: "Fiasp" }],
  }));
  assert.equal(stacked.units, 0);
  assert.equal(stacked.kind, "hold");
});

test("one time to look again, not two", () => {
  const s = state({
    readings: flat(220), profile: known, insulin: [{ ts: min(-20), units: 1, kind: "rapid", insulin_name: "Fiasp" }],
  });
  assert.equal(anticipate(s, decideAction(s))?.kind === "dont_stack", false);
});

test("held back entirely, nothing may be quoted as due", () => {
  const s = state({
    readings: flat(220), profile: known, insulin: [{ ts: min(-20), units: 1, kind: "rapid", insulin_name: "Fiasp" }],
  });
  const d = decideAction(s);
  assert.equal(d.units, 0);
  assert.equal(d.capped, true);
  assert.equal(d.nothingDue, true);
  assert.equal(d.insulinForbidden, true);
  assert.match(d.line, /^Pas d'insuline pour l'instant : ça pourrait passer sous 100\. Regarde de nouveau à 21:30\.$/);
});

test("a fall already under way at a meal: eat first, no insulin yet", () => {
  const down = curve([[-20, 150], [-15, 142], [-10, 135], [-5, 128], [0, 121]]);
  const d = decideAction(state({ readings: down, profile: known }), { candidate: { carbsG: 40, description: "pommes de terre" } });
  assert.equal(d.units, 0);
  assert.equal(d.laterUnits, 0);
  assert.match(d.line, /Commence à manger/);
});

test("the insulin already working can be what carries the meal", () => {
  const d = decideAction(state({
    readings: flat(220), profile: known, insulin: [{ ts: min(-50), units: 2.5, kind: "rapid", insulin_name: "Fiasp" }],
  }), { candidate: { carbsG: 20, description: "riz" } });
  assert.equal(d.units, 0);
  assert.match(d.line, /celle qui agit encore suffit/);
});

test("what the sentence names is what the plan, the memory and the prose are told", () => {
  const s = state({ readings: flat(168), profile: known });
  const d = decideAction(s, { candidate: { carbsG: 90, description: "pizza" } });
  assert.equal(d.plan?.totalUnits, d.units);
  assert.equal((d.plan?.mealUnits ?? 0) + (d.plan?.correctionUnits ?? 0), d.units);
  assert.ok(d.proseCeiling <= d.units + 0.01, String(d.proseCeiling));
  assert.doesNotMatch(d.line, /[3-9] u de/);
});

test("the same floor in Spanish", () => {
  const es = buildState({ nowMs: NOW, lang: "es", tzOffsetMin: TZ, profile: { ...RYAN, ...known }, readings: flat(240), insulin: [], meals: [] });
  const d = decideAction(es);
  assert.match(d.line, /^Pon 1,5 u de Fiasp ahora\. No más: con más, podría bajar de 100\. Vuelve a mirar a las 21:30/);
});

test("a meal hours away is not judged on the glucose of this minute", () => {
  const far = decideAction(state({ readings: flat(85), profile: known }), { candidate: { carbsG: 60, description: "riz", minutesUntil: 120 } });
  assert.ok(far.laterUnits > 0, far.line);
  assert.match(far.line, /au moment de manger/);
});

test("whatever the moment, the floor only ever takes units off, and a harder hit means less", () => {
  for (const g of [75, 95, 110, 140, 180, 220, 280, 350]) {
    for (const carbs of [0, 20, 60, 120]) {
      for (const iob of [0, 1, 3]) {
        const insulin = iob ? [{ ts: min(-45), units: iob, kind: "rapid", insulin_name: "Fiasp" }] : [];
        const food = carbs ? { carbsG: carbs, description: "riz", inMin: 0 } : null;
        const easy = state({ readings: flat(g), profile: known, insulin });
        const hard = state({ readings: flat(g), profile: known, insulin, model: { doses: { factor: HARD_HIT_MAX } } });
        for (const w of [0.5, 2, 6]) {
          const a = safeDose(easy, w, food);
          const b = safeDose(hard, w, food);
          assert.ok(a <= w && b <= a, `${g} ${carbs} ${iob} ${w}: ${a} ${b}`);
          assert.equal((a * 2) % 1, 0);
        }
      }
    }
  }
});

test("no dose named at or above 110 can reach the floor on its own pessimistic path", () => {
  for (const g of [110, 130, 160, 200, 260, 330]) {
    for (const carbs of [0, 30, 60, 90]) {
      const s = state({ readings: flat(g), profile: known });
      const d = carbs ? decideAction(s, { candidate: { carbsG: carbs, description: "pâtes" } }) : decideAction(s);
      if (!d.units) continue;
      const one = safeDose(s, d.units + 0.5, carbs ? { carbsG: carbs, description: "pâtes", inMin: 0 } : null);
      assert.ok(d.units <= one, `${g} ${carbs}: ${d.units} ${one}`);
    }
  }
  assert.equal(DOSE_FLOOR_MGDL, 100);
});

test("a learned harder hit reaches the decision, and nothing can lower the starting caution", () => {
  const s = (factor: number | null) => state({ readings: flat(240), profile: known, model: factor == null ? null : { doses: { factor, judged: 0 } } });
  assert.equal(s(null).hardFactor, HARD_HIT_FACTOR);
  assert.equal(s(0.5).hardFactor, HARD_HIT_FACTOR);
  assert.equal(s(9).hardFactor, HARD_HIT_MAX);
  assert.ok(decideAction(s(2)).units < decideAction(s(null)).units);
});

test("eat less: how much the insulin already in can carry, in grams", () => {
  assert.equal(carbRoomG(state({ readings: flat(130), profile: known })), 10);
  assert.equal(carbRoomG(state({ readings: flat(210), profile: known })), 0);
  assert.ok((carbRoomG(state({ readings: flat(130), profile: known, insulin: [{ ts: min(-30), units: 2, kind: "rapid", insulin_name: "Fiasp" }] })) ?? 0) >= 40);
  const d = decideAction(state({ readings: flat(130), profile: known }), { candidate: { carbsG: 60, description: "pâtes" } });
  assert.match(d.line, /Sans aucune dose, pas plus de ~10 g\.$/);
  const high = decideAction(state({ readings: flat(210), profile: known }), { candidate: { carbsG: 40, description: "gâteau" } });
  assert.match(high.line, /Sans aucune dose, mieux vaut ne rien manger pour l'instant\.$/);
  // A rescue is not a meal to ration, and a correction has no food to talk about.
  assert.doesNotMatch(decideAction(state({ readings: flat(60), profile: known }), { candidate: { carbsG: 16, description: "4 sucres" } }).line, /Sans aucune dose/);
  assert.doesNotMatch(decideAction(state({ readings: flat(240), profile: known })).line, /Sans aucune dose/);
});

// ---- What the doses really did ------------------------------------------------------------------
const dayMs = 86400000;
const stream = (from: number, hours: number, at: (m: number) => number) => {
  const out: { ts: number; value: number }[] = [];
  for (let m = 0; m <= hours * 60; m += 5) out.push({ ts: from + m * 60000, value: at(m) });
  return out;
};

test("a treatment is judged on the four hours after it, and a first part and its rest get one verdict", () => {
  const t = NOW - 3 * dayMs;
  const series = stream(t - 3600000, 8, (m) => (m < 180 ? 150 : 60));
  const one = scoreDoses([{ ts: t, units: 2 }], series, [], NOW);
  assert.equal(one.judged, 1);
  assert.equal(one.stayed90, 0);
  assert.equal(one.stayed70, 0);
  // The fall comes after the second part: the evening counts once, and it failed.
  const two = scoreDoses([{ ts: t, units: 2 }, { ts: t + 100 * 60000, units: 3 }], series, [], NOW);
  assert.equal(two.judged, 1);
  assert.equal(two.stayed90, 0);
  // Far enough apart, they are two treatments.
  const apart = scoreDoses([{ ts: t - 200 * 60000, units: 2 }, { ts: t, units: 2 }], stream(t - 260 * 60000, 12, () => 130), [], NOW);
  assert.equal(apart.judged, 2);
  assert.equal(apart.stayed90, 2);
});

test("too recent, too thin or followed at once: not judged", () => {
  const series = stream(NOW - 6 * 3600000, 6, () => 120);
  assert.equal(scoreDoses([{ ts: NOW - 3600000, units: 2 }], series, [], NOW).judged, 0);
  const t = NOW - 2 * dayMs;
  assert.equal(scoreDoses([{ ts: t, units: 2 }], [], [], NOW).judged, 0);
  assert.equal(scoreDoses([{ ts: t, units: 2 }, { ts: t + 30 * 60000, units: 2 }], stream(t, 6, () => 120), [], NOW).judged, 1);
  // A first part with its rest still inside the last four hours: not over yet.
  assert.equal(scoreDoses([{ ts: NOW - 5 * 3600000, units: 2 }, { ts: NOW - 3 * 3600000, units: 2 }], stream(NOW - 6 * 3600000, 6, () => 120), [], NOW).judged, 0);
  assert.equal(scoreDoses([{ ts: NOW - 40 * dayMs, units: 2 }], stream(NOW - 40 * dayMs, 6, () => 120), [], NOW).judged, 0);
});

test("one dose of the family's own in a treatment does not take it out of the app's account", () => {
  const t = NOW - 3 * dayMs;
  const doses = [{ ts: t, units: 2 }, { ts: t + 60 * 60000, units: 4 }];
  const series = stream(t - 1800000, 7, () => 130);
  assert.equal(scoreDoses(doses, series, [{ ms: t - 60000, units: 2 }], NOW).followed, 1);
  assert.equal(scoreDoses(doses, series, [], NOW).followed, 0);
});

test("a treatment has an end: a dose every two hours is not one verdict", () => {
  const start = NOW - 20 * dayMs;
  const doses = Array.from({ length: 12 }, (_, i) => ({ ts: start + i * 120 * 60000, units: 1 }));
  const s = scoreDoses(doses, stream(start, 30, () => 130), [], NOW);
  assert.ok(s.judged >= 4, String(s.judged));
});

test("the doses the app had just named are counted apart from the others", () => {
  const t = NOW - 3 * dayMs;
  const u = NOW - 2 * dayMs;
  const series = [...stream(t - 1800000, 6, () => 120), ...stream(u - 1800000, 6, () => 60)];
  const doses = [{ ts: t, units: 2 }, { ts: u, units: 5 }];
  const s = scoreDoses(doses, series, [{ ms: t - 10 * 60000, units: 2.5 }, { ms: u - 10 * 60000, units: 2 }], NOW);
  assert.equal(s.judged, 2);
  assert.equal(s.followed, 1);
  assert.equal(s.followed90, 1);
  // Named an hour before, or after the fact: not the same dose.
  assert.equal(scoreDoses(doses, series, [{ ms: t - 60 * 60000, units: 2 }, { ms: t + 60 * 60000, units: 2 }], NOW).followed, 0);
});

test("under nine in ten, the caution rises; it comes back down by itself; few doses say nothing", () => {
  const start = NOW - 25 * dayMs;
  const score = (bad: number, total: number) => {
    const doses: { ts: number; units: number }[] = [];
    const named: { ms: number; units: number }[] = [];
    const series: { ts: number; value: number }[] = [];
    for (let i = 0; i < total; i++) {
      const t = start + i * dayMs;
      doses.push({ ts: t, units: 2 });
      named.push({ ms: t - 60000, units: 2 });
      series.push(...stream(t, 5, () => (i < bad ? 60 : 130)));
    }
    return scoreDoses(doses, series, named, NOW);
  };
  assert.equal(score(0, 20).factor, HARD_HIT_FACTOR);
  assert.equal(score(2, 20).factor, HARD_HIT_FACTOR);
  assert.equal(score(3, 20).factor, 1.7);
  assert.equal(score(5, 20).factor, HARD_HIT_MAX);
  assert.equal(score(14, 14).factor, HARD_HIT_FACTOR);
});

test("the score shows once there is something to show, with or without a forecast", () => {
  const doses = { days: 30, judged: 12, stayed90: 7, stayed70: 11, followed: 8, followed90: 7, factor: 1.5 };
  const s = state({ readings: flat(120), model: { doses } });
  assert.match(forecastNote(s) ?? "", /Doses de l'app sur 30 jours : 7 sur 8 sont restées au-dessus de 90\. Les autres doses : 0 sur 4\./);
  const few = state({ readings: flat(120), model: { doses: { ...doses, followed: 1, followed90: 1 } } });
  assert.match(forecastNote(few) ?? "", /Doses notées sur 30 jours : 7 sur 12/);
  assert.equal(forecastNote(state({ readings: flat(120), model: { doses: { ...doses, judged: 3 } } })), null);
});

// ---- What the sixth review found ----------------------------------------------------------------
const given = (m: number, units: number) => ({ ts: min(m), units, kind: "rapid", insulin_name: "Fiasp" });
const noFigure = (line: string) => assert.doesNotMatch(line, /\d(?:,\d)? u de/, line);

test("a plan held back names no figure for later: that one was the full dose", () => {
  const candidate = { carbsG: 64, description: "riz" };
  for (const s of [
    state({ readings: flat(85), profile: known }),
    state({ readings: flat(120), profile: known, insulin: [given(-20, 3)] }),
    state({ readings: flat(62), profile: known }),
  ]) {
    const d = decideAction(s, { candidate });
    noFigure(d.line);
    assert.equal(d.units, 0);
    assert.equal(d.laterUnits, 0);
    assert.equal(d.plan?.totalUnits ?? 0, 0);
    assert.equal(d.proseCeiling, Math.max(0, ...(s.insulin as any[]).map((x) => x.units)));
  }
  assert.match(decideAction(state({ readings: flat(85), profile: known }), { candidate }).line, /redemande-moi/);
  // The same for a meal already logged, and for one announced.
  noFigure(decideAction(state({ readings: flat(85), profile: known, meals: [{ ts: min(-2), description: "riz", carbs_g: 64 }] })).line);
  noFigure(decideAction(state({ readings: flat(85), profile: known, meals: [{ ts: min(10), description: "riz", carbs_g: 64, planned: true }] })).line);
});

test("the rest of a meal comes up at the second look, even past half of it", () => {
  const plate = { ts: min(-60), description: "riz", carbs_g: 64 };
  const held = { ...known, held_back: { at: min(-60), total: 4, carbsG: 64, description: "riz" } };
  const first = decideAction(state({ readings: flat(160), profile: known }), { candidate: { carbsG: 64, description: "riz" } });
  assert.equal(first.units, 2);
  assert.deepEqual(first.heldBack, { total: 4, carbsG: 64, description: "riz" });
  for (const g of [170, 190, 220]) {
    const d = decideAction(state({ readings: rising(g, 1), profile: held, meals: [plate], insulin: [given(-60, 2)] }));
    assert.ok(d.units >= 0.5 && d.units <= 2, `${g}: ${d.line}`);
    assert.match(d.line, /[Pp]our la suite du repas/, d.line);
    assert.equal(d.heldBack, null, "the first figure stays the one on record");
  }
  // Nothing owed once the whole dose is in, and nothing under the line or on the way down.
  assert.equal(decideAction(state({ readings: rising(170, 1), profile: held, meals: [plate], insulin: [given(-60, 4)] })).units, 0);
  assert.equal(decideAction(state({ readings: flat(120), profile: held, meals: [plate], insulin: [given(-60, 2)] })).units, 0);
  assert.equal(decideAction(state({ readings: rising(170, -2), profile: held, meals: [plate], insulin: [given(-60, 2)] })).units, 0);
  // Not on the way up from a low, and not as the answer to a question about something else.
  const afterLow = curve([[-60, 60], [-50, 62], [-40, 90], [-30, 120], [-20, 140], [-10, 160], [-5, 165], [0, 170]]);
  assert.equal(decideAction(state({ readings: afterLow, profile: held, meals: [plate], insulin: [given(-60, 2)] })).units, 0);
  const rescue = decideAction(state({ readings: rising(170, 1), profile: held, meals: [plate], insulin: [given(-60, 2)] }), { candidate: { carbsG: 8, description: "3 sucres" } });
  assert.equal(rescue.units, 0);
  // Too soon after the first part: it has not shown what it does yet. First part not done: the question comes first.
  assert.equal(decideAction(state({ readings: rising(170, 1), profile: { ...held, held_back: { ...held.held_back, at: min(-30) } }, meals: [{ ...plate, ts: min(-30) }], insulin: [given(-30, 2)] })).units, 0);
  assert.equal(decideAction(state({ readings: rising(170, 1), profile: held, meals: [{ ...plate, ts: min(-300) }] })).capped, false);
});

test("the rest is what the app held back, never something it works out from the rows", () => {
  // The can that treated a low, a dose and no memory of holding anything back: the frozen answer stands.
  const afterLow = curve([[-110, 75], [-100, 66], [-92, 60], [-85, 62], [-75, 90], [-60, 120], [-40, 145], [-20, 160], [-10, 168], [-5, 172], [0, 175]]);
  const can = decideAction(state({ readings: afterLow, profile: known, meals: [{ ts: min(-92), description: "7up", carbs_g: 33 }], insulin: [given(-125, 1)] }));
  assert.equal(can.units, 0, can.line);
  // A meal covered at half with nothing held back.
  const plain = decideAction(state({ readings: rising(170, 1), profile: known, meals: [{ ts: min(-60), description: "riz", carbs_g: 64 }], insulin: [given(-60, 2)] }));
  assert.equal(plain.units, 0, plain.line);
});

test("the rest stops at what is really left, and at a dose announced", () => {
  const held = (at: number, total: number, carbsG: number, description: string) => ({ ...known, held_back: { at: min(at), total, carbsG, description } });
  // Juice two hours gone: nothing of it is left to dose.
  assert.equal(decideAction(state({ readings: flat(178), profile: held(-135, 2, 30, "jus"), meals: [{ ts: min(-135), description: "jus", carbs_g: 30 }], insulin: [given(-135, 1)] })).units, 0);
  // Past three hours the memory is gone.
  assert.equal(state({ readings: flat(178), profile: held(-200, 2, 30, "riz") }).heldBack, null);
  const rows = { meals: [{ ts: min(-60), description: "riz", carbs_g: 96 }], profile: held(-60, 6, 96, "riz") };
  const later = decideAction(state({ ...rows, readings: rising(200, 1), insulin: [given(-60, 3), given(15, 2)] }));
  assert.equal(later.units, 0, later.line);
});

test("no ban on a new dose during the second look it announced", () => {
  const profile = { ...known, held_back: { at: min(-40), total: 4, carbsG: 64, description: "riz" } };
  const s = state({ readings: flat(220), profile, meals: [{ ts: min(-40), description: "riz", carbs_g: 64 }], insulin: [given(-40, 2)] });
  assert.notEqual(anticipate(s, decideAction(s))?.kind, "dont_stack");
});

test("the same plate seen twice feeds him once", () => {
  const row = { ts: min(-1), description: "riz et poulet", carbs_g: 80 };
  const candidate = { carbsG: 80, description: "riz et poulet" };
  const once = decideAction(state({ readings: flat(150), profile: known }), { candidate });
  assert.equal(decideAction(state({ readings: flat(150), profile: known, meals: [row] }), { candidate }).units, once.units);
  // A second photo that wrote its own row.
  assert.equal(decideAction(state({ readings: flat(150), profile: known, meals: [row, { ...row, ts: min(0) }] })).units, once.units);
});

test("a dose named and never answered counts, and it still gets asked about", () => {
  const meals = [{ ts: min(20), description: "riz", carbs_g: 48, planned: true }];
  const clear = decideAction(state({ readings: flat(180), profile: known, meals }));
  const open = decideAction(state({
    readings: flat(180), meals, profile: { ...known, pending_action: { units: 2, at: min(-15), insulin: "Fiasp" } },
  }));
  assert.ok(open.laterUnits < clear.laterUnits, `${open.laterUnits} ${clear.laterUnits}`);
  // Whatever the floor leaves of the dose, the question comes first.
  const asked = decideAction(state({ readings: flat(190), profile: { ...known, pending_action: { units: 3, at: min(-15), insulin: "Fiasp" } } }));
  assert.equal(asked.kind, "ask_done");
});

test("a dose just named is not counted on top of itself", () => {
  const profile = { ...known, pending_action: { units: 1.5, at: min(-4), insulin: "Fiasp" } };
  assert.equal(decideAction(state({ readings: flat(240), profile })).units, 1.5);
});

test("no blame after a first part done as told, and one time to look again", () => {
  const s = state({ readings: rising(240, 1), profile: known, meals: [{ ts: min(-60), description: "pâtes", carbs_g: 80 }], insulin: [given(-60, 2)] });
  const d = decideAction(s);
  assert.doesNotMatch(sideNotes(s, d).map((n) => n.display).join(" "), /n'a pas été couvert/);
  const p = state({ readings: flat(168), profile: known, meals: [{ ts: min(-40), description: "pizza", carbs_g: 90 }], insulin: [given(-40, 1)] });
  const pd = decideAction(p);
  if (pd.capped) assert.notEqual(anticipate(p, pd)?.kind, "fatty_late");
});

test("a meal far ahead does not depend on today's high", () => {
  const candidate = { carbsG: 64, description: "riz", minutesUntil: 120 };
  const a = decideAction(state({ readings: flat(130), profile: known }), { candidate });
  const b = decideAction(state({ readings: flat(250), profile: known }), { candidate });
  assert.ok(b.laterUnits <= a.laterUnits + 0.5, `${a.laterUnits} ${b.laterUnits}`);
});

test("better eat nothing is never said next to start eating", () => {
  const down = curve([[-20, 230], [-15, 215], [-10, 200], [-5, 185], [0, 170]]);
  const d = decideAction(state({ readings: down, profile: known }), { candidate: { carbsG: 16, description: "gâteau" } });
  assert.doesNotMatch(d.line, /mieux vaut ne rien manger/);
});

test("sport reaches the figure the floor names", () => {
  const activity = [{ ts: min(-30), ended_at: min(-30), kind: "football", intensity: "high", duration_min: 60 }];
  const none = decideAction(state({ readings: flat(240), profile: known }));
  const after = decideAction(state({ readings: flat(240), profile: known, activity }));
  if (state({ readings: flat(240), profile: known, activity }).activityCut > 0) assert.ok(after.units < none.units, `${after.units} ${none.units}`);
});

test("older insulin counts at least as much as the plain estimate says", () => {
  const d = decideAction(state({ readings: flat(150), profile: known, insulin: [given(-120, 2)] }), { candidate: { carbsG: 60, description: "riz" } });
  assert.equal(d.units, 1);
});

test("a direction nobody can read is not flat, and an old reading is where he was", () => {
  const gap = curve([[-90, 220], [-80, 220], [-70, 220], [-60, 220], [-3, 140], [0, 138]]);
  const unread = state({ readings: gap, profile: known });
  assert.equal(unread.slope ?? null, null);
  const candidate = { carbsG: 64, description: "riz" };
  const steady = decideAction(state({ readings: flat(138), profile: known }), { candidate });
  assert.ok(decideAction(unread, { candidate }).units < steady.units);
  // Falling 3 a minute, the last reading 14 minutes old: he is nearer 128 than 170.
  const old = state({ readings: rising(170, -3).map((r) => ({ ...r, ts: r.ts - 14 * 60000 })), profile: known });
  const fresh = state({ readings: rising(128, -3), profile: known });
  const dish = { carbsG: 64, description: "riz", inMin: 0 };
  assert.equal(safeDose(old, 4, dish), safeDose(fresh, 4, dish));
});

test("the floor never sits under 90", () => {
  const d = decideAction(state({ readings: flat(92), profile: known }), { candidate: { carbsG: 40, description: "pizza" } });
  assert.equal(d.units, 0);
  assert.match(d.line, /Commence à manger|mange d'abord/);
});

test("the prose can quote what is on record or what is named, not the two added up", () => {
  const d = decideAction(state({ readings: flat(240), profile: known, insulin: [given(-420, 4)] }));
  assert.equal(d.units, 1.5);
  assert.equal(d.proseCeiling, 4);
});

test("a fall that held the dose back is looked at soon, with sugar at hand", () => {
  const down = rising(130, -3);
  const d = decideAction(state({ readings: down, profile: known }), { candidate: { carbsG: 40, description: "pâtes" } });
  assert.equal(d.units, 0);
  assert.match(d.line, /regarde de nouveau à 20:20\. Garde du sucre à portée\./i);
});

test("a meal two hours off is not « start eating »", () => {
  const d = decideAction(state({ readings: flat(180), profile: known, insulin: [given(-40, 2)] }), {
    candidate: { carbsG: 48, description: "riz", minutesUntil: 120 },
  });
  assert.doesNotMatch(d.line, /Commence à manger/);
  assert.ok(d.laterUnits > 0 || /redemande-moi au moment de manger/.test(d.line), d.line);
});

test("what the analysis calls covered, the photo calls covered", () => {
  const s = state({ readings: flat(250), profile: known, insulin: [given(-40, 3)] });
  const photo = decideAction(s, { candidate: { carbsG: 64, description: "riz" } });
  const row = decideAction(state({ readings: flat(250), profile: known, insulin: [given(-40, 3)], meals: [{ ts: min(0), description: "riz", carbs_g: 64 }] }));
  assert.equal(photo.units, row.units);
});

test("a dose announced with its meal counts, however far off", () => {
  const meals = [{ ts: min(90), description: "riz", carbs_g: 64, planned: true }];
  const alone = decideAction(state({ readings: flat(150), profile: known, meals }));
  const withDose = decideAction(state({ readings: flat(150), profile: known, meals, insulin: [given(90, 3)] }));
  assert.ok(withDose.laterUnits < alone.laterUnits, `${withDose.laterUnits} ${alone.laterUnits}`);
});

test("a profile with no correction factor still has a floor", () => {
  const d = decideAction(state({ readings: flat(100), profile: { ...known, correction_factor: null } }), { candidate: { carbsG: 96, description: "riz" } });
  assert.ok(d.units <= 2.5, d.line);
});

test("the small things in the sentence", () => {
  // No grams on a correction when there is no ratio to dose food with.
  const noRatio = decideAction(state({ readings: flat(240), profile: { ...known, carb_ratio: null }, meals: [{ ts: min(-20), description: "riz", carbs_g: 64 }] }));
  assert.doesNotMatch(noRatio.line, /^Pour ~/);
  // Not two colons in a row.
  const blind = decideAction(state({ readings: flat(150) }), { candidate: { carbsG: 48, description: "riz" } });
  assert.doesNotMatch(blind.line, /: [^:.]*: fais/, blind.line);
  // Under 110 the reason says it in words.
  const es = buildState({ nowMs: NOW, lang: "es", tzOffsetMin: TZ, profile: { ...RYAN, ...known }, readings: flat(105), insulin: [], meals: [] });
  assert.doesNotMatch(decideAction(es, { candidate: { carbsG: 40, description: "arroz" } }).line, /bajar más/);
  // "Eat less" is for a plate that has not been eaten.
  const eaten = decideAction(state({ readings: flat(150), profile: known, meals: [{ ts: min(-4), description: "riz", carbs_g: 48 }] }));
  assert.doesNotMatch(eaten.line, /Sans aucune dose/);
});

// ---- What the seventh review found --------------------------------------------------------------
test("a model reads one plate two ways: still one plate", () => {
  const row = { ts: min(-3), description: "Riz et poulet", carbs_g: 80 };
  const once = decideAction(state({ readings: flat(150), profile: known }), { candidate: { carbsG: 80, description: "Riz et poulet" } });
  const again = decideAction(state({ readings: flat(150), profile: known, meals: [row] }), { candidate: { carbsG: 78, description: "Assiette de riz au poulet" } });
  assert.equal(again.units, once.units);
  assert.doesNotMatch(again.line, /Sans aucune dose/);
  // Another size is another plate, and so is the same size further apart, under another name.
  const other = decideAction(state({ readings: flat(150), profile: known, meals: [row] }), { candidate: { carbsG: 40, description: "gâteau" } });
  assert.ok(other.units >= 1, other.line);
  const later = decideAction(state({ readings: flat(150), profile: known, meals: [{ ...row, ts: min(-30) }] }), { candidate: { carbsG: 78, description: "pâtes carbonara" } });
  assert.ok(later.units > once.units, later.line);
});

test("a fall with a meal on its way: sugar at hand and a time to look, whatever the hour of the meal", () => {
  const down = rising(100, -2);
  for (const minutesUntil of [10, 30, 60]) {
    const d = decideAction(state({ readings: down, profile: known }), { candidate: { carbsG: 48, description: "riz", minutesUntil } });
    if (d.laterUnits > 0) continue;
    assert.match(d.line, /sucre/i, `${minutesUntil}: ${d.line}`);
  }
  const far = decideAction(state({ readings: rising(130, -3), profile: known }), { candidate: { carbsG: 48, description: "riz", minutesUntil: 60 } });
  assert.match(far.line, /20:20/, far.line);
  assert.doesNotMatch(decideAction(state({ readings: rising(130, -3), profile: known }), { candidate: { carbsG: 40, description: "pâtes" } }).line, /Sans aucune dose/);
});

test("a direction nobody can read gets the same quick look as a fall", () => {
  const gap = curve([[-90, 220], [-80, 220], [-70, 220], [-60, 220], [-3, 140], [0, 138]]);
  const d = decideAction(state({ readings: gap, profile: known }), { candidate: { carbsG: 64, description: "riz" } });
  assert.match(d.line, /20:20/, d.line);
});

test("the hint says when the dose is for", () => {
  const s = state({ readings: flat(150), profile: known });
  const later = decideAction(s, { candidate: { carbsG: 64, description: "riz", minutesUntil: 120 } });
  assert.match(decisionHint(s, later), /au moment de manger/);
  const held = state({ readings: flat(220), profile: known, insulin: [given(-20, 1)] });
  assert.match(decisionHint(held, decideAction(held)), /pas d'insuline/);
  const hot = state({ readings: flat(240), profile: known });
  assert.match(decisionHint(hot, decideAction(hot)), /une petite dose maintenant/);
});

test("the plate counts even when the sum calls it covered", () => {
  const s = state({ readings: flat(300), profile: known, insulin: [given(-40, 3)] });
  const d = decideAction(s, { candidate: { carbsG: 64, description: "riz" } });
  assert.doesNotMatch(d.line, /Pas d'insuline pour l'instant : ça pourrait passer sous 100/, d.line);
});

test("a dose for later done early settles the question", () => {
  const raw = { units: 2, at: min(-36), namedAt: min(-76), insulin: "Fiasp" };
  assert.equal(openPendingDose(raw, [given(-61, 2)], NOW), null);
  assert.ok(openPendingDose(raw, [], NOW));
  assert.ok(openPendingDose(raw, [given(-90, 2)], NOW), "a dose from before it was named is not its answer");
});

test("what follows a brand-new plate after a correction is about that plate", () => {
  const d = decideAction(state({ readings: flat(240), profile: known, insulin: [given(-120, 1)] }), { candidate: { carbsG: 64, description: "riz" } });
  assert.doesNotMatch(d.line, /suite du repas/);
});

test("the estimate and the rest do not make two colons", () => {
  const held = { ...known, held_back: { at: min(-60), total: 5, carbsG: 80, description: "paella" } };
  const d = decideAction(state({
    readings: rising(220, 1), profile: held, insulin: [given(-60, 2)],
    meals: [{ ts: min(-60), description: "paella", carbs_g: 80, carbs_estimated: true }],
  }));
  assert.doesNotMatch(d.line, /: [^.:]*: fais/, d.line);
});

// ---- What the eighth review found ---------------------------------------------------------------
test("a dose the sum names goes through the floor, held back or not", () => {
  const profile = { ...known, held_back: { at: min(-35), total: 4, carbsG: 64, description: "pâtes" } };
  const rows = { meals: [{ ts: min(-35), description: "pâtes", carbs_g: 64 }], insulin: [given(-35, 1)] };
  const down = decideAction(state({ ...rows, readings: rising(135, -1.5), profile }));
  assert.equal(down.units, 0, down.line);
  assert.match(down.line, /sucre/, down.line);
  const flatLook = decideAction(state({ ...rows, readings: flat(135), profile: { ...known, held_back: { at: min(-10), total: 4, carbsG: 60, description: "riz" } } }));
  assert.ok(flatLook.units <= 1, flatLook.line);
});

test("with something held back, no dose anywhere stands above the floor or the total", () => {
  let fired = 0;
  for (const g of [100, 120, 135, 150, 170, 190, 220, 260, 320]) {
    for (const slope of [-4, -2, -1, 0, 1, 3]) {
      for (const age of [10, 35, 50, 60, 90, 150]) {
        for (const done of [0, 1, 2, 3.5]) {
          const carbs = 64;
          const s = state({
            readings: rising(g, slope),
            profile: { ...known, held_back: { at: min(-age), total: 4, carbsG: carbs, description: "pâtes" } },
            meals: [{ ts: min(-age), description: "pâtes", carbs_g: carbs }],
            insulin: done ? [given(-age, done)] : [],
          });
          const d = decideAction(s);
          if (d.units <= 0) continue;
          fired++;
          assert.ok(d.units <= safeDose(s, d.units), `${g} ${slope} ${age} ${done}: ${d.units} ${d.line}`);
          if (d.rest) assert.ok(d.units + done <= 4, `${g} ${slope} ${age} ${done}: ${d.units}`);
        }
      }
    }
  }
  assert.ok(fired > 50, String(fired));
});

test("a correction just before the plate is not its first part", () => {
  const d = decideAction(state({
    readings: flat(200), insulin: [given(-10, 1)], meals: [{ ts: min(-3), description: "riz", carbs_g: 64 }],
    profile: { ...known, held_back: { at: min(-3), total: 4, carbsG: 64, description: "riz" } },
  }));
  assert.doesNotMatch(d.line, /suite du repas/, d.line);
});

test("a plate deleted takes its rest with it, and another plate is not its rest", () => {
  const profile = { ...known, held_back: { at: min(-60), total: 4, carbsG: 64, description: "riz" } };
  const gone = decideAction(state({ readings: rising(190, 1), profile, insulin: [given(-60, 2)] }));
  assert.equal(gone.rest, false);
  const fresh = decideAction(state({ readings: rising(190, 1), profile, insulin: [given(-60, 2)], meals: [{ ts: min(-60), description: "riz", carbs_g: 64 }, { ts: min(-2), description: "gâteau", carbs_g: 40 }] }));
  assert.doesNotMatch(fresh.line, /suite du repas/, fresh.line);
});

test("no dose stands beside his own history saying this ends low", () => {
  const base0 = state({ readings: flat(150), profile: known });
  const warned = { ...base0, forecast: { ...(base0.forecast as any), lowWarning: true } };
  const d = decideAction(warned, { candidate: { carbsG: 40, description: "riz" } });
  assert.equal(d.units, 0);
  assert.match(d.line, /sucre/);
  const hot = state({ readings: flat(240), profile: known });
  assert.equal(decideAction({ ...hot, forecast: { ...(hot.forecast as any), lowWarning: true } }).units, 0);
});

test("the stacking warning stays once nothing is owed", () => {
  const profile = { ...known, held_back: { at: min(-100), total: 4, carbsG: 64, description: "riz" } };
  const s = state({ readings: flat(230), profile, meals: [{ ts: min(-100), description: "riz", carbs_g: 64 }], insulin: [given(-100, 2), given(-20, 2)] });
  const d = decideAction(s);
  assert.equal(d.units, 0);
  assert.equal(anticipate(s, d)?.kind, "dont_stack");
});

test("the model hears that it is the rest, and a rest gives a time too", () => {
  const profile = { ...known, held_back: { at: min(-60), total: 4, carbsG: 64, description: "riz" } };
  const s = state({ readings: rising(170, 1), profile, meals: [{ ts: min(-60), description: "riz", carbs_g: 64 }], insulin: [given(-60, 2)] });
  const d = decideAction(s);
  assert.equal(d.rest, true);
  assert.match(decisionHint(s, d), /il reste un peu d'insuline/);
  assert.match(d.line, /Regarde de nouveau à/);
});

test("a dose on a fall comes with sugar at hand", () => {
  const d = decideAction(state({ readings: rising(130, -3), profile: known }), { candidate: { carbsG: 48, description: "riz", minutesUntil: 30 } });
  if (d.laterUnits > 0) assert.match(d.line, /sucre/, d.line);
});

test("two names for one plate, moments apart", () => {
  const row = { ts: min(-3), description: "Spaghetti bolognaise", carbs_g: 80 };
  const once = decideAction(state({ readings: flat(150), profile: known }), { candidate: { carbsG: 80, description: "Spaghetti bolognaise" } });
  const again = decideAction(state({ readings: flat(150), profile: known, meals: [row] }), { candidate: { carbsG: 78, description: "Pâtes à la sauce tomate et viande" } });
  assert.equal(again.units, once.units);
});

test("7 November: 8 u on record, two slices of toast, and a curve that climbs", () => {
  const ryan = { weight_kg: 40, carb_ratio: 16, correction_factor: 58, target_mgdl: 120, rapid_insulin: "Fiasp" };
  const dose = [{ ts: min(-130), units: 8, kind: "rapid", insulin_name: "Fiasp" }];
  const toast = [{ ts: min(-5), description: "Une tartine beurre et Nutella et une tartine au beurre", carbs_g: 40, planned: false }];
  const up = curve([[-12, 53], [-10, 53], [-8, 55], [-7, 57], [-6, 60], [-5, 62], [-4, 63], [-3, 64], [-1, 64], [0, 64]]);

  // Both are in the sum: this was never the problem.
  const s = state({ readings: up, profile: ryan, insulin: dose, meals: toast });
  assert.ok(s.iob > 1.5 && s.iobInjected > 1.5, `insulin ${s.iob}`);
  assert.ok(s.cob > 30, `food ${s.cob}`);

  // 11:16, 53, flat, nothing eaten: the rule, not six.
  const low = decideAction(state({ readings: flat(53), profile: ryan, insulin: dose }));
  assert.equal(low.kind, "sugar");
  assert.equal(low.sugarGrams, 16);
  assert.match(low.line, /^Prends 16 g de sucre rapide \(4 morceau/);

  // 11:25, 64, climbing, toast noted: nothing more.
  const fed = decideAction(s);
  assert.notEqual(fed.kind, "sugar");
  assert.equal(fed.sugarGrams, 0);
  assert.equal(fed.units, 0);
  assert.match(fed.line, /^Tu as mangé et ça remonte : pas de sucre en plus/, fed.line);
  assert.match(fed.line, /Recontrôle dans 10 min/);

  // The same, before the toast was noted.
  const unknown = decideAction(state({ readings: up, profile: ryan, insulin: dose }));
  assert.equal(unknown.sugarGrams, 0);
  assert.match(unknown.line, /^Ça remonte déjà : pas de sucre en plus/, unknown.line);

  // Toast eaten and still going down: it treats nothing yet.
  const down = decideAction(state({ readings: rising(64, -1), profile: ryan, insulin: dose, meals: toast }));
  assert.equal(down.kind, "sugar");
  assert.equal(down.sugarGrams, 16);

  // 11:28, 77 and up 3 a minute: not "sans sucre tu passes sous 70".
  const back = curve([[-14, 57], [-12, 60], [-10, 62], [-8, 63], [-6, 64], [-4, 64], [-3, 71], [0, 77]]);
  const after = decideAction(state({ readings: back, profile: ryan, insulin: dose, meals: toast }));
  assert.equal(after.sugarGrams, 0);
  assert.equal(after.units, 0);
  assert.doesNotMatch(after.line, /TROP TARD|passes sous 70|MAINTENANT/, after.line);
  assert.match(after.line, /ça remonte/, after.line);
  assert.match(after.line, /aucune insuline en plus/, after.line);
});
