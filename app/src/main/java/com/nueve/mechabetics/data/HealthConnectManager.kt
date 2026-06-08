package com.nueve.mechabetics.data

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.temporal.ChronoUnit

/** A snapshot of recent wearable/phone health signals (any field may be null if unavailable). */
data class HealthSnapshot(
    val avgHeartRate: Int?,
    val steps: Long?,
    val available: Boolean,
    val granted: Boolean
)

/**
 * Reads heart rate + steps from Health Connect. A real resting/active heart rate needs a wearable
 * paired into Health Connect; without one this returns nulls cleanly (the UI then just shows "—").
 * Everything is wrapped so a missing Health Connect app, denied permission, or no data can never
 * crash the app.
 */
class HealthConnectManager(private val context: Context) {

    val permissions: Set<String> = setOf(
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(StepsRecord::class)
    )

    /** True only when the Health Connect SDK + provider app are present and usable. */
    fun isAvailable(): Boolean =
        try { HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE } catch (_: Exception) { false }

    private fun client(): HealthConnectClient? =
        if (isAvailable()) try { HealthConnectClient.getOrCreate(context) } catch (_: Exception) { null } else null

    suspend fun hasPermissions(): Boolean {
        val c = client() ?: return false
        return try { c.permissionController.getGrantedPermissions().containsAll(permissions) } catch (_: Exception) { false }
    }

    /** Average heart rate over the last hour + step count since midnight. Null-safe throughout. */
    suspend fun snapshot(): HealthSnapshot {
        val c = client() ?: return HealthSnapshot(null, null, available = false, granted = false)
        return try {
            val granted = c.permissionController.getGrantedPermissions().containsAll(permissions)
            if (!granted) return HealthSnapshot(null, null, available = true, granted = false)
            val now = Instant.now()

            val hr = c.readRecords(
                ReadRecordsRequest(
                    HeartRateRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(now.minus(1, ChronoUnit.HOURS), now)
                )
            )
            val bpm = hr.records.flatMap { it.samples }.map { it.beatsPerMinute }
            val avgHr = if (bpm.isNotEmpty()) bpm.average().toInt() else null

            val startOfDay = now.truncatedTo(ChronoUnit.DAYS)
            val steps = c.readRecords(
                ReadRecordsRequest(
                    StepsRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(startOfDay, now)
                )
            )
            val total = if (steps.records.isNotEmpty()) steps.records.sumOf { it.count } else null

            HealthSnapshot(avgHr, total, available = true, granted = true)
        } catch (_: Exception) {
            HealthSnapshot(null, null, available = isAvailable(), granted = false)
        }
    }
}
