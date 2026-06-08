package com.nueve.mechabetics.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks in the two new alarm behaviours:
 *  1) AlarmEngine recovery HYSTERESIS — the "ça sonnait en revenant à la normale" bug: a hyper that
 *     settles and bounces around 180 must not re-ring on every re-crossing.
 *  2) AlarmPolicy — volume / vibrate / quiet-hours / per-type resolution, including the safety rule
 *     that quiet hours silence a HIGH but a LOW still chimes through by default (hypoAlwaysSounds).
 */
class AlarmBehaviorTest {

    private val now = 1_000_000_000_000L
    private fun book(kind: String?, lastMs: Long = 0L, lastVal: Int = 0) =
        AlarmEngine.Bookkeeping(kind, lastMs, lastVal)
    private fun alert(kind: AlertKind, value: Int, slope: Double = 0.0) = GlucoseAlert(kind, slope, value)

    // ── Recovery hysteresis ─────────────────────────────────────────────────────────────────────

    @Test
    fun reArmsOnlyWhenClearlyBackInRange() {
        // Returning from a HIGH episode: a value still in the hysteresis band (>165) does NOT re-arm…
        val settling = AlarmEngine.decide(alert(AlertKind.NONE, 175), book("HIGH", now - 60_000, 200), now)
        assertEquals("episode held while settling at the edge", "HIGH", settling.book.firedKind)
        assertTrue(settling.recovered)
        // …but a value clearly back in range (≤165) re-arms for the next episode.
        val recovered = AlarmEngine.decide(alert(AlertKind.NONE, 150), book("HIGH", now - 60_000, 200), now)
        assertNull("episode re-armed once clearly back in range", recovered.book.firedKind)
    }

    @Test
    fun bounceBackOver180WhileSettling_doesNotReRing() {
        // THE BUG: rang at 200, dips to 176 (NONE, still settling), bounces to 183 a minute later.
        val afterSettle = AlarmEngine.decide(alert(AlertKind.NONE, 176), book("HIGH", now - 60_000, 200), now)
        val bounce = AlarmEngine.decide(alert(AlertKind.HIGH, 183), afterSettle.book, now)
        assertFalse("a small bounce back over 180 must NOT be treated as a new episode", bounce.ring)
    }

    @Test
    fun lowEpisodeHasHysteresisToo() {
        val settling = AlarmEngine.decide(alert(AlertKind.NONE, 80), book("LOW", now - 60_000, 60), now)
        assertEquals("LOW", settling.book.firedKind) // 80 < 70+15 → still settling
        val recovered = AlarmEngine.decide(alert(AlertKind.NONE, 90), book("LOW", now - 60_000, 60), now)
        assertNull(recovered.book.firedKind) // 90 ≥ 85 → re-armed
    }

    @Test
    fun signalLost_holdsTheEpisode() {
        // value 0 = no fresh reading: hold the episode rather than re-arming on nothing.
        val d = AlarmEngine.decide(alert(AlertKind.NONE, 0), book("HIGH", now - 60_000, 200), now)
        assertEquals("HIGH", d.book.firedKind)
    }

    @Test
    fun genuinelyNewHigh_stillRings() {
        val d = AlarmEngine.decide(alert(AlertKind.HIGH, 210), book(null), now)
        assertTrue("a fresh hyper with no prior episode rings", d.ring)
        assertEquals("HIGH", d.book.firedKind)
    }

    @Test
    fun worseningHypo_stillEscalatesDespiteSnooze() {
        // Sanity: the hysteresis change must not break hypo escalation through a snooze.
        val d = AlarmEngine.decide(alert(AlertKind.LOW, 48), book("LOW", now - 60_000, 65), now)
        assertTrue("a hypo dropping into severe re-sounds despite the snooze", d.ring)
    }

    // ── AlarmPolicy ─────────────────────────────────────────────────────────────────────────────

    private fun settings(
        sound: Boolean = true, volume: Int = 70, vibrate: Boolean = true,
        hypo: Boolean = true, hyper: Boolean = true, fall: Boolean = true,
        hypoAlways: Boolean = true,
        quiet: Boolean = false, qStart: Int = 22 * 60, qEnd: Int = 7 * 60
    ) = AlarmPolicy.Settings(sound, volume, vibrate, hypo, hyper, fall, hypoAlways, quiet, qStart, qEnd)

    @Test
    fun quietHours_silenceHigh_butVibrate() {
        val e = AlarmPolicy.effect(AlertKind.HIGH, settings(quiet = true), minuteOfDay = 23 * 60)
        assertTrue(e.ring)
        assertEquals("a high inside quiet hours does not chime", 0, e.volumePct)
        assertTrue("…but still vibrates", e.vibrate)
    }

    @Test
    fun quietHours_hypoStillChimesByDefault_butCanBeMuted() {
        // A LOW pierces quiet hours and still CHIMES by default — the dangerous direction isn't muted by
        // a clock…
        val sounding = AlarmPolicy.effect(AlertKind.LOW, settings(quiet = true, volume = 70), minuteOfDay = 23 * 60)
        assertTrue("a hypo chimes through quiet hours by default", sounding.volumePct > 0)
        // …unless the user explicitly turns hypoAlwaysSounds off (then it vibrate-only's like a HIGH).
        val muted = AlarmPolicy.effect(AlertKind.LOW, settings(quiet = true, volume = 70, hypoAlways = false), minuteOfDay = 23 * 60)
        assertEquals("hypoAlwaysSounds=false → LOW vibrates without chiming in quiet hours", 0, muted.volumePct)
        assertTrue(muted.vibrate)
    }

    @Test
    fun defaultSettings_soundEverythingAtFullChosenVolume() {
        // The out-of-the-box contract the user asked for: by default every alert SOUNDS.
        val d = settings() // defaults: sound on, quiet off, all types on
        assertTrue(AlarmPolicy.effect(AlertKind.LOW, d, minuteOfDay = 3 * 60).volumePct > 0)
        assertTrue(AlarmPolicy.effect(AlertKind.HIGH, d, minuteOfDay = 3 * 60).volumePct > 0)
        assertTrue(AlarmPolicy.effect(AlertKind.RAPID_FALL, d, minuteOfDay = 3 * 60).volumePct > 0)
    }

    @Test
    fun typeOff_doesNotRing() {
        val e = AlarmPolicy.effect(AlertKind.HIGH, settings(hyper = false), minuteOfDay = 12 * 60)
        assertFalse(e.ring)
    }

    @Test
    fun vibrateOnlyMode_noChimeStillVibrates() {
        val e = AlarmPolicy.effect(AlertKind.HIGH, settings(sound = false, vibrate = true), minuteOfDay = 12 * 60)
        assertTrue(e.ring); assertEquals(0, e.volumePct); assertTrue(e.vibrate)
    }

    @Test
    fun highOutsideQuietWindow_chimesNormally() {
        val e = AlarmPolicy.effect(AlertKind.HIGH, settings(quiet = true, volume = 55), minuteOfDay = 12 * 60)
        assertEquals(55, e.volumePct)
    }

    @Test
    fun quietWindowWrapsMidnight() {
        assertTrue(AlarmPolicy.inQuietWindow(23 * 60, 22 * 60, 7 * 60))  // 23:00 inside 22→07
        assertTrue(AlarmPolicy.inQuietWindow(3 * 60, 22 * 60, 7 * 60))   // 03:00 inside 22→07
        assertFalse(AlarmPolicy.inQuietWindow(12 * 60, 22 * 60, 7 * 60)) // 12:00 outside
        assertFalse(AlarmPolicy.inQuietWindow(8 * 60, 22 * 60, 7 * 60))  // 08:00 outside
    }
}
