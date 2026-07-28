package com.nueve.mechabetics.data

/**
 * Pure ring-decision logic for the hypo/hyper alarm. Given the current alert and the persisted
 * bookkeeping, it returns whether to sound NOW plus the updated bookkeeping to persist.
 *
 * Snooze (don't nag every reading), hypo-escalation (a worsening LOW re-sounds despite the snooze)
 * and recovery-reset all live here, so the foreground UI ([MainActivity]) and the background
 * [com.nueve.mechabetics.MonitorService] make the EXACT same call and can never diverge. No Android
 * dependencies — trivially unit-testable.
 */
object AlarmEngine {

    /** Persisted across episodes (mirrors the CredentialsStore fields). */
    data class Bookkeeping(
        val firedKind: String?,   // AlertKind name already sounded for the ongoing episode (null = none)
        val lastAlarmMs: Long,    // when it last sounded
        val lastAlarmValue: Int   // the glucose value at the last sound (for hypo escalation)
    )

    data class Decision(
        val ring: Boolean,            // sound the alarm now?
        val book: Bookkeeping,        // bookkeeping to persist
        val recovered: Boolean        // alert returned to NONE → stop any alarm + re-arm
    )

    fun decide(alert: GlucoseAlert, book: Bookkeeping, nowMs: Long): Decision {
        if (alert.kind == AlertKind.NONE) {
            // Back in range (or signal lost): stop the sound. But RE-ARM only with hysteresis — a hyper
            // that just dipped under 180 yet is still hovering at the edge (e.g. settling at 175 after a
            // 250) must NOT re-arm, or a tiny bounce back over 180 counts as a brand-new episode and
            // re-rings at once. We only re-arm once it's clearly back inside the range. A value of 0
            // (no fresh reading / signal lost) holds the episode rather than re-arming on nothing.
            val v = alert.value
            val stillSettling =
                (book.firedKind == AlertKind.HIGH.name && v > GlucoseAlert.HIGH - GlucoseAlert.RECOVERY_MARGIN) ||
                (book.firedKind == AlertKind.LOW.name && v in 1 until GlucoseAlert.LOW + GlucoseAlert.RECOVERY_MARGIN) ||
                (v == 0 && book.firedKind != null)
            val newBook = if (stillSettling) book else Bookkeeping(null, book.lastAlarmMs, 0)
            return Decision(ring = false, book = newBook, recovered = true)
        }
        if (!alert.ringsAlarm) {
            // In-range fast RISE etc. — banner only, never a sound; leave bookkeeping untouched.
            return Decision(ring = false, book = book, recovered = false)
        }
        val kindName = alert.kind.name
        val newEpisode = book.firedKind != kindName
        // A LOW that keeps dropping breaks the snooze: it fell another HYPO_ESCALATE_DROP since the
        // last ring, or it just crossed into severe hypo. A worsening hypo must never stay muted.
        val worseningHypo = alert.kind == AlertKind.LOW && book.lastAlarmValue > 0 && (
            alert.value <= book.lastAlarmValue - GlucoseAlert.HYPO_ESCALATE_DROP ||
            (alert.value < GlucoseAlert.SEVERE_LOW && book.lastAlarmValue >= GlucoseAlert.SEVERE_LOW)
        )
        // A HIGH escalates on VALUE, not on a timer: it re-sounds only on a new PALIER further out.
        val worseningHigh = alert.kind == AlertKind.HIGH && book.lastAlarmValue > 0 &&
            (alert.value / GlucoseAlert.PALIER) > (book.lastAlarmValue / GlucoseAlert.PALIER)
        val snoozed = !newEpisode && when (alert.kind) {
            AlertKind.HIGH -> !worseningHigh
            AlertKind.LOW -> !worseningHypo && (nowMs - book.lastAlarmMs) < GlucoseAlert.SNOOZE_MS
            else -> (nowMs - book.lastAlarmMs) < GlucoseAlert.SNOOZE_MS
        }
        if (snoozed) return Decision(ring = false, book = book, recovered = false)
        return Decision(
            ring = true,
            book = Bookkeeping(kindName, nowMs, alert.value),
            recovered = false
        )
    }
}
