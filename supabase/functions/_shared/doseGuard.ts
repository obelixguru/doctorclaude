// Deterministic dose-safety guard for Doctor Claude — the SOURCE OF TRUTH for what action
// is allowed. It does NOT depend on the LLM. coach/ask/scan compute the guard in code and
// (a) feed the authoritative action to the model and (b) OVERRIDE the model's output if it
// ever proposes insulin the guard forbids or more than the guard ceiling.
//
// Invariants (locked HERE, not just in the prompt text):
//   - Data stale (> STALE_MIN) or glucose unknown -> WAIT, no insulin (recheck first).
//   - Glucose < 70                                -> SUGAR by body weight (0.3 g/kg), no insulin.
//   - Glucose 70..180 (in range)                  -> NONE, no correction insulin.
//   - Glucose > 180                               -> correction ONLY if (stable or rising), minus
//                                                    IOB, rounded to 0.5 u, floored at 0. Falling or
//                                                    unknown-trend -> no insulin. (A high AFTER a
//                                                    hypo IS corrected — stacking is prevented by the
//                                                    IOB subtraction, not by blocking post-hypo.)
//   - No doctor ratios                            -> NO_RATIOS, never invent units.
//
// Pure TS (no Deno/Node APIs) so it imports cleanly in edge functions AND runs under the
// Node test runner. Erasable-only syntax (type-strip safe).

export type Trend = "rising_fast" | "rising" | "stable" | "falling" | "falling_fast" | "unknown";
export type ActionKind = "sugar" | "correction" | "none" | "wait" | "no_ratios";

export interface GuardProfile {
  carbRatio?: number | null;
  correctionFactor?: number | null; // mg/dL dropped per 1 u
  targetMgdl?: number | null;
  weightKg?: number | null;
  rapidInsulin?: string | null;
}

export interface GuardInput {
  glucoseMgdl: number | null;
  trend: Trend;
  staleMin: number;
  iobUnits: number;
  recentHypo: boolean;
  // Minutes since the last EATEN fast carbs / sugar (a hypo rescue), or null if none recent. When
  // a low is already being treated, we hold instead of stacking more sugar (see RESCUE_WINDOW_MIN).
  minSinceRescue?: number | null;
  profile: GuardProfile | null;
}

export interface GuardResult {
  kind: ActionKind;
  insulinUnits: number;     // correction units recommended (0 unless kind === "correction")
  maxInsulinUnits: number;  // absolute ceiling for ANY insulin suggestion (0 => no insulin at all)
  sugarGrams: number;       // fast sugar grams (0 unless kind === "sugar")
  sugarCubes: number;       // 4 g cubes
  reason: string;           // machine reason code
}

export const STALE_MIN = 15;
export const LOW_MGDL = 70;
export const HIGH_MGDL = 180;
// Sugar/carbs eaten within this window are still being absorbed (the clinical "rule of 15"):
// don't recommend MORE sugar yet, or we over-treat the low and rebound high.
export const RESCUE_WINDOW_MIN = 15;
// Below this (severe hypo) the rescue-window "hold" NEVER applies: a deep low must be re-treated
// with sugar immediately, even if some was just taken — waiting on a 45 mg/dL is dangerous.
export const SEVERE_LOW_MGDL = 54;
// A hypo while rapid insulin is still on board keeps falling (pendingDrop = iob × ISF). A plain
// 0.3 g/kg rescue then doesn't hold (the real case: 6.5 u Fiasp → an hour under 70 despite 3 sucres,
// twice). We add carbs to blunt PART of the remaining insulin (this fraction of iob × ICR grams) on
// top of the base rescue — the rest is covered by re-treating. Kept a FRACTION + capped at 0.6 g/kg
// so we never push a rebound-high carb load; the guidance still says recheck + re-treat.
export const IOB_RESCUE_FRACTION = 0.3;
// At/above this much active insulin during a hypo, warn that one rescue may not be enough.
export const IOB_HYPO_WARN_UNITS = 1.0;

export function roundToHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

/** The one function that decides the allowed action. Safety-biased: when in doubt, no insulin. */
export function computeGuard(input: GuardInput): GuardResult {
  const { glucoseMgdl: g, trend, staleMin, iobUnits, profile } = input;
  const block = (kind: ActionKind, reason: string): GuardResult => ({
    kind, insulinUnits: 0, maxInsulinUnits: 0, sugarGrams: 0, sugarCubes: 0, reason,
  });

  if (g == null || !Number.isFinite(g) || g <= 0) return block("wait", "no_reading");
  if (staleMin > STALE_MIN) return block("wait", "stale_data");

  if (g < LOW_MGDL) {
    // Already treated this low recently? The sugar is still being absorbed — don't pile on more
    // (rule of 15), or we over-correct and rebound high. Hold and recheck; re-treat only if still
    // low after it's had time to act.
    const ms = input.minSinceRescue;
    // ...UNLESS it's a SEVERE hypo: a deep low (< SEVERE_LOW_MGDL) is always re-treated, never told
    // to "wait" just because sugar was taken — the rule of 15 is for mild lows, not emergencies.
    if (ms != null && ms >= 0 && ms <= RESCUE_WINDOW_MIN && g >= SEVERE_LOW_MGDL) {
      return { kind: "wait", insulinUnits: 0, maxInsulinUnits: 0, sugarGrams: 0, sugarCubes: 0, reason: "sugar_recent" };
    }
    const w = profile?.weightKg && profile.weightKg > 0 ? profile.weightKg : null;
    let grams = w ? 0.3 * w : 15; // base rescue (≈0.3 g/kg) to fix the CURRENT low
    // INSULIN-ON-BOARD AWARE: rapid insulin still active will keep lowering glucose, so add carbs to
    // blunt part of it now (capped) — otherwise a single rescue fails and the low drags on.
    const cr = profile?.carbRatio && profile.carbRatio > 0 ? profile.carbRatio : null;
    const iob = iobUnits || 0;
    if (cr && iob > 0) grams += iob * cr * IOB_RESCUE_FRACTION;
    const capG = w ? w * 0.6 : 30; // never recommend a rebound-sized load in one go
    grams = Math.round(Math.min(grams, capG));
    const cubes = Math.max(1, Math.ceil(grams / 4));
    return { kind: "sugar", insulinUnits: 0, maxInsulinUnits: 0, sugarGrams: grams, sugarCubes: cubes, reason: iob >= IOB_HYPO_WARN_UNITS ? "hypo_iob" : "hypo" };
  }

  if (g <= HIGH_MGDL) return block("none", "in_range");

  // g > 180 from here
  const hasRatios = !!(profile && profile.correctionFactor && profile.targetMgdl);
  if (!hasRatios) return block("no_ratios", "no_ratios");
  // A high that is stable or RISING gets a correction even just after a hypo. The user (an informed
  // T1D parent) wants hypers corrected — "hyper = insuline". We no longer hard-block as a "post-hypo
  // rebound": stacking is already prevented by subtracting IOB below, and a glucose that is FALLING
  // is left alone (it's coming down on its own). Treating a genuine 214 ↑↑ is standard care.
  if (trend === "falling" || trend === "falling_fast") return block("none", "falling");
  if (trend === "unknown") return block("wait", "trend_unknown");

  // stable or rising -> correction allowed, minus insulin-on-board
  const raw = (g - (profile!.targetMgdl as number)) / (profile!.correctionFactor as number);
  const units = Math.max(0, roundToHalf(raw - (iobUnits || 0)));
  if (units <= 0) return block("none", "covered_by_iob");
  return { kind: "correction", insulinUnits: units, maxInsulinUnits: units, sugarGrams: 0, sugarCubes: 0, reason: "high_correction" };
}

/** Recent trend from readings ({ ts: ms, value: mg/dL }), over the last ~20 min. Safety-biased. */
export function trendFromReadings(readings: { ts: number; value: number }[], _nowMs: number): Trend {
  const pts = (readings || [])
    .filter((r) => r && Number(r.value) > 0 && Number.isFinite(Number(r.ts)))
    .map((r) => ({ t: Number(r.ts), v: Number(r.value) }))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return "unknown";
  const last = pts[pts.length - 1];
  const windowStart = last.t - 20 * 60 * 1000;
  const first = pts.find((p) => p.t >= windowStart) ?? pts[0];
  const mins = (last.t - first.t) / 60000;
  if (mins <= 0) return "unknown";
  const slope = (last.v - first.v) / mins; // mg/dL per minute
  if (slope >= 2) return "rising_fast";
  if (slope >= 0.5) return "rising";
  if (slope <= -2) return "falling_fast";
  if (slope <= -0.5) return "falling";
  return "stable";
}

/** Minutes since the last EATEN fast carbs / sugar (a hypo rescue), or null if there are none.
 *  A PLANNED (not-yet-eaten) meal doesn't count — it isn't on board. `ts` may be ISO or epoch ms.
 *  computeGuard only acts on this inside RESCUE_WINDOW_MIN, so a large value is harmless. */
export function minutesSinceLastRescue(meals: any[], nowMs: number): number | null {
  let latest = 0;
  for (const m of meals || []) {
    if (!m || m.planned === true) continue;
    const t = typeof m.ts === "number" ? m.ts : new Date(m.ts).getTime();
    if (Number.isFinite(t) && t <= nowMs + 60000 && t > latest) latest = t;
  }
  return latest ? Math.max(0, Math.round((nowMs - latest) / 60000)) : null;
}

/** Did the person come up from a hypo recently (rebound)? Then don't stack a correction. */
export function recentHypoFrom(readings: { ts: number; value: number }[], nowMs: number, windowMin = 75): boolean {
  const cut = nowMs - windowMin * 60 * 1000;
  return (readings || []).some(
    (r) => r && Number(r.value) > 0 && Number(r.ts) >= cut && Number(r.value) < LOW_MGDL,
  );
}

function fmtUnits(u: number): string {
  return Number.isInteger(u) ? String(u) : String(u).replace(".", ",");
}

/** The authoritative, localized action sentence. Code owns the numbers; the LLM only adds tone. */
export function actionLine(g: GuardResult, lang: string, profile: GuardProfile | null): string {
  const rapid = profile?.rapidInsulin || (lang === "es" ? "insulina rápida" : "insuline rapide");
  // A low that was JUST treated: hold, don't take more sugar yet.
  if (g.reason === "sugar_recent") {
    return lang === "es"
      ? `ya tomaste azúcar hace unos minutos — déjale ~15 min para actuar antes de tomar más, y vuelve a medir; toma más solo si sigues por debajo de 70.`
      : `tu as déjà pris du sucre il y a quelques minutes — laisse-lui ~15 min pour agir avant d'en reprendre, et recontrôle ; reprends-en seulement si tu es encore sous 70.`;
  }
  if (lang === "es") {
    switch (g.kind) {
      case "sugar": return `${g.sugarGrams} g de azúcar rápido (${g.sugarCubes} terrón/es) ahora, recontrola en 15 min.`;
      case "correction": return `${fmtUnits(g.insulinUnits)} u de ${rapid} ahora.`;
      case "none": return `ninguna insulina ahora.`;
      case "wait": return `ninguna insulina ahora; recontrola la glucosa en 15 min.`;
      case "no_ratios": return `completa los ratios del médico en el perfil para una dosis exacta.`;
    }
  }
  switch (g.kind) {
    case "sugar": return `${g.sugarGrams} g de sucre rapide (${g.sugarCubes} morceau(x)) tout de suite, recontrôle dans 15 min.`;
    case "correction": return `${fmtUnits(g.insulinUnits)} u de ${rapid} maintenant.`;
    case "none": return `aucune insuline pour l'instant.`;
    case "wait": return `aucune insuline pour l'instant ; recontrôle ta glycémie dans 15 min.`;
    case "no_ratios": return `renseigne les ratios du médecin dans le profil pour une dose chiffrée.`;
  }
  return "";
}

/** Safety net: strip any insulin-dose mention the model may have slipped in (e.g. "2 u",
 *  "1,5 unités", "3 unidades"). Applied only when the guard forbids insulin entirely. */
export function stripInsulinNumbers(text: string): string {
  // Collapse only HORIZONTAL whitespace ([ \t]) — NOT newlines — so paragraph breaks (\n\n) added
  // for readability survive this strip (it runs on every in-range/blocked analysis).
  return (text || "")
    .replace(/\d+(?:[.,]\d+)?\s*(?:u\b|unit[ée]s?\b|unidad(?:es)?\b)/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}

/** Clamp a model-proposed insulin dose to the guard. Returns the safe units + whether we overrode. */
export function clampInsulin(modelUnits: number, g: GuardResult): { units: number; overridden: boolean } {
  const m = Number.isFinite(modelUnits) ? Math.max(0, modelUnits) : 0;
  if (m > g.maxInsulinUnits + 1e-9) return { units: g.maxInsulinUnits, overridden: true };
  return { units: m, overridden: false };
}

/** A short, NUMBER-FREE situation phrase so the LLM's tone matches the code-computed action. */
export function situationHint(guard: GuardResult, lang: string): string {
  const es = lang === "es";
  switch (guard.reason) {
    case "hypo": return es ? "hipoglucemia en curso, hace falta azúcar rápido" : "hypo en cours, resucrage nécessaire";
    case "hypo_iob": return es ? "hipoglucemia con insulina aún activa: seguirá bajando, hace falta azúcar y vigilancia estrecha" : "hypo avec insuline encore active : ça va continuer à baisser, sucre + surveillance rapprochée";
    case "sugar_recent": return es ? "ya se tomó azúcar hace poco; se deja actuar, sin más azúcar por ahora" : "du sucre vient d'être pris ; on le laisse agir, pas plus de sucre pour l'instant";
    case "high_correction": return es ? "glucosa alta, una corrección de insulina está justificada" : "glycémie haute, une correction d'insuline est justifiée";
    case "in_range": return es ? "glucosa dentro del objetivo" : "glycémie dans la cible";
    case "covered_by_iob": return es ? "glucosa alta pero ya cubierta por la insulina activa" : "glycémie haute mais déjà couverte par l'insuline active";
    case "falling": return es ? "glucosa bajando, sin corrección" : "glycémie qui redescend, pas de correction";
    case "stale_data": return es ? "datos no actuales, recontrolar antes de cualquier dosis" : "données pas à jour, recontrôle avant toute dose";
    case "trend_unknown": return es ? "tendencia incierta, prudencia" : "tendance incertaine, prudence";
    case "no_ratios": return es ? "faltan los ratios del médico" : "ratios du médecin manquants";
    case "no_reading": return es ? "sin medición reciente" : "pas de mesure récente";
    default: return "";
  }
}

/** Meal bolus = carbs / carb-ratio, rounded to 0.5 u. Carb counting doesn't need fresh glucose. */
export function mealBolusUnits(carbsG: number | null | undefined, profile: GuardProfile | null): number {
  if (!profile || !profile.carbRatio || !carbsG || carbsG <= 0) return 0;
  return Math.max(0, roundToHalf(carbsG / profile.carbRatio));
}

/** A food's carbs expressed as ~4 g sugar-cube equivalents (e.g. 25 g -> 6). Every carb figure
 *  shown to the user is paired with this so grams are tangible (the user's Spanish sugar cubes). */
export function carbsCubes(carbsG: number | null | undefined): number {
  if (!carbsG || carbsG <= 0) return 0;
  return Math.max(1, Math.round(carbsG / 4));
}

/** Localized "≈ N sucres" phrase for a carb amount (empty when no carbs). */
export function carbsCubesPhrase(carbsG: number | null | undefined, lang: string): string {
  const n = carbsCubes(carbsG);
  if (!n) return "";
  return lang === "es" ? `≈ ${n} terrón(es) de azúcar` : `≈ ${n} sucre(s)`;
}

const FATTY_MEAL_WORDS = [
  "mcdo", "mcdonald", "burger", "hamburger", "cheeseburger", "royal", "big mac", "whopper",
  "pizza", "frite", "fries", "kebab", "nugget", "tacos", "fromage", "cheese", "gras", "friture",
  "beurre", "bacon", "charcuterie", "raclette", "crème", "creme", "mayo", "pané", "panee", "panée",
];
/** True when a meal description looks high-fat (fast-food, pizza, cheese…). Fat slows digestion, so
 *  the glucose rise is DELAYED — worth a split-bolus heads-up. Shared by coach / ask / scan. */
export function isFattyMeal(desc?: string | null): boolean {
  const d = (desc || "").toLowerCase();
  return FATTY_MEAL_WORDS.some((k) => d.includes(k));
}

/** Standalone "fatty meal → delayed rise, split the bolus" advice (no dose numbers, no emoji so the
 *  TTS reads it cleanly). Appended at logging time by ask / scan. */
export function fattyMealAdvice(lang: string): string {
  return lang === "es"
    ? "Comida grasa (digestión lenta): la glucosa suele subir con RETRASO. Piensa en un bolo dividido — una parte ahora, otra 1-2 h después — y recontrola 2-3 h más tarde."
    : "Repas gras (digestion lente) : la glycémie monte souvent en RETARD. Pense à un bolus étalé — une partie maintenant, une partie 1-2 h après — et recontrôle 2-3 h plus tard.";
}

/** Code-owned WARNING for a hypo while rapid insulin is still on board: the glucose will keep
 *  falling, so one rescue often won't hold (the real prolonged-hypo case). Appended by coach/ask to
 *  the analysis so the parent expects to re-treat + rechecks sooner. Empty below IOB_HYPO_WARN_UNITS. */
export function hypoIobWarning(iobUnits: number | null | undefined, lang: string): string {
  const iob = iobUnits || 0;
  if (iob < IOB_HYPO_WARN_UNITS) return "";
  const u = fmtUnits(roundToHalf(iob));
  return lang === "es"
    ? `⚠️ Aún quedan ~${u} u de insulina rápida activa que SEGUIRÁ bajando la glucosa: un solo azúcar puede no bastar. Vuelve a medir en ~10 min y vuelve a tomar azúcar si sigues bajo; vigila de cerca.`
    : `⚠️ Il reste ~${u} u d'insuline rapide active qui va CONTINUER à faire baisser : un seul resucrage peut ne pas suffire. Recontrôle dans ~10 min et reprends du sucre si tu es encore bas ; surveille de près.`;
}

/** Code-owned FACT about how fast a hypo rescue acts, so the model stops INVENTING durations (the
 *  user heard "le sucre met 26 minutes à agir" — made up). Fast sugar = the clinical "rule of 15":
 *  it STARTS acting in ~15 min, full effect ~30-45 min; take sugar, wait 15 min, recheck. Fed to the
 *  coach AND ask prompts so the spoken/written analysis never quotes a bogus number. */
export function sugarTimingFact(lang: string): string {
  return lang === "es"
    ? `TIEMPO DEL AZÚCAR (dato fijo — NO lo inventes): el azúcar rápido (terrones, zumo, refresco) EMPIEZA a actuar en ~15 min y su efecto pleno llega a los ~30-45 min — es la «regla del 15»: tomar azúcar, esperar 15 min y recontrolar. Tras un resucrado, deja pasar ~15 min antes de tomar más o de volver a medir. NUNCA des otra duración (nada de «20 min», «26 min»…).`
    : `DÉLAI DU SUCRE (donnée fixe — NE l'invente pas) : le sucre rapide (morceaux, jus, soda) COMMENCE à agir en ~15 min et son plein effet arrive vers ~30-45 min — c'est la « règle des 15 » : prendre du sucre, attendre 15 min puis recontrôler. Après un resucrage, laisse passer ~15 min avant d'en reprendre ou de recontrôler. Ne donne JAMAIS une autre durée (pas de « 20 min », « 26 min »…).`;
}

/** Effective duration of insulin action (minutes) for a named insulin, used for the linear IOB
 *  decay. Returns null for an unknown name so the caller can fall back to its default (4 h).
 *  Rapid/ultra-rapid analogs ≈ 4 h working time; Fiasp/Lyumjev act FASTER with a SHORTER tail than
 *  older analogs, but 4 h linear already tails high — keeping them at 4 h overestimates late IOB,
 *  which BLOCKS dose-stacking (the safe direction) rather than causing it. Regular human insulin
 *  lasts ~6 h, inhaled (Afrezza) ~3 h — those genuinely need a different duration. */
export function insulinActionMinutes(name?: string | null): number | null {
  const n = (name || "").toLowerCase();
  if (!n) return null;
  if (n.includes("afrezza") || n.includes("inhal")) return 180; // inhaled — very short
  if (
    n.includes("actrapid") || n.includes("humulin r") || n.includes("humulin s") ||
    n.includes("insuman") || n.includes("novolin r") || n.includes("insulatard") ||
    /\bregular\b/.test(n) || n.includes("humaine") || n.includes("humana")
  ) return 360; // regular/human short-acting — long tail (~6 h)
  if (
    n.includes("fiasp") || n.includes("lyumjev") || n.includes("novorapid") || n.includes("novolog") ||
    n.includes("humalog") || n.includes("apidra") || n.includes("admelog") || n.includes("trurapi") ||
    n.includes("kirsty") || n.includes("aspart") || n.includes("lispro") || n.includes("glulisine") ||
    n.includes("rapid") || n.includes("rápid") || n.includes("rapide")
  ) return 240; // rapid & ultra-rapid analogs — ~4 h
  return null; // unknown → caller's default
}

/** Active insulin-on-board from recent rapid doses (linear decay over each dose's action duration —
 *  insulin-type-aware via insulinActionMinutes, fallback `durationMin`). ts may be ISO or ms. */
export function activeIob(
  doses: { ts: string | number; units: number; kind?: string; name?: string | null; insulin_name?: string | null }[],
  nowMs: number,
  durationMin = 240,
): number {
  let iob = 0;
  for (const d of (doses || [])) {
    if (!d || d.kind === "basal") continue;
    const t = typeof d.ts === "number" ? d.ts : new Date(d.ts).getTime();
    const dur = insulinActionMinutes(d.name ?? d.insulin_name) ?? durationMin;
    const mins = (nowMs - t) / 60000;
    if (!Number.isFinite(mins) || mins < 0 || mins > dur) continue;
    iob += Number(d.units) * (1 - mins / dur);
  }
  return Math.max(0, iob);
}

/**
 * The final, code-owned action line combining a meal bolus (covering carbs) with the guard's
 * correction. Hypo dominates (sugar first, never bolus a low). When data is stale a meal bolus
 * is still allowed (it covers food) but no correction is added.
 */
export function combinedActionLine(
  guard: GuardResult,
  mealUnits: number,
  lang: string,
  profile: GuardProfile | null,
): string {
  const rapid = profile?.rapidInsulin || (lang === "es" ? "insulina rápida" : "insuline rapide");
  // Sugar / no-ratios / sugar-already-taken: a meal bolus must NOT be stacked on top, so return the
  // standalone action (never the "X u for the meal" line) — you don't bolus while low.
  if (guard.kind === "sugar" || guard.kind === "no_ratios" || guard.reason === "sugar_recent") return actionLine(guard, lang, profile);

  const meal = Math.max(0, mealUnits || 0);
  const corr = guard.kind === "correction" ? guard.insulinUnits : 0;
  const total = roundToHalf(meal + corr);

  if (total <= 0) {
    if (guard.kind === "wait") return actionLine(guard, lang, profile); // recheck, nothing to inject
    return lang === "es" ? "ninguna insulina ahora." : "aucune insuline pour l'instant.";
  }

  const stale = guard.reason === "stale_data";
  if (lang === "es") {
    let line = (meal > 0 && corr === 0)
      ? `${fmtUnits(total)} u de ${rapid} para la comida`
      : `${fmtUnits(total)} u de ${rapid} ahora`;
    if (meal > 0 && corr > 0) line += ` (${fmtUnits(meal)} u por la comida + ${fmtUnits(corr)} u de corrección)`;
    if (stale && meal > 0) line += `; recontrola la glucosa antes de cualquier corrección`;
    return line + ".";
  }
  let line = (meal > 0 && corr === 0)
    ? `${fmtUnits(total)} u de ${rapid} pour le repas`
    : `${fmtUnits(total)} u de ${rapid} maintenant`;
  if (meal > 0 && corr > 0) line += ` (${fmtUnits(meal)} u pour le repas + ${fmtUnits(corr)} u de correction)`;
  if (stale && meal > 0) line += ` ; recontrôle la glycémie avant toute correction`;
  return line + ".";
}

// ---- Proactive prediction (SUGGESTION only — the dose guard still owns every number) ---------

export interface Projection {
  slopePerMin: number;
  projectedMgdl: number | null;
  minutesAhead: number;
  current: number | null;
}

/** Linear projection of glucose `minutesAhead` from the recent (~20 min) slope. Suggestion-grade
 *  (a straight-line extrapolation, clamped to a sane 20..600 mg/dL range). */
export function projectGlucose(
  readings: { ts: number; value: number }[],
  _nowMs: number,
  minutesAhead = 30,
): Projection {
  const pts = (readings || [])
    .filter((r) => r && Number(r.value) > 0 && Number.isFinite(Number(r.ts)))
    .map((r) => ({ t: Number(r.ts), v: Number(r.value) }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return { slopePerMin: 0, projectedMgdl: null, minutesAhead, current: null };
  const last = pts[pts.length - 1];
  if (pts.length < 2) return { slopePerMin: 0, projectedMgdl: last.v, minutesAhead, current: last.v };
  const windowStart = last.t - 20 * 60 * 1000;
  const first = pts.find((p) => p.t >= windowStart) ?? pts[0];
  const mins = (last.t - first.t) / 60000;
  const slope = mins > 0 ? (last.v - first.v) / mins : 0;
  const projected = Math.max(20, Math.min(600, Math.round(last.v + slope * minutesAhead)));
  return { slopePerMin: slope, projectedMgdl: projected, minutesAhead, current: last.v };
}

export type PredictKind = "none" | "low_soon" | "high_soon" | "watch_fall" | "watch_rise";
export interface Predict {
  kind: PredictKind;
  minutes: number;
  projected: number | null;
  current: number | null;
}

// The proactive banner fires ONLY near the edges of range, never on harmless mid-range drift:
// "falling, keep sugar nearby" only when ALREADY below 90, "rising, watch" only when ALREADY above
// 160 (the user's rule — a 120→110 dip is in-range and must stay silent). Mirrored in the client's
// Prediction.kt (Predictor.FALL_WATCH_BELOW / RISE_WATCH_ABOVE).
export const FALL_WATCH_BELOW = 90;
export const RISE_WATCH_ABOVE = 160;

/** Proactive heads-up: heading toward a hypo (keep sugar nearby) or a hyper (get ready to correct
 *  once truly high). SUGGESTION ONLY — never a dose. Gated on the CURRENT value, not the projection. */
export function predictiveAdvice(
  readings: { ts: number; value: number }[],
  nowMs: number,
  horizonMin = 30,
): Predict {
  const proj = projectGlucose(readings, nowMs, horizonMin);
  const cur = proj.current;
  if (cur == null) return { kind: "none", minutes: 0, projected: null, current: null };
  const slope = proj.slopePerMin;
  const minsTo = (target: number) => (Math.abs(slope) < 1e-6 ? Infinity : (target - cur) / slope);

  // Falling AND already near the low end (70–89) → "keep sugar nearby + watch". Never pre-emptive
  // sugar (a real hypo <70 is the guard's job). Gated on the CURRENT value, not the projection, so a
  // mid-range dip (120→110) stays silent.
  if (slope < -0.3 && cur >= LOW_MGDL && cur < FALL_WATCH_BELOW) {
    return { kind: "watch_fall", minutes: horizonMin, projected: proj.projectedMgdl, current: cur };
  }
  // Rising AND already above 160 (161–180) → heads-up. Below 160 a rise is still well in range.
  if (slope > 0.3 && cur > RISE_WATCH_ABOVE && cur <= HIGH_MGDL) {
    const m = minsTo(HIGH_MGDL);
    if (m > 0 && m <= horizonMin) return { kind: "high_soon", minutes: Math.round(m), projected: proj.projectedMgdl, current: cur };
    return { kind: "watch_rise", minutes: horizonMin, projected: proj.projectedMgdl, current: cur };
  }
  return { kind: "none", minutes: 0, projected: proj.projectedMgdl, current: cur };
}

/** Localized one-liner for a proactive prediction (empty when kind === "none"). */
export function predictiveLine(p: Predict, lang: string): string {
  const es = lang === "es";
  switch (p.kind) {
    case "low_soon":
      return es
        ? `Vas hacia una hipo (~${p.projected} mg/dL en ~${p.minutes} min). Toma un poco de azúcar AHORA para adelantarte.`
        : `Tu vas vers une hypo (~${p.projected} mg/dL dans ~${p.minutes} min). Prends un peu de sucre MAINTENANT pour anticiper.`;
    case "watch_fall":
      return es
        ? `La glucosa baja; ten azúcar a mano y vigila. No hace falta tomarlo mientras no estés en hipo.`
        : `La glycémie descend ; garde du sucre à portée et surveille. Pas besoin d'en prendre tant que tu n'es pas en hypo.`;
    case "high_soon":
      return es
        ? `Vas hacia una hiper (~${p.projected} mg/dL en ~${p.minutes} min). Prepárate para corregir cuando pases de 180.`
        : `Tu montes vers une hyper (~${p.projected} mg/dL dans ~${p.minutes} min). Prépare-toi à corriger une fois au-dessus de 180.`;
    case "watch_rise":
      return es
        ? `La glucosa sube; vigila la subida.`
        : `La glycémie monte ; garde un œil sur la montée.`;
    default:
      return "";
  }
}

// ---- Carb SPEED (glycemic index axis) -----------------------------------------------------------
// The user's point: "a fast sugar acts quicker than pasta" — the timing must be factored EVERYWHERE.
// isFattyMeal already covers ONE axis (fat → delayed rise). These add the missing FAST↔SLOW axis so
// the analysis/voice/scan explain the right curve and the right bolus TIMING. Description-based (like
// isFattyMeal): no DB schema/migration, works on every meal already logged. Speed changes WHEN to
// dose and what curve to expect — NOT the units (the dose stays carbs ÷ ratio, owned by the guard).

// Fast carbs (HIGH glycemic index): simple sugars, sugary drinks, refined starch → spike FAST
// (peak ~15-45 min). NOTE: slow-carb words ("complet"/"intégral") are checked FIRST in mealCarbSpeed,
// so "pain complet" never falls through to "pain blanc".
const FAST_CARB_WORDS = [
  "sucre", "azúcar", "azucar", "sugar", "bonbon", "caramelo", "caramel", "sucette", "dragée", "dragee",
  "miel", "honey", "confiture", "mermelada", "sirop", "sirope", "syrup",
  "jus de", "jus d'", "zumo", "juice", "soda", "coca", "cola", "fanta", "sprite", "pepsi",
  "limonade", "limonada", "refresco", "ice tea", "thé glacé", "smoothie",
  "pain blanc", "pan blanco", "baguette", "biscotte",
  "corn flakes", "cornflakes", "galette de riz", "riz soufflé", "rice cake",
  "purée", "puré", "datte", "dátil", "datil", "pastèque", "sandía", "sandia", "watermelon",
  "glace", "helado", "sorbet", "sorbete", "compote", "compota",
];
// Slow carbs (LOW glycemic index): pasta, legumes, whole grains → rise SLOWLY and LATE (peak 2-3 h
// out). The exact case the user named ("pasta acts slower than sugar").
const SLOW_CARB_WORDS = [
  "pâtes", "pates", "pasta", "spaghetti", "espagueti", "macaroni", "macarrones", "lasagne", "lasaña", "lasagna",
  "tagliatelle", "penne", "nouilles", "fideos", "ravioli", "gnocchi", "ñoqui",
  "lentille", "lenteja", "lentil", "pois chiche", "garbanzo", "chickpea",
  "haricot", "judía", "judia", "frijol", "alubia", "fève", "haba", "légumineuse", "legumbre",
  "quinoa", "avoine", "avena", "oatmeal", "porridge", "flocons d", "muesli",
  "complet", "intégral", "integral", "complète", "completo", "whole grain", "wholemeal", "wholewheat",
  "riz complet", "riz brun", "arroz integral", "brown rice",
  "patate douce", "boniato", "batata", "sweet potato",
  "boulgour", "bulgur", "épeautre", "spelt", "orge", "barley", "cebada", "sarrasin", "buckwheat",
];

export type CarbSpeed = "fast" | "slow" | "fatty" | "normal";

/** Classify a meal's CARB SPEED from its description. FAT dominates (it slows everything → delayed
 *  rise), then slow-carb signals, then fast; "normal" when nothing matches. Shared by coach/ask/scan
 *  so the timing message is identical everywhere. Mirrors isFattyMeal (no schema, retroactive). */
export function mealCarbSpeed(desc?: string | null): CarbSpeed {
  const d = (desc || "").toLowerCase();
  if (!d) return "normal";
  if (isFattyMeal(d)) return "fatty"; // fat slows gastric emptying — dominant effect
  if (SLOW_CARB_WORDS.some((k) => d.includes(k))) return "slow"; // before fast: "pain complet" ≠ "pain blanc"
  if (FAST_CARB_WORDS.some((k) => d.includes(k))) return "fast";
  return "normal";
}

/** Speed-aware TIMING advice (no dose numbers, TTS-clean). "fatty" reuses fattyMealAdvice; "normal"
 *  is empty. Appended at logging/analysis time so the curve EXPECTATION and the bolus TIMING match
 *  the food: a fast sugar wants a pre-bolus and its quick spike is normal (don't chase it); slow and
 *  fatty meals rise late, so recheck later. Callers must SKIP it during a hypo rescue (guard "sugar")
 *  — telling someone treating a low to "pre-bolus next time" is contradictory. */
export function carbSpeedAdvice(speed: CarbSpeed, lang: string): string {
  const es = lang === "es";
  switch (speed) {
    case "fast":
      return es
        ? "Azúcar rápido (zumo, dulces, pan blanco…): la glucosa sube MUY RÁPIDO (pico ~15-45 min). Una subida rápida tras esta comida es NORMAL, no la sobre-corrijas enseguida; la próxima vez, si no hay hipo, poner la insulina un poco ANTES de comer (pre-bolo ~15 min) frena el pico."
        : "Sucre rapide (jus, bonbons, pain blanc…) : la glycémie monte TRÈS VITE (pic ~15-45 min). Une montée rapide après ce repas est NORMALE, ne la sur-corrige pas tout de suite ; la prochaine fois, s'il n'y a pas d'hypo, faire l'insuline un peu AVANT de manger (pré-bolus ~15 min) limite le pic.";
    case "slow":
      return es
        ? "Carbohidratos lentos (pasta, legumbres, integral…): la glucosa sube DESPACIO y TARDE; el pico puede llegar 2-3 h después. No esperes una subida inmediata — vigila y recontrola más tarde."
        : "Glucides lents (pâtes, légumineuses, complet…) : la glycémie monte LENTEMENT et TARD ; le pic peut arriver 2-3 h après. N'attends pas une montée immédiate — surveille et recontrôle plus tard.";
    case "fatty":
      return fattyMealAdvice(lang);
    default:
      return "";
  }
}

// Starchy staples are NOT sweet but are HIGH-CARB (starch → glucose), so they raise BG like sugar.
// The user's confusion: "potatoes don't seem sugary, why 8 sucres?". This note clears it up.
const STARCHY_WORDS = [
  "pomme de terre", "pommes de terre", "patate", "patata", "potato", "papa", "papas", "frite", "fries",
  "purée", "pure", "puré", "pain", "bread", "pan ", "baguette", "biscotte", "riz", "rice", "arroz",
  "pâtes", "pates", "pasta", "semoule", "couscous", "polenta", "maïs", "maiz", "corn", "blé", "trigo",
  "tortilla", "céréale", "cereal", "gnocchi", "ñoqui", "boniato", "banane plantain", "plátano",
];
export function isStarchy(desc?: string | null): boolean {
  const d = (desc || "").toLowerCase();
  return STARCHY_WORDS.some((w) => d.includes(w));
}
/** "Féculents = pas sucrés mais riches en glucides" — appended for a starchy food so the carb count
 *  (and its sugar-cube equivalent) isn't mistaken for the food being sweet. */
export function starchyCarbNote(desc: string | null | undefined, lang: string): string {
  if (!isStarchy(desc)) return "";
  return lang === "es"
    ? "Bueno saber: los féculentos (patata, pan, arroz, pasta) NO son dulces pero sí ricos en CARBOHIDRATOS — suben la glucosa igual que el azúcar, por eso se cubren con insulina (los « terrones » son el equivalente en carbohidratos, no en dulzor)."
    : "Bon à savoir : les féculents (pommes de terre, pain, riz, pâtes) ne sont PAS sucrés mais riches en GLUCIDES — ils font monter la glycémie autant que le sucre, d'où l'insuline (les « sucres » indiqués sont l'équivalent en glucides, pas en goût sucré).";
}
