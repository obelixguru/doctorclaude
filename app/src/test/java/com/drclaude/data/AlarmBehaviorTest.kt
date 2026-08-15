package com.drclaude.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks in the alarm contract the user asked for: the in-app and push alarms must sound at the same
 * moments as the Telegram alerts, and never merely because the app was opened.
 *
 *  1) Zones — red < 60 / > 180 sound; amber 60–69 and 171–180 are shown, silent; 70–170 is normal.
 *  2) A reading is judged once: re-evaluating it (app re-opened) can never sound anything.
 *  3) Re-alerting is value-driven only — a further whole step away from range since the last sound.
 *     No timer anywhere.
 *  4) AlarmPolicy — volume / vibrate / quiet-hours / per-type resolution, including the safety rule
 *     that quiet hours silence a HIGH but a LOW still chimes through by default (hypoAlwaysSounds).
 */
class AlarmBehaviorTest {

    private val now = 1_000_000_000_000L
    private fun book(kind: String?, lastMs: Long = 0L, lastVal: Int = 0, judgedMs: Long = 0L) =
        AlarmEngine.Bookkeeping(kind, lastMs, lastVal, judgedMs)
    private fun alert(kind: AlertKind, value: Int, slope: Double = 0.0) = GlucoseAlert(kind, slope, value)
    private fun readingAt(value: Int, tsMs: Long) = GlucoseReading(tsMs, value)

    // ── Zones ───────────────────────────────────────────────────────────────────────────────────

    @Test
    fun zonesFollowTheUsersThresholds() {
        fun kindOf(v: Int) = GlucoseAlert.of(readingAt(v, now), listOf(readingAt(v, now)), now).kind
        assertEquals(AlertKind.LOW, kindOf(59))
        assertEquals(AlertKind.LOW_WARN, kindOf(60))
        assertEquals(AlertKind.LOW_WARN, kindOf(69))
        assertEquals(AlertKind.NONE, kindOf(70))
        assertEquals(AlertKind.NONE, kindOf(170))
        assertEquals(AlertKind.HIGH_WARN, kindOf(171))
        assertEquals(AlertKind.HIGH_WARN, kindOf(180))
        assertEquals(AlertKind.HIGH, kindOf(181))
    }

    @Test
    fun amberZonesAndFastCurvesNeverSound() {
        assertFalse(alert(AlertKind.LOW_WARN, 65).ringsAlarm)
        assertFalse(alert(AlertKind.HIGH_WARN, 175).ringsAlarm)
        assertFalse("the fast-fall alarm was removed on the user's instruction", alert(AlertKind.RAPID_FALL, 110).ringsAlarm)
        assertFalse(alert(AlertKind.RAPID_RISE, 160).ringsAlarm)
        assertTrue(alert(AlertKind.LOW, 55).ringsAlarm)
        assertTrue(alert(AlertKind.HIGH, 220).ringsAlarm)
    }

    // ── A reading is judged once (THE "it rings every time I open the app" BUG) ──────────────────

    @Test
    fun reEvaluatingTheSameReadingNeverRings() {
        val readingMs = now - 2 * 60_000
        // The background service judges the reading and sounds it.
        val first = AlarmEngine.decide(alert(AlertKind.HIGH, 230), book(null), now, readingMs)
        assertTrue(first.ring)
        assertEquals(readingMs, first.book.lastJudgedMs)
        // The user opens the app: same reading, re-evaluated. It must stay silent.
        val onOpen = AlarmEngine.decide(alert(AlertKind.HIGH, 230), first.book, now + 5 * 60_000, readingMs)
        assertFalse("opening the app re-judges the same reading — it must not sound", onOpen.ring)
        // Even hours later, and even after the episode bookkeeping was cleared by a stop.
        val muchLater = AlarmEngine.decide(alert(AlertKind.HIGH, 230), first.book, now + 6 * 60 * 60_000L, readingMs)
        assertFalse(muchLater.ring)
    }

    @Test
    fun aGenuinelyNewReadingInTheSameZoneStillFollowsTheStepRule() {
        val r1 = now - 10 * 60_000
        val first = AlarmEngine.decide(alert(AlertKind.HIGH, 230), book(null), now, r1)
        assertTrue(first.ring)
        // New reading, still high, not a further step away → silent.
        val flat = AlarmEngine.decide(alert(AlertKind.HIGH, 235), first.book, now, r1 + 5 * 60_000)
        assertFalse("a new reading inside the same step is silent", flat.ring)
        // A further step away → sounds again.
        val worse = AlarmEngine.decide(alert(AlertKind.HIGH, 242), first.book, now, r1 + 10 * 60_000)
        assertTrue("+10 mg/dL further out re-sounds", worse.ring)
    }

    // ── Value-driven re-alerting, no timers ─────────────────────────────────────────────────────

    @Test
    fun sittingOutOfRangeIsSilentHoweverLong() {
        val fourHours = now + 4 * 60 * 60 * 1000L
        assertFalse("same value, four hours later", AlarmEngine.decide(alert(AlertKind.HIGH, 250), book("HIGH", now, 250), fourHours, now + 1).ring)
        assertFalse("drifting up inside the step stays quiet", AlarmEngine.decide(alert(AlertKind.HIGH, 259), book("HIGH", now, 250), now + 60_000, now + 1).ring)
        assertTrue("a further 10 mg/dL out re-sounds", AlarmEngine.decide(alert(AlertKind.HIGH, 260), book("HIGH", now, 250), now + 60_000, now + 1).ring)
        assertFalse("an improving hyper never re-sounds", AlarmEngine.decide(alert(AlertKind.HIGH, 210), book("HIGH", now, 250), now + 60_000, now + 1).ring)
    }

    @Test
    fun aWorseningHypoSoundsOnEveryFiveMgdl() {
        assertFalse(AlarmEngine.decide(alert(AlertKind.LOW, 57), book("LOW", now, 59), now + 60_000, now + 1).ring)
        assertTrue(AlarmEngine.decide(alert(AlertKind.LOW, 54), book("LOW", now, 59), now + 60_000, now + 1).ring)
    }

    @Test
    fun crossingIntoSevereHypoAlwaysSounds() {
        // 55 → 53 is only 2 mg/dL, under the step rule, but it crosses into severe hypo.
        val d = AlarmEngine.decide(alert(AlertKind.LOW, 53), book("LOW", now, 55), now + 60_000, now + 1)
        assertTrue("a severe hypo crossing is never silenced by the step rule", d.ring)
    }

    // ── Episode bookkeeping ─────────────────────────────────────────────────────────────────────

    @Test
    fun theAmberBandHoldsTheEpisodeSoAThresholdBounceIsSilent() {
        // Rang at 200, drifts down to 175 — that is HIGH_WARN (amber), NOT a recovery: the episode is
        // held, so bouncing back to 183 is not a brand-new episode and does not sound.
        val settling = AlarmEngine.decide(alert(AlertKind.HIGH_WARN, 175), book("HIGH", now - 60_000, 200), now, now + 1)
        assertEquals("the amber band holds the episode", "HIGH", settling.book.firedKind)
        assertFalse(settling.recovered)
        val bounce = AlarmEngine.decide(alert(AlertKind.HIGH, 183), settling.book, now, now + 2)
        assertFalse("a bounce back over 180 must not be treated as a new episode", bounce.ring)
    }

    @Test
    fun backInsideTheNormalBandReArms() {
        val recovered = AlarmEngine.decide(alert(AlertKind.NONE, 150), book("HIGH", now - 60_000, 200), now, now + 1)
        assertNull("episode re-armed once back inside 70–170", recovered.book.firedKind)
        assertTrue(recovered.recovered)
        // …and the next excursion is a fresh episode that sounds again.
        val next = AlarmEngine.decide(alert(AlertKind.HIGH, 190), recovered.book, now, now + 2)
        assertTrue(next.ring)
    }

    @Test
    fun signalLost_holdsTheEpisode() {
        // value 0 = no fresh reading: hold the episode rather than re-arming on nothing.
        val d = AlarmEngine.decide(alert(AlertKind.NONE, 0), book("HIGH", now - 60_000, 200), now)
        assertEquals("HIGH", d.book.firedKind)
        assertFalse(d.recovered)
    }

    @Test
    fun genuinelyNewHigh_stillRings() {
        val d = AlarmEngine.decide(alert(AlertKind.HIGH, 210), book(null), now)
        assertTrue("a fresh hyper with no prior episode rings", d.ring)
        assertEquals("HIGH", d.book.firedKind)
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
        // The amber zones are shown, never sounded, so the policy is never even consulted for them.
        assertFalse(AlarmPolicy.effect(AlertKind.HIGH_WARN, d, minuteOfDay = 3 * 60).ring)
        assertFalse(AlarmPolicy.effect(AlertKind.LOW_WARN, d, minuteOfDay = 3 * 60).ring)
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

    // ── 5) A banner is for a glucose moving AWAY from range, never one coming back to it. ──────────

    /** Readings ending NOW, five minutes apart — cleanGlucoseSeries anchors on the real clock and
     *  keeps one reading per 5-minute bucket, so anything denser or older simply disappears. */
    private fun series(vararg vals: Int): List<GlucoseReading> {
        val end = System.currentTimeMillis()
        return vals.mapIndexed { i, v ->
            GlucoseReading(end - (vals.size - 1 - i) * 5L * 60_000L, v)
        }
    }

    private fun kindOfSeries(vararg vals: Int): AlertKind {
        val h = series(*vals)
        return GlucoseAlert.evaluate(h.last(), h, iobUnits = 0.0, nowMs = h.last().timestampMs).kind
    }

    @Test
    fun `a glucose falling through 175 no longer says presque haut`() {
        // The reported case: coming down from 200, still announced as nearly-high at every refresh.
        assertEquals(AlertKind.NONE, kindOfSeries(200, 191, 183, 175))
    }

    @Test
    fun `a glucose still climbing through 175 does say presque haut`() {
        assertEquals(AlertKind.HIGH_WARN, kindOfSeries(150, 158, 167, 175))
    }

    @Test
    fun `climbing back through 67 after a rescue drops the amber low badge`() {
        assertEquals(AlertKind.NONE, kindOfSeries(55, 59, 63, 67))
    }

    @Test
    fun `still falling through 65 keeps the amber low badge`() {
        assertEquals(AlertKind.LOW_WARN, kindOfSeries(80, 75, 70, 65))
    }

    @Test
    fun `a red hypo is never suppressed by rising - it is about where you ARE`() {
        val h = series(45, 49, 53, 57)
        val a = GlucoseAlert.evaluate(h.last(), h, iobUnits = 0.0, nowMs = h.last().timestampMs)
        assertEquals(AlertKind.LOW, a.kind)
        assertTrue(a.ringsAlarm)
    }

    @Test
    fun `a flat out-of-range value is still announced`() {
        // Not moving is not recovering: 175 sitting still has something to say.
        assertEquals(AlertKind.HIGH_WARN, kindOfSeries(175, 174, 176, 175))
    }

    @Test
    fun `one noisy sample cannot decide the direction`() {
        // A single low sample among a flat line used to drag the two-point slope negative and silence
        // the banner; the median-of-3 despike ignores it.
        assertEquals(AlertKind.HIGH_WARN, kindOfSeries(176, 176, 168, 176))
    }
}
