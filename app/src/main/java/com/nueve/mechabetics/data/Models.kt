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
    val history: List<GlucoseReading>,
    // End of the sensor's 14-day life (LibreLinkUp connection.sensor.a + 14 d), null when the API
    // didn't include the sensor block. Past this instant the readings stop: the UI shows CAPTEUR
    // EXPIRÉ instead of a generic NO SIGNAL, and the AI is told the real cause.
    val sensorEndMs: Long? = null
)

sealed class LibreResult<out T> {
    data class Success<T>(val data: T) : LibreResult<T>()
    /**
     * @param needsLogin  the session is gone (401/403) — re-login before retrying.
     * @param rateLimited Abbott answered HTTP 429. A flag rather than a substring match on [message],
     *   so the stand-down survives rewording the user-facing text (the old check looked for "429" in
     *   the message, which silently stops working the moment that text becomes readable French).
     */
    data class Error(
        val message: String,
        val needsLogin: Boolean = false,
        val rateLimited: Boolean = false
    ) : LibreResult<Nothing>()
}
