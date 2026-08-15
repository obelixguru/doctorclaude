// The five glucose zones — a direct mirror of `_shared/alertZones.ts` and of the app's
// `data/GlucoseAlert.kt` / `ui/theme/Color.kt:statusOf`.
//
// The user's rule, quoted in alertZones.ts: "il faut qu'elle sonne dans les mêmes moments". Colour
// and sound must agree everywhere — red is what alerts, orange is what is merely watched — so these
// thresholds are duplicated deliberately rather than derived, and any change has to land in all
// three places at once (server, Android, here).
//
//   < 60      red      alerts
//   60–69     amber    shown, never alerts
//   70–170    normal
//   171–180   amber    shown, never alerts
//   > 180     red      alerts

export const LOW = 60;
export const LOW_WARN = 70;
export const HIGH_WARN = 170;
export const HIGH = 180;
export const VERY_LOW = 54;

/** "red_low" | "amber_low" | "normal" | "amber_high" | "red_high" */
export function zoneOf(v) {
  if (v == null || !Number.isFinite(v)) return "normal";
  if (v < LOW) return "red_low";
  if (v < LOW_WARN) return "amber_low";
  if (v > HIGH) return "red_high";
  if (v > HIGH_WARN) return "amber_high";
  return "normal";
}

/** The three-colour status the cards and the curve paint with: good / warning / danger. */
export function statusOf(v) {
  const z = zoneOf(v);
  if (z === "red_low" || z === "red_high") return "danger";
  if (z === "amber_low" || z === "amber_high") return "warning";
  return "good";
}

/** Does this zone ring? Only red does — the same moments the Telegram monitor sends 🚨. */
export const zoneAlerts = (z) => z === "red_low" || z === "red_high";

/**
 * Time-weighted low / in-range / high percentages over a window of `{ ts, value }` readings.
 *
 * A port of `tirSplit` in the phone's ui/HistoryScreen.kt:410 ("same method as the server +
 * DayStats"), kept here beside the thresholds so one family can never read two different numbers
 * for the same person on two screens. Two things it does NOT do, both of which it used to:
 *
 *   • It does not count readings. Each reading holds until the next one, capped at 30 min, so a
 *     sensor gap or a night with the phone off cannot swallow the window — and a dense stretch of
 *     readings cannot outweigh a sparse one.
 *   • It does not treat the amber watch band as out of range. Out is < LOW_WARN / > HIGH: what the
 *     app actually rings for, and the range time-in-range is read against clinically. 171–180 is
 *     "shown, never alerts" per the zone table above, so it counts as in range.
 */
export function timeInRange(readings) {
  const pts = (readings ?? [])
    .filter((r) => r && Number.isFinite(r.ts) && Number.isFinite(r.value))
    .sort((a, b) => a.ts - b.ts);
  let low = 0, inRange = 0, high = 0, total = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const w = Math.min(Math.max((pts[k + 1].ts - pts[k].ts) / 60000, 0), 30);
    total += w;
    const v = pts[k].value;
    if (v < LOW_WARN) low += w;
    else if (v > HIGH) high += w;
    else inRange += w;
  }
  const pct = (x) => (total > 0 ? Math.round((x / total) * 100) : 0);
  return { low: pct(low), inRange: pct(inRange), high: pct(high) };
}

/**
 * Should this new reading raise an alert, and why? Null means silence.
 *
 * Ported from `alertZones.zoneAlert`: entering a worse zone alerts once, sitting in a zone is
 * silent however long it lasts, and only a further whole step AWAY from range (or crossing into
 * severe hypo) speaks up again. Without the step rule a value parked at 250 would nag forever;
 * without the severe-hypo exception 55 → 50 would stay silent, because no multiple of 10 lies
 * between them.
 */
export function zoneAlert(prev, cur) {
  const SEVERITY = { normal: 0, amber_low: 1, amber_high: 1, red_low: 2, red_high: 2 };
  const WARN_DEADBAND = 2, STEP_HIGH = 10, STEP_LOW = 5;
  const zCur = zoneOf(cur), zPrev = zoneOf(prev);

  if (zCur === "normal") {
    // "Back to normal" needs the same deadband as entering a band, or a value hovering on 170
    // alternates ⚠️ and ✅ for as long as it sits there.
    const clearlyBack = cur <= HIGH_WARN - WARN_DEADBAND && cur >= LOW_WARN + WARN_DEADBAND;
    return zPrev !== "normal" && clearlyBack ? { zone: zCur, reason: "recovery", severe: false } : null;
  }

  const severeCrossed = cur < VERY_LOW && prev >= VERY_LOW;
  if (severeCrossed) return { zone: zCur, reason: "severe", severe: true };

  const worsened = SEVERITY[zCur] > SEVERITY[zPrev];
  // Entering amber only counts once the value is clearly inside the band (anti-flapping).
  const clearlyInside = zCur === "amber_high" ? cur > HIGH_WARN + WARN_DEADBAND
                      : zCur === "amber_low" ? cur < LOW_WARN - WARN_DEADBAND
                      : true;
  if (worsened && clearlyInside) return { zone: zCur, reason: "enter", severe: cur <= VERY_LOW };

  const steppedFurther = zCur === zPrev && (
    (zCur === "red_high" && cur >= prev + STEP_HIGH) ||
    (zCur === "red_low" && cur <= prev - STEP_LOW)
  );
  if (steppedFurther) return { zone: zCur, reason: "step", severe: cur <= VERY_LOW };

  return null;
}

/** The alert headline + suggested action, keyed to the i18n table. */
export function alertKind(v) {
  const z = zoneOf(v);
  if (z === "red_low") return { titleKey: "alertLow", actKey: "alertActLow" };
  if (z === "red_high") return { titleKey: "alertHigh", actKey: "alertActHigh" };
  return null;
}
