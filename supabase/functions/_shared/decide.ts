// THE ONE DECISION. Analysis, voice, photo and the meals screen all come through here.
//
// They used to reach their own answers. The analysis called mealBolusPlan, the voice did not; the
// voice saw twelve untimed values and no stored history; the photo and the meals screen had a third
// path. On 6 November 2026 that gave one family three different answers in four minutes about the
// same 3 u. A single state and a single function make that impossible by construction: the surfaces
// differ in how they TALK, never in what they decide.
//
// What this adds on top of doseGuard, which keeps every rule about doses:
//   - knowing what it does not know: 866 of 1010 named doses were computed with "no insulin logged"
//     on a child who injects 20 u a day, so a dose is now conditional until the last 3 h are known;
//   - remembering what it said: six analyses in 46 minutes added up to 8 u, each one blind to the last;
//   - looking ahead: what the insulin and food on board will do, and what his history says next;
//   - never asking a dose to be right on the first try. See THE FLOOR, below.
//
// Pure TS, no Deno or Node APIs.

import {
  activeIob, activityBolusCut, activityLowWatchBump, activityNote, ANNOUNCED_DOSE_MIN, applyActivityCut, balanceRates,
  balanceSystemLine, carbOnsetMin, carbsLandingWithin, carbsOnBoard, cobWindowMin, combinedActionLine, computeGuard,
  COB_TRUST_FRACTION, dosingActingWithin, dosingIob, eatenAsTreatment, FALL_WATCH_BELOW, findUncoveredMeal, glucoseBalance,
  HIGH_MGDL, hypoIobWarning,
  inRangeActionLine, insulinActingWithin, isEatenBy, isFattyMeal, isHypoRescue, LOW_MGDL, MEAL_COVER_WINDOW_MIN, mealBolusHeldByIob,
  mealBolusHeldLine, mealBolusPlan, mealCarbSpeed, mealPlanLine, namedAsRescue, noDoseDue, plannedMealNote, planMealDose,
  predictiveAdvice, preSportCarbsLine, recentHypoFrom, robustSlope, roundToHalf, situationHint,
  speakable, STALE_MIN, temperatureLowWatchBump, temperatureNote, toGuardProfile, trendFromReadings,
  UNCOVERED_MEAL_MIN_CARBS, uncoveredMealWarning, minutesSinceFood, minutesSinceLastRescue,
} from "./doseGuard.ts";
import type {
  BalanceRates, GlucoseBalance, GuardProfile, GuardResult, MealPlanResult, Predict, Trend,
} from "./doseGuard.ts";
import { DOSE_STAYS_ABOVE, forecastGlucose, HARD_HIT_FACTOR, HARD_HIT_MAX, REGIME_SETTLED_DAYS } from "./forecast.ts";
import type { DoseScore, Forecast, ForecastModel, Pt } from "./forecast.ts";
import { basalNotice, curveOf, fractionRemaining, insulinByName, isBasalInsulin } from "./insulins.ts";
import type { InsulinCurve } from "./insulins.ts";

/** How far back the app must know the rapid insulin before it may name a firm dose. Fiasp has done
 *  about 86 % of its work by then, and this is the window ISPAD names for stacking. */
export const INSULIN_MEMORY_MIN = 180;
/** "Nothing injected" stays true for this long after someone says so. */
export const CONFIRM_VALID_MIN = 60;
/** A dose just named is left alone this long before asking whether it was done. */
export const PENDING_GRACE_MIN = 10;
/** Past this, a dose named and never answered has stopped mattering. */
export const PENDING_MAX_MIN = 240;
/** Sooner for a dose that was only ever "if nothing in 3 h": ignored, it held every other dose back for
 *  nearly four hours while the glucose went from 252 to 340. */
export const PENDING_CONDITIONAL_MAX_MIN = 60;
/** The learned chance of going under 70 within the hour that is worth saying out loud, for a model
 *  fitted before the dedicated low warning existed. Measured walk-forward: announced 30-40 %, happened
 *  42 %, about 15 moments a day. */
export const LOW_RISK_WARN = 0.3;
/** Same for going over 250: announced 50-70 %, happened 89 %. */
export const HIGH_RISK_WARN = 0.5;
/** A landing this far above the low line is not worth a warning, however the curve bends. */
const LANDING_SIM_STEP_MIN = 5;
const LANDING_SIM_HORIZON_MIN = 240;
/** The family's rule: a dose followed must leave him at 90 to 100 at the very least. */
export const DOSE_FLOOR_MGDL = 100;
/** When to look again after a dose held back. His lows after a dose come at 68 / 90 / 129 min (quartiles):
 *  by then the dose has shown what it does, and it is still early enough to add to it. Sooner around a
 *  meal, where what was held back is food already on its way. */
export const SECOND_LOOK_MIN = 90;
export const SECOND_LOOK_MEAL_MIN = 60;
/** A dose held back by a fall in progress: at 3 mg/dL per minute, 130 is 70 in twenty minutes. */
const FALL_LOOK_MIN = 20;
/** The floor can sit a little under where he is, down to this and no further. */
const DOSE_LAST_LINE_MGDL = 90;
/** Past this a meal is eaten at another glucose: the one on the screen says nothing about it. */
const MEAL_TOO_FAR_MIN = 45;
/** Further off than this, "start eating" is not what to say about it. */
const MEAL_SOON_MIN = 20;
/** The same food seen twice this close is the same plate, and the same size this close whatever it is called. */
const SAME_PLATE_MIN = 45;
const SAME_PLATE_NOW_MIN = 10;
/** When nobody can read the direction, the side to take: robustSlope's null is not a flat line. */
const UNREADABLE_SLOPE = -1.5;
/** The rest of a meal: not under this, not sooner after the last dose, and not past this long after it. */
const REST_FROM_MGDL = 130;
const REST_AFTER_DOSE_MIN = 45;
const REST_MAX_MIN = 180;

export type InsulinKnowledge = "logged" | "confirmed_none" | "unknown";

export interface PendingDose {
  units: number;
  /** When the dose was named, in ms. */
  at: number;
  insulin?: string | null;
  /** The newest dose already on record at that moment. Only a dose after it can be the answer: the one
   *  that was already counted when this dose was worked out says nothing about this dose. */
  knownDoseAt?: number | null;
  /** It was "if nothing in 3 h". Any dose that sum did not know about means the condition failed. */
  conditional?: boolean;
  /** It goes in two parts: "done" means a part, so the answer has to say how much. */
  split?: boolean;
}

/** What the floor kept back from a meal's dose, on record so that the second look can come back to it. */
export interface HeldBack {
  /** When the first part was due, in ms. */
  at: number;
  /** The whole dose the sum wanted for this meal. */
  total: number;
  carbsG: number;
  description?: string | null;
}

export interface EngineInput {
  nowMs: number;
  lang: string;
  tzOffsetMin: number;
  /** The `mechabetics_profiles` row, as it comes out of the database. */
  profile: any;
  /** Ascending, suspect rows already removed. */
  readings: Pt[];
  insulin: any[];
  meals: any[];
  activity?: any[];
  tempC?: number | null;
  outdoor?: boolean;
  place?: string | null;
  sensorExpired?: boolean;
  model?: ForecastModel | null;
  /** Rows for the rescue clock when `meals` leaves one out (a meal being edited). */
  rescueMeals?: any[];
}

export interface EngineState {
  nowMs: number;
  lang: string;
  tzOffsetMin: number;
  profileRow: any;
  gp: GuardProfile | null;
  readings: Pt[];
  insulin: any[];
  meals: any[];
  activity: any[];
  cur: number | null;
  lastTs: number;
  staleMin: number;
  signalLost: boolean;
  sensorExpired: boolean;
  trend: Trend;
  slope: number | null;
  /** Best estimate of the insulin still working: what the screen shows and the forecast uses. */
  iob: number;
  /** What a new dose is judged against. Never less than `iob`. See dosingIob. */
  iobDose: number;
  /** The same without what was only announced: what a low has to be treated against. */
  iobInjected: number;
  cob: number;
  rates: BalanceRates;
  /** The same rates, with the hour's insulin judged like `iobDose`. */
  ratesDose: BalanceRates;
  balance: GlucoseBalance | null;
  guard: GuardResult;
  recentHypo: boolean;
  minSinceRescue: number | null;
  minSinceFood: number | null;
  activityCut: number;
  knowledge: InsulinKnowledge;
  pending: PendingDose | null;
  predict: Predict;
  forecast: Forecast | null;
  /** How hard a dose is assumed to hit, and what his doses really did. See THE FLOOR. */
  hardFactor: number;
  doseScore: DoseScore | null;
  heldBack: HeldBack | null;
  tempC: number | null;
  outdoor: boolean;
  place: string | null;
}

const es = (lang: string) => lang === "es";
const tsOf = (v: any): number => (typeof v === "number" ? v : new Date(v).getTime());
const fmtU = (u: number): string => (Number.isInteger(u) ? String(u) : String(u).replace(".", ","));

/** "20:45" in the patient's local time. */
export function clock(ms: number, tzOffsetMin: number): string {
  const m = ((Math.floor(ms / 60000 + tzOffsetMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Was any rapid dose logged in the window, or did someone just say there was none? */
export function insulinKnowledge(doses: any[], nowMs: number, confirmedAtMs: number | null | undefined): InsulinKnowledge {
  const since = nowMs - INSULIN_MEMORY_MIN * 60000;
  const logged = (doses || []).some((d) => {
    if (!d || d.kind === "basal" || isBasalInsulin(d.name ?? d.insulin_name)) return false;
    const t = tsOf(d.ts);
    return Number.isFinite(t) && t >= since && t <= nowMs + 60000;
  });
  if (logged) return "logged";
  const c = Number(confirmedAtMs);
  if (Number.isFinite(c) && c > 0 && nowMs - c >= 0 && nowMs - c <= CONFIRM_VALID_MIN * 60000) return "confirmed_none";
  return "unknown";
}

/** The dose named earlier and never answered, or null. A dose given after the one already known at
 *  that moment settles it, whatever its size: the question was only ever "did something happen". One
 *  given long before the naming is not an answer to it. */
export function openPendingDose(raw: any, doses: any[], nowMs: number): PendingDose | null {
  if (!raw || typeof raw !== "object") return null;
  const units = Number(raw.units);
  const at = Number(raw.at);
  if (!(units > 0) || !Number.isFinite(at)) return null;
  const conditional = raw.conditional === true;
  const maxMin = conditional ? PENDING_CONDITIONAL_MAX_MIN : PENDING_MAX_MIN;
  if (nowMs - at > maxMin * 60000 || at > nowMs + 60000) return null;
  const known = Number(raw.knownDoseAt) || 0;
  // "Si aucune insuline depuis 3 h": a dose half an hour before it, told afterwards, is the answer. DÉJÀ
  // FAITE at -30 min left the question open, and FAIT then wrote a second dose. Older than those 3 h, it
  // says nothing about the condition. A dose for later can be done any time after it was named.
  const named = Number(raw.namedAt) || at;
  const from = Math.min(named, at - (conditional ? INSULIN_MEMORY_MIN : 15) * 60000);
  const settled = (doses || []).some((d) => {
    if (!d || d.kind === "basal" || isBasalInsulin(d.name ?? d.insulin_name)) return false;
    const t = tsOf(d.ts);
    return Number.isFinite(t) && t >= from && t > known && t <= nowMs + 60000;
  });
  if (settled) return null;
  return {
    units, at, insulin: raw.insulin ?? null,
    ...(known ? { knownDoseAt: known } : {}),
    ...(conditional ? { conditional } : {}),
    ...(raw.split === true ? { split: true } : {}),
  };
}

/**
 * What the logged insulin and food will still do by each horizon, for the forecast. A dose logged at
 * normal glucose with no meal beside it is almost always the meal's dose with the meal left unnoted,
 * and its fall will not happen: on those windows the arithmetic made the forecast much worse (60 min:
 * 61 to 84), so insulin only counts when its reason is known.
 */
function forecastPhysics(
  insulin: any[], meals: any[], readings: Pt[], nowMs: number, gp: GuardProfile | null,
): Record<string, number> {
  const isf = gp?.correctionFactor && gp.correctionFactor > 0 ? gp.correctionFactor : null;
  const icr = gp?.carbRatio && gp.carbRatio > 0 ? gp.carbRatio : null;
  if (!isf) return {};
  const recentDoses = (insulin || []).filter((d) => {
    if (!d || d.kind === "basal" || isBasalInsulin(d.name ?? d.insulin_name)) return false;
    const t = tsOf(d.ts);
    return Number.isFinite(t) && t <= nowMs && nowMs - t <= 240 * 60000;
  });
  const unexplained = recentDoses.some((d) => {
    const t = tsOf(d.ts);
    const withMeal = (meals || []).some((m) => {
      if (!m) return false;
      return Math.abs(tsOf(m.ts) - t) <= 90 * 60000 && Number(m.carbs_g ?? m.carbsG ?? 0) > 0;
    });
    if (withMeal) return false;
    let nearest: Pt | null = null;
    for (const r of readings || []) {
      if (!nearest || Math.abs(r.ts - t) < Math.abs(nearest.ts - t)) nearest = r;
    }
    return !nearest || nearest.value < HIGH_MGDL;
  });
  const out: Record<string, number> = {};
  for (const h of [30, 60]) {
    const fall = unexplained ? 0 : isf * insulinActingWithin(insulin, nowMs, gp?.rapidInsulin, h);
    const rise = icr ? (isf / icr) * carbsLandingWithin(meals, nowMs, h) : 0;
    out[String(h)] = rise - fall;
  }
  return out;
}

/** Everything known about this moment, computed once. */
export function buildState(input: EngineInput): EngineState {
  const { nowMs, lang, tzOffsetMin } = input;
  const gp = toGuardProfile(input.profile);
  const readings = (input.readings || []).filter((r) => r && r.value > 0 && Number.isFinite(r.ts));
  const insulin = input.insulin ?? [];
  const meals = input.meals ?? [];
  const activity = input.activity ?? [];
  const last = readings.length ? readings[readings.length - 1] : null;
  const cur = last ? Math.round(last.value) : null;
  const lastTs = last ? last.ts : 0;
  const staleMin = lastTs ? Math.round((nowMs - lastTs) / 60000) : 999;
  // No reading at all is the same problem as an old one, and a dose must never be named on either.
  const signalLost = !lastTs || nowMs - lastTs > STALE_MIN * 60000;
  const trend: Trend = lastTs ? trendFromReadings(readings, nowMs) : "unknown";
  const rapid = gp?.rapidInsulin ?? null;
  const iob = activeIob(insulin, nowMs, rapid);
  const iobDose = dosingIob(insulin, nowMs, rapid);
  const iobInjected = dosingIob(insulin.filter((d) => d && tsOf(d.ts) <= nowMs), nowMs, rapid);
  const cob = carbsOnBoard(meals, nowMs);
  const rates = balanceRates(meals, insulin, nowMs, rapid);
  const ratesDose = { ...rates, unitsSoon: dosingActingWithin(insulin, nowMs, rapid) };
  const balance = glucoseBalance(cur, iob, cob, gp, rates);
  const recentHypo = recentHypoFrom(readings, nowMs);
  const minSinceRescue = minutesSinceLastRescue(input.rescueMeals ?? meals, nowMs);
  const minSinceFood = minutesSinceFood(input.rescueMeals ?? meals, nowMs);
  // A low is treated against what is really in: an announced dose is nobody's insulin yet.
  const low = cur != null && cur < LOW_MGDL;
  const guard = computeGuard({ glucoseMgdl: cur, trend, staleMin, iobUnits: low ? iobInjected : iobDose, recentHypo, minSinceRescue, minSinceFood, profile: gp });
  const tempC = input.tempC ?? null;
  const predict = predictiveAdvice(readings, nowMs, 30, activityLowWatchBump(activity, nowMs) + temperatureLowWatchBump(tempC));
  const confirmedAt = input.profile?.no_insulin_confirmed_at ? new Date(input.profile.no_insulin_confirmed_at).getTime() : null;
  const forecast = signalLost || !lastTs ? null : forecastGlucose({
    readings, nowMs, tzOffsetMin, model: input.model ?? null,
    physics: forecastPhysics(insulin, meals, readings, nowMs, gp),
  });
  const doseScore = input.model?.doses ?? null;
  return {
    nowMs, lang, tzOffsetMin, profileRow: input.profile ?? null, gp, readings, insulin, meals, activity,
    cur, lastTs, staleMin, signalLost, sensorExpired: input.sensorExpired === true && signalLost,
    trend, slope: robustSlope(readings).slope, iob, iobDose, iobInjected, cob, rates, ratesDose, balance, guard, recentHypo, minSinceRescue, minSinceFood,
    activityCut: activityBolusCut(activity, nowMs),
    knowledge: insulinKnowledge(insulin, nowMs, confirmedAt),
    pending: openPendingDose(input.profile?.pending_action, insulin, nowMs),
    predict, forecast, tempC, outdoor: input.outdoor === true, place: input.place ?? null,
    hardFactor: Math.min(HARD_HIT_MAX, Math.max(HARD_HIT_FACTOR, Number(doseScore?.factor) || HARD_HIT_FACTOR)),
    doseScore,
    heldBack: heldBackFrom(input.profile?.held_back, nowMs),
  };
}

/** The row as stored, if it is still about this meal. */
function heldBackFrom(raw: any, nowMs: number): HeldBack | null {
  if (!raw || typeof raw !== "object") return null;
  const at = Number(raw.at);
  const total = Number(raw.total);
  const carbsG = Number(raw.carbsG);
  if (!Number.isFinite(at) || !(total > 0) || !(carbsG > 0)) return null;
  const age = (nowMs - at) / 60000;
  if (age < 0 || age > REST_MAX_MIN) return null;
  return { at, total, carbsG, description: raw.description ?? null };
}

export type DecisionKind =
  | "sugar"        // a low to treat now
  | "dose"         // insulin to inject now
  | "dose_if"      // insulin to inject, provided the last 3 h are clear
  | "dose_later"   // insulin for a meal still to come
  | "ask_done"     // a dose was named earlier: did it happen?
  | "hold"         // no insulin, with a reason worth reading
  | "fine"         // nothing to do
  | "no_ratios"
  | "signal";      // no live glucose

export interface Decision {
  kind: DecisionKind;
  /** The action sentence, verb first, without the "Action :" label. */
  line: string;
  /** Insulin to inject NOW. What a "Done" button records. 0 for anything else. */
  units: number;
  /** Insulin for a meal still ahead, shown but not due yet. */
  laterUnits: number;
  sugarGrams: number;
  insulinName: string | null;
  knowledge: InsulinKnowledge;
  /** The earlier dose still waiting for an answer, on any kind of decision. */
  pending: PendingDose | null;
  /** The most a narrative may name, in units: the dose decided plus any dose it may legitimately report. */
  proseCeiling: number;
  /** What the prose may not contradict: no dose due, insulin forbidden. */
  nothingDue: boolean;
  insulinForbidden: boolean;
  /** Set when a meal plan produced the answer. */
  plan: MealPlanResult | null;
  /** The sum called for more than the floor allows: this is the part that is safe now. */
  capped: boolean;
  /** No dose stands: the floor or a low took it all. Advice about how to give it has no place here. */
  stopped: boolean;
  /** When a dose for later falls due. */
  laterAtMs: number | null;
  /** What to remember about the part held back from a meal. */
  heldBack: Omit<HeldBack, "at"> | null;
  /** This dose is what was held back from a meal earlier. */
  rest: boolean;
  /** The dose goes in two parts: a Done button must not record the whole of it. */
  split: boolean;
  /** The food under discussion is there to bring up a low. Advice about a meal has no place after it. */
  rescueFood: boolean;
}

/** A meal under discussion that is not on record yet: a photo, or the meals screen before saving. */
export interface MealCandidate {
  carbsG: number;
  description?: string | null;
  minutesUntil?: number | null;
  /** When it was eaten, if it already was: the curve at that moment is what says what it was for. */
  eatenAtMs?: number | null;
}

export interface DecisionOptions {
  candidate?: MealCandidate | null;
  /** Keep the action short: the card shows one line. The voice and the photo give the reasoning. */
  concise?: boolean;
  /** Grams the model guessed for the candidate, nobody having weighed it. Said, never as a firm dose. */
  estimatedCarbs?: number | null;
}

const FIRST_DOSE = /(\d+(?:[.,]\d+)?)\s*u\s+de\s/i;

/** The first dose figure in a code-owned line, or 0. Only ever applied to lines this engine built. */
function firstUnits(line: string): number {
  const m = FIRST_DOSE.exec(line || "");
  if (!m) return 0;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

const capitalise = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * "2 u de Fiasp maintenant" read to a parent as something already done: on 6 November the question
 * was literally "3 u, c'est ce qu'il a fait ou ce qu'il doit faire ?". A dose to inject gets a verb.
 */
export function withVerb(line: string, lang: string): string {
  const verb = es(lang) ? "pon" : "fais";
  return capitalise(line.replace(FIRST_DOSE, (m) => `${verb} ${m}`));
}

function sugarVerb(line: string, lang: string): string {
  if (!/^\d/.test(line)) return capitalise(line);
  return `${es(lang) ? "Toma" : "Prends"} ${line}`;
}

const lowered = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** "Pour ~120 g de glucides : ", the opening of a meal plan. The condition says the grams instead. */
const PLAN_HEAD = /^(?:Pour|Para) ~\d+ g[^:]*:\s*/;

/** Two colons in a row read as two conditions. */
const oneColon = (body: string): string => body.replace(/^((?:pour|para) [^:]*?)\s*:\s*/, "$1, ");

/** The same sentence, with its condition stated first. */
function conditional(line: string, lang: string, estimatedG?: number | null): string {
  const g = estimatedG ? Math.round(estimatedG) : null;
  const body = oneColon(lowered(withVerb(g ? line.replace(PLAN_HEAD, "") : line, lang)));
  if (es(lang)) {
    const carbs = g ? ` y si son unos ${g} g de carbohidratos` : "";
    return `Si no se ha puesto insulina rápida en las últimas 3 h${carbs}: ${body} Si ya se ha puesto, anótala primero y lo recalculo.`;
  }
  const carbs = g ? ` et si c'est bien ~${g} g de glucides` : "";
  return `Si aucune insuline rapide depuis 3 h${carbs} : ${body} Si une dose a déjà été faite, note-la d'abord et je recalcule.`;
}

/** A dose on a figure nobody weighed: it stays a proposal until someone has looked at the number. A dose
 *  for later keeps no verb: there is nothing to do yet. */
function onEstimate(line: string, grams: number, lang: string, later = false): string {
  const bare = line.replace(PLAN_HEAD, "");
  const body = oneColon(later ? bare : lowered(withVerb(bare, lang)));
  const g = Math.round(grams);
  return es(lang)
    ? `Si son unos ${g} g de carbohidratos: ${body} Si no, corrígelos en la pestaña Comidas y lo recalculo.`
    : `Si c'est bien ~${g} g de glucides : ${body} Sinon, corrige-les dans l'onglet Repas et je recalcule.`;
}

/** The same dose, seen again before anyone answered. Two phones can each show it: said so, it is done
 *  once. A different figure is not the same dose: what matters then is whether the first one was done. */
function namedAlready(p: PendingDose, s: EngineState, units: number): string {
  const at = clock(p.at, s.tzOffsetMin);
  if (Math.abs(p.units - units) >= 0.01) {
    return es(s.lang)
      ? ` (Si las ${fmtU(p.units)} u propuestas a las ${at} ya se pusieron, anótalas primero y lo recalculo.)`
      : ` (Si les ${fmtU(p.units)} u proposées à ${at} ont été faites, note-les d'abord et je recalcule.)`;
  }
  return es(s.lang)
    ? ` (${fmtU(p.units)} u ya propuestas a las ${at}: una sola vez.)`
    : ` (${fmtU(p.units)} u déjà proposées à ${at} : une seule fois.)`;
}

function askDoneLine(p: PendingDose, s: EngineState): string {
  const name = p.insulin || s.gp?.rapidInsulin || (es(s.lang) ? "insulina rápida" : "insuline rapide");
  const at = clock(p.at, s.tzOffsetMin);
  return es(s.lang)
    ? `¿Se pusieron las ${fmtU(p.units)} u de ${name} propuestas a las ${at}? Contesta primero: sin ese dato no puedo decidir otra dosis.`
    : `Les ${fmtU(p.units)} u de ${name} proposées à ${at} ont-elles été faites ? Réponds d'abord : sans ça, je ne peux pas décider d'une autre dose.`;
}

function signalLine(s: EngineState): string {
  if (s.sensorExpired) {
    return es(s.lang)
      ? "Sensor caducado: pon un sensor NUEVO lo antes posible (cuenta ~1 h de arranque); mientras tanto, decide solo con una punción capilar."
      : "Capteur expiré : pose un NOUVEAU capteur dès que possible (compte ~1 h de démarrage) ; en attendant, décide uniquement avec un test au doigt.";
  }
  return es(s.lang)
    ? "Señal perdida: reconecta el sensor (acerca el teléfono que lo escanea, vuelve a escanear); si no vuelve, hazte una punción capilar antes de cualquier decisión."
    : "Signal perdu : reconnecte le capteur (rapproche le téléphone qui le scanne, re-scanne) ; s'il ne revient pas, fais un test au doigt avant toute décision.";
}

function planFor(
  s: EngineState, carbsG: number, description: string | null | undefined, minutesUntil?: number | null,
  /** The meal is already in the rows: its own carbs must not count as earlier food still landing. */
  alreadyListed = false,
): MealPlanResult {
  const others = alreadyListed
    ? (s.meals || []).filter((m) => !(m?.description === description && Number(m?.carbs_g ?? m?.carbsG ?? 0) === carbsG))
    : s.meals;
  const low = s.cur != null && s.cur < LOW_MGDL;
  return planMealDose({
    glucoseMgdl: s.cur, trend: s.trend, staleMin: s.staleMin, iobUnits: low ? s.iobInjected : s.iobDose, carbsG, description,
    cobGrams: alreadyListed ? carbsOnBoard(others, s.nowMs) : s.cob,
    rates: alreadyListed ? { ...balanceRates(others, s.insulin, s.nowMs, s.gp?.rapidInsulin), unitsSoon: s.ratesDose.unitsSoon } : s.ratesDose,
    minutesUntilMeal: minutesUntil ?? 0,
    minSinceRescue: s.minSinceRescue, minSinceFood: s.minSinceFood, recentHypo: s.recentHypo, activityCut: s.activityCut, profile: s.gp,
  });
}

interface Raw {
  line: string;
  units: number;
  laterUnits: number;
  plan: MealPlanResult | null;
  /** Units the prose may quote because this decision itself computed them. */
  named: number;
  /** The meal these units are for, when one is part of them. */
  meal?: { carbsG: number; description?: string | null } | null;
  /** Food this answer is about that is not in the eaten rows yet. */
  coming?: ComingFood | null;
  /** The floor took units off. */
  capped?: boolean;
  /** A plan held back by a low or a fall: nothing is due and no figure stands. */
  held?: boolean;
  /** What is left of a meal after a first part. */
  rest?: boolean;
  /** The floor kept part of a meal's dose back. */
  kept?: Omit<HeldBack, "at"> | null;
  /** The meal in question and what else is digesting: what "or eat less" is worked out on. */
  question?: { carbsG: number; cobG: number } | null;
}

// THE FLOOR. What a followed dose may not do, whatever the sum says.
//
// Everything above works out what the food and the glucose call for, and that sum is a point estimate:
// it takes the insulin to hit exactly as hard and as fast as the profile says and the food to arrive on
// time. On his 59 known doses the glucose went under 70 after 47 % of them and under 90 after 64 %, and
// a landing worked out at 170 or more still went under 70 more than half the time, because the low came
// 60 to 110 minutes after the dose, before a fatty meal had arrived. Replayed on those same doses, the
// sum's own figure would have stayed above 90 about 75 % of the time.
//
// Same dose, same food, a different day: insulin need alone moves by about 23 % between days in children,
// and more under twelve. The landing cannot be known to better than about 50 mg/dL, so no single dose can
// be aimed at a number. What can be done is to make each dose small enough to be survivable if it hits
// hard, and look again. That is how closed-loop pumps work, a little at a time, every five minutes.
//
// So a dose is worth what its pessimistic path says: the insulin hitting `hardFactor` times harder than
// the profile on a curve about a quarter faster, the food counted at COB_TRUST_FRACTION on its usual ramp,
// a fall in progress carrying on for twenty minutes, a rise not counted at all. The dose named is the
// largest one whose path stays above the floor. Replayed on the moments where it names a dose: 85 to 91 %
// stay above 90 and 94 to 100 % above 70, at the price of going over 300 about a quarter of the time instead
// of a fifth. Those are what-ifs on 33 doses, not measurements: scoreDoses is what will say.
//
// It can only ever take units off. Applied last, so that no surface, no plan and no rule above can name
// more. A cap is said, with the time to look again, never done silently.
export interface ComingFood {
  carbsG: number;
  description?: string | null;
  /** Minutes until it is eaten. Negative: eaten that long ago, and not in the rows yet. */
  inMin: number;
}

/** The same insulin the way his own falls look: 42 % done at 60 minutes and 66 % at 90, against 25 % and
 *  46 % on the published Fiasp curve. The one that fits his curve (63 % at 90 minutes) cannot be told from
 *  the published one on 8 clean corrections, which is why this is the pessimistic side and not the estimate. */
function hardCurve(name?: string | null): InsulinCurve {
  const c = curveOf(name);
  return { peakMin: c.peakMin * 0.73, durationMin: c.durationMin * 0.83, delayMin: c.delayMin / 2 };
}

const actedBy = (c: InsulinCurve, minutes: number): number => (minutes <= 0 ? 0 : 1 - fractionRemaining(minutes, c));

/** The correction factor, or what the daily-dose rules of thumb give for this carb ratio (1800 and 500
 *  over the same day): a profile without one must not be a profile without a floor. */
function floorIsf(s: EngineState): number | null {
  const isf = s.gp?.correctionFactor;
  if (isf && isf > 0) return isf;
  const icr = s.gp?.carbRatio;
  return icr && icr > 0 ? icr * 3.6 : null;
}

/** Grams of a meal reaching the blood in the next `t` minutes, on the ramp the balance uses. */
function foodWithin(carbs: number, description: string | null | undefined, ageMin: number, t: number): number {
  const speed = mealCarbSpeed(description);
  const win = cobWindowMin(speed);
  const onset = Math.min(carbOnsetMin(speed), win - 1);
  const by = (min: number) => Math.max(0, Math.min(1, (min - onset) / (win - onset)));
  return carbs * (by(ageMin + t) - by(ageMin));
}

interface Plate {
  carbs: number;
  description?: string | null;
  age: number;
}

const NOT_A_FOOD = new Set([
  "avec", "les", "des", "une", "con", "los", "las", "del", "una", "assiette", "plato", "plat", "portion", "bol", "verre", "vaso",
  "petit", "petite", "grand", "grande",
]);

const foodNames = (t?: string | null): string[] => (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .split(/[^a-z]+/).filter((w) => w.length >= 3 && !NOT_A_FOOD.has(w));

/** One plate seen twice. Close, not identical: a model never reads the same picture the same way, and "Riz et
 *  poulet", 80 g, then "Assiette de riz au poulet", 78 g, took the dose from 2 u to 4. When in doubt it is the
 *  same plate, the side with less food and so less insulin. */
function samePlate(a: Plate, b: Plate): boolean {
  if (Math.abs(a.age - b.age) > SAME_PLATE_MIN) return false;
  if (Math.abs(a.carbs - b.carbs) > 0.25 * Math.max(a.carbs, b.carbs)) return false;
  // Moments apart and the same size: "Spaghetti bolognaise" and "Pâtes à la sauce tomate" share no word.
  if (Math.abs(a.age - b.age) <= SAME_PLATE_NOW_MIN) return true;
  const words = foodNames(a.description);
  const other = foodNames(b.description);
  return (!words.length && !other.length) || words.some((w) => other.includes(w));
}

/**
 * The pessimistic path without the dose under discussion, then the lowest point with it. `shift` looks at
 * the path from that many minutes ahead, for a meal too far off for this minute to say anything about it.
 *
 * Whatever may have been injected counts: a dose announced for later, and a dose named and never answered
 * once there has been time to do it. Insulin already working is taken on whichever curve leaves more of it
 * to come: the faster curve is the pessimistic side for a new dose only, and on an old one it says the work
 * is done. Sport makes the same insulin hit harder, and a cut the sentence announces has to reach the figure.
 * The same plate seen twice, a retry or a second photo, feeds him once.
 */
function carefulLowest(
  s: EngineState, food: ComingFood | null, from: number, slope: number, shift: number,
): (units: number, doseInMin: number) => number {
  const isf = floorIsf(s) as number;
  const perGram = s.gp?.carbRatio && s.gp.carbRatio > 0 ? isf / s.gp.carbRatio : 0;
  const k = s.hardFactor / (1 - Math.min(0.5, Math.max(0, s.activityCut || 0)));
  const rapid = s.gp?.rapidInsulin ?? null;
  const doses: { units: number; age: number; hard: InsulinCurve; plain: InsulinCurve }[] = [];
  const dose = (units: number, ageMin: number, name?: string | null) => {
    doses.push({ units, age: ageMin + shift, hard: hardCurve(name), plain: curveOf(name) });
  };
  for (const d of s.insulin || []) {
    if (!d || d.kind === "basal") continue;
    const name = d.name ?? d.insulin_name ?? rapid;
    if (isBasalInsulin(name)) continue;
    const age = (s.nowMs - tsOf(d.ts)) / 60000;
    const units = Number(d.units);
    if (!Number.isFinite(age) || !(units > 0) || age > 480) continue;
    // Beyond the hour an announced dose is a plan, unless it goes with the meal in question.
    const withTheMeal = !!food && Math.abs(age + food.inMin) <= 30;
    if (age >= -ANNOUNCED_DOSE_MIN || withTheMeal) dose(units, age, name);
  }
  const open = s.pending;
  if (open && s.nowMs - open.at >= PENDING_GRACE_MIN * 60000) dose(open.units, (s.nowMs - open.at) / 60000, open.insulin ?? rapid);
  const meals: Plate[] = [];
  const meal = (carbs: number, description: string | null | undefined, age: number) => {
    const next = { carbs, description, age };
    const seen = meals.findIndex((m) => samePlate(m, next));
    if (seen < 0) meals.push(next);
    else if (age < meals[seen].age) meals[seen] = next; // the later of the two: that food has further to come
  };
  for (const m of s.meals || []) {
    if (!m || !isEatenBy(m, s.nowMs)) continue;
    const carbs = Number(m.carbs_g ?? m.carbsG ?? 0);
    const age = (s.nowMs - tsOf(m.ts)) / 60000;
    if (carbs > 0 && Number.isFinite(age)) meal(carbs, m.description, age + shift);
  }
  if (food && food.carbsG > 0) meal(food.carbsG, food.description, shift - food.inMin);
  const falling = Math.max(-4, Math.min(0, slope));
  const span = (c: InsulinCurve, age: number, t: number) => actedBy(c, age + t) - actedBy(c, age);
  const base: { t: number; v: number }[] = [];
  for (let t = LANDING_SIM_STEP_MIN; t <= LANDING_SIM_HORIZON_MIN; t += LANDING_SIM_STEP_MIN) {
    let fall = 0;
    for (const d of doses) fall += d.units * Math.max(span(d.hard, d.age, t), span(d.plain, d.age, t));
    let rise = 0;
    for (const m of meals) rise += foodWithin(m.carbs, m.description, m.age, t);
    base.push({ t, v: from + falling * Math.min(t, 20) + COB_TRUST_FRACTION * perGram * rise - k * isf * fall });
  }
  const curve = hardCurve(rapid);
  return (units, doseInMin) => {
    let lowest = Infinity;
    for (const p of base) lowest = Math.min(lowest, p.v - k * isf * units * actedBy(curve, p.t - doseInMin));
    return lowest;
  };
}

/**
 * The largest half-unit dose, at most `wanted`, whose pessimistic path stays above the floor. Near the floor
 * the line is a little under where he is now, because insulin always starts a few minutes before food does,
 * but never under 90. A direction nobody can read is not flat, and a reading a quarter of an hour old is
 * where he was. A meal too far ahead is judged at its own hour, on the target: the glucose of this minute
 * says nothing about it, and neither does the dip the insulin already in makes before then.
 */
export function safeDose(s: EngineState, wanted: number, food: ComingFood | null = null, doseInMin = 0): number {
  if (s.cur == null || !floorIsf(s)) return 0;
  const far = doseInMin > MEAL_TOO_FAR_MIN;
  const slope = s.slope != null && Number.isFinite(s.slope) ? s.slope : UNREADABLE_SLOPE;
  const now = s.cur + Math.max(-4, Math.min(0, slope)) * Math.min(Math.max(0, s.staleMin || 0), STALE_MIN);
  const from = far ? Number(s.gp?.targetMgdl) || DOSE_FLOOR_MGDL + 20 : now;
  const lowest = carefulLowest(s, food, from, far ? 0 : slope, far ? doseInMin : 0);
  const floor = Math.max(DOSE_LAST_LINE_MGDL, Math.min(DOSE_FLOOR_MGDL, from - 10));
  let d = Math.floor(wanted * 2) / 2;
  while (d > 0 && lowest(d, far ? 0 : doseInMin) < floor) d -= 0.5;
  return Math.max(0, d);
}

/** A rapid dose in the last `minutes`. */
function dosedWithin(s: EngineState, minutes: number): boolean {
  return (s.insulin || []).some((d: any) => {
    if (!d || d.kind === "basal" || isBasalInsulin(d.name ?? d.insulin_name)) return false;
    const age = (s.nowMs - tsOf(d.ts)) / 60000;
    return Number.isFinite(age) && age >= 0 && age <= minutes;
  });
}

/** What the sentence says when the floor took units off. No total: a figure nobody should inject has no
 *  business being on the screen next to the one to do. */
function floorLine(s: EngineState, units: number, raw: Raw, later: boolean): string {
  const { lang } = s;
  const spanish = es(lang);
  const food = raw.coming ?? null;
  const inMin = later ? Math.max(0, food?.inMin ?? 0) : 0;
  // A fall that held the dose back will not wait an hour to be looked at, and neither will a direction
  // nobody can read. Neither is about the meal's hour.
  const falling = s.trend === "falling" || s.trend === "falling_fast" || s.trend === "unknown" || s.forecast?.lowWarning === true;
  const look = falling ? FALL_LOOK_MIN : inMin + (raw.meal || food ? SECOND_LOOK_MEAL_MIN : SECOND_LOOK_MIN);
  const at = clock(s.nowMs + look * 60000, s.tzOffsetMin);
  const high = (s.cur as number) >= DOSE_FLOOR_MGDL + 10;
  const rapid = s.gp?.rapidInsulin || (spanish ? "insulina rápida" : "insuline rapide");
  const why = spanish
    ? (high ? `podría bajar de ${DOSE_FLOOR_MGDL}` : "podría bajar demasiado")
    : (high ? `ça pourrait passer sous ${DOSE_FLOOR_MGDL}` : "ça pourrait descendre trop bas");
  const sugar = falling ? (spanish ? " Ten azúcar a mano." : " Garde du sucre à portée.") : "";
  const carbs = raw.meal?.carbsG ?? food?.carbsG ?? 0;
  const icr = s.gp?.carbRatio && s.gp.carbRatio > 0 ? s.gp.carbRatio : null;
  if (units > 0) {
    // A dose you cannot attach to a food is a dose you cannot check. PLAN_HEAD takes the grams off when
    // they are said some other way.
    const head = !icr || carbs <= 0
      ? ""
      : raw.rest === true
        ? (spanish ? "Para lo que queda de la comida: " : "Pour la suite du repas : ")
        : (spanish ? `Para ~${Math.round(carbs)} g de carbohidratos: ` : `Pour ~${Math.round(carbs)} g de glucides : `);
    return spanish
      ? `${head}${fmtU(units)} u de ${rapid} ${later ? "al empezar a comer" : "ahora"}. No más: con más, ${why}. Vuelve a mirar a las ${at}, te diré si hace falta más.${sugar}`
      : `${head}${fmtU(units)} u de ${rapid} ${later ? "au moment de manger" : "maintenant"}. Pas plus : au-delà, ${why}. Regarde de nouveau à ${at}, je te dirai s'il en faut encore.${sugar}`;
  }
  if (inMin > MEAL_SOON_MIN) {
    if (falling) {
      return spanish
        ? `Nada de insulina prevista para esta comida por ahora: ${why}. Vuelve a mirar a las ${at}.${sugar}`
        : `Pas d'insuline à prévoir pour ce repas pour l'instant : ${why}. Regarde de nouveau à ${at}.${sugar}`;
    }
    return spanish
      ? "Nada de insulina prevista para esta comida por ahora: vuelve a preguntarme al empezar a comer."
      : "Pas d'insuline à prévoir pour ce repas pour l'instant : redemande-moi au moment de manger.";
  }
  if (carbs > 0 && icr && s.iobDose * icr >= carbs * COB_TRUST_FRACTION) {
    return spanish
      ? `Nada de insulina de más para esta comida: la que sigue activa basta por ahora. Vuelve a mirar a las ${at}.${sugar}`
      : `Pas d'insuline en plus pour ce repas : celle qui agit encore suffit pour l'instant. Regarde de nouveau à ${at}.${sugar}`;
  }
  if (food && food.inMin >= 0 && food.carbsG > 0) {
    return spanish
      ? `Nada de insulina todavía para esta comida: ${why}. Empieza a comer y vuelve a mirar a las ${at}.${sugar}`
      : `Pas d'insuline tout de suite pour ce repas : ${why}. Commence à manger et regarde de nouveau à ${at}.${sugar}`;
  }
  return spanish
    ? `Nada de insulina por ahora: ${why}. Vuelve a mirar a las ${at}.${sugar}`
    : `Pas d'insuline pour l'instant : ${why}. Regarde de nouveau à ${at}.${sugar}`;
}

/** The last word on any dose: the same decision, at what is safe to do now. */
function underFloor(s: EngineState, raw: Raw): Raw {
  const wanted = raw.units > 0 ? raw.units : raw.laterUnits;
  if (!(wanted > 0) || s.cur == null || !floorIsf(s)) return raw;
  const later = raw.units <= 0;
  const doseIn = later ? Math.max(0, raw.coming?.inMin ?? 0) : 0;
  // "Tu peux passer sous 70 dans l'heure" and "fais 1 u" do not go on one card: his own history says this
  // kind of moment ends low, and the side to take is the one with less insulin.
  const warned = s.forecast?.lowWarning === true && doseIn <= MEAL_TOO_FAR_MIN;
  const safe = warned ? 0 : safeDose(s, wanted, raw.coming ?? null, doseIn);
  if (safe >= wanted) return raw;
  const p = raw.plan;
  const meal = p ? Math.min(p.mealUnits, safe) : 0;
  const carbsG = raw.meal?.carbsG ?? raw.coming?.carbsG ?? 0;
  return {
    ...raw, capped: true, named: safe, units: later ? 0 : safe, laterUnits: later ? safe : 0,
    line: floorLine(s, safe, raw, later),
    kept: carbsG > 0 && !raw.rest ? { total: wanted, carbsG, description: raw.meal?.description ?? raw.coming?.description ?? null } : null,
    plan: p
      ? {
        ...p, totalUnits: safe, mealUnits: meal, correctionUnits: Math.max(0, safe - meal),
        timing: safe > 0 ? (p.timing === "split" ? "at_meal" : p.timing) : "after_meal", lowBeforeMeal: p.lowBeforeMeal || safe <= 0,
      }
      : null,
  };
}

/**
 * "Je te dirai s'il en faut encore" has to be true. A dose counts as covering a meal once it reaches half of
 * it, so a first part of 2 u on 64 g left the meal covered with 43 g still digesting, and the look an hour
 * later said to watch.
 *
 * This is the one place that can name insulin nothing else asks for, so it answers for what the app itself
 * held back and for nothing it merely infers: worked out from the meal rows, it dosed the can of 7up that had
 * treated a low. What it names is the least of what was held back and not given since, what is really still
 * digesting, and what the balance says is missing. Not on the way up from a low, not with a dose announced,
 * not on the first part's heels, not as the answer to a question about another food.
 */
function restOfMeal(s: EngineState, raw: Raw, asked: boolean): Raw {
  const held = s.heldBack;
  if (!held || asked || raw.laterUnits > 0 || s.recentHypo || s.cur == null || s.cur < REST_FROM_MGDL) return raw;
  if (s.forecast?.lowWarning === true) return raw;
  const since = (s.nowMs - held.at) / 60000;
  if (since < REST_AFTER_DOSE_MIN) return raw;
  const heldPlate = { carbs: held.carbsG, description: held.description, age: since };
  // The plate has to still be there: a row deleted or corrected takes its rest with it.
  const stillOnRecord = (s.meals || []).some((m) => m && isEatenBy(m, s.nowMs)
    && samePlate({ carbs: Number(m.carbs_g ?? m.carbsG ?? 0), description: m.description, age: (s.nowMs - tsOf(m.ts)) / 60000 }, heldPlate));
  if (!stillOnRecord) return raw;
  const given = givenSince(s, held);
  if (given == null || given <= 0) return raw;
  // The sum has its own reason to name something: if it is for this plate, the sentence says it is the rest.
  if (raw.units > 0) {
    const samePlateAsked = !!raw.meal && samePlate({ carbs: raw.meal.carbsG, description: raw.meal.description, age: since }, heldPlate);
    return samePlateAsked ? { ...raw, rest: true } : raw;
  }
  const isf = s.gp?.correctionFactor;
  const icr = s.gp?.carbRatio;
  if (!isf || !icr || isf <= 0 || icr <= 0) return raw;
  if (s.trend !== "stable" && s.trend !== "rising" && s.trend !== "rising_fast") return raw;
  if (s.guard.kind === "sugar" || s.guard.reason === "sugar_recent" || s.guard.reason === "stale_data") return raw;
  if (dosedWithin(s, REST_AFTER_DOSE_MIN)) return raw;
  if ((s.readings || []).some((r) => r.ts >= held.at && r.value < LOW_MGDL)) return raw;
  const landing = s.cur + s.cob * (isf / icr) * COB_TRUST_FRACTION - s.iobDose * isf;
  const target = Number(s.gp?.targetMgdl) || 120;
  const wanted = Math.floor(Math.min(held.total - given, s.cob / icr, (landing - target) / isf) * 2) / 2;
  if (wanted < 0.5) return raw;
  const rapid = s.gp?.rapidInsulin || (es(s.lang) ? "insulina rápida" : "insuline rapide");
  const at = clock(s.nowMs + SECOND_LOOK_MIN * 60000, s.tzOffsetMin);
  return {
    line: es(s.lang)
      ? `${fmtU(wanted)} u de ${rapid} para lo que queda de la comida. Vuelve a mirar a las ${at}.`
      : `${fmtU(wanted)} u de ${rapid} pour la suite du repas. Regarde de nouveau à ${at}.`,
    units: wanted, laterUnits: 0, plan: null, named: wanted, meal: { carbsG: held.carbsG, description: held.description }, rest: true,
  };
}

/** Rapid units on record since the part held back was named, or null with a dose announced: nothing is
 *  named on top of that. */
function givenSince(s: EngineState, held: HeldBack): number | null {
  let given = 0;
  for (const d of s.insulin || []) {
    if (!d || d.kind === "basal" || isBasalInsulin(d.name ?? d.insulin_name)) continue;
    const t = tsOf(d.ts);
    if (!Number.isFinite(t)) continue;
    if (t > s.nowMs) return null;
    if (t >= held.at - 15 * 60000) given += Number(d.units) || 0;
  }
  return given;
}

/** Whether the second look still has something to come back to. */
function restStillOwed(s: EngineState): boolean {
  const held = s.heldBack;
  if (!held) return false;
  const given = givenSince(s, held);
  return given != null && held.total - given >= 0.5;
}

/** How much food the insulin already working can carry without new insulin, staying under the top of the
 *  range: the other way out when a child wants more than the dose covers. Null when it cannot be said. */
export function carbRoomG(s: EngineState, cobG = s.cob): number | null {
  const isf = s.gp?.correctionFactor;
  const icr = s.gp?.carbRatio;
  if (s.cur == null || !isf || !icr || isf <= 0 || icr <= 0) return null;
  const perGram = isf / icr;
  const landing = s.cur + cobG * perGram * COB_TRUST_FRACTION - s.iobDose * isf;
  return Math.max(0, Math.floor((HIGH_MGDL - landing) / perGram / 5) * 5);
}

/** "Either the insulin to carry it, or eat less": the second half of that, as a figure. With no dose to set
 *  it against, "better eat nothing" would only contradict a sentence that says to start eating. */
function roomLine(s: EngineState, q: Raw["question"], dosing: boolean): string {
  if (!q || q.carbsG < UNCOVERED_MEAL_MIN_CARBS) return "";
  // On the way down a limit on food is the last thing to say.
  if (s.trend === "falling" || s.trend === "falling_fast") return "";
  const room = carbRoomG(s, q.cobG);
  if (room == null || room >= q.carbsG) return "";
  if (room < 5) {
    if (!dosing) return "";
    return es(s.lang)
      ? " Sin ninguna dosis, mejor no comer nada por ahora."
      : " Sans aucune dose, mieux vaut ne rien manger pour l'instant.";
  }
  return es(s.lang) ? ` Sin ninguna dosis, no más de ~${room} g.` : ` Sans aucune dose, pas plus de ~${room} g.`;
}

/** A plate the analysis would call covered is covered for the photo too: at 250 with 3 u given 40 minutes
 *  ago the photo named half a unit, and the analysis seconds later none. */
function coveredAlready(s: EngineState, cand: MealCandidate): boolean {
  if ((Number(cand.minutesUntil) || 0) > 0 || !s.gp?.carbRatio || s.guard.kind === "sugar") return false;
  const eaten = cand.eatenAtMs ?? s.nowMs;
  const near = (s.insulin || []).some((d: any) => {
    if (!d || d.kind === "basal" || isBasalInsulin(d.name ?? d.insulin_name)) return false;
    const t = tsOf(d.ts);
    return Number.isFinite(t) && Math.abs(t - eaten) <= MEAL_COVER_WINDOW_MIN * 60000;
  });
  if (!near) return false;
  const row = { ts: eaten, description: cand.description ?? null, carbs_g: cand.carbsG, planned: false };
  return mealBolusPlan([...(s.meals || []), row], s.insulin, s.nowMs, s.gp, 180, s.readings).units <= 0;
}

/** The figures of a plan that is held back: none. */
const heldPlan = (p: MealPlanResult): MealPlanResult => ({ ...p, totalUnits: 0, mealUnits: 0, correctionUnits: 0 });

/** Sugar on the way up from a low is treatment, whether it comes by photo, by the meals screen or
 *  logged. Three sugar cubes or a can of 7up at 92, twenty minutes after a 65, asked for "1 u". The same
 *  rule as a row in the log, see eatenAsTreatment. Eaten two hours from now it treats nothing. */
function isRescueCandidate(s: EngineState, c: MealCandidate): boolean {
  if (namedAsRescue(c.description, c.carbsG)) return true;
  if ((Number(c.minutesUntil) || 0) > 30) return false;
  return eatenAsTreatment(c.eatenAtMs ?? s.nowMs, s.readings, c.carbsG, c.description);
}

/** The grams these units rest on that nobody weighed, or null. A correction next to a coffee is not a
 *  dose on a guess, and a figure stays a guess once it is on record: the voice said "si c'est bien
 *  ~120 g" and, a second and a half later, the analysis said the same dose firmly. */
function guessedGrams(s: EngineState, raw: Raw, opts: DecisionOptions): number | null {
  const meal = raw.meal;
  if (!meal) return null;
  const cand = opts.candidate;
  if (cand && opts.estimatedCarbs && opts.estimatedCarbs > 0 && cand.description === meal.description) return opts.estimatedCarbs;
  // The newest row of that name: the same word guessed yesterday says nothing about the one typed today.
  let newest: any = null;
  for (const m of s.meals || []) {
    if (m && m.description === meal.description && (!newest || tsOf(m.ts) > tsOf(newest.ts))) newest = m;
  }
  return newest?.carbs_estimated === true ? meal.carbsG : null;
}

function rawDecision(s: EngineState, opts: DecisionOptions): Raw {
  const { gp, guard, lang } = s;
  const concise = opts.concise === true;

  // A meal under discussion: the prospective answer, with its timing. Under the size a row is covered at,
  // the screen named a dose that the analysis, a moment later, knew nothing about.
  const cand = opts.candidate;
  if (cand && cand.carbsG >= UNCOVERED_MEAL_MIN_CARBS && !isRescueCandidate(s, cand) && !coveredAlready(s, cand)) {
    const plan = planFor(s, cand.carbsG, cand.description, cand.minutesUntil);
    const line = mealPlanLine(plan, lang, gp, concise, false);
    const dueLater = (Number(cand.minutesUntil) || 0) > 0;
    const held = plan.lowBeforeMeal || plan.reason === "hypo_first";
    const total = held ? 0 : Math.max(0, plan.totalUnits);
    const age = cand.eatenAtMs != null ? (s.nowMs - cand.eatenAtMs) / 60000 : null;
    const eaten = age != null && Number.isFinite(age);
    const asPlate = { carbs: cand.carbsG, description: cand.description, age: eaten ? age : 0 };
    const logged = (s.meals || []).some((m) => m && isEatenBy(m, s.nowMs)
      && samePlate({ carbs: Number(m.carbs_g ?? m.carbsG ?? 0), description: m.description, age: (s.nowMs - tsOf(m.ts)) / 60000 }, asPlate));
    return {
      line, plan: held ? heldPlan(plan) : plan, named: total, held,
      units: !dueLater ? total : 0,
      laterUnits: dueLater ? total : 0,
      meal: plan.mealUnits > 0 ? { carbsG: cand.carbsG, description: cand.description } : null,
      coming: { carbsG: cand.carbsG, description: cand.description, inMin: eaten ? -Math.max(0, age) : Math.max(0, Number(cand.minutesUntil) || 0) },
      question: eaten || logged ? null : { carbsG: cand.carbsG, cobG: s.cob },
    };
  }

  const plan = mealBolusPlan(s.meals, s.insulin, s.nowMs, gp, 180, s.readings);
  const namedMeal = applyActivityCut(Math.max(0, plan.units || 0), s.activityCut);

  // No bolus into what the insulin already in is about to do. Never in place of treating a low: this
  // sentence has no grams in it, and it used to answer every low with a meal announced in the last 3 h.
  const treatingLow = guard.kind === "sugar" || guard.reason === "sugar_recent";
  if (!treatingLow && plan.units > 0 && mealBolusHeldByIob(s.cur, s.iobDose, gp, s.cob, s.ratesDose)) {
    return { line: mealBolusHeldLine(s.cur as number, s.iobDose, gp, lang, s.cob), units: 0, laterUnits: 0, plan: null, named: 0 };
  }
  if (plan.planned && plan.carbsG != null) {
    const until = Math.max(0, -Number(plan.minutesAgo ?? 0));
    const p = planFor(s, plan.carbsG, plan.description, until);
    const held = p.lowBeforeMeal || p.reason === "hypo_first";
    const total = held ? 0 : Math.max(0, p.totalUnits);
    return {
      line: mealPlanLine(p, lang, gp, concise, false), plan: held ? heldPlan(p) : p, named: total, units: 0, held,
      laterUnits: total,
      meal: { carbsG: plan.carbsG, description: plan.description },
      coming: { carbsG: plan.carbsG, description: plan.description, inMin: until },
      question: { carbsG: plan.carbsG, cobG: s.cob },
    };
  }
  // A meal logged a moment ago is still the question "what do I do for this meal": same answer as the
  // photo and the meals screen, with the timing, rather than a bare number.
  if (plan.units > 0 && !plan.planned && (plan.minutesAgo ?? 99) <= 5 && plan.carbsG != null && !plan.rescueG) {
    const p = planFor(s, plan.carbsG, plan.description, 0, true);
    const held = p.lowBeforeMeal || p.reason === "hypo_first";
    const total = held ? 0 : Math.max(0, p.totalUnits);
    return {
      line: mealPlanLine(p, lang, gp, concise, false), plan: held ? heldPlan(p) : p, named: total, units: total, laterUnits: 0, held,
      meal: { carbsG: plan.carbsG, description: plan.description },
      // Still the question "how much for this plate" for a moment; a few minutes on it is eaten.
      question: (plan.minutesAgo ?? 99) <= 2
        ? {
          carbsG: plan.carbsG,
          cobG: carbsOnBoard((s.meals || []).filter((m) => !(m?.description === plan.description && Number(m?.carbs_g ?? m?.carbsG ?? 0) === plan.carbsG)), s.nowMs),
        }
        : null,
    };
  }
  if (guard.reason === "in_range" && plan.units <= 0) {
    return {
      line: inRangeActionLine(s.meals, s.insulin, s.readings, s.nowMs, gp, lang, s.iobDose, s.ratesDose),
      units: 0, laterUnits: 0, plan: null, named: 0,
    };
  }
  const line = combinedActionLine(guard, plan.units, lang, gp, plan.planned,
    { description: plan.description, carbsG: plan.carbsG, minutesAgo: plan.minutesAgo },
    {
      glucoseMgdl: s.cur, trend: s.trend, activityCut: s.activityCut, rescueG: plan.rescueG,
      remainingG: plan.remainingG, iobUnits: s.iobDose, cobGrams: s.cob,
    });
  // Lines that say no insulin may still mention a meal's grams, never "N u de".
  const units = firstUnits(line);
  return {
    line, units, laterUnits: 0, plan: null, named: Math.max(units, guard.maxInsulinUnits + namedMeal),
    meal: plan.units > 0 && plan.carbsG != null ? { carbsG: plan.carbsG, description: plan.description } : null,
  };
}

/** The decision. Same state in, same answer out, whoever is asking. */
export function decideAction(s: EngineState, opts: DecisionOptions = {}): Decision {
  const { lang, guard } = s;
  const rapid = s.gp?.rapidInsulin ?? null;
  // What the prose may legitimately quote: a recent rapid dose. Thirty-six hours of doses are loaded for
  // the background insulin's sake, and 15 u of Lantus must not widen what the model is allowed to say.
  const recentRapid = (s.insulin || []).filter((d: any) =>
    d && d.kind !== "basal" && !isBasalInsulin(d.name ?? d.insulin_name) && s.nowMs - tsOf(d.ts) <= 8 * 3600000);
  const contextUnits = Math.max(s.iobDose || 0, ...recentRapid.map((d: any) => Number(d?.units) || 0), 0);
  const base = {
    insulinName: rapid, knowledge: s.knowledge, pending: s.pending, plan: null as MealPlanResult | null, split: false,
    rescueFood: false, capped: false, stopped: false, rest: false, laterAtMs: null as number | null, heldBack: null as Omit<HeldBack, "at"> | null,
  };

  if (s.signalLost) {
    return {
      ...base, kind: "signal", line: signalLine(s), units: 0, laterUnits: 0, sugarGrams: 0, pending: null,
      proseCeiling: contextUnits, nothingDue: true, insulinForbidden: true,
    };
  }

  const cand = opts.candidate;
  const rescueFood = !!cand && cand.carbsG > 0 && isRescueCandidate(s, cand);
  const answer = rawDecision(s, opts);
  // A plate the sum called covered is still food on its way, whatever the answer is about.
  const first = cand && cand.carbsG >= UNCOVERED_MEAL_MIN_CARBS && !rescueFood && !answer.coming
    ? { ...answer, coming: { carbsG: cand.carbsG, description: cand.description, inMin: Math.max(0, Number(cand.minutesUntil) || 0) } }
    : answer;
  const wanted = restOfMeal(s, first, !!cand);
  const floored = underFloor(s, wanted);
  // A rest that comes to nothing goes back to what was there before it, which had no dose in it. Only that:
  // a dose the sum named goes through the floor like any other, and the floor's answer stands.
  const raw = wanted !== first && first.units <= 0 && floored.units <= 0 ? first : floored;
  const capped = raw.capped === true;
  const stopped = capped || raw.held === true;
  // The largest figure on record or the one named, never their sum: with 4 u seven hours ago, a model's
  // "5 u" passed next to "Fais 1,5 u".
  const ceiling = Math.max(stopped ? raw.named : Math.max(raw.named, guard.maxInsulinUnits), contextUnits);
  const sugar = guard.kind === "sugar";
  const common = {
    ...base, plan: raw.plan, capped, stopped, heldBack: raw.kept ?? null, rest: raw.rest === true, split: raw.plan?.timing === "split", rescueFood,
    proseCeiling: ceiling, sugarGrams: sugar ? guard.sugarGrams : 0,
    nothingDue: (noDoseDue(guard) || stopped) && raw.units <= 0,
    insulinForbidden: (guard.maxInsulinUnits === 0 || stopped) && raw.units <= 0 && raw.laterUnits <= 0,
  };
  const room = roomLine(s, raw.question, raw.units > 0 || raw.laterUnits > 0);

  if (sugar) return { ...common, kind: "sugar", line: sugarVerb(raw.line, lang), units: 0, laterUnits: 0 };

  const guessed = guessedGrams(s, raw, opts);
  // Asked first, because answering it can change everything below it. On what the sum wanted, not on what
  // is left of it: the floor counts this very dose as done, and would otherwise silence the question.
  if (wanted.units > 0 && s.pending && s.nowMs - s.pending.at >= PENDING_GRACE_MIN * 60000) {
    return {
      ...common, kind: "ask_done", line: askDoneLine(s.pending, s), units: 0, laterUnits: 0,
      nothingDue: true, insulinForbidden: true, proseCeiling: contextUnits,
    };
  }
  if (raw.units > 0) {
    // Not in the first two minutes: that is this same look, translated for the other language.
    const again = s.pending && s.nowMs - s.pending.at >= 2 * 60000 ? namedAlready(s.pending, s, raw.units) : "";
    if (s.knowledge === "unknown") {
      return { ...common, kind: "dose_if", line: conditional(raw.line, lang, guessed) + again + room, units: raw.units, laterUnits: 0 };
    }
    const line = guessed ? onEstimate(raw.line, guessed, lang) : withVerb(raw.line, lang);
    return { ...common, kind: "dose", line: line + again + room, units: raw.units, laterUnits: 0 };
  }
  if (raw.laterUnits > 0) {
    const line = guessed ? onEstimate(raw.line, guessed, lang, true) : capitalise(raw.line);
    const again = s.pending && s.nowMs - s.pending.at >= 2 * 60000 ? namedAlready(s.pending, s, raw.laterUnits) : "";
    return {
      ...common, kind: "dose_later", line: line + again + room, units: 0, laterUnits: raw.laterUnits,
      laterAtMs: s.nowMs + Math.max(0, raw.coming?.inMin ?? 0) * 60000,
    };
  }
  if (guard.kind === "no_ratios") return { ...common, kind: "no_ratios", line: capitalise(raw.line), units: 0, laterUnits: 0 };
  const fine = guard.reason === "in_range" && !/insuline|insulina/i.test(raw.line);
  const rescue = rescueFood
    ? (es(lang) ? "Nada de insulina para esto: sirve para remontar. " : "Pas d'insuline pour ça : ça sert à remonter. ")
    : "";
  return { ...common, kind: fine ? "fine" : "hold", line: rescue + capitalise(raw.line) + room, units: 0, laterUnits: 0 };
}

export interface OnBoardProjection {
  /** The lowest point the arithmetic reaches, and when. */
  lowestMgdl: number;
  lowestAtMin: number;
  /** First minute under 70, or null. */
  underLowAtMin: number | null;
  /** Where it ends once everything has acted. */
  landingMgdl: number;
}

/**
 * Where the insulin and food on record take the glucose, five minutes at a time. The sensor's own
 * momentum is deliberately left out: this is the balance, the part that measured as a good predictor
 * of the coming low (landing under 70: 6 in 10 went low, 70-120: 2 in 10).
 */
export function projectOnBoard(s: EngineState): OnBoardProjection | null {
  const isf = s.gp?.correctionFactor && s.gp.correctionFactor > 0 ? s.gp.correctionFactor : null;
  const icr = s.gp?.carbRatio && s.gp.carbRatio > 0 ? s.gp.carbRatio : null;
  if (s.cur == null || !isf) return null;
  let lowest = s.cur;
  let lowestAt = 0;
  let under: number | null = null;
  let v = s.cur;
  for (let t = LANDING_SIM_STEP_MIN; t <= LANDING_SIM_HORIZON_MIN; t += LANDING_SIM_STEP_MIN) {
    const fall = isf * insulinActingWithin(s.insulin, s.nowMs, s.gp?.rapidInsulin, t);
    const rise = icr ? (isf / icr) * carbsLandingWithin(s.meals, s.nowMs, t) * COB_TRUST_FRACTION : 0;
    v = s.cur + rise - fall;
    if (v < lowest) { lowest = v; lowestAt = t; }
    if (under == null && v < LOW_MGDL) under = t;
  }
  return { lowestMgdl: Math.round(lowest), lowestAtMin: lowestAt, underLowAtMin: under, landingMgdl: Math.round(v) };
}

/** Minutes from a dose to the usual first value under 70: the median on his 59 logged doses. */
export const LOW_AFTER_DOSE_MIN = 90;

/** The newest rapid dose this sum counted, injected or announced for the coming hour, or null. Neither can
 *  be the answer to a dose worked out on top of it. */
export function lastCountedDoseMs(s: EngineState): number | null {
  const times = (s.insulin || [])
    .filter((x) => x && x.kind !== "basal" && !isBasalInsulin(x.name ?? x.insulin_name))
    .map((x) => tsOf(x.ts))
    .filter((t) => Number.isFinite(t) && t <= s.nowMs + ANNOUNCED_DOSE_MIN * 60000);
  return times.length ? Math.max(...times) : null;
}

/** Rapid doses already injected, newest first. */
function rapidDoseTimes(s: EngineState): number[] {
  return (s.insulin || [])
    .filter((x) => x && x.kind !== "basal" && !isBasalInsulin(x.name ?? x.insulin_name))
    .map((x) => tsOf(x.ts))
    .filter((t) => Number.isFinite(t) && t <= s.nowMs)
    .sort((a, b) => b - a);
}

export type AnticipationKind =
  | "insulin_low" | "low_risk" | "high_risk" | "rising_no_meal" | "fatty_late" | "dont_stack";

export interface Anticipation {
  kind: AnticipationKind;
  line: string;
  /** When to look again, in ms. */
  recheckAtMs: number | null;
}

/**
 * What is already in takes him under 70.
 * The hour, and how it is chosen. On his doses the first value under 70 came 68 / 90 / 129 minutes
 * after the injection (quartiles), earlier than the curve says when the dose was large: the arithmetic
 * put one at 22:51 that really came at 21:00. So the sooner of the two is the one to say.
 */
function insulinLowAhead(s: EngineState): Anticipation | null {
  if (s.signalLost || s.cur == null) return null;
  const proj = projectOnBoard(s);
  if (!proj || proj.underLowAtMin == null || s.iob < 0.3) return null;
  const { lang, tzOffsetMin: tz, nowMs: now } = s;
  const at = (min: number) => clock(now + min * 60000, tz);
  const lastDose = rapidDoseTimes(s)[0];
  const typical = lastDose ? Math.round((lastDose + LOW_AFTER_DOSE_MIN * 60000 - now) / 60000) : Infinity;
  const m = typical > 5 ? Math.min(proj.underLowAtMin, typical) : proj.underLowAtMin;
  const check = Math.max(10, Math.min(30, Math.round(m / 2)));
  return {
    kind: "insulin_low",
    recheckAtMs: now + check * 60000,
    line: es(lang)
      ? `Lo que queda de insulina puede llevarte por debajo de 70, sobre todo hacia las ${at(m)}. Ten azúcar a mano y vuelve a mirar a las ${at(check)}.`
      : `Ce qu'il reste d'insuline peut t'emmener sous 70, surtout vers ${at(m)}. Garde du sucre à portée et regarde de nouveau à ${at(check)}.`,
  };
}

/** Days until a new slow insulin has taught the forecast enough, or null when there is none. Until then
 *  "his history" is the history of another insulin, and saying how often it proved right says nothing. */
export function slowInsulinDaysLeft(s: EngineState): number | null {
  const changed = s.profileRow?.basal_changed_at ? new Date(s.profileRow.basal_changed_at).getTime() : NaN;
  if (!Number.isFinite(changed) || changed > s.nowMs) return null;
  const settle = insulinByName(s.profileRow?.basal_insulin)?.settlesDays ?? 3;
  const left = settle + REGIME_SETTLED_DAYS - (s.nowMs - changed) / 86400000;
  return left > 0 ? Math.ceil(left) : null;
}

/** His own history says the coming hour may end low. */
export function historyLowAhead(s: EngineState): Anticipation | null {
  const f = s.forecast;
  if (s.signalLost || s.cur == null || !f) return null;
  const { lang, tzOffsetMin: tz, nowMs: now } = s;
  const again = clock(now + 20 * 60000, tz);
  const recheckAtMs = now + 20 * 60000;
  if (f.lowest60 != null) {
    if (!f.lowWarning) return null;
    const k = f.lowWarningRight != null && slowInsulinDaysLeft(s) == null ? Math.max(1, Math.round(f.lowWarningRight * 10)) : null;
    const odds = k == null ? "" : es(lang)
      ? ` En tu historial, este aviso se cumple unas ${k} veces de cada 10.`
      : ` Sur ton historique, cet avertissement se vérifie environ ${k} fois sur 10.`;
    return {
      kind: "low_risk",
      recheckAtMs,
      line: es(lang)
        ? `Puedes bajar de 70 en la próxima hora.${odds} Ten azúcar a mano y vuelve a mirar a las ${again}.`
        : `Tu peux passer sous 70 dans l'heure.${odds} Garde du sucre à portée et regarde de nouveau à ${again}.`,
    };
  }
  // A model fitted before the low warning existed: the risk table, until the next daily fit.
  const rising = s.trend === "rising" || s.trend === "rising_fast";
  if (f.lowRisk60 == null || f.lowRisk60 < LOW_RISK_WARN || rising || s.cur >= 200) return null;
  const k = Math.max(3, Math.round(f.lowRisk60 * 10));
  return {
    kind: "low_risk",
    recheckAtMs,
    line: es(lang)
      ? `En momentos parecidos (a esta hora, a este nivel) bajaste de 70 en la hora siguiente unas ${k} veces de cada 10. Ten azúcar a mano y vuelve a mirar a las ${again}.`
      : `Dans des moments semblables (cette heure, ce niveau), tu es passé sous 70 dans l'heure environ ${k} fois sur 10. Garde du sucre à portée et regarde de nouveau à ${again}.`,
  };
}


/** What to expect next, and what to do about it before it happens. The one most urgent thing. */
export function anticipate(s: EngineState, d: Decision): Anticipation | null {
  if (s.signalLost || s.cur == null) return null;
  if (d.kind === "sugar" || d.kind === "ask_done") return null;
  const { lang, tzOffsetMin: tz, nowMs: now } = s;
  const g = s.cur;
  const at = (min: number) => clock(now + min * 60000, tz);
  const f = s.forecast;
  const rising = s.trend === "rising" || s.trend === "rising_fast";
  const falling = s.trend === "falling" || s.trend === "falling_fast";

  // 1. What is already in takes him under 70, and the dose in this line has not been counted yet.
  const alreadySaid = /sous 70|por debajo de 70|bajas de 70/.test(d.line);
  const fromInsulin = d.units <= 0 && !alreadySaid ? insulinLowAhead(s) : null;
  if (fromInsulin) return fromInsulin;

  // 2. His own history says this kind of moment often ends low.
  const fromHistory = alreadySaid ? null : historyLowAhead(s);
  if (fromHistory) return fromHistory;

  // 3. Rising with nothing to explain it: the one moment a dose can still get ahead of the climb.
  const hour = Math.floor((((now / 60000 + tz) % 1440) + 1440) % 1440 / 60);
  const night = hour < 7 || hour >= 23;
  const mealRecently = (s.meals || []).some((m) => {
    const t = tsOf(m?.ts);
    return Number.isFinite(t) && now - t >= 0 && now - t <= 180 * 60000 && !isHypoRescue(m?.description, m?.carbs_g ?? m?.carbsG);
  });
  if (rising && !night && !mealRecently && g >= 110 && g <= HIGH_MGDL && d.units <= 0) {
    const pace = Math.max(1, Math.round(Math.abs(s.slope ?? 1)));
    return {
      kind: "rising_no_meal",
      recheckAtMs: now + 15 * 60000,
      line: es(lang)
        ? `Sube unos ${pace} mg/dL por minuto sin comida anotada. Si has comido, anótala y calculo la dosis antes de que suba más.`
        : `Ça monte d'environ ${pace} mg/dL par minute sans repas noté. Si tu as mangé, note-le et je calcule la dose avant que ça monte plus.`,
    };
  }

  // 4. His own history says this kind of moment often ends very high.
  if (f?.highRisk60 != null && f.highRisk60 >= HIGH_RISK_WARN && !falling && g < 230 && d.units <= 0) {
    const k = Math.round(f.highRisk60 * 10);
    return {
      kind: "high_risk",
      recheckAtMs: now + 20 * 60000,
      line: es(lang)
        ? `En momentos parecidos pasaste de 250 en la hora siguiente unas ${k} veces de cada 10. Vuelve a mirar a las ${at(20)}.`
        : `Dans des moments semblables, tu as dépassé 250 dans l'heure environ ${k} fois sur 10. Regarde de nouveau à ${at(20)}.`,
    };
  }

  // 5. A fatty meal arrives late. ISPAD: glucose lower at 1-2 h, higher at 3-6 h, watch for 6 h.
  let fatty: any = null;
  for (const m of s.meals || []) {
    const t = tsOf(m?.ts);
    if (!Number.isFinite(t) || !isFattyMeal(m?.description)) continue;
    const age = (now - t) / 60000;
    if (age < 30 || age > 360) continue;
    if (Number(m?.carbs_g ?? m?.carbsG ?? 0) < 20) continue;
    if (!fatty || t > tsOf(fatty.ts)) fatty = m;
  }
  if (fatty && !d.capped) {
    const t = tsOf(fatty.ts);
    const until = clock(t + 360 * 60000, tz);
    const check = Math.max(now + 15 * 60000, t + 180 * 60000);
    return {
      kind: "fatty_late",
      recheckAtMs: check,
      line: es(lang)
        ? `Comida grasa de las ${clock(t, tz)}: la glucosa puede seguir subiendo hasta las ${until}. Vuelve a mirar a las ${clock(check, tz)}.`
        : `Repas gras de ${clock(t, tz)} : la glycémie peut remonter jusque vers ${until}. Regarde de nouveau à ${clock(check, tz)}.`,
    };
  }

  // 6. Insulin still arriving: the commonest way to end low is a second dose too soon.
  const lastRapid = rapidDoseTimes(s)[0];
  if (lastRapid && g > HIGH_MGDL && now - lastRapid < 120 * 60000 && d.units <= 0 && !d.capped && !restStillOwed(s)) {
    const until = lastRapid + 120 * 60000;
    return {
      kind: "dont_stack",
      recheckAtMs: until,
      line: es(lang)
        ? `La insulina de las ${clock(lastRapid, tz)} aún no ha dado todo: nada de repetir antes de las ${clock(until, tz)}.`
        : `L'insuline de ${clock(lastRapid, tz)} n'a pas encore tout donné : pas de nouvelle dose avant ${clock(until, tz)}.`,
    };
  }
  return null;
}

/** "Dans 30 min : ~150 (120-190). Dans 1 h : ~160 (110-220)." Empty when nothing can be said. */
export function forecastLine(f: Forecast | null, lang: string): string {
  if (!f || !f.points.length) return "";
  const part = (minutes: number, mgdl: number, low: number, high: number) => {
    const when = minutes >= 60 ? (es(lang) ? "En 1 h" : "Dans 1 h") : (es(lang) ? `En ${minutes} min` : `Dans ${minutes} min`);
    return `${when} : ~${mgdl} (${low}-${high})`;
  };
  return f.points.map((p) => part(p.minutes, p.mgdl, p.low, p.high)).join(". ") + ".";
}

/**
 * How far to trust the range, in one sentence under it. A new slow insulin first: until it has enough
 * days of its own, the measurements below describe the old one. Then what the forecasts really scored.
 */
export function forecastNote(s: EngineState): string | null {
  const f = s.forecast;
  const doses = doseNote(s);
  if (!f) return doses;
  const { lang } = s;
  const left = slowInsulinDaysLeft(s);
  if (left != null) {
    return es(lang)
      ? `Insulina lenta nueva: la previsión aún está aprendiendo, menos segura durante unos ${left} días.`
      : `Nouvelle insuline lente : la prévision apprend encore, moins sûre pendant environ ${left} jours.`;
  }
  const m = f.measured;
  if (!m?.h30 || !m.h60) return doses;
  const days = Math.round(m.days);
  const a = Math.round(m.h30.rmse);
  const b = Math.round(m.h60.rmse);
  const a0 = Math.round(m.h30.noChange);
  const b0 = Math.round(m.h60.noChange);
  const lows = m.lows >= 5 ? Math.round((m.lowsWarned / m.lows) * 10) : null;
  const measured = es(lang)
    ? `Medido de verdad en ${days} días: error típico ${a} mg/dL a 30 min y ${b} a 1 h (${a0} y ${b0} sin previsión).${lows == null ? "" : ` Hipos avisadas: ${lows} de cada 10.`}`
    : `Mesuré en vrai sur ${days} jours : écart typique ${a} mg/dL à 30 min et ${b} à 1 h (${a0} et ${b0} sans prévision).${lows == null ? "" : ` Hypos annoncées : ${lows} sur 10.`}`;
  return doses ? `${measured} ${doses}` : measured;
}

/** The action's own score, once there is something to say. */
function doseNote(s: EngineState): string | null {
  const d = s.doseScore;
  if (!d || d.judged < 5) return null;
  const others = d.judged - d.followed;
  const othersRight = d.stayed90 - d.followed90;
  if (d.followed < 3) {
    return es(s.lang)
      ? `Dosis anotadas en ${d.days} días: ${d.stayed90} de ${d.judged} se mantuvieron por encima de ${DOSE_STAYS_ABOVE}.`
      : `Doses notées sur ${d.days} jours : ${d.stayed90} sur ${d.judged} sont restées au-dessus de ${DOSE_STAYS_ABOVE}.`;
  }
  const rest = others >= 3
    ? (es(s.lang) ? ` Las demás dosis: ${othersRight} de ${others}.` : ` Les autres doses : ${othersRight} sur ${others}.`)
    : "";
  return es(s.lang)
    ? `Dosis de la app en ${d.days} días: ${d.followed90} de ${d.followed} se mantuvieron por encima de ${DOSE_STAYS_ABOVE}.${rest}`
    : `Doses de l'app sur ${d.days} jours : ${d.followed90} sur ${d.followed} sont restées au-dessus de ${DOSE_STAYS_ABOVE}.${rest}`;
}

/**
 * Everything said after the action, in one order for every surface. `voice` strips what only makes
 * sense on screen.
 */
export function sideNotes(s: EngineState, d: Decision): { display: string; voice: string }[] {
  const out: { display: string; voice: string }[] = [];
  const add = (line: string | null | undefined) => {
    if (!line) return;
    out.push({ display: line, voice: speakable(line.replace(/[🌡️🏃⚠️]/gu, "").trim(), s.lang) });
  };
  if (s.signalLost) return out;
  const { lang, nowMs: now } = s;
  add(preSportCarbsLine(s.activity, now, s.cur, lang));
  add(temperatureNote(s.tempC, lang, s.outdoor, s.place));
  add(activityNote(s.activity, now, s.activityCut, lang, d.units > 0 || d.laterUnits > 0));
  if (d.kind === "sugar") add(hypoIobWarning(s.iobInjected, lang));
  if (s.cur != null && s.cur < LOW_MGDL && s.iobDose > s.iobInjected + 0.05) {
    add(es(lang) ? "No te pongas la dosis anunciada mientras sigas bajo." : "Ne fais pas la dose annoncée tant que tu es bas.");
  }
  // Not after a first part done as told: "this meal was not covered" is then both false and unfair, and its
  // "in about 2 h" fights the time the action gives.
  if (s.guard.kind === "correction" && !d.capped && !dosedWithin(s, 180)) add(uncoveredMealWarning(s.meals, s.insulin, now, s.gp, lang));
  if (d.kind !== "sugar") {
    const upcoming = (s.meals || []).find((m: any) => {
      if (!m || m.planned !== true || !m.ts) return false;
      const t = tsOf(m.ts);
      return Number.isFinite(t) && t > now;
    });
    if (upcoming && !d.stopped) {
      const recentRapid = (s.insulin || []).some((x: any) => {
        if (!x || x.kind === "basal" || isBasalInsulin(x.name ?? x.insulin_name)) return false;
        const t = tsOf(x.ts);
        return Number.isFinite(t) && t <= now + 60000 && now - t <= 45 * 60000;
      });
      add(plannedMealNote(Number(upcoming.carbs_g) || null, recentRapid, lang));
    }
  }
  const row = s.profileRow;
  const basalDoses = (s.insulin || []).filter((x: any) => x && (x.kind === "basal" || isBasalInsulin(x.name ?? x.insulin_name)));
  const lastBasal = basalDoses.map((x: any) => tsOf(x.ts)).filter((t: number) => Number.isFinite(t)).sort((a: number, b: number) => b - a)[0] ?? null;
  const changed = row?.basal_changed_at ? new Date(row.basal_changed_at).getTime() : null;
  const basal = basalNotice(row?.basal_insulin, lastBasal, changed, now, lang);
  if (basal) add(basal.line);
  return out;
}

/** What the model is told about the situation. A correction "justified" next to "no insulin for now" got
 *  written into the summary above the action that contradicts it. */
export function decisionHint(s: EngineState, d: Decision): string {
  if (d.rest && d.units > 0) {
    return es(s.lang) ? "queda algo de insulina por poner para esta comida" : "il reste un peu d'insuline à faire pour ce repas";
  }
  if (d.capped && d.units <= 0 && d.laterUnits <= 0) {
    return es(s.lang) ? "por ahora nada de insulina, hay que volver a mirar a la hora indicada" : "pas d'insuline pour l'instant, à revoir à l'heure indiquée";
  }
  if (d.capped && d.units <= 0) {
    return es(s.lang) ? "una dosis pequeña al empezar a comer, el resto se decide después" : "une petite dose au moment de manger, le reste se décide ensuite";
  }
  if (d.capped) {
    return es(s.lang) ? "una dosis pequeña ahora, el resto se decide después" : "une petite dose maintenant, le reste se décide ensuite";
  }
  return situationHint(s.guard, s.lang);
}

/** The decision as it travels to the app: numbers and flags, no prose the app would have to parse. */
export function decisionPayload(s: EngineState, d: Decision, a: Anticipation | null) {
  return {
    kind: d.kind,
    units: d.units,
    laterUnits: d.laterUnits,
    sugarGrams: d.sugarGrams,
    insulinName: d.insulinName,
    knowledge: d.knowledge,
    pending: d.pending,
    split: d.split,
    capped: d.capped,
    forecast: s.forecast,
    forecastNote: forecastNote(s),
    anticipation: a ? { kind: a.kind, line: a.line, recheckAtMs: a.recheckAtMs } : null,
    iobUnits: Math.round(s.iob * 10) / 10,
    cobGrams: Math.round(s.cob),
  };
}

/** The facts handed to the model. It writes the sentences; it decides nothing. */
export function engineFacts(s: EngineState, d: Decision, a: Anticipation | null): string {
  const lang = s.lang;
  const parts: string[] = [];
  const bal = balanceSystemLine(s.balance, lang);
  if (bal) parts.push(bal);
  if (d.knowledge === "unknown") {
    parts.push(es(lang)
      ? "INSULINA DE LAS ÚLTIMAS 3 H: DESCONOCIDA (nada anotado, y casi nunca se anota todo). NO digas que no hay insulina activa: di que no se sabe."
      : "INSULINE DES 3 DERNIÈRES HEURES : INCONNUE (rien de noté, et presque personne ne note tout). NE dis PAS qu'il n'y a pas d'insuline active : dis qu'on ne sait pas.");
  }
  if (s.forecast) {
    const line = forecastLine(s.forecast, lang);
    parts.push(es(lang)
      ? `PREVISIÓN (calculada con su historial, fórmula del sistema): ${line} Es una horquilla, no una promesa; más allá de 1 h no hay cifra.`
      : `PRÉVISION (calculée sur son historique par le système) : ${line} C'est une fourchette, pas une promesse ; au-delà d'une heure il n'y a pas de chiffre.`);
  }
  if (a) {
    parts.push(es(lang) ? `A PREVER (ya calculado, no lo cambies): ${a.line}` : `À PRÉVOIR (déjà calculé, ne le change pas) : ${a.line}`);
  }
  return parts.join(" ");
}

/** The last hours, on the clock, so the model can say when things happened instead of guessing. */
export function timedSeries(s: EngineState, hours = 3): string {
  const { readings, nowMs, tzOffsetMin: tz, lang } = s;
  const since = nowMs - hours * 3600000;
  const rows: string[] = [];
  let next = since;
  for (const r of readings) {
    if (r.ts < since || r.ts < next) continue;
    rows.push(`${clock(r.ts, tz)} ${Math.round(r.value)}`);
    next = r.ts + 15 * 60000;
  }
  const events: { t: number; text: string }[] = [];
  for (const d of s.insulin || []) {
    const t = tsOf(d?.ts);
    if (!Number.isFinite(t) || t < since - 3600000 || t > nowMs) continue;
    const basal = d.kind === "basal" || isBasalInsulin(d.name ?? d.insulin_name);
    events.push({ t, text: `${clock(t, tz)} ${es(lang) ? "dosis" : "dose"} ${d.units} u ${d.insulin_name ?? d.name ?? ""}${basal ? (es(lang) ? " (lenta)" : " (lente)") : ""}`.trim() });
  }
  for (const m of s.meals || []) {
    const t = tsOf(m?.ts);
    if (!Number.isFinite(t) || t < since - 3600000 || t > nowMs) continue;
    const c = Number(m.carbs_g ?? m.carbsG ?? 0);
    events.push({ t, text: `${clock(t, tz)} ${es(lang) ? "comida" : "repas"}${c > 0 ? ` ${Math.round(c)} g` : ""} ${String(m.description ?? "").slice(0, 50)}`.trim() });
  }
  events.sort((a, b) => a.t - b.t);
  const logged = events.length
    ? events.map((e) => e.text).join(" ; ")
    : (es(lang) ? "NADA anotado" : "RIEN de noté");
  return es(lang)
    ? `CURVA (hora local, mg/dL): ${rows.join(", ")}. ANOTADO EN ESTE TIEMPO: ${logged}. Si no hay nada anotado, NO atribuyas una subida o bajada a una comida o a una insulina: di que no se sabe por qué.`
    : `COURBE (heure locale, mg/dL) : ${rows.join(", ")}. NOTÉ SUR CETTE PÉRIODE : ${logged}. Si rien n'est noté, N'ATTRIBUE PAS une montée ou une baisse à un repas ou à une insuline : dis qu'on ne sait pas pourquoi.`;
}

/** What the prose has to know about why nothing is said about a covered meal. */
export { findUncoveredMeal, situationHint, FALL_WATCH_BELOW, roundToHalf };
