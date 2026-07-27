package com.nueve.mechabetics.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

class CredentialsStore(context: Context) {

    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "mechabetics_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        context.getSharedPreferences("mechabetics_prefs_fallback", Context.MODE_PRIVATE)
    }

    var email: String?
        get() = prefs.getString(KEY_EMAIL, null)
        set(v) = prefs.edit().putString(KEY_EMAIL, v).apply()

    var password: String?
        get() = prefs.getString(KEY_PASSWORD, null)
        set(v) = prefs.edit().putString(KEY_PASSWORD, v).apply()

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(v) = prefs.edit().putString(KEY_TOKEN, v).apply()

    var accountIdHash: String?
        get() = prefs.getString(KEY_ACCOUNT_ID_HASH, null)
        set(v) = prefs.edit().putString(KEY_ACCOUNT_ID_HASH, v).apply()

    var region: String?
        get() = prefs.getString(KEY_REGION, null)
        set(v) = prefs.edit().putString(KEY_REGION, v).apply()

    var patientId: String?
        get() = prefs.getString(KEY_PATIENT_ID, null)
        set(v) = prefs.edit().putString(KEY_PATIENT_ID, v).apply()

    /** UI language: "fr" (default) or "es". */
    var language: String
        get() = prefs.getString(KEY_LANG, "fr") ?: "fr"
        set(v) = prefs.edit().putString(KEY_LANG, v).apply()

    /**
     * Whose phone this is: [ROLE_PARENT], [ROLE_CHILD], or null while it has never been chosen.
     *
     * One LibreLinkUp account can follow several people, and the Profile tab lets you switch between
     * them. On the child's own phone that switch is a hazard, not a feature: insulin and meals logged
     * there landed on the parent's record. A child device is therefore PINNED to
     * [lockedPatientId] — the person it was set up for — and cannot switch away.
     */
    var deviceRole: String?
        get() = prefs.getString(KEY_DEVICE_ROLE, null)
        set(v) = prefs.edit().putString(KEY_DEVICE_ROLE, v).apply()

    /** The one patient a CHILD device may ever write to. Null on a parent device (no restriction). */
    var lockedPatientId: String?
        get() = prefs.getString(KEY_LOCKED_PATIENT, null)
        set(v) = prefs.edit().putString(KEY_LOCKED_PATIENT, v).apply()

    /** True when this phone must stay on a single patient — i.e. it is the child's own device. */
    val isChildDevice: Boolean get() = deviceRole == ROLE_CHILD

    /** Meal-time reminders (08/12/16/20h) on/off. Default on. */
    var mealRemindersEnabled: Boolean
        get() = prefs.getBoolean(KEY_MEAL_REMINDERS, true)
        set(v) = prefs.edit().putBoolean(KEY_MEAL_REMINDERS, v).apply()

    /** Whether the one-time "allow background / exempt from battery optimization" prompt has been
     *  shown. Set once it's offered (granted or dismissed) so we don't nag — the Notifications page
     *  keeps a permanent toggle for changing it later. */
    var batteryPromptShown: Boolean
        get() = prefs.getBoolean(KEY_BATTERY_PROMPT, false)
        set(v) = prefs.edit().putBoolean(KEY_BATTERY_PROMPT, v).apply()

    /** On-phone hypo/hyper alarm SOUND on/off. Default on (safety). Turning it off silences only the
     *  local ring — the red banner and the server→Telegram alert are unaffected. */
    var alarmSoundEnabled: Boolean
        get() = prefs.getBoolean(KEY_ALARM_SOUND, true)
        set(v) = prefs.edit().putBoolean(KEY_ALARM_SOUND, v).apply()

    /** Vibrate on an alarm. Default on. With sound off + this on = "vibreur" mode. */
    var alarmVibrate: Boolean
        get() = prefs.getBoolean(KEY_ALARM_VIBRATE, true)
        set(v) = prefs.edit().putBoolean(KEY_ALARM_VIBRATE, v).apply()

    /** Alarm chime loudness, 0..100. Default 70 (deliberately softer than full). 0 = no sound. */
    var alarmVolumePct: Int
        get() = prefs.getInt(KEY_ALARM_VOLUME, 70).coerceIn(0, 100)
        set(v) = prefs.edit().putInt(KEY_ALARM_VOLUME, v.coerceIn(0, 100)).apply()

    /** Quiet hours (e.g. school / night): inside the window the HIGH alarm only vibrates. A LOW
     *  still sounds (the dangerous direction is never muted by a clock). Default OFF. */
    var quietHoursEnabled: Boolean
        get() = prefs.getBoolean(KEY_QUIET_ENABLED, false)
        set(v) = prefs.edit().putBoolean(KEY_QUIET_ENABLED, v).apply()

    /** Quiet-hours start/end as minutes from midnight (default 22:00 → 07:00). */
    var quietStartMin: Int
        get() = prefs.getInt(KEY_QUIET_START, 22 * 60)
        set(v) = prefs.edit().putInt(KEY_QUIET_START, v.coerceIn(0, 1439)).apply()

    var quietEndMin: Int
        get() = prefs.getInt(KEY_QUIET_END, 7 * 60)
        set(v) = prefs.edit().putInt(KEY_QUIET_END, v.coerceIn(0, 1439)).apply()

    /** Per-type alarm switches. Hypo defaults ON (safety; the UI warns if turned off). */
    var alarmHypoEnabled: Boolean
        get() = prefs.getBoolean(KEY_ALARM_HYPO, true)
        set(v) = prefs.edit().putBoolean(KEY_ALARM_HYPO, v).apply()

    var alarmHyperEnabled: Boolean
        get() = prefs.getBoolean(KEY_ALARM_HYPER, true)
        set(v) = prefs.edit().putBoolean(KEY_ALARM_HYPER, v).apply()

    var alarmRapidFallEnabled: Boolean
        get() = prefs.getBoolean(KEY_ALARM_RAPID_FALL, true)
        set(v) = prefs.edit().putBoolean(KEY_ALARM_RAPID_FALL, v).apply()

    /** Hypo (LOW) chimes even inside quiet hours. Default ON — the dangerous direction isn't muted by a
     *  clock. The user can turn it off (the UI shows a confirmation) to make hypo vibrate-only at night. */
    var alarmHypoAlwaysSounds: Boolean
        get() = prefs.getBoolean(KEY_ALARM_HYPO_ALWAYS, true)
        set(v) = prefs.edit().putBoolean(KEY_ALARM_HYPO_ALWAYS, v).apply()

    /** Snapshot the alarm prefs as the pure [AlarmPolicy.Settings] the ring sites resolve against. */
    fun alarmSettings(): AlarmPolicy.Settings = AlarmPolicy.Settings(
        soundEnabled = alarmSoundEnabled,
        volumePct = alarmVolumePct,
        vibrate = alarmVibrate,
        hypoEnabled = alarmHypoEnabled,
        hyperEnabled = alarmHyperEnabled,
        rapidFallEnabled = alarmRapidFallEnabled,
        hypoAlwaysSounds = alarmHypoAlwaysSounds,
        quietHoursEnabled = quietHoursEnabled,
        quietStartMin = quietStartMin,
        quietEndMin = quietEndMin
    )

    /** Use Health Connect (heart rate + steps). Default OFF — opt-in, and lets the user turn it
     *  back off from Profile after granting it (the OS permission itself is revoked in HC settings). */
    var healthConnectEnabled: Boolean
        get() = prefs.getBoolean(KEY_HEALTH_CONNECT, false)
        set(v) = prefs.edit().putBoolean(KEY_HEALTH_CONNECT, v).apply()

    /** Version of the safety/consent disclaimer the user has accepted (0 = never). */
    var consentVersion: Int
        get() = prefs.getInt(KEY_CONSENT_VERSION, 0)
        set(v) = prefs.edit().putInt(KEY_CONSENT_VERSION, v).apply()

    /** Timestamp (ms) of the last periodic "don't follow the AI blindly" reminder shown. */
    var lastSafetyPromptMs: Long
        get() = prefs.getLong(KEY_LAST_SAFETY_PROMPT, 0L)
        set(v) = prefs.edit().putLong(KEY_LAST_SAFETY_PROMPT, v).apply()

    /** AI voice (TTS) playback on/off. Default on. */
    var voiceEnabled: Boolean
        get() = prefs.getBoolean(KEY_VOICE_ENABLED, true)
        set(v) = prefs.edit().putBoolean(KEY_VOICE_ENABLED, v).apply()

    /** Use the free on-device Android TTS instead of the premium ElevenLabs cloud voice.
     *  Default ON — the cost-saving default for the public/free tier (ElevenLabs is opt-in). */
    var useNativeVoice: Boolean
        get() = prefs.getBoolean(KEY_NATIVE_VOICE, true)
        set(v) = prefs.edit().putBoolean(KEY_NATIVE_VOICE, v).apply()

    /** BYOK: the user's own Google Gemini API key. When set, the edge functions route the LLM
     *  to the user's free quota (marginal AI cost ≈ 0). Empty = use the server/Hosted key. */
    var geminiApiKey: String?
        get() = prefs.getString(KEY_GEMINI_KEY, null)
        set(v) = prefs.edit().putString(KEY_GEMINI_KEY, v?.trim()).apply()

    /** Hosted mode (opt-in, paid): use the project's keys + ElevenLabs voice + cloud sync.
     *  Default OFF (free/BYOK on-device). Ready-to-activate — see docs/ACTIVATION.md. */
    var hostedMode: Boolean
        get() = prefs.getBoolean(KEY_HOSTED, false)
        set(v) = prefs.edit().putBoolean(KEY_HOSTED, v).apply()

    /** Google account email after Sign-In (identity only; ≠ a Gemini key). Ready-to-activate. */
    var googleEmail: String?
        get() = prefs.getString(KEY_GOOGLE_EMAIL, null)
        set(v) = prefs.edit().putString(KEY_GOOGLE_EMAIL, v).apply()

    /** The last "improve insulin settings" suggestion text, so it persists across tab switches and
     *  app restarts instead of vanishing each time. Paired with the patientId it was computed for
     *  so it never shows under a different profile. */
    var ratioSuggestionText: String?
        get() = prefs.getString(KEY_RATIO_SUGGESTION, null)
        set(v) = prefs.edit().putString(KEY_RATIO_SUGGESTION, v).apply()

    var ratioSuggestionPatient: String?
        get() = prefs.getString(KEY_RATIO_SUGGESTION_PATIENT, null)
        set(v) = prefs.edit().putString(KEY_RATIO_SUGGESTION_PATIENT, v).apply()

    // The suggested ratios (numbers), so the "use these settings" button survives tab switches.
    var ratioSuggestionCarb: Int?
        get() = prefs.getInt(KEY_RATIO_SUGGESTION_CARB, 0).takeIf { it > 0 }
        set(v) = prefs.edit().putInt(KEY_RATIO_SUGGESTION_CARB, v ?: 0).apply()

    var ratioSuggestionCorr: Int?
        get() = prefs.getInt(KEY_RATIO_SUGGESTION_CORR, 0).takeIf { it > 0 }
        set(v) = prefs.edit().putInt(KEY_RATIO_SUGGESTION_CORR, v ?: 0).apply()

    /** The last AI analysis (coach) shown on the homepage, persisted so it stays visible across
     *  app restarts / time instead of disappearing and forcing the user to regenerate one.
     *  Paired with its timestamp + the patientId it was computed for. */
    var lastReportText: String?
        get() = prefs.getString(KEY_LAST_REPORT, null)
        set(v) = prefs.edit().putString(KEY_LAST_REPORT, v).apply()

    var lastReportAt: Long
        get() = prefs.getLong(KEY_LAST_REPORT_AT, 0L)
        set(v) = prefs.edit().putLong(KEY_LAST_REPORT_AT, v).apply()

    var lastReportPatient: String?
        get() = prefs.getString(KEY_LAST_REPORT_PATIENT, null)
        set(v) = prefs.edit().putString(KEY_LAST_REPORT_PATIENT, v).apply()

    /** The language ("fr"/"es") the persisted report was generated in, so a report in the wrong
     *  language is never shown after a language switch — we regenerate in the new language instead. */
    var lastReportLang: String?
        get() = prefs.getString(KEY_LAST_REPORT_LANG, null)
        set(v) = prefs.edit().putString(KEY_LAST_REPORT_LANG, v).apply()

    /** Per-device CAPABILITY TOKEN from mechabetics-claim (proves LibreLinkUp ownership of the
     *  patient). Sent as x-mechabetics-access on every edge-function call. Paired with the patientId
     *  it was issued for so it's never reused under a different profile. */
    var accessToken: String?
        get() = prefs.getString(KEY_ACCESS_TOKEN, null)
        set(v) = prefs.edit().putString(KEY_ACCESS_TOKEN, v).apply()

    var accessTokenPatient: String?
        get() = prefs.getString(KEY_ACCESS_TOKEN_PATIENT, null)
        set(v) = prefs.edit().putString(KEY_ACCESS_TOKEN_PATIENT, v).apply()

    /** True once the BYOK key is set OR Hosted mode is on — i.e. the AI can run. */
    val aiReady: Boolean get() = hostedMode || !geminiApiKey.isNullOrBlank()

    /** Premium (ElevenLabs) voice is used only in Hosted mode AND when native voice is off. */
    val premiumVoice: Boolean get() = hostedMode && !useNativeVoice

    /** Alert kind already alarmed for in the ongoing episode — so we don't re-ring on every
     *  app launch while still low/high. Null once the glucose recovers (alert NONE). */
    var firedAlert: String?
        get() = prefs.getString(KEY_FIRED_ALERT, null)
        set(v) = prefs.edit().putString(KEY_FIRED_ALERT, v).apply()

    /** Alert kind whose red banner the user dismissed via STOP. Null once recovered. */
    var ackAlert: String?
        get() = prefs.getString(KEY_ACK_ALERT, null)
        set(v) = prefs.edit().putString(KEY_ACK_ALERT, v).apply()

    /** When the looping alarm last SOUNDED (ms). Used to snooze: it sounds once, stays quiet for a
     *  while even if still out of range, then may sound again — instead of nagging every reading. */
    var lastAlarmMs: Long
        get() = prefs.getLong(KEY_LAST_ALARM, 0L)
        set(v) = prefs.edit().putLong(KEY_LAST_ALARM, v).apply()

    /** The glucose value (mg/dL) at the moment the alarm last SOUNDED. Lets a LOW re-sound when it
     *  keeps dropping (escalation) instead of staying snoozed while the hypo worsens. 0 = none. */
    var lastAlarmValue: Int
        get() = prefs.getInt(KEY_LAST_ALARM_VALUE, 0)
        set(v) = prefs.edit().putInt(KEY_LAST_ALARM_VALUE, v).apply()

    /** Drops the session tokens only (keeps email/password) — used to retry after a 401. */
    fun clearSession() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_ACCOUNT_ID_HASH)
            .remove(KEY_PATIENT_ID)
            .apply()
    }

    /**
     * Full sign-out of the ACTIVE account (credentials + session) WITHOUT touching the
     * saved-accounts list or global prefs (language / reminders). After this the app shows
     * the login screen, where the saved profiles remain tappable. Used by logout.
     */
    fun clearActiveSession() {
        prefs.edit()
            .remove(KEY_EMAIL)
            .remove(KEY_PASSWORD)
            .remove(KEY_TOKEN)
            .remove(KEY_ACCOUNT_ID_HASH)
            .remove(KEY_PATIENT_ID)
            .remove(KEY_REGION)
            .apply()
    }

    fun clearAll() = prefs.edit().clear().apply()

    val hasCredentials: Boolean
        get() = !email.isNullOrBlank() && !password.isNullOrBlank()

    // ---- Multi-profils : plusieurs comptes LibreLinkUp mémorisés ------------------------
    // The live fields above (email/password/token/…) are the ACTIVE account's working state.
    // The accounts list below persists every known account so the user can switch instantly.

    private fun accountsArray(): JSONArray =
        try { JSONArray(prefs.getString(KEY_ACCOUNTS, "[]") ?: "[]") } catch (e: Exception) { JSONArray() }

    private fun writeAccounts(arr: JSONArray) =
        prefs.edit().putString(KEY_ACCOUNTS, arr.toString()).apply()

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

    /** All remembered accounts, in insertion order. */
    fun accounts(): List<SavedAccount> {
        val arr = accountsArray()
        val out = ArrayList<SavedAccount>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val em = o.optStringOrNull("email") ?: continue
            out += SavedAccount(
                email = em,
                password = o.optString("password"),
                region = o.optStringOrNull("region"),
                token = o.optStringOrNull("token"),
                accountIdHash = o.optStringOrNull("accountIdHash"),
                patientId = o.optStringOrNull("patientId"),
                patientName = o.optStringOrNull("patientName")
            )
        }
        return out
    }

    /** Snapshot the current live fields (+ resolved patient name) into the saved list. */
    fun upsertActiveAccount(patientName: String?) {
        val em = email ?: return
        val arr = accountsArray()
        var idx = -1
        var existing: JSONObject? = null
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("email").equals(em, ignoreCase = true)) { idx = i; existing = o; break }
        }
        val name = patientName?.takeIf { it.isNotBlank() } ?: existing?.optStringOrNull("patientName")
        val obj = JSONObject().apply {
            put("email", em)
            put("password", password ?: existing?.optString("password") ?: "")
            putOpt("region", region)
            putOpt("token", token)
            putOpt("accountIdHash", accountIdHash)
            putOpt("patientId", patientId ?: existing?.optStringOrNull("patientId"))
            putOpt("patientName", name)
        }
        if (idx >= 0) arr.put(idx, obj) else arr.put(obj)
        writeAccounts(arr)
    }

    /** Load a saved account's fields into the live (active) fields. Returns it, or null. */
    fun activateAccount(target: String): SavedAccount? {
        val acc = accounts().firstOrNull { it.email.equals(target, ignoreCase = true) } ?: return null
        email = acc.email
        password = acc.password
        region = acc.region
        token = acc.token
        accountIdHash = acc.accountIdHash
        patientId = acc.patientId
        return acc
    }

    /** Remove an account from the saved list (does not touch the live/active fields). */
    fun removeAccountFromList(target: String) {
        val arr = accountsArray()
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (!o.optString("email").equals(target, ignoreCase = true)) kept.put(o)
        }
        writeAccounts(kept)
    }

    companion object {
        private const val KEY_EMAIL = "email"
        private const val KEY_PASSWORD = "password"
        private const val KEY_TOKEN = "token"
        private const val KEY_ACCOUNT_ID_HASH = "account_id_hash"
        private const val KEY_REGION = "region"
        private const val KEY_PATIENT_ID = "patient_id"
        private const val KEY_LANG = "language"
        private const val KEY_MEAL_REMINDERS = "meal_reminders"
        private const val KEY_BATTERY_PROMPT = "battery_prompt_shown"
        private const val KEY_HEALTH_CONNECT = "health_connect_enabled"
        private const val KEY_ACCOUNTS = "accounts"
        private const val KEY_CONSENT_VERSION = "consent_version"
        private const val KEY_LAST_SAFETY_PROMPT = "last_safety_prompt"
        private const val KEY_VOICE_ENABLED = "voice_enabled"
        private const val KEY_NATIVE_VOICE = "native_voice"
        private const val KEY_GEMINI_KEY = "gemini_api_key"
        private const val KEY_HOSTED = "hosted_mode"
        private const val KEY_GOOGLE_EMAIL = "google_email"
        private const val KEY_FIRED_ALERT = "fired_alert"
        private const val KEY_ACK_ALERT = "ack_alert"
        private const val KEY_LAST_ALARM = "last_alarm_ms"
        private const val KEY_LAST_ALARM_VALUE = "last_alarm_value"
        private const val KEY_ALARM_SOUND = "alarm_sound_enabled"
        private const val KEY_ALARM_VIBRATE = "alarm_vibrate"
        private const val KEY_ALARM_VOLUME = "alarm_volume_pct"
        private const val KEY_QUIET_ENABLED = "quiet_hours_enabled"
        private const val KEY_QUIET_START = "quiet_start_min"
        private const val KEY_QUIET_END = "quiet_end_min"
        private const val KEY_ALARM_HYPO = "alarm_hypo_enabled"
        private const val KEY_ALARM_HYPER = "alarm_hyper_enabled"
        private const val KEY_ALARM_RAPID_FALL = "alarm_rapid_fall_enabled"
        private const val KEY_ALARM_HYPO_ALWAYS = "alarm_hypo_always_sounds"
        private const val KEY_RATIO_SUGGESTION = "ratio_suggestion_text"
        private const val KEY_RATIO_SUGGESTION_PATIENT = "ratio_suggestion_patient"
        private const val KEY_RATIO_SUGGESTION_CARB = "ratio_suggestion_carb"
        private const val KEY_RATIO_SUGGESTION_CORR = "ratio_suggestion_corr"
        private const val KEY_LAST_REPORT = "last_report_text"
        private const val KEY_LAST_REPORT_AT = "last_report_at"
        private const val KEY_LAST_REPORT_PATIENT = "last_report_patient"
        private const val KEY_LAST_REPORT_LANG = "last_report_lang"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_ACCESS_TOKEN_PATIENT = "access_token_patient"
        private const val KEY_DEVICE_ROLE = "device_role"
        private const val KEY_LOCKED_PATIENT = "locked_patient"

        /** This phone belongs to the carer: every followed patient is reachable and switchable. */
        const val ROLE_PARENT = "parent"
        /** This phone belongs to the person with diabetes: pinned to their own record only. */
        const val ROLE_CHILD = "child"
    }
}
