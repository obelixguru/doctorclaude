// Glucose ALERT ZONES — the single spec behind all three channels: the in-app alarm, the local push
// notification (both in the Android app, data/GlucoseAlert.kt + data/AlarmEngine.kt) and the
// Telegram monitor (mechabetics-monitor). The user's rule: "il faut qu'elle sonne dans les mêmes
// moments" — so the thresholds and the re-alerting rules live in one place per side, and the two
// sides are kept deliberately identical.
//
//   < 60      🚨 red      alerts / sounds
//   60–69     ⚠️ amber    shown, never sounds
//   70–170       normal   one "back to normal" message on return
//   171–180   ⚠️ amber    shown, never sounds
//   > 180     🚨 red      alerts / sounds
//
// Pure TypeScript (no Deno/Node APIs) so it imports in the edge runtime AND runs under the test
// runner, like the other _shared modules.

export const LOW = 60;         // red-low ceiling
export const LOW_WARN = 70;    // amber-low ceiling (60–69 is "presque bas")
export const HIGH_WARN = 170;  // amber-high floor (171–180 is "presque haut")
export const HIGH = 180;       // red-high floor
export const VERY_LOW = 54;    // "TRÈS BASSE" wording, and a crossing that always alerts

/** Re-entering an amber zone needs this much margin past the boundary, so a value hovering on the
 *  line (169 → 172 → 168 → 171…) doesn't send a message on every wobble. */
export const WARN_DEADBAND = 2;
/** While already in a red zone, only a further whole step AWAY from range alerts again. */
export const STEP_HIGH = 10;
export const STEP_LOW = 5;

export type Zone = "red_low" | "amber_low" | "normal" | "amber_high" | "red_high";

export function zoneOf(v: number): Zone {
  if (v < LOW) return "red_low";
  if (v < LOW_WARN) return "amber_low";
  if (v > HIGH) return "red_high";
  if (v > HIGH_WARN) return "amber_high";
  return "normal";
}

const SEVERITY: Record<Zone, number> = { normal: 0, amber_low: 1, amber_high: 1, red_low: 2, red_high: 2 };

export interface ZoneAlert {
  zone: Zone;
  /** "recovery" = back inside 70–170; "enter" = a worse zone; "step" = further out again. */
  reason: "recovery" | "enter" | "step" | "severe";
  severe: boolean;
}

/**
 * Should this new reading alert, and why? Returns null for silence. Three rules:
 *
 *  1. Entering a worse zone alerts once. Improving is silent, except the single "back to normal"
 *     when the value reaches 70–170.
 *  2. Staying in a zone is silent however long it lasts — unless the glucose moves a further whole
 *     step AWAY from range, or crosses into severe hypo, which always alerts (55 → 50 used to be
 *     silent because no multiple of 10 lay between them).
 *  3. An amber zone needs [WARN_DEADBAND] past the boundary before it alerts again.
 *
 * @param prev the previous reading, @param cur the new one.
 */
export function zoneAlert(prev: number, cur: number): ZoneAlert | null {
  const zCur = zoneOf(cur);
  const zPrev = zoneOf(prev);
  if (zCur === "normal") {
    // "Back to normal" needs the same deadband as entering a band, or a value sitting on 170 sends
    // ⚠️ and ✅ alternately for as long as it hovers.
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

/** The Telegram message for a reading, or null for silence. `name` is the patient's OWN first name
 *  (from LibreLinkUp) so an account following several people never mislabels a value. */
export function alertMessage(prev: number, cur: number, name: string): string | null {
  const a = zoneAlert(prev, cur);
  if (!a) return null;
  if (a.reason === "recovery") return `✅ <b>Glycémie de ${name} revenue à la normale</b> : ${cur} mg/dL`;
  switch (a.zone) {
    case "red_low":
      return a.severe
        ? `🚨 <b>Glycémie de ${name} : ${cur} mg/dL — TRÈS BASSE</b>\nResucrage immédiat (15 g de sucre rapide).`
        : `🚨 <b>Glycémie de ${name} : ${cur} mg/dL — basse</b>`;
    case "amber_low":
      return `⚠️ <b>Glycémie de ${name} : ${cur} mg/dL — presque basse</b>`;
    case "amber_high":
      return `⚠️ <b>Glycémie de ${name} : ${cur} mg/dL — presque haute</b>`;
    case "red_high":
      return `🚨 <b>Glycémie de ${name} : ${cur} mg/dL — haute</b>`;
    default:
      return null;
  }
}
