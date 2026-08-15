package com.drclaude.data

/**
 * Pure ring-decision logic for the hypo/hyper alarm. Given the current alert and the persisted
 * bookkeeping, it returns whether to sound NOW plus the updated bookkeeping to persist.
 *
 * This is the ONLY place the question "should it sound?" is answered: the foreground UI
 * ([com.drclaude.MainActivity]) and the background
 * [com.drclaude.MonitorService] both call it, and the Telegram monitor
 * (supabase/functions/mechabetics-monitor) implements the same three rules server-side, so the
 * three channels alert at the same moments:
 *
 *  1. **A new reading only.** The same reading is never judged twice, so re-opening the app cannot
 *     sound anything — it merely re-evaluates a value that has already been ruled on.
 *  2. **A red zone only** (< 60 or > 180). The amber bands (60–69, 171–180) and the fast-curve
 *     flags are shown, never sounded.
 *  3. **Entering the red zone, or moving a further whole step away from range since the last
 *     sound** ([GlucoseAlert.PALIER_LOW] / [GlucoseAlert.PALIER_HIGH]) — plus crossing into severe
 *     hypo, which always sounds. Sitting still is silent, however long it lasts and however far out
 *     it is: there is no timer anywhere in here.
 *
 * No Android dependencies — trivially unit-testable.
 */
object AlarmEngine {

    /** Persisted across episodes (mirrors the CredentialsStore fields). */
    data class Bookkeeping(
        val firedKind: String?,   // AlertKind name already sounded for the ongoing episode (null = none)
        val lastAlarmMs: Long,    // when it last sounded
        val lastAlarmValue: Int,  // the glucose value at the last sound (for the step rule)
        val lastJudgedMs: Long = 0L // timestamp of the last reading this logic has already ruled on
    )

    data class Decision(
        val ring: Boolean,            // sound the alarm now?
        val book: Bookkeeping,        // bookkeeping to persist
        val recovered: Boolean        // back inside 70–170 → stop any alarm + re-arm
    )

    /** @param readingMs timestamp of the reading being judged (0 = unknown, skips the new-reading
     *  gate). Passing it is what stops an alarm sounding just because the app was re-opened. */
    fun decide(alert: GlucoseAlert, book: Bookkeeping, nowMs: Long, readingMs: Long = 0L): Decision {
        val alreadyJudged = readingMs != 0L && readingMs == book.lastJudgedMs
        val judged = if (readingMs != 0L) book.copy(lastJudgedMs = readingMs) else book

        if (alert.kind == AlertKind.NONE) {
            // Truly back inside 70–170. Note the amber bands do NOT come through here: 171–180 is
            // HIGH_WARN, so a hyper settling at the threshold holds its episode instead of re-arming
            // and re-ringing on the next small bounce — the amber band IS the hysteresis. A value of
            // 0 (no fresh reading / signal lost) holds the episode too rather than re-arming on nothing.
            val holding = alert.value == 0 && book.firedKind != null
            val newBook = if (holding) judged else judged.copy(firedKind = null, lastAlarmValue = 0)
            return Decision(ring = false, book = newBook, recovered = !holding)
        }
        if (!alert.ringsAlarm) {
            // Amber zone or a fast curve: banner only, never a sound. The ongoing episode's
            // bookkeeping is left untouched so a return to red doesn't read as a brand-new episode.
            return Decision(ring = false, book = judged, recovered = false)
        }
        val kindName = alert.kind.name
        val enteredRedZone = book.firedKind != kindName
        // Moved a further whole step AWAY from range since the last sound.
        val steppedFurther = book.lastAlarmValue > 0 && when (alert.kind) {
            AlertKind.LOW -> alert.value <= book.lastAlarmValue - GlucoseAlert.PALIER_LOW
            else -> alert.value >= book.lastAlarmValue + GlucoseAlert.PALIER_HIGH
        }
        // A deep hypo always sounds on the crossing, whatever the step rule says.
        val severeCrossed = alert.kind == AlertKind.LOW &&
            alert.value < GlucoseAlert.SEVERE_LOW && book.lastAlarmValue >= GlucoseAlert.SEVERE_LOW
        val ring = !alreadyJudged && (enteredRedZone || steppedFurther || severeCrossed)
        if (!ring) return Decision(ring = false, book = judged, recovered = false)
        return Decision(
            ring = true,
            book = judged.copy(firedKind = kindName, lastAlarmMs = nowMs, lastAlarmValue = alert.value),
            recovered = false
        )
    }
}
