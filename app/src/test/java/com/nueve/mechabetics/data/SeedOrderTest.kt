package com.nueve.mechabetics.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The on-device history is stored NEWEST FIRST (LocalHistoryDb.recent uses ORDER BY ts DESC) while
 * GlucoseRepository.refresh() publishes ASCENDING. Restoring the dial at launch by taking "the last
 * element" therefore picked the OLDEST reading and the home card announced "signal perdu depuis
 * 984 min" on a perfectly healthy sensor. Selecting by timestamp is order-independent; these tests
 * pin that so the next person to touch either side cannot reintroduce it.
 */
class SeedOrderTest {

    private val now = 1_000_000_000_000L
    private fun r(minutesAgo: Long, v: Int) = GlucoseReading(now - minutesAgo * 60_000L, v)

    private val newestFirst = listOf(r(2, 120), r(30, 140), r(984, 90))   // as the DB returns it
    private val oldestFirst = newestFirst.reversed()                       // as refresh() publishes it

    @Test
    fun newestIsFoundWhateverTheOrder() {
        assertEquals(120, newestFirst.maxByOrNull { it.timestampMs }?.valueMgDl)
        assertEquals(120, oldestFirst.maxByOrNull { it.timestampMs }?.valueMgDl)
    }

    @Test
    fun takingTheLastElementIsWrongOnTheDatabaseOrder() {
        // The exact defect: positional access on the DB's own ordering yields the 984-min-old point.
        assertEquals(90, newestFirst.last().valueMgDl)
        assertEquals(984L, (now - newestFirst.last().timestampMs) / 60_000L)
    }

    @Test
    fun sortingTheSeedMakesBothPathsAgree() {
        val sorted = newestFirst.sortedBy { it.timestampMs }
        assertEquals(oldestFirst.map { it.valueMgDl }, sorted.map { it.valueMgDl })
        assertEquals(120, sorted.last().valueMgDl) // and only THEN is "last" the newest
    }
}
