package com.nueve.mechabetics.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Safety regression guard for "signal lost" handling.
 *
 * The incident this protects against: a frozen sensor showed a stale HIGH value as if it were live,
 * a correction dose was given, and the real (fingerstick) glucose was a hypo. So a reading older than
 * the freshness window must NEVER drive an alarm or a predictive heads-up — the dashboard shows
 * NO SIGNAL instead and asks for a fingerstick. These tests lock that behaviour in.
 */
class SignalStalenessTest {

    private val now = 1_000_000_000_000L
    private fun ago(min: Int) = now - min * 60_000L

    // ── Alarm layer (shared by the on-screen alarm AND the background MonitorService) ───────────

    @Test
    fun staleHigh_neverAlarms() {
        val stale = GlucoseReading(timestampMs = ago(20), valueMgDl = 250, trend = Trend.STABLE)
        val alert = GlucoseAlert.of(stale, listOf(stale), now)
        assertEquals("a 20-min-old 250 must not raise a HIGH alarm", AlertKind.NONE, alert.kind)
    }

    @Test
    fun staleLow_neverAlarms() {
        // A stale LOW is also untrustworthy: we don't know the live value — fingerstick decides.
        val stale = GlucoseReading(timestampMs = ago(25), valueMgDl = 55, trend = Trend.FALLING)
        val alert = GlucoseAlert.of(stale, listOf(stale), now)
        assertEquals(AlertKind.NONE, alert.kind)
    }

    @Test
    fun freshHigh_stillAlarms() {
        val fresh = GlucoseReading(timestampMs = ago(2), valueMgDl = 250, trend = Trend.STABLE)
        assertEquals(AlertKind.HIGH, GlucoseAlert.of(fresh, listOf(fresh), now).kind)
    }

    @Test
    fun freshLow_stillAlarms() {
        val fresh = GlucoseReading(timestampMs = ago(1), valueMgDl = 55, trend = Trend.FALLING)
        assertEquals(AlertKind.LOW, GlucoseAlert.of(fresh, listOf(fresh), now).kind)
    }

    @Test
    fun freshnessWindow_isFiveMinutes() {
        // Fast signal-loss detection: ~5 missed minute-readings, so NO SIGNAL shows about as quickly
        // as the official LibreLink instead of lagging up to 15 min behind it.
        assertEquals(5 * 60_000L, GlucoseAlert.FRESHNESS_WINDOW_MS)
    }

    @Test
    fun freshnessBoundary_evaluatesJustInside_goesQuietJustPast() {
        val justFresh = GlucoseReading(timestampMs = now - (GlucoseAlert.FRESHNESS_WINDOW_MS - 1), valueMgDl = 250)
        val justStale = GlucoseReading(timestampMs = now - (GlucoseAlert.FRESHNESS_WINDOW_MS + 1), valueMgDl = 250)
        assertEquals(AlertKind.HIGH, GlucoseAlert.of(justFresh, listOf(justFresh), now).kind)
        assertEquals(AlertKind.NONE, GlucoseAlert.of(justStale, listOf(justStale), now).kind)
    }

    // ── Predictive heads-up (client-side mirror) ────────────────────────────────────────────────
    // Predictor.of() reads System.currentTimeMillis() internally, so build timestamps relative to it.

    @Test
    fun predictor_staleRisingSeries_noHeadsUp() {
        val n = System.currentTimeMillis()
        val rising = listOf(
            GlucoseReading(n - 40 * 60_000L, 120),
            GlucoseReading(n - 30 * 60_000L, 150),
            GlucoseReading(n - 20 * 60_000L, 185), // latest point is 20 min old → stale
        )
        assertEquals(
            "a clearly rising but stale curve must not predict a hyper",
            PredictKind.NONE, Predictor.of(rising).kind
        )
    }

    @Test
    fun predictor_freshRisingSeries_stillPredicts() {
        val n = System.currentTimeMillis()
        val rising = listOf(
            GlucoseReading(n - 20 * 60_000L, 120),
            GlucoseReading(n - 10 * 60_000L, 150),
            GlucoseReading(n - 1 * 60_000L, 178), // latest is fresh
        )
        assertTrue(
            "a fresh rising curve should still produce a heads-up",
            Predictor.of(rising).kind != PredictKind.NONE
        )
    }

    @Test
    fun predictor_midRangeFalling_noHeadsUp() {
        val n = System.currentTimeMillis()
        val falling = listOf(
            GlucoseReading(n - 20 * 60_000L, 120),
            GlucoseReading(n - 1 * 60_000L, 110), // in-range dip, fresh
        )
        assertEquals(
            "a 120->110 in-range dip must stay silent (only warn below 90)",
            PredictKind.NONE, Predictor.of(falling).kind
        )
    }

    @Test
    fun predictor_fallingBelow90_watchFall() {
        val n = System.currentTimeMillis()
        val falling = listOf(
            GlucoseReading(n - 20 * 60_000L, 100),
            GlucoseReading(n - 1 * 60_000L, 85), // below 90, fresh
        )
        assertEquals(PredictKind.WATCH_FALL, Predictor.of(falling).kind)
    }

    @Test
    fun predictor_risingUnder160_noHeadsUp() {
        val n = System.currentTimeMillis()
        val rising = listOf(
            GlucoseReading(n - 20 * 60_000L, 130),
            GlucoseReading(n - 1 * 60_000L, 150), // rising but still < 160, fresh
        )
        assertEquals(
            "a rise under 160 must stay silent",
            PredictKind.NONE, Predictor.of(rising).kind
        )
    }
}
