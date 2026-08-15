// The glucose curve, on a canvas. Ported from `ui/GlucoseGraph.kt`, including the decisions the
// user made there:
//
//   * NO area fill under the curve — just the zone-coloured line over the target band + gridlines.
//   * Meal = RED (it sends glucose UP), insulin = GREEN (it brings glucose DOWN). The user's mnemonic.
//   * TAPPING A MARKER SHOWS IT, IT DOES NOT OPEN IT. A tap raises a badge naming the record; the
//     badge is the door to the editor. A finger landing on a dot while reading the curve must never
//     throw the user into a form they did not ask for.
//   * Tap targets are sized in CSS pixels (~44 px), not device pixels — the Android bug was a 44 px
//     target that came out under 15 dp on a 3x screen, so most taps missed.

import { HIGH, HIGH_WARN, LOW, LOW_WARN, statusOf } from "./zones.js";
import { hhmm } from "./util.js";

const COLOR = {
  good: "#10B981",
  warning: "#F59E0B",
  danger: "#FB7185",
  grid: "#E6ECF3",
  band: "rgba(16, 185, 129, 0.07)",
  axis: "#94A3B8",
  meal: "#F43F5E",
  insulin: "#059669",
};

const PAD = { left: 34, right: 10, top: 14, bottom: 20 };
const TAP_RADIUS = 22;   // CSS px — half of the ~44 px a finger needs

/**
 * Draw the curve and return a hit-tester.
 *
 * @param canvas   the <canvas> to draw into
 * @param readings [{ts, value}] ascending
 * @param events   [{ts, kind: "meal"|"insulin", label}] to mark on the curve
 * @returns {{ hit(x, y): object|null }} x/y in CSS pixels relative to the canvas
 */
export function drawGraph(canvas, readings, events = []) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 180;
  // Backing store in device pixels, drawing in CSS pixels — otherwise the line is soft on a retina
  // screen, which is every iPhone.
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const pts = (readings ?? []).filter((r) => r && Number.isFinite(r.value) && Number.isFinite(r.ts));
  if (pts.length < 2) return { hit: () => null };

  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const span = Math.max(1, t1 - t0);

  // The window always shows the target band even when the glucose never leaves it, so the curve is
  // read against a fixed reference rather than against a rescaled one.
  const vals = pts.map((p) => p.value);
  const minV = Math.min(LOW - 10, ...vals) - 5;
  const maxV = Math.max(HIGH + 20, ...vals) + 5;
  const rangeV = Math.max(1, maxV - minV);

  const plotW = cssW - PAD.left - PAD.right;
  const plotH = cssH - PAD.top - PAD.bottom;
  const xOf = (t) => PAD.left + ((t - t0) / span) * plotW;
  const yOf = (v) => PAD.top + ((maxV - Math.min(maxV, Math.max(minV, v))) / rangeV) * plotH;

  // Target band 70–170.
  g.fillStyle = COLOR.band;
  g.fillRect(PAD.left, yOf(HIGH_WARN), plotW, yOf(LOW_WARN) - yOf(HIGH_WARN));

  // Gridlines + left axis labels at the four thresholds the alarms use.
  g.strokeStyle = COLOR.grid;
  g.lineWidth = 1;
  g.font = "10px -apple-system, system-ui, sans-serif";
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (const v of [LOW, LOW_WARN, HIGH_WARN, HIGH]) {
    const y = Math.round(yOf(v)) + 0.5;
    g.beginPath();
    g.moveTo(PAD.left, y);
    g.lineTo(cssW - PAD.right, y);
    g.stroke();
    g.fillStyle = COLOR.axis;
    g.fillText(String(v), PAD.left - 5, y);
  }

  // The curve, segment by segment so each piece carries its own zone colour.
  g.lineWidth = 2.5;
  g.lineJoin = "round";
  g.lineCap = "round";
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    g.strokeStyle = COLOR[statusOf(b.value)];
    g.beginPath();
    g.moveTo(xOf(a.ts), yOf(a.value));
    g.lineTo(xOf(b.ts), yOf(b.value));
    g.stroke();
  }

  // The window's peak and trough, in their zone colour, so the high and the low read at a glance.
  const peak = pts.reduce((m, p) => (p.value > m.value ? p : m), pts[0]);
  const trough = pts.reduce((m, p) => (p.value < m.value ? p : m), pts[0]);
  g.font = "bold 10px -apple-system, system-ui, sans-serif";
  for (const p of [peak, trough]) {
    g.fillStyle = COLOR[statusOf(p.value)];
    g.textAlign = "center";
    g.fillText(String(p.value), Math.min(cssW - PAD.right - 10, Math.max(PAD.left + 10, xOf(p.ts))),
      p === peak ? yOf(p.value) - 8 : yOf(p.value) + 12);
  }

  // Time ticks: first and last.
  g.fillStyle = COLOR.axis;
  g.font = "10px -apple-system, system-ui, sans-serif";
  g.textBaseline = "top";
  g.textAlign = "left";
  g.fillText(hhmm(t0), PAD.left, cssH - PAD.bottom + 4);
  g.textAlign = "right";
  g.fillText(hhmm(t1), cssW - PAD.right, cssH - PAD.bottom + 4);

  // The live point.
  const last = pts[pts.length - 1];
  g.fillStyle = COLOR[statusOf(last.value)];
  g.beginPath();
  g.arc(xOf(last.ts), yOf(last.value), 4, 0, Math.PI * 2);
  g.fill();

  // ── Event markers ────────────────────────────────────────────────────────────────────────────
  // Only events inside the window, placed at the glucose value they happened at so a dot sits ON
  // the curve rather than floating.
  const valueAt = (ts) => {
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
    return best.value;
  };

  const shown = (events ?? [])
    .filter((e) => e && e.ts >= t0 && e.ts <= t1)
    .sort((a, b) => a.ts - b.ts);

  const hits = [];
  // A meal and a dose logged together are two same-size circles almost on top of each other. The
  // OLDER one sits behind, offset a little, so it peeks out as a crescent; the newer is drawn on
  // top with a white ring separating the two.
  for (let i = 0; i < shown.length; i++) {
    const e = shown[i];
    const x = xOf(e.ts);
    const y = yOf(valueAt(e.ts));
    const coincident = i > 0 && Math.abs(shown[i - 1].ts - e.ts) < 3 * 60_000;
    const cx = coincident ? x + 2 : x;
    if (coincident) {
      g.strokeStyle = "#FFFFFF";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, y, 6, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = e.kind === "meal" ? COLOR.meal : COLOR.insulin;
    g.beginPath();
    g.arc(cx, y, 5.5, 0, Math.PI * 2);
    g.fill();
    hits.push({ x: cx, y, event: e });
  }

  return {
    /** The event nearest a tap within the finger-sized radius, or null. */
    hit(px, py) {
      let best = null, bestD = TAP_RADIUS;
      for (const h of hits) {
        const d = Math.hypot(h.x - px, h.y - py);
        if (d <= bestD) { bestD = d; best = h; }
      }
      return best ? { ...best.event, x: best.x, y: best.y } : null;
    },
  };
}
