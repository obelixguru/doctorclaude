package com.drclaude.data

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Client-side proactive prediction — a pure-Kotlin mirror of the server's `predictiveAdvice`
 * (supabase/functions/_shared/doseGuard.ts) so the dashboard can show a heads-up LIVE, the
 * instant a new reading arrives, without a round-trip. SUGGESTION only — never a dose.
 *
 *   HIGH_SOON  heading toward a hyper within the horizon -> get ready to correct once high
 *   WATCH_FALL / WATCH_RISE  drifting that way, keep an eye on it
 * (No "low soon": we NEVER tell the user to eat sugar pre-emptively — sugar is only for an actual
 *  hypo, owned by the dose guard. Kept out of the enum so it can't be re-introduced by accident.)
 */
enum class PredictKind { NONE, HIGH_SOON, WATCH_FALL, WATCH_RISE }

data class Prediction(
    val kind: PredictKind,
    val minutes: Int,
    val projected: Int?
) {
    val isActionable: Boolean get() = kind != PredictKind.NONE
}

/**
 * Removes noisy-source artefacts for charting & prediction: dedupe to one reading per 5-min
 * bucket (keep the latest = the live measurement, which tracks the real curve) then drop isolated
 * up-spikes (a point >40 mg/dL above BOTH neighbours within 25 min). NEVER drops lows/hypos.
 * Mirrors the server's `cleanSeries` (mechabetics-history) so every view agrees.
 *
 * `maxAgeMs` bounds how far back to keep: the home graph only needs ~24 h (default 26 h), but the
 * advanced History screen passes ~14 days so its day-by-day chips/graph span the real history
 * instead of being capped to today + yesterday.
 */
fun cleanGlucoseSeries(
    history: List<GlucoseReading>,
    maxAgeMs: Long = 26L * 60 * 60 * 1000,
): List<GlucoseReading> {
    val now = System.currentTimeMillis()
    val byBucket = HashMap<Long, GlucoseReading>()
    for (r in history) {
        if (r.valueMgDl <= 0) continue
        if (r.timestampMs > now + 120000L) continue // drop future-dated points (bad-timezone artefact)
        if (r.timestampMs < now - maxAgeMs) continue // drop points older than the requested window
        val b = r.timestampMs / 300000L
        val ex = byBucket[b]
        if (ex == null || r.timestampMs > ex.timestampMs) byBucket[b] = r
    }
    val pts = byBucket.values.sortedBy { it.timestampMs }
    if (pts.size < 3) return pts
    val out = ArrayList<GlucoseReading>(pts.size)
    for (i in pts.indices) {
        val cur = pts[i]
        if (i == 0 || i == pts.size - 1) { out.add(cur); continue }
        val prev = pts[i - 1]; val next = pts[i + 1]
        val dp = (cur.timestampMs - prev.timestampMs) / 60000.0
        val dn = (next.timestampMs - cur.timestampMs) / 60000.0
        val upSpike = dp <= 25 && dn <= 25 &&
            cur.valueMgDl > prev.valueMgDl + 40 && cur.valueMgDl > next.valueMgDl + 40
        if (!upSpike) out.add(cur)
    }
    return out
}

/**
 * Live "is the glucose rising right now?" from the recent ~20-min slope — mirrors the server's
 * rising-trend gate used for the meal nudge. Lets the dashboard decide the nudge WITHOUT a server
 * round-trip and, crucially, re-evaluate it on every reading so it never goes stale (the old sticky
 * server flag lingered after the rise ended). False on a too-short or stale series (never nudge off
 * a frozen curve). `slope > 0.3` ≈ rising by more than ~6 mg/dL over the 20-min window.
 */
fun glucoseRisingNow(history: List<GlucoseReading>): Boolean {
    val pts = cleanGlucoseSeries(history)
    if (pts.size < 2) return false
    val last = pts.last()
    if (System.currentTimeMillis() - last.timestampMs > GlucoseAlert.FRESHNESS_WINDOW_MS) return false
    val windowStart = last.timestampMs - 20 * 60_000L
    val first = pts.firstOrNull { it.timestampMs >= windowStart } ?: pts.first()
    val mins = (last.timestampMs - first.timestampMs) / 60_000.0
    val slope = if (mins > 0) (last.valueMgDl - first.valueMgDl) / mins else 0.0
    return slope > 0.3
}

object Predictor {
    const val LOW = 70
    const val HIGH = 180
    // The proactive banner fires ONLY near the edges of range, never on harmless mid-range drift:
    // "falling, keep sugar nearby" only when ALREADY below 90, "rising, watch" only when ALREADY
    // above 160 (the user's rule — a 120→110 dip is in-range and must stay silent).
    const val FALL_WATCH_BELOW = 90
    const val RISE_WATCH_ABOVE = 160

    fun of(history: List<GlucoseReading>, horizonMin: Int = 30): Prediction {
        val pts = cleanGlucoseSeries(history)
        if (pts.size < 2) return Prediction(PredictKind.NONE, 0, pts.lastOrNull()?.valueMgDl)
        val last = pts.last()
        // Signal lost: the newest point is too old to trust — never extrapolate a heads-up off a
        // frozen value (mirrors GlucoseAlert's freshness gate; the dashboard shows NO SIGNAL instead).
        if (System.currentTimeMillis() - last.timestampMs > GlucoseAlert.FRESHNESS_WINDOW_MS)
            return Prediction(PredictKind.NONE, 0, last.valueMgDl)
        val windowStart = last.timestampMs - 20 * 60_000L
        val first = pts.firstOrNull { it.timestampMs >= windowStart } ?: pts.first()
        val mins = (last.timestampMs - first.timestampMs) / 60_000.0
        val slope = if (mins > 0) (last.valueMgDl - first.valueMgDl) / mins else 0.0
        val cur = last.valueMgDl
        val projected = (cur + slope * horizonMin).coerceIn(20.0, 600.0).toInt()
        fun minsTo(target: Int): Double =
            if (abs(slope) < 1e-6) Double.POSITIVE_INFINITY else (target - cur) / slope

        // Falling AND already near the low end (70–89) → "keep sugar nearby + watch". We never tell
        // the user to pre-emptively EAT sugar (that's only a real hypo <70, owned by the dose guard).
        // Gated on the CURRENT value, not the projection, so a mid-range dip (120→110) stays silent.
        if (slope < -0.3 && cur in LOW until FALL_WATCH_BELOW) {
            return Prediction(PredictKind.WATCH_FALL, horizonMin, projected)
        }
        // Rising AND already above 160 (161–180) → heads-up. Below 160 a rise is still well in range.
        if (slope > 0.3 && cur > RISE_WATCH_ABOVE && cur <= HIGH) {
            val m = minsTo(HIGH)
            if (m > 0 && m <= horizonMin) return Prediction(PredictKind.HIGH_SOON, m.roundToInt(), projected)
            return Prediction(PredictKind.WATCH_RISE, horizonMin, projected)
        }
        return Prediction(PredictKind.NONE, 0, projected)
    }
}
