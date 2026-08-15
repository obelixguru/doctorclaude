// Pure SVG builder for the glucose chart attached to the parent's Telegram alerts.
// NO Deno/Node APIs — just string building — so the exact same source renders in the
// edge runtime (resvg-wasm) and offline (resvg-js) for eyeballing.
//
// This MIRRORS the in-app homepage graph (ui/GlucoseGraph.kt) so the Telegram image
// reads like the screen the parent knows: same 24 h window, same y-scale formula, the
// soft green target band (70–180), y-axis ticks (50/70/100/180/200/300…), FIVE time
// labels along the bottom, a 45-min gap break, and the curve COLOURED BY ZONE
// (green in 80–169, amber near the edges, red in hypo/hyper). Text needs a font passed
// to resvg (it ships none) — see renderGraphPng in the monitor.

export interface GlucosePoint {
  t: number; // epoch ms (UTC)
  v: number; // mg/dL
}

export interface ChartOpts {
  width?: number;
  height?: number;
  tzOffsetMin?: number; // minutes to add to UTC for the x-axis labels (Europe/Paris = +120 in summer)
  gapMs?: number; // break the line across gaps longer than this (default 45 min, matches the app)
}

const r1 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0);
const pad2 = (n: number): string => String(n).padStart(2, "0");

// Five-zone colour, identical to the app's colorFor()/statusOf():
//   <70 or >180 → red (DANGER) · 70-79 or 170-180 → amber (WARNING) · 80-169 → green (GOOD)
function zoneColor(v: number): string {
  if (v < 70 || v > 180) return "#E11D48";
  if (v < 80 || v >= 170) return "#F59E0B";
  return "#10B981";
}

export function buildGlucoseSvg(points: GlucosePoint[], opts: ChartOpts = {}): string {
  const W = opts.width ?? 800;
  const H = opts.height ?? 400;
  const off = opts.tzOffsetMin ?? 0;
  const GAP = opts.gapMs ?? 45 * 60 * 1000;

  const leftPad = 48, rightPad = 16, topPad = 14, bottomPad = 30;
  const plotW = W - leftPad - rightPad;
  const plotH = H - topPad - bottomPad;
  const baselineY = topPad + plotH;

  const pts = points
    .filter((p) => Number.isFinite(p.t) && p.v > 0)
    .sort((a, b) => a.t - b.t);

  const blank = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/></svg>`;
  if (pts.length < 2) return blank;

  const dataMax = Math.max(...pts.map((p) => p.v));
  const dataMin = Math.min(...pts.map((p) => p.v));
  // Identical scale formula to the app so the curve has the same vertical proportions.
  const maxV = Math.max(220, Math.ceil((dataMax + 15) / 20) * 20);
  const minV = Math.max(10, Math.min(50, Math.floor((dataMin - 10) / 10) * 10));
  const range = Math.max(1, maxV - minV);

  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const useDate = span > 30 * 3600_000;

  const X = (t: number) => r1(leftPad + ((t - t0) / span) * plotW);
  const Y = (v: number) => r1(topPad + ((maxV - Math.max(minV, Math.min(maxV, v))) / range) * plotH);

  const fmtX = (t: number): string => {
    const d = new Date(t + off * 60000); // shift to local, then read via UTC getters
    return useDate
      ? `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`
      : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  };

  // Soft green target band (70–180).
  const band = `<rect x="${leftPad}" y="${Y(180)}" width="${plotW}" height="${r1(Y(70) - Y(180))}" fill="#10B981" fill-opacity="0.08"/>`;

  // Y gridlines + labels at 50/70/100/180/200/300… (only those inside the visible range).
  const ticks: number[] = [];
  const pushTick = (n: number) => { if (n >= minV && n <= maxV && !ticks.includes(n)) ticks.push(n); };
  pushTick(70); pushTick(180);
  for (let v = 100; v <= maxV; v += 100) pushTick(v);
  if (minV <= 50) pushTick(50);
  ticks.sort((a, b) => a - b);
  let yAxis = "";
  for (const v of ticks) {
    const y = Y(v);
    const strong = v === 70 || v === 180;
    yAxis += `<line x1="${leftPad}" y1="${y}" x2="${r1(leftPad + plotW)}" y2="${y}" stroke="#E6ECF3" stroke-width="1" stroke-opacity="${strong ? 0.9 : 0.45}"/>`;
    yAxis += `<text x="${leftPad - 8}" y="${r1(y + 6)}" font-family="Inter" font-size="20" fill="#8A93A2" text-anchor="end">${v}</text>`;
  }

  // Five evenly-spaced time labels along the bottom.
  let xAxis = "";
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const t = t0 + frac * span;
    const anchor = i === 0 ? "start" : i === 4 ? "end" : "middle";
    const x = i === 0 ? leftPad : i === 4 ? leftPad + plotW : r1(leftPad + frac * plotW);
    xAxis += `<text x="${x}" y="${H - 8}" font-family="Inter" font-size="20" fill="#8A93A2" text-anchor="${anchor}">${fmtX(t)}</text>`;
  }

  // Curve: contiguous runs (gap > 45 min breaks both the area and the line). Each run gets a
  // green→transparent area fill; the line is split into per-segment strokes coloured by zone.
  let area = "", line = "";
  let i = 0;
  while (i < pts.length) {
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].t - pts[j].t <= GAP) j++;
    if (j > i) {
      let d = `M ${X(pts[i].t)} ${baselineY}`;
      for (let k = i; k <= j; k++) d += ` L ${X(pts[k].t)} ${Y(pts[k].v)}`;
      d += ` L ${X(pts[j].t)} ${baselineY} Z`;
      area += `<path d="${d}" fill="url(#area)"/>`;
      for (let k = i; k < j; k++) {
        const a = pts[k], b = pts[k + 1];
        line += `<line x1="${X(a.t)}" y1="${Y(a.v)}" x2="${X(b.t)}" y2="${Y(b.v)}" stroke="${zoneColor(Math.round((a.v + b.v) / 2))}" stroke-width="4" stroke-linecap="round"/>`;
      }
    }
    i = j + 1;
  }

  const last = pts[pts.length - 1];
  const dot = `<circle cx="${X(last.t)}" cy="${Y(last.v)}" r="7" fill="${zoneColor(last.v)}" stroke="#ffffff" stroke-width="2.5"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="area" gradientUnits="userSpaceOnUse" x1="0" y1="${topPad}" x2="0" y2="${baselineY}">` +
    `<stop offset="0" stop-color="#059669" stop-opacity="0.16"/><stop offset="1" stop-color="#059669" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    band + yAxis + xAxis + area + line + dot +
    `<rect x="${leftPad}" y="${topPad}" width="${plotW}" height="${plotH}" fill="none" stroke="#E6ECF3" stroke-width="1"/>` +
    `</svg>`
  );
}
