package com.nueve.mechabetics.data

enum class Trend(val arrow: String, val label: String) {
    FALLING_FAST("↓↓", "Chute rapide"),
    FALLING("↓", "Baisse"),
    STABLE("→", "Stable"),
    RISING("↑", "Hausse"),
    RISING_FAST("↑↑", "Montée rapide"),
    UNKNOWN("•", "");

    companion object {
        fun fromInt(v: Int?) = when (v) {
            1 -> FALLING_FAST
            2 -> FALLING
            3 -> STABLE
            4 -> RISING
            5 -> RISING_FAST
            else -> UNKNOWN
        }
    }
}

data class GlucoseReading(
    val timestampMs: Long,
    val valueMgDl: Int,
    val trend: Trend = Trend.UNKNOWN,
    val isHigh: Boolean = false,
    val isLow: Boolean = false
)

data class PatientConnection(
    val patientId: String,
    val firstName: String,
    val lastName: String,
    val current: GlucoseReading?
)

/**
 * A remembered LibreLinkUp account = one "profile" (multi-profils). Each maps to a
 * distinct patient → a distinct `subject` (sha256 of patientId) server-side, so the
 * AI history/meals/insulin of one profile never bleed into another.
 */
data class SavedAccount(
    val email: String,
    val password: String,
    val region: String?,
    val token: String?,
    val accountIdHash: String?,
    val patientId: String?,
    val patientName: String?
)

data class GraphSnapshot(
    val current: GlucoseReading?,
    val history: List<GlucoseReading>
)

sealed class LibreResult<out T> {
    data class Success<T>(val data: T) : LibreResult<T>()
    data class Error(val message: String, val needsLogin: Boolean = false) : LibreResult<Nothing>()
}
