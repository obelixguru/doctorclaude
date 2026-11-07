// What the glucose is likely to do next, learned from THIS patient's own sensor history.
//
// Measured on Ryan's data, walk-forward (train on the past, test on the following month, Sept-Nov
// 2026, RMSE in mg/dL at 30 / 60 / 120 min):
//     "nothing changes"          38 / 63 / 83
//     the old straight line      46 / 88 / 152
//     this ridge                 34 / 54 / 67
// A boosted tree scores 33 / 53 / 65, so the simpler model loses almost nothing and it fits inside an
// edge function. Beyond an hour the error stops shrinking relative to "nothing changes" enough to be
// worth a number, so nothing past 60 minutes is ever shown as a figure.
//
// WHY THE LOGGED INSULIN AND FOOD ONLY GET A QUARTER OF THEIR WEIGHT HERE. Adding the full arithmetic
// to this forecast made it WORSE in every logged situation (60 min: 50 -> 61 with dose + meal, 54 ->
// 71 for a correction), because most of the day is unlogged and the sensor's own momentum already
// contains what is happening. A quarter of it was the best measured (50 -> 49, 54 -> 51). The same
// arithmetic is very good at something else: the LANDING tells the risk (under 70: he went low 6
// times in 10, 70-120: 2 in 10). So the balance decides the warning, this decides the shape.
//
// THE LOW WARNING IS ITS OWN NUMBER. The point forecast is an average and a low is a dip: a 30-minute
// forecast under 70 came before 0 of his 74 lows. A ridge fitted on one thing only, the LOWEST value of
// the coming hour, does see them. 58 held-out days, 113 lows, 45 of them under 54, one warning an hour,
// counted the way scoreForecasts counts them live, sent at least ten minutes before the low:
//     the risk table at 30 %       47 % of lows warned, 2.1 false alarms a day, 20 of the 45
//     this ridge                   67 %, 2.4, 30 of the 45, typically 25 minutes ahead
// At least five minutes before: 54 % against 77 %. A dedicated logistic did no better. Half of these
// warnings prove right, and the sentence says so.
//
// Pure TS, no Deno or Node APIs: it runs in the edge functions and under the Node test runner.

export const GRID_MIN = 5;
const GRID_MS = GRID_MIN * 60000;
/** How far back a feature looks, in grid steps. The first five must exist; the rest are filled. */
const LAGS = [0, 1, 2, 3, 4, 6, 9, 12, 18, 24];
const REQUIRED_RECENT = 5;
/** A hole this many grid steps long, between two readings, is crossed along the line joining them. See below. */
export const CROSSED_HOLE_STEPS = 4;
export const FORECAST_HORIZONS = [30, 60] as const;
export type Horizon = (typeof FORECAST_HORIZONS)[number];
/** Weight of the logged insulin and carbs in the point forecast. See the header. */
export const PHYSICS_WEIGHT = 0.25;
/** Below this many grid points the history cannot carry a model: the damped trend answers instead. */
export const MIN_TRAIN_POINTS = 2000; // about a week
/** Older than this, the data describes a different child: needs move with growth and the seasons. */
export const TRAIN_DAYS = 120;
const RIDGE_LAMBDA = 30;
/** A lowest value predicted under this is worth saying. 73 loses a tenth of the lows to save 0.1 false
 *  alarm a day, and from 77 false alarms grow with no gain. */
export const LOWEST_WARN_BELOW = 75;
/** Climbing faster than this, in mg/dL a minute, there is no fall to warn about yet. Costs no low. */
export const LOWEST_WARN_MAX_SLOPE = 1;
/** One warning an hour. The same words again say nothing new. */
export const LOW_WARN_SILENCE_MIN = 60;
/** Data from the old slow insulin keeps one point in this many once the new one has enough of its own. */
export const OLD_REGIME_KEEP_EVERY = 4;
/** Days of settled data a new slow insulin needs before the fit favours it. Fourteen days alone score
 *  36 / 60 against 35 / 56 for 120 days, and ten days are no better than "nothing changes". Before that
 *  the old model stays: on a simulated change it did as well or better for the first ten days, because
 *  the forecast leans on the last hours of the curve far more than on the long past. */
export const REGIME_SETTLED_DAYS = 14;
/** Fewer days than this of live measurements say nothing worth showing. */
export const MEASURED_MIN_DAYS = 7;
/** How strongly a thin risk cell is pulled toward the overall rate, in pseudo-observations. */
const RISK_PRIOR = 20;
const BAND_MIN_CELL = 60;

export interface Pt { ts: number; value: number }

export interface HorizonModel {
  mu: number[];
  sd: number[];
  /** One weight per feature, then the intercept. Predicts the CHANGE from the current value. */
  w: number[];
  /** p10 and p90 of the error, per band cell, then the overall pair last. */
  band: [number, number][];
}

/** Predicts the fall to the lowest value of the coming hour, from a moment at or above 70. */
export interface LowestModel {
  mu: number[];
  sd: number[];
  w: number[];
  /** Share of the warnings that proved right on this person's own past, or null with too few. */
  right: number | null;
  /** Warnings a day that past would have sent: what the family should expect. */
  perDay: number;
}

export interface RiskTable {
  /** Moments seen, per cell (level x slope x block of four hours). */
  n: number[];
  low60: number[];
  high60: number[];
  low120: number[];
  /** The overall rates, which a thin cell falls back toward. */
  base: { low60: number; high60: number; low120: number };
}

export interface ForecastModel {
  version: 1;
  fittedAt: number;
  tzOffsetMin: number;
  days: number;
  points: number;
  horizons: Record<string, HorizonModel>;
  risk: RiskTable;
  /** Share of the time under 70, per local hour: the hours worth naming. */
  hourLow: number[];
  /** Absent from a model fitted before the low warning existed. */
  lowest?: LowestModel;
  /** What the forecasts really scored, measured against the readings that followed them. */
  live?: LiveScore | null;
  /** What the doses really did, measured the same way. */
  doses?: DoseScore | null;
}

export interface FitOptions {
  /** When the slow insulin changed, in ms. */
  regimeChangedAt?: number | null;
  /** How long that insulin takes to settle, in days. Those days belong to neither insulin. */
  settleDays?: number;
}

export interface HorizonScore {
  n: number;
  /** Typical error of the forecast, and of "nothing changes" on the same moments, in mg/dL. */
  rmse: number;
  noChange: number;
  /** Share within 20 % or 20 mg/dL, and share inside the range. */
  within: number;
  covered: number;
  width: number;
}

export interface LiveScore {
  days: number;
  h30: HorizonScore | null;
  h60: HorizonScore | null;
  lows: number;
  /** Lows with a warning sent 10 to 60 minutes before. */
  lowsWarned: number;
  leadMin: number | null;
  warnings: number;
  /** A warning the family acted on and that never became a low counts as wrong here. */
  warningsRight: number;
}

export interface ForecastPoint {
  minutes: number;
  mgdl: number;
  /** The range it lands in about 8 times in 10. Never a promise. */
  low: number;
  high: number;
}

export interface Forecast {
  source: "learned" | "trend";
  points: ForecastPoint[];
  /** Chance of going under 70 / over 250 in the next hour, under 70 within two hours (0..1). */
  lowRisk60: number | null;
  highRisk60: number | null;
  lowRisk120: number | null;
  /** How many similar past moments stand behind those figures. */
  similarMoments: number;
  /** The lowest value expected in the coming hour, or null without a model that knows. */
  lowest60: number | null;
  /** That value says to warn. See LOWEST_WARN_BELOW. */
  lowWarning: boolean;
  /** How often that warning proved right on this person's past (0..1), or null. */
  lowWarningRight: number | null;
  /** What these forecasts really scored, or null while there is too little to say. */
  measured: LiveScore | null;
}

/**
 * Isolated samples that disagree with their own neighbourhood are removed before anything is fitted.
 * Two patients were mixed minute by minute on nine dates (138 / 67 / 138 / 67...), and nothing real
 * moves 30 mg/dL away from the median of the five minutes around it.
 */
export function despikeStream(pts: Pt[], windowMs = 300000, threshold = 30): Pt[] {
  const s = (pts || []).filter((p) => p && p.value > 0 && Number.isFinite(p.ts)).slice().sort((a, b) => a.ts - b.ts);
  const out: Pt[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < s.length; i++) {
    while (s[i].ts - s[lo].ts > windowMs) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < s.length && s[hi + 1].ts - s[i].ts <= windowMs) hi++;
    // Never the newest point: nothing can confirm it yet, and a real fall looks exactly like a spike
    // for its first minutes. Flat at 110 then 68 gave a "~110" tile under "Prends 12 g de sucre".
    if (i < s.length - 1 && hi - lo + 1 >= 5) {
      const seg = s.slice(lo, hi + 1).map((p) => p.value).sort((a, b) => a - b);
      const mid = seg.length >> 1;
      const med = seg.length % 2 ? seg[mid] : (seg[mid - 1] + seg[mid]) / 2;
      if (Math.abs(s[i].value - med) >= threshold) continue;
    }
    out.push(s[i]);
  }
  return out;
}

/** Mean of each five-minute bucket, NaN where the sensor said nothing. `startMs` is the first bucket. */
export function gridOf(pts: Pt[]): { startMs: number; g: number[] } {
  if (!pts.length) return { startMs: 0, g: [] };
  const b0 = Math.floor(pts[0].ts / GRID_MS);
  const b1 = Math.floor(pts[pts.length - 1].ts / GRID_MS);
  const sum = new Array(b1 - b0 + 1).fill(0);
  const cnt = new Array(b1 - b0 + 1).fill(0);
  for (const p of pts) {
    const k = Math.floor(p.ts / GRID_MS) - b0;
    sum[k] += p.value;
    cnt[k] += 1;
  }
  return { startMs: b0 * GRID_MS, g: sum.map((s, k) => (cnt[k] ? s / cnt[k] : NaN)) };
}

const hourOf = (ms: number, tzOffsetMin: number): number => {
  const m = (((ms / 60000 + tzOffsetMin) % 1440) + 1440) % 1440;
  return m / 60;
};

function olsSlope(vals: number[]): number {
  const n = vals.length;
  const mid = (n - 1) / 2;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mid) * vals[i];
    den += (i - mid) * (i - mid);
  }
  return den ? num / den / GRID_MIN : 0;
}

/** The numbers a prediction is made from, or null when the last twenty minutes are not all there. */
export function featuresAt(g: number[], i: number, hour: number): number[] | null {
  if (i < LAGS[LAGS.length - 1]) {
    // Early in a series the deepest lags fall off the start: treat them like a hole.
  }
  const base: number[] = [];
  for (let k = 0; k < LAGS.length; k++) {
    const j = i - LAGS[k];
    const v = j >= 0 ? g[j] : NaN;
    if (Number.isNaN(v)) {
      if (k < REQUIRED_RECENT) return null;
      base.push(base[k - 1]);
    } else base.push(v);
  }
  const cur = base[0];
  const s20 = olsSlope([base[4], base[3], base[2], base[1], base[0]]);
  const s10 = olsSlope([base[2], base[1], base[0]]);
  const two = 2 * Math.PI * hour / 24;
  let mean = 0;
  let mx = -Infinity;
  let mn = Infinity;
  for (const v of base) {
    mean += v;
    if (v > mx) mx = v;
    if (v < mn) mn = v;
  }
  mean /= base.length;
  return [
    cur, cur - base[1], cur - base[2], cur - base[3], cur - base[4], cur - base[5],
    cur - base[6], cur - base[7], cur - base[8], cur - base[9],
    s20, s10, s10 - s20,
    Math.sin(two), Math.cos(two), Math.sin(2 * two), Math.cos(2 * two), Math.sin(3 * two), Math.cos(3 * two),
    Math.max(cur - 180, 0), Math.max(90 - cur, 0), Math.max(cur - 180, 0) * s20,
    Math.max(120 - cur, 0) * s20, s20 * s20 * Math.sign(s20),
    mean, mx - cur, cur - mn,
  ];
}

const G_EDGES = [85, 110, 140, 180, 230];
const S_EDGES = [-2, -0.7, 0.7, 2];
const CELLS = (G_EDGES.length + 1) * (S_EDGES.length + 1) * 6;

const binOf = (v: number, edges: number[]): number => {
  let b = 0;
  while (b < edges.length && v >= edges[b]) b++;
  return b;
};

/** Which kind of moment this is: level, direction, block of four hours. */
export function riskCell(g: number, slope: number, hour: number): number {
  return binOf(g, G_EDGES) * 30 + binOf(slope, S_EDGES) * 6 + Math.min(5, Math.floor(hour / 4));
}

/** The same numbers, plus how near the line and how fast toward it: a ridge cannot build those itself. */
function lowestFeatures(f: number[]): number[] {
  const cur = f[0];
  const s20 = f[10];
  const s10 = f[11];
  const minutesTo70 = s20 < -0.1 ? Math.min((cur - 70) / -s20, 180) : 180;
  return [
    ...f, Math.max(140 - cur, 0), Math.max(110 - cur, 0), Math.min(s20, 0), Math.min(s10, 0),
    1 / (1 + minutesTo70 / 30), Math.max(110 - cur, 0) * Math.min(s20, 0),
  ];
}

const warnsOfLow = (lowest: number, slope: number): boolean =>
  lowest < LOWEST_WARN_BELOW && slope <= LOWEST_WARN_MAX_SLOPE;

const P_EDGES = [90, 140, 200];
const bandCell = (predicted: number, slope: number): number =>
  binOf(predicted, P_EDGES) * 2 + (Math.abs(slope) >= 1 ? 1 : 0);

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q;
  const a = Math.floor(p);
  const b = Math.min(sorted.length - 1, a + 1);
  return sorted[a] + (sorted[b] - sorted[a]) * (p - a);
}

function solveSymmetric(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

function fitRidge(X: number[][], y: number[]): { mu: number[]; sd: number[]; w: number[] } {
  const n = X.length;
  const d = X[0].length;
  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (const r of X) for (let j = 0; j < d; j++) mu[j] += r[j];
  for (let j = 0; j < d; j++) mu[j] /= n;
  for (const r of X) for (let j = 0; j < d; j++) sd[j] += (r[j] - mu[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / n) + 1e-9;
  const D = d + 1;
  const A = Array.from({ length: D }, () => new Array(D).fill(0));
  const b = new Array(D).fill(0);
  const z = new Array(D).fill(1);
  for (let i = 0; i < n; i++) {
    const r = X[i];
    for (let j = 0; j < d; j++) z[j] = (r[j] - mu[j]) / sd[j];
    for (let p = 0; p < D; p++) {
      const zp = z[p];
      b[p] += zp * y[i];
      const row = A[p];
      for (let q = p; q < D; q++) row[q] += zp * z[q];
    }
  }
  for (let p = 0; p < D; p++) {
    A[p][p] += RIDGE_LAMBDA;
    for (let q = 0; q < p; q++) A[p][q] = A[q][p];
  }
  return { mu, sd, w: solveSymmetric(A, b) };
}

function applyRidge(m: { mu: number[]; sd: number[]; w: number[] }, x: number[]): number {
  let s = m.w[m.w.length - 1];
  for (let j = 0; j < x.length; j++) s += m.w[j] * ((x[j] - m.mu[j]) / m.sd[j]);
  return s;
}

/**
 * Fits the whole model from raw readings. Runs in well under a second on 120 days, so it can live in
 * an edge function and be refreshed at most daily.
 */
export function fitForecastModel(
  rawPoints: Pt[],
  nowMs: number,
  tzOffsetMin: number,
  opts: FitOptions = {},
): ForecastModel | null {
  const fitted = fitOnce(rawPoints, nowMs, tzOffsetMin, opts);
  // Counting the old insulin for less must never cost the model or its warning: with little history
  // it can leave too few moments, and the warnings would stop without anyone being told.
  if (opts.regimeChangedAt != null && (!fitted || !fitted.lowest)) return fitOnce(rawPoints, nowMs, tzOffsetMin, {}) ?? fitted;
  return fitted;
}

function fitOnce(rawPoints: Pt[], nowMs: number, tzOffsetMin: number, opts: FitOptions): ForecastModel | null {
  const since = nowMs - TRAIN_DAYS * 86400000;
  const pts = despikeStream((rawPoints || []).filter((p) => p.ts >= since && p.ts <= nowMs));
  if (pts.length < MIN_TRAIN_POINTS) return null;
  const { startMs, g } = gridOf(pts);
  const n = g.length;
  // A new slow insulin. Once it has enough days of its own they count in full, the days it took to settle
  // not at all, and the old insulin for a quarter. Until then nothing changes: see REGIME_SETTLED_DAYS.
  const changedAt = Number(opts.regimeChangedAt);
  const settledFrom = changedAt + (opts.settleDays ?? 3) * 86400000;
  const reweigh = opts.regimeChangedAt != null && Number.isFinite(changedAt) && changedAt >= since &&
    nowMs - settledFrom >= REGIME_SETTLED_DAYS * 86400000;
  const counts = (i: number): boolean => {
    if (!reweigh) return true;
    const t = startMs + i * GRID_MS;
    if (t >= settledFrom) return true;
    return t < changedAt && i % OLD_REGIME_KEEP_EVERY === 0;
  };
  const feats: (number[] | null)[] = new Array(n).fill(null);
  const slopes = new Array(n).fill(0);
  const hours = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    hours[i] = hourOf(startMs + i * GRID_MS, tzOffsetMin);
    feats[i] = featuresAt(g, i, hours[i]);
    if (feats[i]) slopes[i] = (feats[i] as number[])[10];
  }
  const horizons: Record<string, HorizonModel> = {};
  for (const h of FORECAST_HORIZONS) {
    const steps = h / GRID_MIN;
    const X: number[][] = [];
    const y: number[] = [];
    const at: number[] = [];
    for (let i = 0; i + steps < n; i++) {
      const f = feats[i];
      const t = g[i + steps];
      if (!f || Number.isNaN(t) || !counts(i)) continue;
      X.push(f);
      y.push(t - g[i]);
      at.push(i);
    }
    if (X.length < MIN_TRAIN_POINTS) return null;
    const m = fitRidge(X, y);
    const cells: number[][] = Array.from({ length: (P_EDGES.length + 1) * 2 }, () => []);
    const all: number[] = [];
    for (let k = 0; k < X.length; k++) {
      const change = applyRidge(m, X[k]);
      const res = y[k] - change;
      cells[bandCell(g[at[k]] + change, slopes[at[k]])].push(res);
      all.push(res);
    }
    all.sort((a, b) => a - b);
    const overall: [number, number] = [quantile(all, 0.1), quantile(all, 0.9)];
    const band = cells.map((c): [number, number] => {
      if (c.length < BAND_MIN_CELL) return overall;
      c.sort((a, b) => a - b);
      return [quantile(c, 0.1), quantile(c, 0.9)];
    });
    band.push(overall);
    horizons[String(h)] = { ...m, band: band.map(([a, b]) => [Math.round(a), Math.round(b)]) };
  }

  const risk: RiskTable = {
    n: new Array(CELLS).fill(0), low60: new Array(CELLS).fill(0), high60: new Array(CELLS).fill(0),
    low120: new Array(CELLS).fill(0), base: { low60: 0, high60: 0, low120: 0 },
  };
  let seen = 0;
  const totals = { low60: 0, high60: 0, low120: 0 };
  const lowX: number[][] = [];
  const lowY: number[] = [];
  const lowAt: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = feats[i];
    if (!f || g[i] < 70 || !counts(i)) continue;
    let min60 = Infinity;
    let max60 = -Infinity;
    let min120 = Infinity;
    let c60 = 0;
    let c120 = 0;
    for (let k = 1; k <= 24 && i + k < n; k++) {
      const v = g[i + k];
      if (Number.isNaN(v)) continue;
      c120++;
      if (v < min120) min120 = v;
      if (k <= 12) {
        c60++;
        if (v < min60) min60 = v;
        if (v > max60) max60 = v;
      }
    }
    if (c60 >= 8) {
      lowX.push(lowestFeatures(f));
      lowY.push(min60 - g[i]);
      lowAt.push(i);
    }
    if (c60 < 8 || c120 < 15) continue; // too little of what followed is known to count it
    const c = riskCell(g[i], slopes[i], hours[i]);
    risk.n[c]++;
    seen++;
    if (min60 < 70) { risk.low60[c]++; totals.low60++; }
    if (max60 > 250) { risk.high60[c]++; totals.high60++; }
    if (min120 < 70) { risk.low120[c]++; totals.low120++; }
  }
  if (!seen) return null;
  risk.base = { low60: totals.low60 / seen, high60: totals.high60 / seen, low120: totals.low120 / seen };

  let lowest: LowestModel | undefined;
  if (lowX.length >= MIN_TRAIN_POINTS) {
    const m = fitRidge(lowX, lowY);
    // How often a warning proved right, counted the way one is really sent: one an hour at most.
    let warned = 0;
    let right = 0;
    let quietUntil = -1;
    for (let k = 0; k < lowX.length; k++) {
      const i = lowAt[k];
      if (i < quietUntil || !warnsOfLow(g[i] + applyRidge(m, lowX[k]), slopes[i])) continue;
      warned++;
      if (g[i] + lowY[k] < 70) right++;
      quietUntil = i + LOW_WARN_SILENCE_MIN / GRID_MIN;
    }
    lowest = {
      ...m,
      right: warned >= 20 ? Math.round((right / warned) * 100) / 100 : null,
      perDay: Math.round((warned / Math.max(1, (lowAt[lowAt.length - 1] - lowAt[0]) / 288)) * 10) / 10,
    };
  }

  const lowCount = new Array(24).fill(0);
  const allCount = new Array(24).fill(0);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(g[i]) || !counts(i)) continue;
    const hr = Math.floor(hours[i]) % 24;
    allCount[hr]++;
    if (g[i] < 70) lowCount[hr]++;
  }
  return {
    version: 1, fittedAt: nowMs, tzOffsetMin,
    days: Math.round((pts[pts.length - 1].ts - pts[0].ts) / 86400000),
    points: pts.length, horizons, risk,
    hourLow: lowCount.map((c, i) => (allCount[i] ? Math.round((c / allCount[i]) * 1000) / 1000 : 0)),
    ...(lowest ? { lowest } : {}),
  };
}

const clampMgdl = (v: number): number => Math.max(40, Math.min(450, Math.round(v)));

/** With no model yet: the recent slope, fading out, the way Loop treats momentum. */
export const TREND_FADE_MIN = 15;

function trendForecast(g: number, slope: number, physics: Record<string, number>): Forecast {
  const spread: Record<string, number> = { "30": 30, "60": 55 };
  const capped = Math.max(-4, Math.min(4, slope)); // beyond this a Libre slope is mostly noise
  const points = FORECAST_HORIZONS.map((h) => {
    const change = capped * TREND_FADE_MIN * (1 - Math.exp(-h / TREND_FADE_MIN));
    const mid = g + change + PHYSICS_WEIGHT * (physics[String(h)] ?? 0);
    return { minutes: h, mgdl: clampMgdl(mid), low: clampMgdl(mid - spread[String(h)]), high: clampMgdl(mid + spread[String(h)]) };
  });
  return {
    source: "trend", points, lowRisk60: null, highRisk60: null, lowRisk120: null, similarMoments: 0,
    lowest60: null, lowWarning: false, lowWarningRight: null, measured: null,
  };
}

export interface ForecastArgs {
  /** The stored and live readings, any order, any density. */
  readings: Pt[];
  nowMs: number;
  /** Local time offset, used only when no model is available; a model carries its own. */
  tzOffsetMin?: number;
  model?: ForecastModel | null;
  /** mg/dL that the logged insulin and carbs still have to move by each horizon, signed. */
  physics?: Record<string, number> | null;
}

/** No reading for this long, and the monitor cannot tell where the glucose is. */
export const BLIND_AFTER_MIN = 10;
/** Past this the question is the sensor, not the fall. */
const BLIND_UNTIL_MIN = 30;
/** How steep the last quarter of an hour has to be, in mg/dL a minute. */
const BLIND_SLOPE = -2;
/** From higher up there is time, and a fall from there is usually the dose working. */
const BLIND_FROM_MGDL = 180;

/**
 * Falling when the readings stopped. Holes are common and most falls end well, so this only says something
 * under 180, on a fall steep enough: on 62 days, with one warning an hour shared with the others, it adds
 * 0.03 message a day and comes before one more low under 54.
 */
export function blindFall(readings: Pt[], nowMs: number): { ageMin: number } | null {
  const pts = despikeStream((readings || []).filter((p) => p.ts >= nowMs - 2 * 3600000 && p.ts <= nowMs + 60000));
  const last = pts[pts.length - 1];
  if (!last) return null;
  const ageMin = (nowMs - last.ts) / 60000;
  if (ageMin < BLIND_AFTER_MIN || ageMin > BLIND_UNTIL_MIN || last.value < 70 || last.value > BLIND_FROM_MGDL) return null;
  const seg = pts.filter((p) => p.ts >= last.ts - 15 * 60000);
  if (seg.length < 3 || last.ts - seg[0].ts < 5 * 60000) return null;
  const meanT = seg.reduce((a, p) => a + p.ts, 0) / seg.length;
  const meanV = seg.reduce((a, p) => a + p.value, 0) / seg.length;
  let num = 0;
  let den = 0;
  for (const p of seg) {
    num += (p.ts - meanT) * (p.value - meanV);
    den += (p.ts - meanT) ** 2;
  }
  return den && (num / den) * 60000 <= BLIND_SLOPE ? { ageMin } : null;
}

/** Null when the series cannot support any statement: no fresh reading, or a hole too long to cross. */
export function forecastGlucose(args: ForecastArgs): Forecast | null {
  const recentPts = (args.readings || []).filter((p) => p.ts >= args.nowMs - 3 * 3600000 && p.ts <= args.nowMs + 60000);
  const pts = despikeStream(recentPts);
  if (pts.length < 3) return null;
  const physics = args.physics ?? {};
  const model = args.model && args.model.version === 1 ? args.model : null;
  const tz = model?.tzOffsetMin ?? args.tzOffsetMin ?? 0;
  // Anchored on the newest reading so the last bucket is a full one, not a half-empty clock bucket.
  const lastTs = pts[pts.length - 1].ts;
  const steps = LAGS[LAGS.length - 1] + 1;
  const g = new Array(steps).fill(NaN);
  const cnt = new Array(steps).fill(0);
  for (const p of pts) {
    const k = steps - 1 - Math.floor((lastTs - p.ts) / GRID_MS);
    if (k < 0) continue;
    g[k] = (cnt[k] ? g[k] * cnt[k] + p.value : p.value) / (cnt[k] + 1);
    cnt[k]++;
  }
  // A hole between two readings is the phone or the network, not the sensor, and the glucose went from one
  // to the other all the same. Nearly seven holes a day last ten minutes or more. Refused, they left the
  // forecast silent in the worst place: 7 November, 255 to 73 in half an hour through three of them, and the
  // only warning there was to give never left.
  for (let k = 1; k < steps - 1; k++) {
    if (!Number.isNaN(g[k]) || Number.isNaN(g[k - 1])) continue;
    let next = k + 1;
    while (next < steps && Number.isNaN(g[next])) next++;
    if (next < steps && next - k <= CROSSED_HOLE_STEPS) {
      for (let m = k; m < next; m++) g[m] = g[k - 1] + (g[next] - g[k - 1]) * (m - k + 1) / (next - k + 1);
    }
    k = next;
  }
  const hour = hourOf(lastTs, tz);
  const f = featuresAt(g, steps - 1, hour);
  // The newest reading, not the mean of its bucket: on one-minute data the mean of a real fall put a tile
  // of ~97 under a reading of 68. Measured, the forecast gains from it too (33.6 / 54.1, from 34.2 / 54.5).
  const current = pts[pts.length - 1].value;
  if (Number.isNaN(current)) return null;
  if (!f) {
    // A hole too long to cross in the last twenty minutes: the slope cannot be trusted, so nothing past "same as now".
    return null;
  }
  const slope = f[10];
  if (!model) return trendForecast(current, slope, physics);
  const points: ForecastPoint[] = [];
  for (const h of FORECAST_HORIZONS) {
    const m = model.horizons[String(h)];
    if (!m) return trendForecast(current, slope, physics);
    const change = applyRidge(m, f);
    const mid = current + change + PHYSICS_WEIGHT * (physics[String(h)] ?? 0);
    const cell = m.band[bandCell(current + change, slope)] ?? m.band[m.band.length - 1];
    points.push({ minutes: h, mgdl: clampMgdl(mid), low: clampMgdl(mid + cell[0]), high: clampMgdl(mid + cell[1]) });
  }
  const c = riskCell(current, slope, hour);
  const r = model.risk;
  const rate = (hits: number, base: number) => (hits + RISK_PRIOR * base) / (r.n[c] + RISK_PRIOR);
  const inRangeOrAbove = current >= 70;
  // The logged insulin can only deepen it: a meal on record says nothing about the dip before it lands.
  // It starts from the bucket's mean, as it was fitted: one noisy reading cost 0.5 false alarm a day.
  const lowest = inRangeOrAbove && model.lowest
    ? f[0] + applyRidge(model.lowest, lowestFeatures(f)) +
      PHYSICS_WEIGHT * Math.min(physics["30"] ?? 0, physics["60"] ?? 0, 0)
    : null;
  return {
    source: "learned",
    points,
    lowRisk60: inRangeOrAbove ? rate(r.low60[c], r.base.low60) : null,
    highRisk60: inRangeOrAbove ? rate(r.high60[c], r.base.high60) : null,
    lowRisk120: inRangeOrAbove ? rate(r.low120[c], r.base.low120) : null,
    similarMoments: r.n[c],
    lowest60: lowest == null ? null : clampMgdl(lowest),
    lowWarning: lowest != null && warnsOfLow(lowest, slope),
    lowWarningRight: model.lowest?.right ?? null,
    measured: model.live && model.live.days >= MEASURED_MIN_DAYS ? model.live : null,
  };
}

/** How much harder than the profile says a dose is assumed to hit, before anyone has measured it.
 *  Children vary by about 23 % from one day to the next on insulin need alone (coefficient of variation in
 *  closed-loop studies), which puts the 90th percentile near 1.3; his own 59 known doses needed 1.5. */
export const HARD_HIT_FACTOR = 1.5;
/** Past this a dose stops being a dose. */
export const HARD_HIT_MAX = 2;
/** Fewer doses than this say nothing about how hard his insulin hits. */
const DOSE_SCORE_MIN_FOLLOWED = 15;
/** A month is enough to judge, and short enough that an old insulin stops counting. */
export const DOSE_SCORE_DAYS = 30;
/** What a dose is judged against: the family's own rule. */
export const DOSE_STAYS_ABOVE = 90;
/** A dose is finished with after this. */
const DOSE_WINDOW_MIN = 240;
/** Fewer readings than this are too little to judge a treatment by. */
const DOSE_MIN_POINTS = 6;
/** Doses closer than this are one treatment: a first part and what the second look added. */
const DOSE_SAME_TREATMENT_MIN = 150;
/** And a treatment ends: one dose every two hours for a month is not one verdict. */
const DOSE_TREATMENT_MAX_MIN = 300;
/** How long before a dose the app can have named it. */
const DOSE_FOLLOWED_WITHIN_MIN = 45;

export interface DoseScore {
  days: number;
  /** Treatments with enough readings after them to judge, and how many of those stayed above each line. */
  judged: number;
  stayed90: number;
  stayed70: number;
  /** The same, for the doses that match what the app had just said. */
  followed: number;
  followed90: number;
  /** How hard a dose is assumed to hit from now on. Only ever rises above HARD_HIT_FACTOR. */
  factor: number;
}

/**
 * The action's own score: every treatment against what the glucose did in the four hours after it.
 * Doses less than two and a half hours apart are one treatment with one verdict: the app gives a first
 * part and comes back for the rest, and judging the first part alone until the second would count the
 * same evening twice, once as a success. "Followed" means the app had named about one of those figures just
 * before: those treatments say whether the app is right, and the others say what happens without it. One
 * dose of the family's own in the middle does not take the treatment out of the app's account: that would
 * empty the score, and the side to err on is the one that makes the next dose smaller.
 *
 * It drives the caution as well. Under nine in ten followed treatments staying above 90, the app assumes
 * a harder hit, which only ever means smaller doses. No ratio changes, and the bar cannot fall below its
 * starting point. Worked from the window each time rather than stepped, so the same month cannot push
 * it up twice, and it comes back down by itself once the doses land.
 */
export function scoreDoses(
  doses: { ts: string | number; units: number }[],
  series: Pt[],
  named: { ms: number; units: number }[],
  nowMs: number,
  days = DOSE_SCORE_DAYS,
): DoseScore {
  const stamp = (v: string | number) => (typeof v === "number" ? v : new Date(v).getTime());
  const pts = (series || []).filter((p) => p && p.value > 0 && Number.isFinite(p.ts)).slice().sort((a, b) => a.ts - b.ts);
  const rapid = (doses || [])
    .map((d) => ({ t: stamp(d?.ts), units: Number(d?.units) }))
    .filter((d) => Number.isFinite(d.t) && d.units > 0)
    .sort((a, b) => a.t - b.t);
  const firstAtOrAfter = (ms: number) => {
    let lo = 0;
    let hi = pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].ts < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const asSaid = (d: { t: number; units: number }) => (named || []).some((n) => n && n.ms <= d.t + 5 * 60000
    && d.t - n.ms <= DOSE_FOLLOWED_WITHIN_MIN * 60000 && Math.abs(n.units - d.units) <= 0.5);
  const treatments: { t: number; units: number }[][] = [];
  for (const d of rapid) {
    const open = treatments[treatments.length - 1];
    if (open && d.t - open[open.length - 1].t <= DOSE_SAME_TREATMENT_MIN * 60000 && d.t - open[0].t <= DOSE_TREATMENT_MAX_MIN * 60000) open.push(d);
    else treatments.push([d]);
  }
  const from = nowMs - days * 86400000;
  const until = nowMs - DOSE_WINDOW_MIN * 60000;
  let judged = 0;
  let stayed90 = 0;
  let stayed70 = 0;
  let followed = 0;
  let followed90 = 0;
  for (const parts of treatments) {
    const first = parts[0].t;
    const last = parts[parts.length - 1].t;
    if (first < from || last > until) continue;
    let lowest = Infinity;
    let seen = 0;
    for (let k = firstAtOrAfter(first + 10 * 60000); k < pts.length && pts[k].ts <= last + DOSE_WINDOW_MIN * 60000; k++) {
      seen++;
      if (pts[k].value < lowest) lowest = pts[k].value;
    }
    if (seen < DOSE_MIN_POINTS) continue;
    judged++;
    const above = lowest >= DOSE_STAYS_ABOVE;
    if (above) stayed90++;
    if (lowest >= 70) stayed70++;
    if (parts.some(asSaid)) {
      followed++;
      if (above) followed90++;
    }
  }
  const rate = followed >= DOSE_SCORE_MIN_FOLLOWED ? followed90 / followed : 1;
  const factor = rate >= 0.9 ? HARD_HIT_FACTOR : rate >= 0.8 ? 1.7 : HARD_HIT_MAX;
  return { days, judged, stayed90, stayed70, followed, followed90, factor };
}

/** One forecast as the monitor stored it. */
export interface ForecastLogRow {
  made_at: string | number;
  value_mgdl: number;
  source: string;
  f30: number | null;
  low30: number | null;
  high30: number | null;
  f60: number | null;
  low60: number | null;
  high60: number | null;
  warned: boolean;
}

/** Half an hour before a low has to be clear of it, on the readings there are. */
const LOW_ONSET_CLEAR_STEPS = 6;
const LOW_ONSET_MIN_KNOWN = 4;

/**
 * What the stored forecasts really scored, against the readings that followed them. The backtest says
 * what the model could have done; this says what it did, on the moments it was really asked about.
 * `series` is the stored five-minute series. Only learned forecasts count: the fading trend is what
 * runs when there is no model, and it says nothing about the model.
 */
export function scoreForecasts(rows: ForecastLogRow[], series: Pt[]): LiveScore | null {
  const made = (rows || [])
    .map((r) => ({ ...r, t: typeof r.made_at === "number" ? r.made_at : new Date(r.made_at).getTime() }))
    .filter((r) => r.source === "learned" && Number.isFinite(r.t) && r.value_mgdl > 0)
    .sort((a, b) => a.t - b.t);
  if (!made.length) return null;
  const { startMs, g } = gridOf((series || []).filter((p) => p.value > 0 && Number.isFinite(p.ts)).slice().sort((a, b) => a.ts - b.ts));
  if (!g.length) return null;
  const at = (ms: number): number => g[Math.floor((ms - startMs) / GRID_MS)] ?? NaN;
  const horizon = (minutes: number, mid: "f30" | "f60", lo: "low30" | "low60", hi: "high30" | "high60"): HorizonScore | null => {
    let n = 0, sq = 0, flat = 0, near = 0, inside = 0, width = 0;
    for (const r of made) {
      const y = at(r.t + minutes * 60000);
      const f = r[mid];
      if (Number.isNaN(y) || f == null) continue;
      n++;
      sq += (f - y) ** 2;
      flat += (r.value_mgdl - y) ** 2;
      if (Math.abs(f - y) <= Math.max(20, 0.2 * y)) near++;
      const a = r[lo];
      const b = r[hi];
      if (a != null && b != null) {
        if (y >= a && y <= b) inside++;
        width += b - a;
      }
    }
    if (!n) return null;
    const one = (v: number) => Math.round(v * 10) / 10;
    return {
      n, rmse: one(Math.sqrt(sq / n)), noChange: one(Math.sqrt(flat / n)),
      within: Math.round((near / n) * 100) / 100, covered: Math.round((inside / n) * 100) / 100, width: Math.round(width / n),
    };
  };
  // A low starts with the first value under 70 after thirty minutes above it.
  const first = Math.floor((made[0].t - startMs) / GRID_MS);
  const last = Math.floor((made[made.length - 1].t - startMs) / GRID_MS);
  const sent = made.filter((r) => r.warned);
  let lows = 0;
  let lowsWarned = 0;
  const leads: number[] = [];
  for (let i = Math.max(first, LOW_ONSET_CLEAR_STEPS); i <= last && i < g.length; i++) {
    if (!(g[i] < 70)) continue;
    let known = 0;
    let clear = true;
    for (let k = 1; k <= LOW_ONSET_CLEAR_STEPS; k++) {
      if (Number.isNaN(g[i - k])) continue;
      known++;
      if (g[i - k] < 70) clear = false;
    }
    if (!clear || known < LOW_ONSET_MIN_KNOWN) continue;
    lows++;
    const onset = startMs + i * GRID_MS;
    const before = sent.filter((r) => r.t >= onset - 60 * 60000 && r.t <= onset - 10 * 60000);
    if (before.length) {
      lowsWarned++;
      leads.push(Math.round((onset - before[0].t) / 60000));
    }
  }
  let warnings = 0;
  let warningsRight = 0;
  for (const r of sent) {
    let known = 0;
    let hit = false;
    for (let k = 1; k <= 12; k++) {
      const v = at(r.t + k * GRID_MS);
      if (Number.isNaN(v)) continue;
      known++;
      if (v < 70) hit = true;
    }
    if (known < 8) continue; // what followed is not known yet
    warnings++;
    if (hit) warningsRight++;
  }
  leads.sort((a, b) => a - b);
  return {
    days: Math.round((made.length / 288) * 10) / 10,
    h30: horizon(30, "f30", "low30", "high30"),
    h60: horizon(60, "f60", "low60", "high60"),
    lows, lowsWarned, leadMin: leads.length ? leads[leads.length >> 1] : null, warnings, warningsRight,
  };
}
