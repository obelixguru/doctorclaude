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
// A rescue is SMALL and FAST. Above this many carbs it is a MEAL, not a treatment for a low: 80 g of
// rice eaten 10 min before a 65 mg/dL must never read as "sugar already taken" and hold the rescue
// (the real bug: the app answered "you already took sugar, wait 15 min" — rice lifts nothing in 15 min).
export const RESCUE_MAX_CARBS = 25;
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

// NO DOSE IS EVER CAPPED OR REFUSED. Explicit product decision by the owner (an informed T1D
// parent): a carb load has no ceiling, so neither can its bolus — 45 sugar cubes need what they need,
// and an engine that quietly clips the answer is worse than useless because the user cannot tell a
// clipped number from a computed one. The arithmetic is always carried out in full and always shown.
//
// What remains is a purely INFORMATIONAL threshold: above it the action line adds a line inviting a
// check of the ratios, WITHOUT changing the number by a single unit. 0.3 u/kg in one injection is
// already well beyond any ordinary bolus (a whole day is typically 0.5-0.7 u/kg), so an ordinary
// large meal never trips it. Delete [unusualDoseNote] and its two call sites to remove even that.
export const UNUSUAL_UNITS_PER_KG = 0.3;
/** Weight unknown: an adult-sized reference for the same note. */
export const UNUSUAL_UNITS_NO_WEIGHT = 20;

/** Above this, a dose is worth a second look — never a smaller number, never a refusal. */
export function unusualDoseThreshold(profile: GuardProfile | null): number {
  const w = profile?.weightKg && profile.weightKg > 0 ? profile.weightKg : null;
  return w ? Math.max(2, w * UNUSUAL_UNITS_PER_KG) : UNUSUAL_UNITS_NO_WEIGHT;
}

/** Informational only. Returns "" for every ordinary dose. */
export function unusualDoseNote(units: number, profile: GuardProfile | null, lang: string): string {
  if (!(units > 0) || units <= unusualDoseThreshold(profile)) return "";
  return lang === "es"
    ? ` (dosis inusualmente alta — vale la pena comprobar tu ratio y tu factor de corrección en el perfil; la cifra no ha sido modificada)`
    : ` (dose inhabituellement élevée — ça vaut le coup de vérifier ton ratio et ton facteur de correction dans le profil ; le chiffre n'a pas été modifié)`;
}

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
  // Whatever the arithmetic says, in full. See [unusualDoseNote] for the informational-only note.
  return { kind: "correction", insulinUnits: units, maxInsulinUnits: units, sugarGrams: 0, sugarCubes: 0, reason: "high_correction" };
}

// The trend window that decides the ACTION. Deliberately short: this answers "which way is it going
// RIGHT NOW", and a long window would smooth away a fall that started ten minutes ago. The DAY's
// shape is a different question, answered elsewhere from the stored history.
export const TREND_WINDOW_MIN = 20;
// When the window is too sparse to fit anything (the case for a followed patient whose series is
// stitched from 15-min cloud buckets, or after a sensor gap), look further back rather than giving up
// — "unknown" BLOCKS the correction, so reaching for it early costs the user a real dose.
export const TREND_FALLBACK_MIN = 45;
// Minimum time base before any direction is claimed. Three minutes of readings after a sensor
// blackout describe nothing, and pretending otherwise is how a fit gets built on noise. "unknown"
// blocks the correction, which is the honest answer here — and the coach now merges 24 h of stored
// readings before asking, so a window this thin is rare in practice rather than routine.
export const TREND_MIN_SPAN_MIN = 10;
// Widening across a hole is only allowed while the hole is small. Beyond this, the pre-gap point is
// not context, it is a different situation: fitting 150 mg/dL from forty minutes ago to a burst of
// 230s produced "rising_fast" on a glucose that was actually coming down.
export const TREND_MAX_GAP_MIN = 20;
// A fall is judged on the MOST ALARMING evidence available, a rise on the whole window. The costs are
// not symmetric: missing a fall lets insulin go in on top of one, while a cautious "falling" only
// withholds a correction for a few minutes. So the recent segment gets a veto on the downside only.
export const TREND_RECENT_MIN = 10;

/** Median-of-3 despike. Rejects a single outlying sample without moving a genuine ramp — a real rise
 *  keeps every point above its predecessor, so the median passes it through unchanged. */
function despike(vals: number[]): number[] {
  if (vals.length < 3) return vals.slice();
  const out = vals.slice();
  for (let i = 1; i < vals.length - 1; i++) {
    const a = vals[i - 1], b = vals[i], c = vals[i + 1];
    out[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  return out;
}

/** Least-squares slope in mg/dL per minute. Uses EVERY point in the window — the previous version
 *  read only the first and the last, so twenty readings gave no more confidence than two. */
function slopePerMin(pts: { t: number; v: number }[]): number {
  const n = pts.length;
  if (n < 2) return 0;
  const t0 = pts[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 60000;
    sx += x; sy += p.v; sxx += x * x; sxy += x * p.v;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

/**
 * The one robust "which way is it going" computation, shared by the trend and the projection so the
 * two can never disagree. Despikes, then fits a line through EVERY point in the window.
 *
 * Returns slope = null when the series cannot answer the question — fewer than two usable points, or
 * a newest reading left standing alone by a sensor gap. Callers must treat that as "unknown", not as
 * "flat": a hole is not a plateau.
 */
export function robustSlope(
  readings: { ts: number; value: number }[],
): { slope: number | null; spanMin: number; current: number | null } {
  const pts = (readings || [])
    .filter((r) => r && Number(r.value) > 0 && Number.isFinite(Number(r.ts)))
    .map((r) => ({ t: Number(r.ts), v: Number(r.value) }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return { slope: null, spanMin: 0, current: null };
  const last = pts[pts.length - 1];
  if (pts.length < 2) return { slope: null, spanMin: 0, current: last.v };

  // Points close enough to the newest reading to describe where it is heading.
  let win = pts.filter((p) => p.t >= last.t - TREND_WINDOW_MIN * 60000);
  // Widen ONLY when the primary window cannot carry a fit at all. Widening whenever it merely looked
  // thin was a safety bug: with a followed patient's 15-minute cloud buckets the primary window holds
  // two points, and pulling in 45 minutes averaged a genuine 24 mg/dL drop in the last bucket down to
  // nothing — the guard then offered a correction the old code had blocked.
  if (win.length < 2 || (last.t - win[0].t) / 60000 < TREND_MIN_SPAN_MIN) {
    const wider = pts.filter((p) => p.t >= last.t - TREND_FALLBACK_MIN * 60000);
    if (wider.length > win.length) win = wider;
  }
  const spanMin = win.length >= 2 ? (last.t - win[0].t) / 60000 : 0;
  if (win.length < 2 || spanMin < TREND_MIN_SPAN_MIN) return { slope: null, spanMin, current: last.v };

  // A HOLE IS NOT A PLATEAU. Anything can have happened inside a long gap — a rescue, an unlogged
  // dose, a rebound — so a line drawn across it is invention, not measurement.
  for (let i = 1; i < win.length; i++) {
    if ((win[i].t - win[i - 1].t) / 60000 > TREND_MAX_GAP_MIN) return { slope: null, spanMin, current: last.v };
  }

  const fit = (seg: { t: number; v: number }[]) => {
    if (seg.length < 2) return null;
    const sm = despike(seg.map((p) => p.v));
    return slopePerMin(seg.map((p, i) => ({ t: p.t, v: sm[i] })));
  };
  const whole = fit(win) ?? 0;

  // The recent segment gets a veto, but ONLY downwards. A crash that started five minutes ago is
  // averaged away by a twenty-minute fit — the regression is right about the window and wrong about
  // the person. Taking the steeper of the two whenever the recent one is falling keeps the safe
  // direction reachable without letting a short noisy segment manufacture a rise.
  const recent = win.filter((p) => p.t >= last.t - TREND_RECENT_MIN * 60000);
  const recentSlope = recent.length >= 2 && (last.t - recent[0].t) / 60000 >= 3 ? fit(recent) : null;
  const slope = recentSlope != null && recentSlope < whole ? recentSlope : whole;

  return { slope, spanMin, current: last.v };
}

/** Recent trend from readings ({ ts: ms, value: mg/dL }). Safety-biased: an unreadable series is
 *  "unknown", which the guard treats as "no insulin until you recheck". */
export function trendFromReadings(readings: { ts: number; value: number }[], _nowMs: number): Trend {
  const { slope } = robustSlope(readings);
  if (slope === null) return "unknown";
  if (slope >= 2) return "rising_fast";
  if (slope >= 0.5) return "rising";
  if (slope <= -2) return "falling_fast";
  if (slope <= -0.5) return "falling";
  return "stable";
}

// Words that mean "sugar taken to fix a low", not "food". Narrow on purpose (mirrors the same list in
// mechabetics-diet): a rescue is glucose/sugar cubes/juice, not a plate of something.
const RESCUE_WORDS = [
  "sucre", "azúcar", "azucar", "sugar", "morceau", "terrón", "terron",
  "glucose", "glucosa", "dextro", "resucr", "rescate",
];

/** Is this logged item a HYPO RESCUE (small fast sugar taken to treat a low) rather than a meal?
 *  Only a rescue may hold a re-treatment (computeGuard's "sugar_recent" gate), so this stays NARROW:
 *   - more than RESCUE_MAX_CARBS carbs => a meal, never a rescue (whatever it is made of);
 *   - the rescue words always count (typically logged with no gram figure: "3 sucres");
 *   - any other FAST carb counts only when its (small) carb figure is known.
 *  A blank/unknown food with no carb figure is NOT a rescue: mislabelling a meal as a rescue delays
 *  the treatment of a real low, which is the more dangerous mistake. A severe low (< SEVERE_LOW_MGDL)
 *  bypasses the hold entirely anyway. */
export function isHypoRescue(desc?: string | null, carbsG?: number | null): boolean {
  const c = Number(carbsG);
  const known = Number.isFinite(c) && c > 0;
  if (known && c > RESCUE_MAX_CARBS) return false;
  const d = (desc || "").toLowerCase();
  if (!d) return false;
  if (RESCUE_WORDS.some((w) => d.includes(w))) return true;
  return known && mealCarbSpeed(d) === "fast";
}

/**
 * Is this meal ON BOARD by now? A meal announced for LATER is not — it hasn't been eaten. But one
 * whose stated time has PASSED is, whatever its stored `planned` flag still says.
 *
 * That flag is written once, when the meal is logged, and nothing ever sets it back to false. Every
 * carb calculation used to test `planned !== true`, so a meal announced by voice ("je mange dans 10
 * minutes") stayed invisible to carbs-on-board, to the uncovered-meal check and to the chart FOR
 * EVER — the announcement made the food disappear instead of anticipating it. Deriving it from the
 * timestamp needs no migration and fixes every row already stored.
 */
export function isEatenBy(m: MealRow, nowMs: number): boolean {
  if (!m) return false;
  const t = typeof m.ts === "number" ? m.ts : new Date(m.ts).getTime();
  if (!Number.isFinite(t)) return m.planned !== true; // no usable time: fall back to the flag
  return t <= nowMs;
}

/** Minutes since the last EATEN hypo RESCUE, or null if there are none. A meal announced for later
 *  doesn't count — it isn't on board — and neither does an ordinary meal (see isHypoRescue).
 *  `ts` may be ISO or epoch ms; rows may carry `carbs_g` (server) or `carbsG` (client).
 *  computeGuard only acts on this inside RESCUE_WINDOW_MIN, so a large value is harmless. */
export function minutesSinceLastRescue(meals: any[], nowMs: number): number | null {
  let latest = 0;
  for (const m of meals || []) {
    if (!m || !isEatenBy(m, nowMs)) continue;
    if (!isHypoRescue(m.description, m.carbs_g ?? m.carbsG)) continue;
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
      case "correction": return `${fmtUnits(g.insulinUnits)} u de ${rapid} ahora.${unusualDoseNote(g.insulinUnits, profile, lang)}`;
      case "none": case "wait": return noDoseLine(g, lang);
      case "no_ratios": return `completa los ratios del médico en el perfil para una dosis exacta.`;
    }
  }
  switch (g.kind) {
    case "sugar": return `${g.sugarGrams} g de sucre rapide (${g.sugarCubes} morceau(x)) tout de suite, recontrôle dans 15 min.`;
    case "correction": return `${fmtUnits(g.insulinUnits)} u de ${rapid} maintenant.${unusualDoseNote(g.insulinUnits, profile, lang)}`;
    case "none": case "wait": return noDoseLine(g, lang);
    case "no_ratios": return `renseigne les ratios du médecin dans le profil pour une dose chiffrée.`;
  }
  return "";
}

/**
 * WHY nothing is to be injected — said out loud, in the action line itself.
 *
 * The reasons already existed and were already localized ([situationHint]), but they only ever went
 * into the model's PROMPT, so whether one reached the screen depended on the model's phrasing. What
 * the parent actually saw was six different states collapsed into two sentences:
 *
 *   in_range / falling / covered_by_iob   -> "aucune insuline pour l'instant."
 *   no_reading / stale_data / trend_unknown -> "... ; recontrôle ta glycémie dans 15 min."
 *
 * Those groups are not interchangeable. "You are in target" and "I cannot see your glucose" are
 * opposite instructions about what to do in the next ten minutes, and the reported confusion was
 * exactly this: a child sitting at 233 mg/dL with a sensor gap read as "nothing to do" when the truth
 * was "I don't know". Code owns the reason now, the same way it owns the number.
 *
 * Unknown reasons fall back to the previous wording, so a new reason code can never print an empty
 * action line.
 */
function noDoseLine(g: GuardResult, lang: string): string {
  const es = lang === "es";
  switch (g.reason) {
    case "in_range":
      return es
        ? `ninguna insulina ahora: estás en el objetivo (70-180).`
        : `aucune insuline pour l'instant : tu es dans la cible (70-180).`;
    case "falling":
      return es
        ? `ninguna insulina ahora: la glucosa ya está bajando sola.`
        : `aucune insuline pour l'instant : la glycémie redescend déjà toute seule.`;
    case "covered_by_iob":
      return es
        ? `ninguna insulina ahora: la insulina que sigue activa ya cubre esta glucosa.`
        : `aucune insuline pour l'instant : l'insuline encore active couvre déjà cette glycémie.`;
    case "no_reading":
      return es
        ? `ninguna insulina: no hay medición reciente — recontrola la glucosa antes de cualquier decisión.`
        : `aucune insuline : pas de mesure récente — recontrôle ta glycémie avant toute décision.`;
    case "stale_data":
      return es
        ? `ninguna insulina: los datos tienen más de ${STALE_MIN} min — recontrola la glucosa antes de cualquier decisión.`
        : `aucune insuline : les données ont plus de ${STALE_MIN} min — recontrôle ta glycémie avant toute décision.`;
    case "trend_unknown":
      return es
        ? `ninguna insulina ahora: no hay bastantes medidas recientes para saber hacia dónde va (hueco del sensor) — recontrola en 15 min.`
        : `aucune insuline pour l'instant : pas assez de mesures récentes pour savoir dans quel sens ça va (trou de capteur) — recontrôle dans 15 min.`;
    default:
      return g.kind === "wait"
        ? (es ? `ninguna insulina ahora; recontrola la glucosa en 15 min.` : `aucune insuline pour l'instant ; recontrôle ta glycémie dans 15 min.`)
        : (es ? `ninguna insulina ahora.` : `aucune insuline pour l'instant.`);
  }
}

/** Safety net: strip any insulin-dose mention the model may have slipped in (e.g. "2 u",
 *  "1,5 unités", "3 unidades"). Applied only when the guard forbids insulin entirely. */
export function stripInsulinNumbers(text: string): string {
  // Collapse only HORIZONTAL whitespace ([ \t]) — NOT newlines — so paragraph breaks (\n\n) added
  // for readability survive this strip (it runs on every in-range/blocked analysis).
  return (text || "")
    .replace(/\d+(?:[.,]\d+)?\s*(?:ui\b|u\b|unit[ée]s?\b|unidad(?:es)?\b)/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}

/** True when the code has decided that nothing is to be injected or eaten RIGHT NOW. Read off the
 *  amounts rather than the reason codes so a new reason can't silently slip past it. */
export function noDoseDue(g: GuardResult): boolean {
  return !(g.insulinUnits > 0) && !(g.sugarGrams > 0);
}

/**
 * Backstop against the analysis contradicting its own action line.
 *
 * The reported case: "bonne journée mais une chute rapide à corriger" sitting directly above
 * "Action : dans la cible (70-180), rien à corriger". Both were right about different things — the
 * narrative was commenting on a drop that happened during the DAY, the action is about NOW — but read
 * together they simply contradict each other, and the user (correctly) trusts the action, which is
 * code-computed, over the model's prose.
 *
 * The prompt now states the decided action and reserves "corriger" for the system, but a model will
 * still slip, so this makes it deterministic: when the guard says nothing is due, the narrative may
 * no longer say anything is "to correct". Only the *pending-action* reading is removed — "à corriger"
 * becomes "à surveiller", so the observation itself survives, in the register the day summary should
 * have used in the first place. Same shape as [stripInsulinNumbers]: tell the model, then enforce it.
 *
 * Run on the narrative ONLY, and BEFORE the code-owned action line is appended — otherwise it would
 * rewrite the action's own "rien à corriger".
 */
export function softenCorrectionTalk(text: string, lang: string): string {
  if (!text) return text;
  // No \b before "à": JS word boundaries are ASCII-only, so \bà never matches after a space. The ES
  // side keeps \b on purpose — it is what stops "azúcar para corregir una hipo" being rewritten.
  return lang === "es"
    ? text.replace(/\ba\s+corregir\b/gi, "a vigilar")
    : text.replace(/à\s+corriger\b/gi, "à surveiller");
}

/** The largest dose figure written in a free-text paragraph that is ABOVE what the guard allows, or
 *  null when everything the model wrote is within the ceiling. Matches the same shapes as
 *  [stripInsulinNumbers]: "2 u", "1,5 unités", "3 unidades". */
export function overCeilingUnits(text: string, maxUnits: number): number | null {
  const re = /(\d+(?:[.,]\d+)?)\s*(?:ui\b|u\b|unit[ée]s?\b|unidad(?:es)?\b)/gi;
  let m: RegExpExecArray | null;
  let worst: number | null = null;
  while ((m = re.exec(text || "")) !== null) {
    const n = Number(String(m[1]).replace(",", "."));
    if (Number.isFinite(n) && n > (maxUnits || 0) + 1e-9) worst = worst === null ? n : Math.max(worst, n);
  }
  return worst;
}

/**
 * THE OVERRIDE THE FILE HEADER PROMISED, ACTUALLY APPLIED TO THE PROSE.
 *
 * The strip only ever ran when insulin was forbidden OUTRIGHT (maxInsulinUnits === 0). The moment the
 * guard allowed any correction, the model's paragraph went to the screen unchecked — so "une bonne
 * correction de 4 unités s'impose" could sit directly above "Action : 1,5 u de Fiasp maintenant",
 * with nothing in the code preferring the right one. [clampInsulin] existed for exactly this and had
 * no production caller at all.
 *
 * When the narrative names a dose bigger than the guard's, every dose figure comes out of the
 * narrative — the authoritative action line still carries the real number, so the user loses nothing
 * but the contradiction. Under the ceiling, the text is returned untouched.
 */
export function enforceInsulinCeiling(text: string, g: GuardResult): string {
  if (!text) return text;
  return overCeilingUnits(text, g.maxInsulinUnits) === null ? text : stripInsulinNumbers(text);
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

/** How much lowering the rapid insulin already on board still has to deliver, in mg/dL. Null without
 *  a correction factor to convert units into mg/dL. */
export function pendingDropMgdl(iobUnits: number, profile: GuardProfile | null): number | null {
  const isf = profile?.correctionFactor && profile.correctionFactor > 0 ? profile.correctionFactor : null;
  return isf ? Math.max(0, iobUnits || 0) * isf : null;
}

/**
 * Would a meal bolus land on top of a fall that is already happening?
 *
 * Carb counting alone says "50 g needs 3 u" and is right about the carbs — but insulin already on
 * board keeps working regardless, and if it is going to take the glucose under 70 by itself then
 * three more units is not a meal bolus, it is a hypo. The same test planMealDose applies internally
 * (floor = glucose − iob × ISF), lifted out so the eaten-meal path gets it too: that path went
 * straight to combinedActionLine, which sums units and has never seen a glucose or an IOB.
 */
export function mealBolusHeldByIob(
  glucoseMgdl: number | null,
  iobUnits: number,
  profile: GuardProfile | null,
): boolean {
  const drop = pendingDropMgdl(iobUnits, profile);
  if (drop == null || glucoseMgdl == null || !Number.isFinite(glucoseMgdl) || glucoseMgdl <= 0) return false;
  return glucoseMgdl - drop < LOW_MGDL;
}

/** Why no meal bolus is due right now, in the user's language. */
export function mealBolusHeldLine(
  glucoseMgdl: number,
  iobUnits: number,
  profile: GuardProfile | null,
  lang: string,
): string {
  const drop = Math.round(pendingDropMgdl(iobUnits, profile) ?? 0);
  return lang === "es"
    ? `ninguna insulina para la comida ahora: la insulina que sigue activa aún tiene ~${drop} mg/dL de bajada por delante y te llevaría por debajo de 70. Vigila, ten azúcar a mano, y recontrola en 15 min.`
    : `aucune insuline pour le repas maintenant : l'insuline encore active a ~${drop} mg/dL de baisse à délivrer et t'emmènerait sous 70. Surveille, garde du sucre à portée, et recontrôle dans 15 min.`;
}

/** Meal bolus = carbs / carb-ratio, rounded to 0.5 u. Carb counting doesn't need fresh glucose.
 *  UNBOUNDED on purpose: 45 sugar cubes are 45 sugar cubes, and clipping the answer would hand back
 *  a number the user cannot distinguish from a computed one. See [unusualDoseNote]. */
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

/** Localized "≈ N sucres" phrase for a carb amount (empty when no carbs). `voice` spells out the
 *  symbol and picks a real plural: read aloud, "≈ 8 sucre(s)" comes out as noise. */
export function carbsCubesPhrase(carbsG: number | null | undefined, lang: string, voice = false): string {
  const n = carbsCubes(carbsG);
  if (!n) return "";
  if (!voice) return lang === "es" ? `≈ ${n} terrón(es) de azúcar` : `≈ ${n} sucre(s)`;
  return lang === "es"
    ? (n === 1 ? "un terrón de azúcar" : `unos ${n} terrones de azúcar`)
    : (n === 1 ? "environ 1 sucre" : `environ ${n} sucres`);
}

/** Shared carb-COUNTING guidance for every estimator (meals / ask / scan) so they all count the same
 *  way. Fixes the user's report that estimates were off: protein/fat foods (sausages, meat, cheese,
 *  egg) were being given carbs, and an explicit quantity ("1/5 baguette", "2 saucisses") was ignored
 *  in favour of a vague "standard portion". Carbs = DIGESTIBLE carbohydrate only. */
export function carbEstimationRules(lang: string): string {
  return lang === "es"
    ? `LA ETIQUETA MANDA, SIEMPRE. Si el usuario da una cifra de carbohidratos o de azúcares, o si se lee en el envase, ESA es la respuesta: úsala tal cual, ajustada a la cantidad realmente consumida (por 100 g o 100 ml × la cantidad). Las REFERENCIAS de abajo son solo para cuando no hay ninguna cifra — no sirven NUNCA para corregir una etiqueta. BEBIDAS ENVASADAS: el azúcar de una misma marca varía hasta el DOBLE según el país y según si es la fórmula clásica o reformulada — un 7UP español lleva ≈4,8 g/100 ml (≈16 g por lata de 33 cl), una cola clásica ≈10,6 g/100 ml (≈35 g), y las «zero/light/sin azúcar» llevan 0. Sin etiqueta ni país, quédate en la parte BAJA del rango y di en tu respuesta que hay que comprobarlo en la lata: sobrestimar los carbohidratos hace inyectar de más, y eso termina en hipoglucemia. CONTEO DE CARBOHIDRATOS (con cuidado): cuenta SOLO los carbohidratos digeribles, para EXACTAMENTE el alimento y la CANTIDAD descritos (respeta «1/5 de baguette» = un quinto de una baguette, «2 salchichas» = dos). Suma cada componente del plato. La PROTEÍNA y la GRASA casi no tienen carbohidratos: carne, salchicha, embutido, jamón, pollo, pescado, huevo, queso, mantequilla, aceite, nata → ≈ 0 g (cuenta solo el acompañamiento con carbohidratos: pan, patata, arroz, pasta, fruta, azúcar, salsa dulce). Un alimento SIN carbohidratos (salchicha sola, filete, jamón, huevo, queso) → "carbsG" cercano a 0 (0-2 g): NUNCA inventes carbohidratos para «rellenar» — 2 salchichas ≈ 0-2 g, NO 15. Las verduras (tomate, ensalada, calabacín…) son muy bajas (~2-3 g por ración). REFERENCIAS (porciones comunes, calíbrate con ellas): 1 terrón de azúcar = 4 g; 1 pain au chocolat/napolitana ≈ 30 g; 1 cruasán ≈ 25 g; 1 baguette entera ≈ 130 g (1/5 ≈ 26 g); 1 rebanada de pan de molde ≈ 15 g; 1 manzana ≈ 15-20 g; 1 plátano ≈ 25 g; 1 yogur natural ≈ 5 g (azucarado ≈ 15-20 g); 1 lata de refresco 33 cl = 33 cl × los g/100 ml de SU etiqueta (16 g si es 4,8 g/100 ml, 35 g si es 10,6 — nunca un valor único); 1 vaso de zumo 20 cl ≈ 20 g (zumo puro; una bebida «con zumo» es otra cosa: mira la etiqueta); 1 ración de pasta/arroz cocidos (200 g) ≈ 50 g; 1 menú hamburguesa+patatas+refresco ≈ 90-110 g; 1 salchicha ≈ 0-2 g. Sé realista, ni sistemáticamente alto ni bajo.`
    : `L'ÉTIQUETTE FAIT FOI, TOUJOURS. Si l'utilisateur donne un chiffre de glucides ou de sucres, ou s'il est lisible sur l'emballage, c'EST la réponse : reprends-le tel quel, ramené à la quantité réellement consommée (pour 100 g ou 100 ml × la quantité). Les REPÈRES ci-dessous ne servent QUE faute de chiffre — jamais à corriger une étiquette. BOISSONS EN CANETTE OU BOUTEILLE : le sucre d'une même marque varie du SIMPLE AU DOUBLE selon le pays et selon que c'est la formule classique ou reformulée — un 7UP espagnol titre ≈4,8 g/100 ml (≈16 g la canette de 33 cl), un cola classique ≈10,6 g/100 ml (≈35 g), et les « zero/light/sans sucres » sont à 0. Sans étiquette ni pays, reste dans le BAS de la fourchette et dis dans ta réponse qu'il faut vérifier sur la canette : surestimer les glucides fait injecter trop, et ça finit en hypo. COMPTAGE DES GLUCIDES (soigneusement) : compte UNIQUEMENT les glucides digestibles, pour EXACTEMENT l'aliment et la QUANTITÉ décrits (respecte « 1/5 de baguette » = un cinquième d'une baguette, « 2 saucisses » = deux). Additionne chaque composant du plat. La PROTÉINE et le GRAS n'ont quasi pas de glucides : viande, saucisse, charcuterie, jambon, poulet, poisson, œuf, fromage, beurre, huile, crème → ≈ 0 g (ne compte que l'accompagnement glucidique : pain, pomme de terre, riz, pâtes, fruit, sucre, sauce sucrée). Un aliment SANS glucides (saucisse seule, steak, jambon, œuf, fromage) → "carbsG" proche de 0 (0-2 g) : n'invente JAMAIS des glucides pour « remplir » — 2 saucisses ≈ 0-2 g, PAS 15. Les légumes (tomate, salade, courgette…) sont très bas (~2-3 g par portion). REPÈRES (portions courantes, sers-t'en pour te calibrer) : 1 morceau de sucre = 4 g ; 1 pain au chocolat ≈ 30 g ; 1 croissant ≈ 25 g ; 1 baguette entière ≈ 130 g (1/5 ≈ 26 g) ; 1 tranche de pain de mie ≈ 15 g ; 1 pomme ≈ 15-20 g ; 1 banane ≈ 25 g ; 1 yaourt nature ≈ 5 g (sucré ≈ 15-20 g) ; 1 canette de soda 33 cl = 33 cl × les g/100 ml de SON étiquette (16 g si 4,8 g/100 ml, 35 g si 10,6 — jamais une valeur unique) ; 1 verre de jus 20 cl ≈ 20 g (jus pur ; une boisson « à base de jus » est autre chose : regarde l'étiquette) ; 1 portion de pâtes/riz cuits (200 g) ≈ 50 g ; 1 menu burger+frites+soda ≈ 90-110 g ; 1 saucisse ≈ 0-2 g. Sois réaliste, ni systématiquement haut ni bas.`;
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

/** Code-owned phrase for how much insulin is still working — three HONEST tiers. "presque épuisée"
 *  used to cover BOTH a real tail (0 < IOB < 0.1 u) and a long-finished dose (IOB = 0), so the
 *  report said "almost done" while the Insuline tab showed 0. Zero now says plainly nothing acts. */
export function iobStatusPhrase(iobUnits: number | null | undefined, lang: string): string {
  const iob = iobUnits || 0;
  const es = lang === "es";
  if (iob >= 0.1) {
    const u = fmtUnits(Math.round(iob * 10) / 10);
    return es ? `≈ ${u} u aún activa` : `≈ ${u} u encore active`;
  }
  if (iob > 0) return es ? "casi agotada (menos de 0,1 u)" : "presque épuisée (moins de 0,1 u)";
  return es ? "terminada — ya no actúa" : "terminée — n'agit plus";
}

/** Model-facing AUTHORITATIVE insulin-on-board line for the coach/ask prompts. The model used to
 *  see only the raw dose list ("4 u il y a 290 min") and estimated the decay ITSELF — writing
 *  "insuline presque terminée" while the computed IOB (and the Insuline tab) said 0. */
export function iobSystemLine(iobUnits: number | null | undefined, lang: string): string {
  const phrase = iobStatusPhrase(iobUnits, lang);
  return lang === "es"
    ? `INSULINA AÚN ACTIVA (calculada por el sistema): ${phrase}. Usa SOLO este dato cuando hables de insulina activa; NUNCA estimes tú cuánta queda de una dosis.`
    : `INSULINE ENCORE ACTIVE (calculée par le système) : ${phrase}. Appuie-toi UNIQUEMENT sur cette valeur quand tu parles d'insuline active ; n'estime JAMAIS toi-même ce qui reste d'une dose.`;
}

/**
 * The final, code-owned action line combining a meal bolus (covering carbs) with the guard's
 * correction. Hypo dominates (sugar first, never bolus a low). When data is stale a meal bolus
 * is still allowed (it covers food) but no correction is added.
 */
/** "la canette 7up (16 g, il y a 22 min)" — the food, its carbs and when. A bolus the parent cannot
 *  attach to a specific thing eaten is a bolus they cannot sanity-check, and at 23:59 the difference
 *  between "the dinner" and "the can of 7up" was the difference between dismissing the app and
 *  trusting it. Falls back to the plain word when the meal isn't identified. */
function mealLabel(
  meal: { description?: string | null; carbsG?: number | null; minutesAgo?: number | null } | null | undefined,
  lang: string,
): string {
  const es = lang === "es";
  const generic = es ? "la comida" : "le repas";
  const d = (meal?.description ?? "").trim();
  if (!d) return generic;
  const bits: string[] = [];
  if (meal?.carbsG != null && meal.carbsG > 0) bits.push(`${Math.round(meal.carbsG)} g`);
  const m = meal?.minutesAgo;
  if (m != null && m >= 0) {
    bits.push(m < 60
      ? (es ? `hace ${m} min` : `il y a ${m} min`)
      : (es ? `hace ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 60)} h`));
  }
  const paren = bits.length ? ` (${bits.join(", ")})` : "";
  return `«${d.slice(0, 48)}»${paren}`;
}

export function combinedActionLine(
  guard: GuardResult,
  mealUnits: number,
  lang: string,
  profile: GuardProfile | null,
  mealPlanned = false,
  /** WHICH meal this bolus covers, so the line can name it. See [MealBolusPlan]. */
  mealInfo?: { description?: string | null; carbsG?: number | null; minutesAgo?: number | null } | null,
): string {
  const rapid = profile?.rapidInsulin || (lang === "es" ? "insulina rápida" : "insuline rapide");
  // Sugar / no-ratios / sugar-already-taken: a meal bolus must NOT be stacked on top, so return the
  // standalone action (never the "X u for the meal" line) — you don't bolus while low.
  if (guard.kind === "sugar" || guard.kind === "no_ratios" || guard.reason === "sugar_recent") return actionLine(guard, lang, profile);

  const meal = Math.max(0, mealUnits || 0);
  const corr = guard.kind === "correction" ? guard.insulinUnits : 0;
  const total = roundToHalf(meal + corr);

  if (total <= 0) {
    // Nothing to inject, from either half. Delegate so the REASON is printed here too — this branch
    // used to hard-code the bare sentence and was the one path where "in target" and "already coming
    // down" still looked identical on screen.
    return actionLine(guard, lang, profile);
  }

  const stale = guard.reason === "stale_data";

  // A PLANNED (not-yet-eaten) meal must NOT be pre-bolused hours early — injecting its bolus NOW
  // with no carbs on board is a straight path to a hypo. The meal part is therefore timed "when you
  // eat", and it is NEVER summed with the correction (they happen at different moments).
  if (mealPlanned && meal > 0) {
    if (lang === "es") {
      if (corr > 0) return `ahora: ${fmtUnits(corr)} u de ${rapid} de corrección; al comer: ${fmtUnits(meal)} u para ${mealLabel(mealInfo, lang)}.`;
      let l = `${fmtUnits(meal)} u de ${rapid} EN EL MOMENTO de comer, para cubrir ${mealLabel(mealInfo, lang)} (no antes de empezar).`;
      if (stale) l += ` Recontrola la glucosa antes de cualquier corrección.`;
      return l;
    }
    if (corr > 0) return `maintenant : ${fmtUnits(corr)} u de ${rapid} en correction ; au moment de manger : ${fmtUnits(meal)} u pour ${mealLabel(mealInfo, lang)}.`;
    let l = `${fmtUnits(meal)} u de ${rapid} AU MOMENT de manger, pour couvrir ${mealLabel(mealInfo, lang)} (pas avant de commencer).`;
    if (stale) l += ` Recontrôle la glycémie avant toute correction.`;
    return l;
  }

  if (lang === "es") {
    let line = (meal > 0 && corr === 0)
      ? `${fmtUnits(total)} u de ${rapid} para ${mealLabel(mealInfo, lang)}`
      : `${fmtUnits(total)} u de ${rapid} ahora`;
    if (meal > 0 && corr > 0) line += ` (${fmtUnits(meal)} u por ${mealLabel(mealInfo, lang)} + ${fmtUnits(corr)} u de corrección)`;
    if (stale && meal > 0) line += `; recontrola la glucosa antes de cualquier corrección`;
    return line + "." + unusualDoseNote(total, profile, lang);
  }
  let line = (meal > 0 && corr === 0)
    ? `${fmtUnits(total)} u de ${rapid} pour ${mealLabel(mealInfo, lang)}`
    : `${fmtUnits(total)} u de ${rapid} maintenant`;
  if (meal > 0 && corr > 0) line += ` (${fmtUnits(meal)} u pour ${mealLabel(mealInfo, lang)} + ${fmtUnits(corr)} u de correction)`;
  if (stale && meal > 0) line += ` ; recontrôle la glycémie avant toute correction`;
  // The note belongs HERE above all: with the ceilings removed, the meal bolus is the unbounded half,
  // and "450 g" typed for "45 g" produces 37 u with nothing else to question it.
  line += unusualDoseNote(total, profile, lang);
  return line + ".";
}

/** Code-owned note for an ANNOUNCED future meal whose carbs are only ESTIMATED (no firm bolus
 *  number allowed): says plainly that the meal WILL need rapid insulin at eating time, and whether a
 *  recent dose is already on record (the user's ask: "je vais manger un McDo" → if no insulin was
 *  saved, the AI must SAY to take insulin). Pairs with combinedActionLine's mealPlanned branch,
 *  which handles the firm-units case. */
export function plannedMealNote(
  carbsG: number | null | undefined,
  hasRecentRapidDose: boolean,
  lang: string,
): string {
  const es = lang === "es";
  const carbs = carbsG && carbsG > 0 ? carbsG : null;
  const head = es
    ? (carbs ? `Comida prevista (~${carbs} g de carbohidratos): habrá que cubrirla con tu insulina rápida EN EL MOMENTO de comer` : `Comida prevista: habrá que cubrirla con tu insulina rápida EN EL MOMENTO de comer`)
    : (carbs ? `Repas prévu (~${carbs} g de glucides) : il faudra le couvrir avec ton insuline rapide AU MOMENT de manger` : `Repas prévu : il faudra le couvrir avec ton insuline rapide AU MOMENT de manger`);
  const tail = hasRecentRapidDose
    ? (es
      ? ` — ya hay una dosis reciente registrada: comprueba que cubra bien esta comida.`
      : ` — une dose récente est déjà enregistrée : vérifie qu'elle couvre bien ce repas.`)
    : (es
      ? ` — ninguna insulina registrada para esta comida. Registra la comida y tu dosis en ese momento para la dosis exacta.`
      : ` — aucune insuline enregistrée pour ce repas. Logge le repas et ta dose à ce moment-là pour la dose exacte.`);
  return head + tail;
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
  // SAME robust fit as the trend. This used to run its own two-point slope, so the projection that
  // decides "you are heading for a hypo" could be built on a single noisy sample — and could point
  // the opposite way to the trend shown right beside it.
  const { slope: raw, current } = robustSlope(readings);
  if (current === null) return { slopePerMin: 0, projectedMgdl: null, minutesAhead, current: null };
  const slope = raw ?? 0; // no readable direction -> project flat, never invent a ramp
  const projected = Math.max(20, Math.min(600, Math.round(current + slope * minutesAhead)));
  return { slopePerMin: slope, projectedMgdl: projected, minutesAhead, current };
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
  // "terrón/terrones" is the app's OWN Spanish word for a sugar cube (every carb figure is shown as
  // "≈ N terrón(es)"), yet a meal logged as "30 terrones" fell through to "normal" — no pre-bolus
  // advice on the fastest carb there is.
  "terrón", "terron", "terrones",
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
  // Plain potato is a STARCH (féculent) — the user expects it counted as a slow/complex carb, not left
  // uncategorised ("aucun sucre lent" while potatoes were eaten). (Mashed "purée" stays fast = high GI.)
  "pomme de terre", "pommes de terre", "patate", "patates", "patata", "patatas", "papas", "potato",
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

/** Speed-aware TIMING advice (no dose numbers). "fatty" reuses fattyMealAdvice; "normal" is empty.
 *  Appended at logging/analysis time so the curve EXPECTATION and the bolus TIMING match the food:
 *  a fast sugar wants a pre-bolus and its quick spike is normal (don't chase it); slow and fatty
 *  meals rise late, so recheck later. Callers must SKIP it during a hypo rescue (guard "sugar") —
 *  telling someone treating a low to "pre-bolus next time" is contradictory.
 *
 *  `voice` drops the food EXAMPLES. Spoken aloud, the parentheses are inaudible, so
 *  "Sucre rapide (jus, bonbons, pain blanc…)" is heard as a list of what the person just ate — the
 *  reported bug ("it tells me I had white bread every time", for a meal that was 8 sugar cubes).
 *  Examples help on screen and mislead in audio, so every caller must pass voice=true for TTS. */
export function carbSpeedAdvice(speed: CarbSpeed, lang: string, planned = false, voice = false): string {
  const es = lang === "es";
  // On screen: "Sucre rapide (jus, bonbons…) : ..." — spoken: "Sucre rapide : ...".
  const ex = (list: string) => (voice ? "" : ` (${list})`);
  switch (speed) {
    case "fast": {
      const head = es
        ? `Azúcar rápido${ex("zumo, dulces, pan blanco…")}:`
        : `Sucre rapide${ex("jus, bonbons, pain blanc…")} :`;
      // For an ANNOUNCED (future) meal the pre-bolus advice applies to THIS meal, not "next time".
      if (planned) {
        return es
          ? `${head} la glucosa subirá MUY RÁPIDO (pico ~15-45 min). Si no hay hipo, poner la insulina un poco ANTES de empezar a comer (pre-bolo ~15 min) frena el pico.`
          : `${head} la glycémie va monter TRÈS VITE (pic ~15-45 min). S'il n'y a pas d'hypo, faire l'insuline un peu AVANT de commencer à manger (pré-bolus ~15 min) limite le pic.`;
      }
      return es
        ? `${head} la glucosa sube MUY RÁPIDO (pico ~15-45 min). Una subida rápida tras esta comida es NORMAL, no la sobre-corrijas enseguida; la próxima vez, si no hay hipo, poner la insulina un poco ANTES de comer (pre-bolo ~15 min) frena el pico.`
        : `${head} la glycémie monte TRÈS VITE (pic ~15-45 min). Une montée rapide après ce repas est NORMALE, ne la sur-corrige pas tout de suite ; la prochaine fois, s'il n'y a pas d'hypo, faire l'insuline un peu AVANT de manger (pré-bolus ~15 min) limite le pic.`;
    }
    case "slow":
      return es
        ? `Carbohidratos lentos${ex("pasta, legumbres, integral…")}: la glucosa sube DESPACIO y TARDE; el pico puede llegar 2-3 h después. No esperes una subida inmediata — vigila y recontrola más tarde.`
        : `Glucides lents${ex("pâtes, légumineuses, complet…")} : la glycémie monte LENTEMENT et TARD ; le pic peut arriver 2-3 h après. N'attends pas une montée immédiate — surveille et recontrôle plus tard.`;
    case "fatty":
      // Planned fatty meal → the split-bolus parts are "when you eat" + later, never "now".
      if (planned) {
        return es
          ? "Comida grasa (digestión lenta): la glucosa suele subir con RETRASO. Piensa en un bolo dividido — una parte al comer, otra 1-2 h después — y recontrola 2-3 h más tarde."
          : "Repas gras (digestion lente) : la glycémie monte souvent en RETARD. Pense à un bolus étalé — une partie au moment de manger, une partie 1-2 h après — et recontrôle 2-3 h plus tard.";
      }
      return fattyMealAdvice(lang);
    default:
      return "";
  }
}

// ---- Uncovered-meal awareness (Carbs-On-Board) --------------------------------------------------
// The dose guard corrects on (glucose − target)/ISF − IOB. It subtracts INSULIN on board (anti-
// stacking) but has NO term for the CARBS still on board. So when a meal is logged but never bolused,
// a later CORRECTION is systematically too small: it dips at the insulin's peak, then the still-
// digesting carbs push the glucose back up — it plateaus ABOVE target instead of reaching it. The real
// case: 30 g chicken + potatoes (slow carbs) logged with NO bolus → 119→202 over 2 h; a 1 u correction
// only reached ~168, then drifted back to ~190 and sat there with a 120 target. This surfaces that the
// meal wasn't covered so a correction alone won't hold. Description-based speed (mealCarbSpeed) sets how
// long the carbs keep acting. No schema change — retroactive on every meal already logged.

// How long a meal's carbs keep meaningfully raising glucose (so an uncovered meal is still the cause).
export const COB_WINDOW_FAST_MIN = 120;   // simple sugars: mostly absorbed within ~2 h
export const COB_WINDOW_NORMAL_MIN = 180; // mixed meal
export const COB_WINDOW_SLOW_MIN = 240;   // pasta/legumes/whole-grain/fatty: long, late tail
// A meal smaller than this is a snack / hypo rescue, not a meal that needed a bolus → never warned.
export const UNCOVERED_MEAL_MIN_CARBS = 15;
// A rapid dose within ±this of the meal counts toward covering it (handles pre-bolus / slightly-late bolus)…
export const MEAL_COVER_WINDOW_MIN = 45;
// …if it carries at least this fraction of the meal's expected bolus.
export const MEAL_COVER_FRACTION = 0.5;

function cobWindowMin(speed: CarbSpeed): number {
  if (speed === "fast") return COB_WINDOW_FAST_MIN;
  if (speed === "slow" || speed === "fatty") return COB_WINDOW_SLOW_MIN;
  return COB_WINDOW_NORMAL_MIN;
}

export interface UncoveredMeal {
  description: string | null;
  carbsG: number;
  speed: CarbSpeed;
  minutesAgo: number;
}

type MealRow = { ts: string | number; carbs_g?: number | null; carbsG?: number | null; description?: string | null; planned?: boolean };
type DoseRow = { ts: string | number; units: number; kind?: string | null };

// A hypo rescue eaten while the glucose was LOW is a rescue whatever it is called. The word list
// below it (RESCUE_WORDS / mealCarbSpeed) knows "soda", "coca", "limonade" — and did not know "7up",
// so a can drunk to climb out of 57 mg/dL was read as a meal and answered with 1 u of rapid insulin
// for a 40 kg child on his way up from a hypo. Brand vocabulary can never be complete; the glucose
// curve at the moment of eating cannot be argued with.
/** At or below this when they ate, and it was treatment, not a meal. */
export const RESCUE_GLUCOSE_MGDL = 80;
/** A low this recently makes whatever followed it a rescue. */
export const RESCUE_LOOKBACK_MIN = 45;

/** Was this eaten to fix a low? Reads the curve around the moment of eating. */
export function eatenToTreatALow(
  mealTs: number,
  readings: { ts: number; value: number }[] | null | undefined,
): boolean {
  const rs = (readings || []).filter((r) => r && Number(r.value) > 0 && Number.isFinite(Number(r.ts)));
  if (!rs.length) return false;
  // A genuine low shortly BEFORE the food (the reason it was eaten), or still low just after.
  const from = mealTs - RESCUE_LOOKBACK_MIN * 60000;
  const to = mealTs + 10 * 60000;
  if (rs.some((r) => Number(r.ts) >= from && Number(r.ts) <= to && Number(r.value) < LOW_MGDL)) return true;
  // Or simply low-ish at the moment itself: nobody boluses a snack taken at 72 mg/dL.
  let nearest: { dt: number; v: number } | null = null;
  for (const r of rs) {
    const dt = Math.abs(Number(r.ts) - mealTs);
    if (dt <= 15 * 60000 && (!nearest || dt < nearest.dt)) nearest = { dt, v: Number(r.value) };
  }
  return !!nearest && nearest.v <= RESCUE_GLUCOSE_MGDL;
}

/** The most recent EATEN meal that (a) was substantial (≥ UNCOVERED_MEAL_MIN_CARBS g), (b) is still
 *  within its carb-speed digestion window, and (c) was NOT covered by a rapid dose near its time.
 *  Returns null when there's no such meal. ts may be ISO or epoch ms; carbs read from carbs_g/carbsG. */
export function findUncoveredMeal(
  meals: MealRow[],
  doses: DoseRow[],
  nowMs: number,
  profile: GuardProfile | null,
  /** The glucose curve, so food eaten to treat a low is never answered with insulin. */
  readings?: { ts: number; value: number }[] | null,
): UncoveredMeal | null {
  const cr = profile?.carbRatio && profile.carbRatio > 0 ? profile.carbRatio : null;
  let best: UncoveredMeal | null = null;
  for (const m of meals || []) {
    // Not yet eaten → nothing to cover yet; already eaten (even if still flagged "planned") → it is
    // exactly the meal this looks for.
    if (!m || !isEatenBy(m, nowMs)) continue;
    // A hypo rescue is NOT a meal to bolus. Without this, 15 g of sugar taken to stop a fall came
    // back as "1,5 u for the meal" — insulin advised to cover the treatment for a low.
    if (isHypoRescue(m.description, m.carbs_g ?? m.carbsG)) continue;
    const carbs = Number(m.carbs_g ?? m.carbsG ?? 0);
    if (!Number.isFinite(carbs) || carbs < UNCOVERED_MEAL_MIN_CARBS) continue;
    const mt = typeof m.ts === "number" ? m.ts : new Date(m.ts).getTime();
    if (!Number.isFinite(mt)) continue;
    // THE CURVE OVERRULES THE WORDS. Eaten while low = treatment for that low, never a meal to cover.
    if (eatenToTreatALow(mt, readings)) continue;
    const minsAgo = (nowMs - mt) / 60000;
    if (minsAgo < 0) continue; // not eaten yet
    const speed = mealCarbSpeed(m.description);
    if (minsAgo > cobWindowMin(speed)) continue; // carbs already absorbed → no longer the cause
    const need = cr ? carbs / cr : 0; // expected meal bolus (0 when no ratio → any nearby dose covers)
    const covered = (doses || []).some((d) => {
      if (!d || d.kind === "basal") return false;
      const dt = typeof d.ts === "number" ? d.ts : new Date(d.ts).getTime();
      if (!Number.isFinite(dt)) return false;
      if (Math.abs(dt - mt) > MEAL_COVER_WINDOW_MIN * 60000) return false;
      return need <= 0 || Number(d.units) >= need * MEAL_COVER_FRACTION;
    });
    if (covered) continue;
    if (!best || minsAgo < best.minutesAgo) {
      best = { description: m.description ?? null, carbsG: Math.round(carbs), speed, minutesAgo: Math.round(minsAgo) };
    }
  }
  return best;
}

/** Code-owned WARNING appended to a CORRECTION when a recent meal went unbolused and its carbs are
 *  still digesting: a correction alone dips then rebounds / plateaus above target. Speed-aware (slow &
 *  fatty carbs peak late → also nudge to cover at meal-time / split the bolus). Empty when there's no
 *  uncovered meal. No dose numbers; ⚠️ prefix stripped by callers for the spoken voice (like
 *  hypoIobWarning). Answers the user's "the target is 120 but it stays at 175 after hours". */
export function uncoveredMealWarning(
  meals: MealRow[],
  doses: DoseRow[],
  nowMs: number,
  profile: GuardProfile | null,
  lang: string,
): string {
  const m = findUncoveredMeal(meals, doses, nowMs, profile);
  if (!m) return "";
  const es = lang === "es";
  const cubes = carbsCubes(m.carbsG);
  const desc = (m.description || (es ? "una comida" : "un repas")).trim();
  const cubesPhrase = cubes ? (es ? `, ≈ ${cubes} terrón(es)` : `, ≈ ${cubes} sucre(s)`) : "";
  const target = profile?.targetMgdl && profile.targetMgdl > 0 ? profile.targetMgdl : null;
  const late = m.speed === "slow" || m.speed === "fatty";

  if (es) {
    let s = `⚠️ La comida «${desc}» (~${m.carbsG} g${cubesPhrase}) no se cubrió con un bolo`;
    s += late
      ? `, y son carbohidratos lentos que aún están subiendo y tarde. `
      : `, y esos carbohidratos siguen haciendo subir la glucosa. `;
    s += `Una corrección sola baja un poco y luego vuelve a subir o se estanca por encima del objetivo${target ? ` (${target})` : ""} — por eso no termina de bajar. `;
    s += late
      ? `Recontrola en ~2 h; la próxima vez cubre este tipo de comida al comer (un bolo dividido limita el pico tardío).`
      : `Recontrola en ~2 h; la próxima vez pon el bolo de la comida al comer.`;
    return s;
  }
  let s = `⚠️ Le repas «${desc}» (~${m.carbsG} g${cubesPhrase}) n'a pas été couvert par un bolus`;
  s += late
    ? `, et ce sont des glucides lents qui montent encore et tard. `
    : `, et ces glucides font encore monter la glycémie. `;
  s += `Une correction seule baisse un peu puis ça remonte ou plafonne au-dessus de la cible${target ? ` (${target})` : ""} — c'est pour ça qu'elle ne redescend pas complètement. `;
  s += late
    ? `Recontrôle dans ~2 h ; la prochaine fois, couvre ce type de repas au moment de manger (un bolus étalé limite le pic tardif).`
    : `Recontrôle dans ~2 h ; la prochaine fois, fais le bolus du repas au moment de manger.`;
  return s;
}

/**
 * Code-owned ACTION for when glucose is IN RANGE (70-180): there's no correction to make, but the
 * analysis should still give a concrete next step (a blank "Action" read as "the coach stopped giving
 * advice" — the user's report). All WITHOUT a dose number (the parent owns the meal-bolus amount).
 * Priority:
 *   1. a meal logged in the last ~45 min that ISN'T covered by a bolus → cover it. This is the exact
 *      case the user hit: logged "2 saucisses" at 84 mg/dL and the analysis said nothing about
 *      covering it. When the glucose is ALSO low-and-falling, the food will lift it, so the line says
 *      to eat + cover + keep sugar handy (never "bolus now" alone on a falling low).
 *   2. drifting toward the low end (70-89, falling) → keep sugar nearby + watch.
 *   3. drifting up (161-180, rising) → get ready to correct once past 180.
 *   4. otherwise → in range, nothing to correct, keep monitoring.
 */
export function inRangeActionLine(
  meals: MealRow[],
  doses: DoseRow[],
  readings: { ts: number; value: number }[],
  nowMs: number,
  profile: GuardProfile | null,
  lang: string,
  iobUnits = 0,
): string {
  const es = lang === "es";
  const uncovered = findUncoveredMeal(meals, doses, nowMs, profile, readings);
  const recentMeal = uncovered && uncovered.minutesAgo <= 45 ? uncovered : null;
  const pred = predictiveAdvice(readings, nowMs);

  // IN RANGE IS NOT THE SAME AS SAFE. The insulin already in keeps working whatever the number on
  // screen says: 85 mg/dL with 3.4 u still active has ~195 mg/dL of fall still owed, and "dans la
  // cible, rien à corriger" is a dangerous thing to read there. This outranks everything below,
  // including an uncovered meal — you do not bolus into a drop that is already coming.
  const cur = readings && readings.length ? readings[readings.length - 1].value : null;
  if (mealBolusHeldByIob(cur, iobUnits, profile)) {
    const drop = Math.round(pendingDropMgdl(iobUnits, profile) ?? 0);
    return es
      ? `la insulina que sigue activa aún tiene ~${drop} mg/dL de bajada por delante — vas hacia una hipoglucemia. Ten azúcar a mano AHORA, recontrola en 15 min, y ninguna insulina más (tampoco para una comida) mientras no haya vuelto a subir.`
      : `l'insuline encore active a ~${drop} mg/dL de baisse à délivrer — tu vas vers une hypo. Garde du sucre à portée MAINTENANT, recontrôle dans 15 min, et aucune insuline en plus (repas compris) tant que ce n'est pas remonté.`;
  }
  const falling = pred.kind === "watch_fall";
  const rising = pred.kind === "watch_rise" || pred.kind === "high_soon";

  if (recentMeal) {
    const desc = (recentMeal.description || (es ? "este alimento" : "ce repas")).trim();
    const cubes = carbsCubes(recentMeal.carbsG);
    const cubesP = cubes ? (es ? `, ≈ ${cubes} terrón(es)` : `, ≈ ${cubes} sucre(s)`) : "";
    if (falling) {
      return es
        ? `vas a comer «${desc}» (~${recentMeal.carbsG} g${cubesP}) y la glucosa está baja y bajando: empieza a comer, cúbrelo con tu bolo de comida habitual y ten azúcar a mano por si baja antes de subir.`
        : `tu vas manger «${desc}» (~${recentMeal.carbsG} g${cubesP}) et la glycémie est basse et descend : commence à manger, couvre-le avec ton bolus repas habituel et garde du sucre à portée au cas où ça baisse avant de remonter.`;
    }
    return es
      ? `comida «${desc}» (~${recentMeal.carbsG} g${cubesP}) aún sin cubrir — piensa en tu bolo de comida habitual y recontrola después.`
      : `repas «${desc}» (~${recentMeal.carbsG} g${cubesP}) pas encore couvert — pense à ton bolus repas habituel, et recontrôle après.`;
  }
  if (falling) {
    return es
      ? `la glucosa baja; ten azúcar a mano y vigila. No hace falta tomarlo mientras no estés por debajo de 70.`
      : `la glycémie descend ; garde du sucre à portée et surveille. Pas besoin d'en prendre tant que tu n'es pas sous 70.`;
  }
  if (rising) {
    return es
      ? `la glucosa sube; vigila y prepárate para corregir si pasas de 180.`
      : `la glycémie monte ; surveille et prépare-toi à corriger si tu dépasses 180.`;
  }
  return es
    ? `en objetivo (70-180), nada que corregir — sigue vigilando.`
    : `dans la cible (70-180), rien à corriger — continue de surveiller.`;
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

/**
 * Carbs still being absorbed (grams), decaying linearly over each meal's own carb-speed window.
 *
 * Needed to read insulin-on-board honestly: 2 u injected WITH the 20 g meal it covers is not "2 u
 * pulling you toward a hypo", it is a balanced bolus. Without netting the food off, every single
 * meal dose looked like an incoming low — an alarm that fires on normal behaviour is an alarm
 * nobody reads. A meal announced for LATER is not on board yet; one whose time has passed is,
 * whatever its stored `planned` flag still says (nothing ever flips it back).
 */
export function carbsOnBoard(meals: MealRow[], nowMs: number): number {
  let g = 0;
  for (const m of meals || []) {
    if (!m || !isEatenBy(m, nowMs)) continue;
    const carbs = Number(m.carbs_g ?? m.carbsG ?? 0);
    if (!Number.isFinite(carbs) || carbs <= 0) continue;
    const t = typeof m.ts === "number" ? m.ts : new Date(m.ts).getTime();
    if (!Number.isFinite(t)) continue;
    const mins = (nowMs - t) / 60000;
    if (mins < 0) continue;
    const win = cobWindowMin(mealCarbSpeed(m.description));
    if (mins > win) continue;
    g += carbs * (1 - mins / win);
  }
  return Math.max(0, g);
}

export interface MealBolusPlan {
  units: number;          // meal bolus to name (0 = nothing to cover, or no carb ratio)
  planned: boolean;       // true => due AT EATING TIME, not now
  carbsG: number | null;  // the carbs it covers
  // WHICH meal. Without these the action line said "X u pour le repas" and the parent had to guess:
  // at 23:59 the app meant a 7up drunk 22 minutes earlier, the parent read it as the dinner from
  // three hours before, and concluded the app was broken — while the advice was in fact correct.
  // A dose you cannot attach to a specific food is a dose you cannot check.
  description?: string | null;
  minutesAgo?: number | null;
}

/**
 * WHICH meal the action line should dose, and WHEN it is due. Extracted from the coach so the choice
 * is unit-tested rather than inline in an edge function.
 *
 * An EATEN meal that is still digesting and was never bolused is due NOW, and it OUTRANKS an
 * announced one (whose bolus is due at eating time) — otherwise a single line would advise two meal
 * boluses at once. With nothing eaten to cover, the most recently ANNOUNCED meal within
 * `announcedWindowMin` is dosed for eating time. `units` is 0 when there is nothing to cover, when
 * the row carries no carbs, or when the profile has no carb ratio — the caller then falls back to its
 * dose-free wording.
 */
export function mealBolusPlan(
  meals: MealRow[],
  doses: DoseRow[],
  nowMs: number,
  profile: GuardProfile | null,
  announcedWindowMin = 180,
  readings?: { ts: number; value: number }[] | null,
): MealBolusPlan {
  const uncovered = findUncoveredMeal(meals, doses, nowMs, profile, readings);
  if (uncovered) {
    return {
      units: mealBolusUnits(uncovered.carbsG, profile), planned: false, carbsG: uncovered.carbsG,
      description: uncovered.description, minutesAgo: uncovered.minutesAgo,
    };
  }
  // Most recently announced meal STILL AHEAD. One whose time has come and gone is an EATEN meal and
  // belongs to findUncoveredMeal above — which, if it returned nothing, means that meal is already
  // covered and there is nothing left to inject for it.
  //
  // This is where the reported incident came from. The test was `t < nowMs - 180 min`, i.e. "skip
  // meals older than three hours" — so any meal still flagged `planned` (nothing ever clears that
  // flag) was re-announced as upcoming for three hours after it was eaten. A child's 50 g dinner,
  // pre-bolused correctly with 5.5 u twenty minutes beforehand, was still being answered with "3 u de
  // Fiasp au moment de manger" an hour and forty minutes later — at 85 mg/dL, with 3.4 u still
  // active, which alone had 195 mg/dL of fall left to deliver. He went to 63.
  let bestTs = -Infinity;
  let bestCarbs = 0;
  let bestDesc: string | null = null;
  for (const m of meals || []) {
    if (!m || m.planned !== true) continue;
    const t = typeof m.ts === "number" ? m.ts : new Date(m.ts).getTime();
    // Still ahead, and not so far ahead that it is tomorrow's dinner.
    if (!Number.isFinite(t) || t <= nowMs || t > nowMs + announcedWindowMin * 60000) continue;
    if (t <= bestTs) continue;
    const c = Number(m.carbs_g ?? m.carbsG ?? 0);
    bestTs = t;
    bestCarbs = Number.isFinite(c) && c > 0 ? c : 0;
    bestDesc = (m.description ?? null) as string | null;
  }
  if (bestTs === -Infinity) return { units: 0, planned: false, carbsG: null, description: null, minutesAgo: null };
  const carbsG = bestCarbs > 0 ? Math.round(bestCarbs) : null;
  return {
    units: mealBolusUnits(carbsG, profile), planned: true, carbsG,
    description: bestDesc, minutesAgo: Math.round((nowMs - bestTs) / 60000),
  };
}

// ---- PROSPECTIVE meal dosing: "if I eat THIS, how much insulin?" --------------------------------
// Everything above answers "what do I do RIGHT NOW, given the current glucose". That is not how a
// meal is actually dosed: you decide BEFORE eating, from the carbs you are about to eat. Uncovered
// carbs raise glucose by ~(carbs / ICR) × ISF mg/dL — 120 g on a 12 ICR / 50 ISF profile is +500
// mg/dL, which is exactly why "30 sucres" reliably ends at 350+. Reacting to the current value can
// never catch that in time; the number has to be available BEFORE the meal.
//
// planMealDose answers the whole question at once: the meal bolus, the correction, the total, where
// the meal would take you if it went uncovered, and WHEN to inject for this kind of carb. The
// correction half is DELEGATED to computeGuard, never re-implemented, so every no-insulin invariant
// (stale data, falling, in-range, IOB subtraction, missing ratios) is inherited by construction.

export type MealTiming = "prebolus" | "at_meal" | "split" | "after_meal" | "none";

export interface MealPlanInput {
  glucoseMgdl: number | null;
  trend: Trend;
  staleMin: number;
  iobUnits: number;
  carbsG: number | null | undefined;
  description?: string | null;
  minutesUntilMeal?: number | null; // 0 / absent = about to eat
  minSinceRescue?: number | null;
  recentHypo?: boolean;
  profile: GuardProfile | null;
}

export interface MealPlanResult {
  carbsG: number;
  mealUnits: number;                     // carbs / ICR
  correctionUnits: number;               // from computeGuard (0 unless a real high, IOB already deducted)
  totalUnits: number;                    // what to inject (0 during a hypo — sugar first)
  expectedRiseMgdl: number | null;       // rise if these carbs went completely uncovered
  projectedUncoveredMgdl: number | null; // where that lands from the current value, IOB deducted
  timing: MealTiming;
  speed: CarbSpeed;
  reason: string;                        // ok | no_carbs | no_ratios | hypo_first | stale_no_correction
  /** Minutes until the meal is eaten (0 = now). Drives WHEN the pre-bolus is due. */
  minutesUntilMeal: number;
  // Dropping fast while about to take FAST carbs: that is usually a fall being arrested, not a meal.
  // Bolusing it would fight the very thing it is there to fix, so the caller warns instead of hiding
  // the number (a genuine meal eaten on a fast fall still needs its cover).
  fastFallCaution: boolean;
  // The glucose is heading LOW before the meal's carbs can land — either it is already low and
  // falling, or the insulin still on board (iob × ISF) will drag it under on its own. A meal bolus
  // then stacks onto a fall already in progress, so it is deferred to after the rise has started.
  lowBeforeMeal: boolean;
  // Where the insulin on board alone would take the glucose (current − iob × ISF), null without ISF.
  // Kept UNCLAMPED for the logic — it can go negative, which is precisely the signal that the drop
  // still owed is larger than the distance to zero. Never show it raw; show pendingDropMgdl instead.
  floorMgdl: number | null;
  // How much the insulin still on board has left to lower the glucose (iob × ISF), in mg/dL.
  pendingDropMgdl: number | null;
  guard: GuardResult;
}

/** Ceiling for the projected-if-uncovered figure; above this we say "plus de N" rather than a number
 *  the meter itself could never show. Matches projectGlucose's clamp. */
export const PROJECTION_MAX_MGDL = 600;

/** How long before a fast-carb meal the insulin should go in. */
export const PREBOLUS_LEAD_MIN = 15;

export function planMealDose(input: MealPlanInput): MealPlanResult {
  const { glucoseMgdl: g, trend, staleMin, iobUnits, profile } = input;
  const carbs = Number(input.carbsG);
  const carbsG = Number.isFinite(carbs) && carbs > 0 ? Math.round(carbs) : 0;
  const speed = mealCarbSpeed(input.description);
  const untilRaw = Number(input.minutesUntilMeal);
  const minutesUntilMeal = Number.isFinite(untilRaw) && untilRaw > 0 ? Math.round(untilRaw) : 0;
  const guard = computeGuard({
    glucoseMgdl: g, trend, staleMin, iobUnits, recentHypo: !!input.recentHypo,
    minSinceRescue: input.minSinceRescue ?? null, profile,
  });

  const icr = profile?.carbRatio && profile.carbRatio > 0 ? profile.carbRatio : null;
  const isf = profile?.correctionFactor && profile.correctionFactor > 0 ? profile.correctionFactor : null;
  const mealUnits = mealBolusUnits(carbsG, profile);
  const correctionUnits = guard.kind === "correction" ? guard.insulinUnits : 0;

  // What these carbs do UNBOLUSED: (carbs / ICR) units' worth of glucose, i.e. × ISF mg/dL. Insulin
  // already on board is netted off — it will absorb part of the rise.
  const expectedRiseMgdl = (icr && isf) ? Math.round((carbsG / icr) * isf) : null;
  const projectedUncoveredMgdl = (expectedRiseMgdl != null && g != null && Number.isFinite(g) && g > 0)
    ? Math.max(20, Math.min(PROJECTION_MAX_MGDL, Math.round(g + expectedRiseMgdl - (isf ? (iobUnits || 0) * isf : 0))))
    : null;

  // A low comes first, always: no pre-bolus, nothing injected until it is treated and the meal started.
  const hypoFirst = guard.kind === "sugar" || guard.reason === "sugar_recent";
  const falling = trend === "falling" || trend === "falling_fast";

  // Insulin already injected keeps pulling the glucose DOWN while the meal is still being digested.
  // If that pending drop (iob × ISF) lands the current value under the low threshold, or the glucose
  // is already low AND falling, then a meal bolus — however correct for the carbs — is added on top
  // of a fall that is already happening. The real shape of the miss: 100 mg/dL falling with 3 u still
  // active is ~150 mg/dL of drop still to come, and the plan used to answer "10 u" with no caveat.
  const floorMgdl = (g != null && Number.isFinite(g) && g > 0 && isf)
    ? Math.round(g - (iobUnits || 0) * isf)
    : null;
  const lowBeforeMeal = !hypoFirst && carbsG > 0 && (
    (floorMgdl != null && floorMgdl < LOW_MGDL) ||
    (falling && g != null && g < FALL_WATCH_BELOW + 10)
  );

  let timing: MealTiming;
  if (carbsG <= 0) timing = "none";
  else if (hypoFirst) timing = "after_meal";
  // Heading low: eat FIRST, inject once the rise is under way — never pre-bolus into a fall.
  else if (lowBeforeMeal) timing = "after_meal";
  else if (speed === "fatty" || speed === "slow") timing = "split";
  else if (speed === "fast" && !falling) timing = "prebolus";
  else timing = "at_meal";

  let reason = "ok";
  if (carbsG <= 0) reason = "no_carbs";
  else if (!icr) reason = "no_ratios";
  else if (hypoFirst) reason = "hypo_first";
  else if (guard.reason === "stale_data") reason = "stale_no_correction";

  const totalUnits = hypoFirst ? 0 : roundToHalf(mealUnits + correctionUnits);
  const fastFallCaution = trend === "falling_fast" && speed === "fast" && !hypoFirst && carbsG > 0;
  return {
    carbsG, mealUnits, correctionUnits, totalUnits,
    expectedRiseMgdl, projectedUncoveredMgdl, timing, speed, reason, minutesUntilMeal,
    fastFallCaution, lowBeforeMeal, floorMgdl,
    pendingDropMgdl: isf ? Math.round((iobUnits || 0) * isf) : null,
    guard,
  };
}

/** WHEN to inject, for this meal's carb speed — and, when the meal was ANNOUNCED for later, how long
 *  from now that is. "In 30 minutes" plus a 15-minute pre-bolus means "in about 15 minutes", not
 *  "now": the announced time is the whole point of announcing it. No dose numbers, TTS-clean. */
export function mealTimingLine(timing: MealTiming, lang: string, minutesUntilMeal = 0): string {
  const es = lang === "es";
  const until = Number.isFinite(minutesUntilMeal) && minutesUntilMeal > 0 ? Math.round(minutesUntilMeal) : 0;
  switch (timing) {
    case "prebolus": {
      if (until > PREBOLUS_LEAD_MIN) {
        const inMin = until - PREBOLUS_LEAD_MIN;
        return es
          ? `Azúcar rápido: como comes dentro de ${until} min, pon la insulina dentro de unos ${inMin} min (unos ${PREBOLUS_LEAD_MIN} min ANTES de empezar), si no el pico llega antes que ella.`
          : `Sucre rapide : comme tu manges dans ${until} min, fais l'insuline dans environ ${inMin} min (soit ~${PREBOLUS_LEAD_MIN} min AVANT de commencer), sinon le pic arrive avant elle.`;
      }
      return es
        ? "Azúcar rápido: pon la insulina ~15 min ANTES de empezar a comer, si no el pico llega antes que ella."
        : "Sucre rapide : fais l'insuline ~15 min AVANT de commencer à manger, sinon le pic arrive avant elle.";
    }
    case "split":
      return es
        ? "Comida lenta o grasa: sube TARDE. Bolo dividido — una parte al empezar, el resto 1-2 h después — y recontrola a las 2-3 h."
        : "Repas lent ou gras : ça monte TARD. Bolus étalé — une partie en commençant, le reste 1-2 h après — et recontrôle à 2-3 h.";
    case "at_meal":
      return until > 0
        ? (es ? `Pon la insulina al empezar a comer, dentro de ${until} min.` : `Fais l'insuline au moment de commencer à manger, dans ${until} min.`)
        : (es ? "Pon la insulina al empezar a comer." : "Fais l'insuline au moment de commencer à manger.");
    case "after_meal":
      return es
        ? "Empieza a comer primero; la insulina de la comida solo DESPUÉS, cuando la subida ya haya empezado."
        : "Commence à manger d'abord ; l'insuline du repas seulement APRÈS, une fois la remontée amorcée.";
    default:
      return "";
  }
}

/** The full prospective answer to "if I eat this, how much do I take?" — code-owned, every number
 *  from planMealDose. Leads with the dose (that is the question), then what the meal would do
 *  unbolused (the reason the dose matters), then the timing. */
export function mealPlanLine(
  plan: MealPlanResult,
  lang: string,
  profile: GuardProfile | null,
  /** Drop the explanatory half (what the carbs would do uncovered). The ANALYSE card is meant to be
   *  a 2-3 sentence summary plus ONE action line — a four-clause action buries the summary it is
   *  supposed to conclude. The voice/ask path, where the user literally asked "if I eat this, how
   *  much?", keeps the full reasoning. Safety clauses are never dropped by this flag. */
  concise = false,
): string {
  const es = lang === "es";
  const rapid = profile?.rapidInsulin || (es ? "insulina rápida" : "insuline rapide");
  const cubes = carbsCubes(plan.carbsG);
  const cubesP = cubes ? (es ? `, ≈ ${cubes} terrón(es)` : `, ≈ ${cubes} sucre(s)`) : "";

  if (plan.reason === "no_carbs") {
    return es ? "Dime qué vas a comer (y la cantidad) para calcular la dosis." : "Dis-moi ce que tu vas manger (et la quantité) pour calculer la dose.";
  }
  if (plan.reason === "no_ratios") {
    return es
      ? `Para ~${plan.carbsG} g de carbohidratos${cubesP} — no puedo dar una dosis: falta tu ratio de carbohidratos en el perfil. Complétalo y te doy el número exacto.`
      : `Pour ~${plan.carbsG} g de glucides${cubesP} — je ne peux pas donner de dose : ton ratio glucides manque dans le profil. Renseigne-le et je te donne le chiffre exact.`;
  }

  const parts: string[] = [];
  if (plan.reason === "hypo_first") {
    // Lead with the GRAMS. "Sucre d'abord" without a quantity is the one number that actually
    // matters at that moment, and it was being dropped in favour of the meal's unit count.
    parts.push(actionLine(plan.guard, lang, profile));
    parts.push(es
      ? `Después, para ~${plan.carbsG} g${cubesP}, la comida necesitará ${fmtUnits(plan.mealUnits)} u de ${rapid} — solo DESPUÉS de haber remontado.`
      : `Ensuite, pour ~${plan.carbsG} g${cubesP}, le repas demandera ${fmtUnits(plan.mealUnits)} u de ${rapid} — seulement APRÈS être remonté.`);
  } else {
    let head = es
      ? `Para ~${plan.carbsG} g de carbohidratos${cubesP}: ${fmtUnits(plan.totalUnits)} u de ${rapid}`
      : `Pour ~${plan.carbsG} g de glucides${cubesP} : ${fmtUnits(plan.totalUnits)} u de ${rapid}`;
    if (plan.correctionUnits > 0) {
      head += es
        ? ` en total (${fmtUnits(plan.mealUnits)} u para la comida + ${fmtUnits(plan.correctionUnits)} u de corrección).`
        : ` au total (${fmtUnits(plan.mealUnits)} u pour le repas + ${fmtUnits(plan.correctionUnits)} u de correction).`;
    } else {
      head += es ? ` para la comida.` : ` pour le repas.`;
    }
    parts.push(head);
  }

  // WHY the dose matters: what these carbs do if they go uncovered. This is the forward-looking half
  // — reacting to the glucose after the fact can never catch a rise this size. Skipped during a hypo:
  // there the one thing that must land is "sugar first", and a "+292 mg/dL" beside it only competes
  // with it (the food IS the treatment at that moment).
  if (!concise && plan.reason !== "hypo_first" && plan.expectedRiseMgdl != null && plan.expectedRiseMgdl > 0) {
    const capped = plan.projectedUncoveredMgdl != null && plan.projectedUncoveredMgdl >= PROJECTION_MAX_MGDL;
    const land = plan.projectedUncoveredMgdl != null
      ? (es
        ? ` — te llevaría ${capped ? `por encima de ${PROJECTION_MAX_MGDL}` : `a ~${plan.projectedUncoveredMgdl}`} mg/dL`
        : ` — ça t'emmènerait ${capped ? `au-delà de ${PROJECTION_MAX_MGDL}` : `vers ~${plan.projectedUncoveredMgdl}`} mg/dL`)
      : "";
    parts.push(es
      ? `Sin insulina, esta comida sube ~${plan.expectedRiseMgdl} mg/dL${land}.`
      : `Sans insuline, ce repas fait monter d'environ ${plan.expectedRiseMgdl} mg/dL${land}.`);
  }

  // Both the hypo head above and the low-before-meal warning below already state WHEN to inject, in
  // stronger words. Emitting the generic timing line too would say the same thing twice in a row.
  const t = (plan.lowBeforeMeal || plan.reason === "hypo_first") ? "" : mealTimingLine(plan.timing, lang, plan.minutesUntilMeal);
  if (t) parts.push(t);

  // Heading low BEFORE the food can act — the dose is right for the carbs, the TIMING is what would
  // hurt. Name the pending drop when insulin on board is the cause: "10 u" next to a silent 3 u still
  // working is the exact situation where a correct number produces a hypo.
  if (plan.lowBeforeMeal) {
    const iobDriven = plan.floorMgdl != null && plan.floorMgdl < LOW_MGDL;
    if (iobDriven) {
      // The pending DROP, never the projected floor: current − iob × ISF goes negative exactly when
      // the warning matters most, and "~-50 mg/dL" is nonsense on screen.
      const drop = plan.pendingDropMgdl && plan.pendingDropMgdl > 0 ? plan.pendingDropMgdl : null;
      const by = drop ? (es ? ` de ~${drop} mg/dL` : ` d'environ ${drop} mg/dL`) : "";
      parts.push(es
        ? `⚠️ La insulina que ya está activa aún hará bajar${by} antes incluso de que la comida actúe, hasta por debajo de 70: come primero y pon el bolo cuando la subida haya empezado, no ahora.`
        : `⚠️ L'insuline déjà active va encore faire baisser${by} avant même que le repas agisse, jusque sous 70 : mange d'abord et fais le bolus une fois la remontée amorcée, pas maintenant.`);
    } else {
      parts.push(es
        ? "⚠️ Estás bajo y bajando: come primero y pon la insulina cuando la subida haya empezado, no antes."
        : "⚠️ Tu es bas et en train de descendre : mange d'abord et fais l'insuline une fois la remontée amorcée, pas avant.");
    }
  }

  if (plan.fastFallCaution) {
    parts.push(es
      ? "Ojo: estás bajando RÁPIDO. Si este azúcar es para frenar la bajada y no una comida, no lo cubras con insulina."
      : "Attention : tu descends VITE. Si ce sucre sert à freiner la baisse et n'est pas un repas, ne le couvre pas avec de l'insuline.");
  }

  if (plan.reason === "stale_no_correction") {
    parts.push(es
      ? "Los datos no están actualizados: esta dosis cubre solo la comida, sin corrección — recontrola la glucosa antes de añadir nada."
      : "Données pas à jour : cette dose ne couvre que le repas, sans correction — recontrôle la glycémie avant d'ajouter quoi que ce soit.");
  }
  return parts.join(" ");
}
