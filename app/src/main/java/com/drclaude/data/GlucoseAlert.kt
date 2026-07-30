package com.drclaude.data

/**
 * A glucose-driven alert level. One detection feeds three outputs: the on-phone ringing
 * alarm, the auto-spoken instant analysis, and the red-flag banner on the dashboard.
 *
 * Five zones, one spec for all three channels (in-app, local push, Telegram): red below 60 and above
 * 180 (these SOUND), amber 60–69 and 171–180 (shown, silent), normal 70–170. [LOW]/[HIGH] (70/180)
 * remain the in-range band used by Predictor / statusOf / the TIR bar — the alarm zones are the
 * ALARM_* constants and are deliberately separate from it.
 *
 * The rapid-slope flags (>= 2 mg/dL per minute) are badges only; the fast-FALL alarm was removed on
 * the user's instruction, so nothing in range ever sounds.
 *
 * A stale reading (older than [FRESHNESS_WINDOW_MS]) is treated as "signal lost" → NONE, so the
 * alarm is never raised on (nor suppressed by) an out-of-date value.
 */
enum class AlertKind {
    NONE,
    LOW,        // red, rings:   < ALARM_LOW (60)
    LOW_WARN,   // orange, quiet: 60–69 — "presque bas"
    HIGH_WARN,  // orange, quiet: 171–180 — "presque haut"
    HIGH,       // red, rings:   > ALARM_HIGH (180)
    RAPID_RISE,
    RAPID_FALL,
}

data class GlucoseAlert(
    val kind: AlertKind,
    val slope: Double, // mg/dL per minute, signed (+ rising, - falling)
    val value: Int
) {
    val isUrgent: Boolean get() = kind != AlertKind.NONE
    val isRapid: Boolean get() = kind == AlertKind.RAPID_RISE || kind == AlertKind.RAPID_FALL

    /** An amber "nearly there" zone: shown, never sounded. */
    val isWarnZone: Boolean get() = kind == AlertKind.LOW_WARN || kind == AlertKind.HIGH_WARN

    /** ONLY a red zone sounds — the same moments the Telegram monitor sends 🚨. A fast fall or rise
     *  is a banner (the fall alarm was dropped on the user's instruction: it fired on in-range values
     *  and made the alarm untrustworthy). The amber zones are informational too. */
    val ringsAlarm: Boolean
        get() = kind == AlertKind.LOW || kind == AlertKind.HIGH

    companion object {
        const val LOW = 70
        const val HIGH = 180 // in-range ceiling (was 170 → alarm fatigue on the acceptable 171–180 band)

        // ── ALERT ZONES — one spec for the three channels (in-app, local push, Telegram). Mirrored in
        //    supabase/functions/mechabetics-monitor/index.ts; change both together.
        //      < 60      red    → sounds / 🚨
        //      60–69     amber  → shown / ⚠️, never sounds
        //      70–170    normal → one "back to normal" message on return
        //      171–180   amber  → shown / ⚠️, never sounds
        //      > 180     red    → sounds / 🚨
        /** Red-low ceiling: below this it sounds. */
        const val ALARM_LOW = 60
        /** Amber-low ceiling: 60–69 is "presque bas" — shown, never sounded. */
        const val ALARM_LOW_WARN = 70
        /** Amber-high floor: 171–180 is "presque haut" — shown, never sounded. */
        const val ALARM_HIGH_WARN = 170
        /** Red-high floor: above this it sounds. */
        const val ALARM_HIGH = 180
        const val RAPID_SLOPE = 2.0 // mg/dL per minute
        /** A reading older than this is "signal lost": we can't know the current glucose, so we must
         *  neither alarm on the stale value nor let it suppress a real alarm (the dashboard shows the
         *  big red NO SIGNAL past this point). Deliberately SHORT — the Libre sends a value every
         *  minute and the official LibreLink flags signal loss within a few minutes, so 5 min (≈5
         *  missed readings, allowing for normal cloud lag) keeps us about as quick as LibreLink. We
         *  re-check it every poll (~60s) and every 30s on screen, so it can't lag behind reality. */
        // 15 min, aligned with STALE_MIN in supabase/functions/_shared/doseGuard.ts. At 5 min the
        // window was under Abbott's own follower lag, so `of()` returned NONE and the hypo alarm was
        // SILENTLY switched off on healthy data — while the server would still compute a dose on the
        // very same reading. This only governs how old a reading may be; it changes nothing about how
        // readings are fetched.
        const val FRESHNESS_WINDOW_MS = 15 * 60_000L

        // ── Ring-policy constants — ONE source of truth, shared by the foreground UI alarm and the
        //    background MonitorService so the two can never disagree. ───────────────────────────────
        /**
         * Re-alerting is driven by the VALUE, never by a timer. Once a red zone has sounded, it sounds
         * again only when the glucose has moved a further whole step AWAY from range since that sound:
         * a step of [PALIER_HIGH] going up, [PALIER_LOW] going down. Sitting at 250 (or at 65) is
         * silent for as long as it sits there — which is what makes the Telegram alerts liveable.
         */
        const val PALIER_HIGH = 10
        /** Finer on the low side: a hypo is the acute emergency, so 5 mg/dL of further fall re-sounds. */
        const val PALIER_LOW = 5
        /** Kept for the banner/ack bookkeeping only — no longer a re-ring trigger. */
        const val SNOOZE_MS = 20 * 60 * 1000L
        /** Crossing below this (severe hypo) re-sounds despite the snooze. */
        const val SEVERE_LOW = 54
        /** Recovery hysteresis: once an episode has sounded, it only RE-ARMS (so the next out-of-range
         *  reading counts as a fresh episode that may ring again) after the glucose comes back this far
         *  INSIDE the threshold — i.e. a HIGH re-arms only at/below HIGH-RECOVERY_MARGIN (180→165), a
         *  LOW only at/above LOW+RECOVERY_MARGIN (70→85). Without it, a hyper settling and bouncing
         *  around 180 (181→179→182…) registered each re-crossing as a NEW episode and re-rang instantly
         *  — the parent's "ça sonnait en revenant à la normale". The banner is unaffected (it tracks the
         *  live kind, which is already NONE in the band); this only governs the loud re-ring. */
        const val RECOVERY_MARGIN = 15
        /** Insulin-on-board (units) at/above which a non-rising HIGH alarm is suppressed. */
        const val IOB_ACTIVE_MIN = 0.5
        /** A HIGH rising at least this fast (mg/dL per min) still alarms even with insulin on board —
         *  insulin on board does not guarantee a correction (failed site / under-dose / DKA path). */
        const val HIGH_RISING_SLOPE = 1.0
        /** Carbs/sugar eaten within this many minutes are still being absorbed (the rule of 15): a LOW
         *  alarm then says "you already took sugar, let it act" instead of "take sugar now". Mirrors
         *  RESCUE_WINDOW_MIN in _shared/doseGuard.ts so the alarm can't contradict the spoken analysis. */
        const val RESCUE_WINDOW_MIN = 15
        // ── RAPID-badge gating (the user's rule): a "montée rapide" badge fires ONLY above 140 AND only
        //    when the rise has been steep AND uninterrupted for ≥15 min; a "descente rapide" badge ONLY
        //    below 120 AND a steep, uninterrupted fall for ≥10 min. Stops a single jumpy step from
        //    flashing a scary badge on an otherwise in-range value.
        const val RAPID_RISE_MIN_MGDL = 140
        const val RAPID_FALL_MAX_MGDL = 120
        const val RAPID_RISE_SUSTAIN_MIN = 15
        const val RAPID_FALL_SUSTAIN_MIN = 10

        /**
         * The full alarm decision for a reading: freshness-gated (via [of]) AND insulin-aware. A HIGH
         * with active insulin-on-board that is NOT still climbing is downgraded to NONE (the correction
         * is handling it); a HIGH that keeps rising still alarms. Lows / fast-falls are never
         * suppressed. Used identically by the foreground UI and the background service.
         */
        fun evaluate(
            current: GlucoseReading?,
            history: List<GlucoseReading>,
            iobUnits: Double,
            nowMs: Long = System.currentTimeMillis()
        ): GlucoseAlert {
            val raw = of(current, history, nowMs)
            if (raw.kind != AlertKind.HIGH && raw.kind != AlertKind.HIGH_WARN) return raw
            // A HIGH only rings when there's something to DO (mirrors the dose guard's "no insulin"
            // cases): suppressed if insulin is on board and it's not still climbing, OR it's already
            // coming down on its own. A high that keeps RISING despite insulin still alarms.
            if (iobUnits >= IOB_ACTIVE_MIN && raw.slope < HIGH_RISING_SLOPE) return GlucoseAlert(AlertKind.NONE, raw.slope, raw.value)
            if (raw.slope <= -0.5) return GlucoseAlert(AlertKind.NONE, raw.slope, raw.value)
            return raw
        }

        /** Average slope over the most recent ~15 min (mg/dL per minute). Returns 0 when the
         *  span is too short to trust, so a single jumpy reading can't fake a "rapid" curve. */
        fun recentSlope(history: List<GlucoseReading>): Double {
            val sorted = cleanGlucoseSeries(history) // dedupe + drop noise/future/ancient before measuring slope
            if (sorted.size < 2) return 0.0
            val last = sorted.last()
            val windowStart = last.timestampMs - 15 * 60_000L
            val pts = sorted.filter { it.timestampMs >= windowStart }
            if (pts.size < 2) return 0.0
            val first = pts.first()
            val dtMin = (last.timestampMs - first.timestampMs) / 60_000.0
            if (dtMin < 4) return 0.0
            return (last.valueMgDl - first.valueMgDl) / dtMin
        }

        /** How many minutes the curve has been moving CONTINUOUSLY in one direction (no reversal
         *  beyond small noise), ending at the latest reading. Gates the rapid-rise/fall badges so they
         *  only fire on a SUSTAINED move ("sans s'arrêter"), not one jumpy step. */
        fun sustainedMinutes(history: List<GlucoseReading>, rising: Boolean): Double {
            val sorted = cleanGlucoseSeries(history)
            if (sorted.size < 2) return 0.0
            val endIdx = sorted.size - 1
            var i = endIdx
            while (i > 0) {
                val dv = sorted[i].valueMgDl - sorted[i - 1].valueMgDl
                val ok = if (rising) dv >= -2 else dv <= 2 // allow ≤2 mg/dL wiggle against the trend
                if (!ok) break
                i--
            }
            return (sorted[endIdx].timestampMs - sorted[i].timestampMs) / 60_000.0
        }

        fun of(
            current: GlucoseReading?,
            history: List<GlucoseReading>,
            nowMs: Long = System.currentTimeMillis()
        ): GlucoseAlert {
            val cur = current ?: return GlucoseAlert(AlertKind.NONE, 0.0, 0)
            // Stale data is NOT a live glucose: never alarm on it, and never let it silence a real
            // alarm. We go quiet (NONE); the dashboard shows "signal perdu" instead.
            if (nowMs - cur.timestampMs > FRESHNESS_WINDOW_MS)
                return GlucoseAlert(AlertKind.NONE, 0.0, cur.valueMgDl)
            val v = cur.valueMgDl
            val slope = recentSlope(history)
            if (v < ALARM_LOW) return GlucoseAlert(AlertKind.LOW, slope, v)
            if (v < ALARM_LOW_WARN) return GlucoseAlert(AlertKind.LOW_WARN, slope, v)
            if (v > ALARM_HIGH) return GlucoseAlert(AlertKind.HIGH, slope, v)
            if (v > ALARM_HIGH_WARN) return GlucoseAlert(AlertKind.HIGH_WARN, slope, v)
            // RAPID badges only on a value past the gate AND a steep move sustained long enough — so an
            // in-range value with one jumpy step no longer flashes "montée/descente rapide".
            if (slope >= RAPID_SLOPE && v > RAPID_RISE_MIN_MGDL &&
                sustainedMinutes(history, rising = true) >= RAPID_RISE_SUSTAIN_MIN)
                return GlucoseAlert(AlertKind.RAPID_RISE, slope, v)
            if (slope <= -RAPID_SLOPE && v < RAPID_FALL_MAX_MGDL &&
                sustainedMinutes(history, rising = false) >= RAPID_FALL_SUSTAIN_MIN)
                return GlucoseAlert(AlertKind.RAPID_FALL, slope, v)
            return GlucoseAlert(AlertKind.NONE, slope, v)
        }
    }
}
