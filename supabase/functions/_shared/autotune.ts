// Autotune — refine the carb-ratio (ICR) and correction-factor (ISF) from ACTUAL logged
// insulin (a MEASURED total-daily-dose) instead of the weight-estimated TDD used at onboarding.
//
// Method (deliberately conservative + explainable, never a black box):
//   1. measured TDD = (sum of logged rapid units / days observed) + basal/day.
//   2. 500/1800 rule on that TDD  ->  ICR = 500/TDD, ISF = 1800/TDD.
//   3. gentle TIR-aware nudge: many lows -> weaker ratios; many highs -> stronger.
//   4. clamp the suggestion to ±25% of the CURRENT ratio (no wild swings).
//   5. confidence scales with how many doses / days we actually have.
//
// This is SUGGESTION-grade and must NEVER be applied silently — the user (and ideally their
// doctor) validates it. Pure TS (no Deno/Node) so it runs under the Node test runner too.

export type Confidence = "low" | "medium" | "high";

export interface AutotuneProfile {
  carbRatio?: number | null;
  correctionFactor?: number | null;
  targetMgdl?: number | null;
  rapidUnitsPerDay?: number | null;
  basalUnitsPerDay?: number | null;
}

export interface AutotuneInput {
  insulin: { ts: string | number; units: number; kind?: string }[];
  readings: { ts: number; value: number }[];
  profile: AutotuneProfile | null;
  nowMs: number;
}

export interface AutotuneResult {
  tdd: number | null;
  days: number;
  doses: number;
  suggestedCarbRatio: number | null;
  suggestedCorrectionFactor: number | null;
  currentCarbRatio: number | null;
  currentCorrectionFactor: number | null;
  confidence: Confidence | null;
  tirLowPct: number;
  tirHighPct: number;
  reason: string;
  same: boolean; // the suggestion is ~the current setting (no real change to propose)
}

const DAY_MS = 24 * 3600 * 1000;

export function suggestRatios(input: AutotuneInput): AutotuneResult {
  const { insulin, readings, profile, nowMs } = input;
  const curCR = profile?.carbRatio ?? null;
  const curCF = profile?.correctionFactor ?? null;

  const empty: AutotuneResult = {
    tdd: null, days: 0, doses: 0,
    suggestedCarbRatio: null, suggestedCorrectionFactor: null,
    currentCarbRatio: curCR, currentCorrectionFactor: curCF,
    confidence: null, tirLowPct: 0, tirHighPct: 0, reason: "insufficient_data", same: false,
  };

  // ---- measured TDD from logged insulin over the available window (cap 14 days) ----
  const cut = nowMs - 14 * DAY_MS;
  const doses = (insulin || [])
    .map((d) => ({ t: typeof d.ts === "number" ? d.ts : new Date(d.ts).getTime(), u: Number(d.units), kind: d.kind }))
    .filter((d) => Number.isFinite(d.t) && d.t >= cut && Number.isFinite(d.u) && d.u > 0);

  let measuredTdd: number | null = null;
  let days = 0;
  if (doses.length > 0) {
    const minT = Math.min(...doses.map((d) => d.t));
    days = Math.max(1, Math.round((nowMs - minT) / DAY_MS));
    const rapidPerDay = doses.filter((d) => d.kind !== "basal").reduce((s, d) => s + d.u, 0) / days;
    const loggedBasalPerDay = doses.filter((d) => d.kind === "basal").reduce((s, d) => s + d.u, 0) / days;
    const basalPerDay = profile?.basalUnitsPerDay ?? (loggedBasalPerDay > 0 ? loggedBasalPerDay : 0);
    measuredTdd = rapidPerDay + basalPerDay;
  }

  // Logged doses UNDERCOUNT the day unless every bolus is recorded — and people rarely log them all.
  // A sparse log makes the measured TDD too low, which would push the suggested ratio too HIGH
  // (e.g. 14 -> 18 from a single partial day). So we trust the measured TDD only with enough data
  // (>=8 doses over >=2 days); otherwise we anchor on the profile's stated daily insulin, a COMPLETE
  // figure, and effectively just confirm the current ratios (with a gentle TIR nudge).
  const profileTdd = (profile?.rapidUnitsPerDay ?? 0) + (profile?.basalUnitsPerDay ?? 0);
  const measuredOk = doses.length >= 8 && days >= 2;
  let tdd: number | null = null;
  let reason = "insufficient_data";
  if (measuredOk && measuredTdd && measuredTdd > 0) { tdd = measuredTdd; reason = "measured_tdd"; }
  else if (profileTdd > 0) { tdd = profileTdd; reason = "profile_tdd"; }
  if (!tdd || tdd <= 0) return empty;

  // ---- time-in-range over the readings window ----
  const rs = (readings || []).filter((r) => r && Number(r.value) > 0);
  const n = rs.length;
  const lowPct = n ? Math.round((rs.filter((r) => r.value < 70).length / n) * 100) : 0;
  const highPct = n ? Math.round((rs.filter((r) => r.value > 180).length / n) * 100) : 0;

  // ---- 500/1800 on MEASURED tdd, then TIR nudge, then clamp vs current (±25%) ----
  let cr = 500 / tdd;
  let cf = 1800 / tdd;
  if (lowPct >= 10) { cr *= 1.1; cf *= 1.1; }       // too many lows -> looser (bigger numbers)
  else if (highPct >= 40) { cr *= 0.9; cf *= 0.9; } // too many highs -> tighter (smaller numbers)

  const clamp = (v: number, cur: number | null) =>
    cur && cur > 0 ? Math.max(cur * 0.75, Math.min(cur * 1.25, v)) : v;
  const sCR = Math.max(1, Math.round(clamp(cr, curCR)));
  const sCF = Math.max(1, Math.round(clamp(cf, curCF)));

  const confidence: Confidence = measuredOk
    ? (doses.length >= 20 && days >= 7 ? "high" : "medium")
    : "low";

  // Is the suggestion basically the current setting (within ~10%)? Then there's no real change to
  // propose — we'll say "your settings look consistent" rather than a confusing near-identical number.
  const near = (a: number, b: number | null) => !!b && b > 0 && Math.abs(a - b) <= Math.max(1, b * 0.1);
  const same = near(sCR, curCR) && near(sCF, curCF);

  return {
    tdd: Math.round(tdd * 10) / 10, days, doses: doses.length,
    suggestedCarbRatio: sCR, suggestedCorrectionFactor: sCF,
    currentCarbRatio: curCR, currentCorrectionFactor: curCF,
    confidence, tirLowPct: lowPct, tirHighPct: highPct, reason, same,
  };
}

/** A PLAIN-LANGUAGE explanation of the suggestion — no jargon (no "TDD", "ICR/ISF", "ratio",
 *  "sensibilité"): the same wording as the Insulin page's settings card. Complete but clear, and
 *  always ends "look at it with your doctor". (The user flagged the old version as too technical.) */
export function autotuneLine(r: AutotuneResult, lang: string): string {
  const es = lang === "es";
  if (!r.suggestedCarbRatio || !r.tdd) {
    return es
      ? "Aún no hay suficientes pinchazos anotados para proponer un ajuste. Anota tus dosis unos días y vuelve a mirar."
      : "Pas encore assez de piqûres notées pour proposer un réglage. Note tes doses quelques jours, puis reviens voir.";
  }
  // Data agrees with the current settings — say so instead of proposing a near-identical "change".
  if (r.same) {
    return es
      ? `Tus ajustes actuales (1 unidad por ~${r.currentCarbRatio} g de carbohidratos, y 1 unidad que baja la glucosa unos ${r.currentCorrectionFactor} mg/dL) parecen coherentes con tus datos: nada que cambiar por ahora. Sigue anotando tus dosis unos días para afinar mejor.`
      : `Tes réglages actuels (1 unité pour ~${r.currentCarbRatio} g de glucides, et 1 unité qui fait baisser la glycémie d'environ ${r.currentCorrectionFactor} mg/dL) semblent cohérents avec tes données : rien à changer pour l'instant. Continue de noter tes doses quelques jours pour affiner davantage.`;
  }
  const cubes = Math.max(1, Math.round(r.suggestedCarbRatio / 4));
  const conf = es
    ? { low: "aún baja", medium: "correcta", high: "buena" }
    : { low: "encore faible", medium: "correcte", high: "bonne" };
  const c = conf[r.confidence ?? "low"];
  if (es) {
    return `Según tus últimos ${r.days} día(s) y ${r.doses} pinchazos anotados, Doctor Claude propone: 1 unidad de insulina por unos ${r.suggestedCarbRatio} g de carbohidratos (≈ ${cubes} terrones), y 1 unidad que baja la glucosa unos ${r.suggestedCorrectionFactor} mg/dL. Fiabilidad ${c}. Míralo con tu médico antes de cambiar tus ajustes.`;
  }
  return `D'après tes ${r.days} dernier(s) jour(s) et ${r.doses} piqûres notées, Doctor Claude propose : 1 unité d'insuline pour environ ${r.suggestedCarbRatio} g de glucides (≈ ${cubes} sucres), et 1 unité qui fait baisser la glycémie d'environ ${r.suggestedCorrectionFactor} mg/dL. Fiabilité ${c}. À regarder avec ton médecin avant de changer tes réglages.`;
}
