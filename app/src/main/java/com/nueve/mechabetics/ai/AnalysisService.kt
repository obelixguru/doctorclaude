package com.nueve.mechabetics.ai

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Base64
import android.util.Log
import com.nueve.mechabetics.data.GlucoseReading
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Talks to the "Maman IA" coach via the Supabase Edge Function `mechabetics-coach`.
 *
 * No API keys live in the app anymore — Gemini & ElevenLabs keys stay server-side.
 * The app only carries the public anon key. The patient is identified by an opaque
 * hash (sha256 of the patientId) — the child's NAME is never sent.
 */
class AnalysisService(private val context: Context) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        // Hard overall cap per request: without it, a slow/streaming server response (e.g. a
        // reasoning LLM holding the connection) would leave the "Analyse…" spinner running forever.
        .callTimeout(80, TimeUnit.SECONDS)
        // Attach the per-device capability token (when claimed) to every edge-function call.
        .addInterceptor { chain ->
            val t = ApiAccess.token
            chain.proceed(
                if (t != null) chain.request().newBuilder().header("x-mechabetics-access", t).build()
                else chain.request()
            )
        }
        .build()

    private var player: MediaPlayer? = null

    /** When false, returned audio is never played (the "Voix" switch in Profile). */
    @Volatile var speakEnabled: Boolean = true

    /** BYOK Gemini key — sent to the edge functions so the LLM runs on the user's free quota. */
    @Volatile var byokKey: String? = null
    /** Ask the server for premium ElevenLabs audio (Hosted); else use the free on-device TTS. */
    @Volatile var premiumVoice: Boolean = false
    /** Speak responses with the free Android TTS when there's no premium audio (default on). */
    @Volatile var useNativeVoice: Boolean = true
    /** Hosted mode on? Sent to the server so it knows it may use its own (paid) LLM key. */
    @Volatile var hostedMode: Boolean = false
    /** Sensor past its 14-day life (set by MainActivity from LibreLinkUp's activation time). Sent
     *  with every AI call so a lost signal is explained by its real cause: replace the sensor —
     *  not "move the phone closer / re-scan", which can't revive a finished sensor. */
    @Volatile var sensorExpired: Boolean = false

    // True while a coach/answer voice is ACTUALLY playing — premium MediaPlayer audio OR the
    // on-device TTS — so the dashboard's speaker button can flip to a STOP icon and the tap cuts it.
    private val _speaking = MutableStateFlow(false)
    val speaking: StateFlow<Boolean> = _speaking.asStateFlow()

    private val nativeTts = NativeTts(context) { _speaking.value = it }

    // Last spoken line + audio, so the analysis card's speaker icon can replay it WITHOUT recomputing.
    @Volatile private var lastVoice: String = ""
    @Volatile private var lastAudioB64: String = ""
    @Volatile private var lastLang: String = "fr"

    private fun JSONObject.putAiFlags() {
        put("premiumVoice", premiumVoice)
        put("hosted", hostedMode)
        if (sensorExpired) put("sensorExpired", true)
        byokKey?.takeIf { it.isNotBlank() }?.let { put("geminiKey", it) }
    }

    /** Replay the last analysis/answer voice — reuses the fetched audio (no extra AI/voice cost).
     *  Bypasses the voice switch since it's an explicit user tap on the speaker icon. */
    fun replay() {
        val audio = lastAudioB64
        if (audio.isNotEmpty() && audio != "null") playBase64(audio)
        else if (lastVoice.isNotEmpty()) nativeTts.speak(lastVoice, lastLang)
    }

    /** True only if there's a cached voice to replay. */
    fun hasVoice(): Boolean = lastVoice.isNotEmpty() || (lastAudioB64.isNotEmpty() && lastAudioB64 != "null")

    /** Drop the cached replay audio/text (e.g. after a language switch) so the next replay re-speaks
     *  the CURRENT text in the CURRENT language instead of playing stale audio in the old one — fixes
     *  "FR text read aloud in the Spanish voice" after flipping the language. */
    fun clearVoiceCache() { lastVoice = ""; lastAudioB64 = "" }

    /** Re-read arbitrary text with the free on-device voice — used to speak a reused analysis aloud
     *  (e.g. after an app restart when there's no cached audio) without any new AI/voice cost. */
    fun speakText(text: String, lang: String) {
        if (!speakEnabled || text.isBlank()) return
        nativeTts.speak(text, lang)
    }

    /** Speak the AI's voice line: premium audio if present, otherwise free on-device TTS. */
    private fun speak(audioB64: String, voice: String, lang: String) {
        if (!speakEnabled) return
        if (audioB64.isNotEmpty() && audioB64 != "null") playBase64(audioB64)
        else if (useNativeVoice && voice.isNotEmpty()) nativeTts.speak(voice, lang)
    }

    data class AnalysisResult(
        val text: String,
        val isError: Boolean = false,
        val avg24h: Int? = null,
        val tir24h: Int? = null,
        val pctHigh24h: Int? = null,
        val pctLow24h: Int? = null,
        val mealNudge: Boolean = false,
        /** Server's classified cause when isError: "out_of_credits" | "rate_limited" | "auth" |
         *  "ai_down", or "transport" when WE couldn't even reach the backend. null on success. */
        val errorKind: String? = null,
        /** True when the server could not persist an auto-logged meal/dose (voice/scan): the user
         *  must be told, because an unrecorded insulin dose breaks IOB tracking. */
        val logFailed: Boolean = false
    )

    /** Honest message when we can't even reach the backend (network down, timeout, Supabase paused,
     *  non-2xx). The glucose feed + alarms are INDEPENDENT (LibreLinkUp-direct), so we say so. */
    private fun transportMsg(lang: String): String =
        if (lang == "es") "No se puede contactar con el servicio de Doctor Claude ahora. Tu glucosa y las alarmas siguen funcionando."
        else "Service Doctor Claude injoignable pour le moment. Ta glycémie et les alarmes fonctionnent toujours."

    data class PastAnalysis(val ts: Long, val message: String, val glucose: Int?)
    data class InsulinDose(val ts: Long, val units: Double, val name: String?, val id: Long = 0, val kind: String? = null)
    /** A logged meal (epoch ms + planned flag, plus description/carbs for the chart markers) — also
     *  mirrors the server's "rescue recent" rule so the LOW banner stops saying "take sugar". */
    data class RecentMeal(val ts: Long, val planned: Boolean, val description: String? = null, val carbsG: Int? = null)
    data class HistoryResult(
        val readings: List<GlucoseReading>,
        val analyses: List<PastAnalysis>,
        val insulin: List<InsulinDose>,
        val meals: List<RecentMeal> = emptyList(),
        val avg24h: Int? = null,
        val tir24h: Int? = null,
        val pctHigh24h: Int? = null,
        val pctLow24h: Int? = null
    )

    data class RatioSuggestion(
        val message: String,
        val carbRatio: Int?,
        val correctionFactor: Int?,
        val confidence: String?,
        val reason: String
    )

    /** A food that raised glucose the most after eating (desc + carbs + the mg/dL rise). */
    data class DietFood(val desc: String, val carbs: Int?, val spike: Int)
    /** Diététique analysis: code-owned DATA (carbs/day, fast/slow/fatty mix, post-meal spike, top
     *  spikers) + LLM-written summary / alerts / good points / tip. Rendered as cards, not a blob. */
    data class DietResult(
        val isError: Boolean,
        val errorKind: String? = null,
        val enough: Boolean = true,
        val days: Int = 7,
        val mealsCount: Int = 0,
        val avgCarbsPerDay: Int = 0,
        val fast: Int = 0, val slow: Int = 0, val fatty: Int = 0, val normal: Int = 0,
        val avgSpike: Int = 0,
        val topSpikers: List<DietFood> = emptyList(),
        val summary: String = "",
        val alerts: List<String> = emptyList(),
        val goodPoints: List<String> = emptyList(),
        val tip: String = ""
    )

    /** Diététique report (mechabetics-diet) over the last [days] days of LOGGED food + glucose. */
    suspend fun diet(patientId: String?, lang: String = "fr", days: Int = 7): DietResult =
        withContext(Dispatchers.IO) {
            if (patientId.isNullOrBlank()) return@withContext DietResult(isError = true, errorKind = "transport", summary = transportMsg(lang))
            try {
                val body = JSONObject().apply {
                    put("subject", sha256Hex(patientId)); put("lang", lang); put("days", days)
                    putAiFlags()
                }
                val req = Request.Builder()
                    .url("$FUNCTIONS_BASE/mechabetics-diet")
                    .addHeader("Authorization", "Bearer $ANON_KEY")
                    .addHeader("content-type", "application/json")
                    .post(body.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(req).execute().use { res ->
                    val raw = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        Log.e(TAG, "diet http ${res.code}"); ServiceHealth.reportUnreachable()
                        return@withContext DietResult(isError = true, errorKind = "transport", summary = transportMsg(lang))
                    }
                    val j = JSONObject(raw)
                    ServiceHealth.reportReachable()
                    val ekind = j.optString("errorKind").ifBlank { null }
                    if (j.optBoolean("isError", false) && ekind != null) ServiceHealth.reportAiProblem(ekind) else ServiceHealth.reportAiOk()
                    fun strList(key: String): List<String> {
                        val arr = j.optJSONArray(key) ?: return emptyList()
                        return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { x -> x.isNotBlank() } }
                    }
                    val sp = j.optJSONArray("topSpikers")
                    val spikers = if (sp == null) emptyList() else (0 until sp.length()).map {
                        val o = sp.getJSONObject(it)
                        DietFood(o.optString("desc"), if (o.isNull("carbs")) null else o.optInt("carbs"), o.optInt("spike"))
                    }
                    DietResult(
                        isError = j.optBoolean("isError", false), errorKind = ekind,
                        enough = j.optBoolean("enough", true), days = j.optInt("days", days),
                        mealsCount = j.optInt("mealsCount", 0), avgCarbsPerDay = j.optInt("avgCarbsPerDay", 0),
                        fast = j.optInt("fast", 0), slow = j.optInt("slow", 0), fatty = j.optInt("fatty", 0), normal = j.optInt("normal", 0),
                        avgSpike = j.optInt("avgSpike", 0), topSpikers = spikers,
                        summary = j.optString("summary", ""), alerts = strList("alerts"),
                        goodPoints = strList("goodPoints"), tip = j.optString("tip", "")
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "diet failed", e); ServiceHealth.reportUnreachable()
                DietResult(isError = true, errorKind = "transport", summary = transportMsg(lang))
            }
        }

    suspend fun coach(history: List<GlucoseReading>, patientId: String?, lang: String = "fr", playVoice: Boolean = true, force: Boolean = false): AnalysisResult =
        withContext(Dispatchers.IO) {
            if (patientId.isNullOrBlank()) return@withContext AnalysisResult("Patient inconnu.", isError = true)
            if (history.size < 3) return@withContext AnalysisResult(
                "Pas assez de mesures pour le moment — reviens dans un petit moment.",
                isError = true
            )
            try {
                val subject = sha256Hex(patientId)
                val readings = JSONArray()
                history.takeLast(192).forEach {
                    readings.put(JSONObject().apply {
                        put("ts", it.timestampMs)
                        put("value", it.valueMgDl)
                    })
                }
                val body = JSONObject().apply {
                    put("subject", subject)
                    put("readings", readings)
                    put("speak", playVoice)
                    put("lang", lang)
                    if (force) put("force", true) // explicit ANALYSE tap → server regenerates (no 10-min cache)
                    // Local UTC offset (min) so "today/yesterday" TIR uses the user's calendar days.
                    put("tzOffsetMin", java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000)
                    putAiFlags()
                }
                val req = Request.Builder()
                    .url("$FUNCTIONS_BASE/mechabetics-coach")
                    .addHeader("Authorization", "Bearer $ANON_KEY")
                    .addHeader("content-type", "application/json")
                    .post(body.toString().toRequestBody("application/json".toMediaType()))
                    .build()

                http.newCall(req).execute().use { res ->
                    val raw = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        Log.e(TAG, "coach http ${res.code}")
                        ServiceHealth.reportUnreachable()
                        return@withContext AnalysisResult(transportMsg(lang), isError = true, errorKind = "transport")
                    }
                    val j = JSONObject(raw)
                    val text = j.optString("text", "")
                    val isErr = j.optBoolean("isError", false)
                    val ekind = j.optString("errorKind").ifBlank { null }
                    // Global health: server reached; flag the AI problem (if any) or clear it.
                    ServiceHealth.reportReachable()
                    if (isErr && ekind != null) ServiceHealth.reportAiProblem(ekind) else ServiceHealth.reportAiOk()
                    val audio = j.optString("audioBase64", "")
                    val voiceLine = j.optString("voice", text)
                    // Cache the voice for replay ONLY on the user-facing call (playVoice). A SILENT
                    // prefetch of the OTHER language (bilingual prefetch / auto-greet) must not overwrite
                    // it — otherwise tapping ▷/ANALYSE reads the current text in the wrong language's
                    // voice (the "French text spoken in Spanish" bug).
                    if (playVoice) {
                        lastVoice = voiceLine; lastAudioB64 = audio; lastLang = lang
                        speak(audio, voiceLine, lang)
                    }
                    // Surface the server's 24h stats so the dashboard cards match the analysis.
                    val stats = j.optJSONObject("stats")
                    fun stat(k: String): Int? = if (stats != null && !stats.isNull(k)) stats.optInt(k) else null
                    AnalysisResult(
                        text, isError = isErr,
                        avg24h = stat("avg_24h"), tir24h = stat("tir_24h"),
                        pctHigh24h = stat("pct_high_24h"), pctLow24h = stat("pct_low_24h"),
                        mealNudge = j.optBoolean("mealNudge", false),
                        errorKind = ekind
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "coach failed", e)
                ServiceHealth.reportUnreachable()
                AnalysisResult(transportMsg(lang), isError = true, errorKind = "transport")
            }
        }

    /** Sends a transcribed voice question (plain text, from on-device SpeechRecognizer) to Claude (mechabetics-ask). */
    suspend fun ask(question: String, history: List<GlucoseReading>, patientId: String?, lang: String): AnalysisResult =
        withContext(Dispatchers.IO) {
            if (question.isBlank()) return@withContext AnalysisResult(
                if (lang == "es") "No te he entendido, ¿puedes repetir?" else "Je n'ai pas compris, tu peux répéter ?",
                isError = true
            )
            try {
                val readings = JSONArray()
                history.takeLast(12).forEach {
                    readings.put(JSONObject().apply { put("ts", it.timestampMs); put("value", it.valueMgDl) })
                }
                val body = JSONObject().apply {
                    put("question", question)
                    put("readings", readings)
                    put("lang", lang)
                    if (!patientId.isNullOrBlank()) put("subject", sha256Hex(patientId))
                    putAiFlags()
                }
                val req = Request.Builder()
                    .url("$FUNCTIONS_BASE/mechabetics-ask")
                    .addHeader("Authorization", "Bearer $ANON_KEY")
                    .addHeader("content-type", "application/json")
                    .post(body.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(req).execute().use { res ->
                    val raw = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        Log.e(TAG, "ask http ${res.code}")
                        ServiceHealth.reportUnreachable()
                        return@withContext AnalysisResult(transportMsg(lang), isError = true, errorKind = "transport")
                    }
                    val j = JSONObject(raw)
                    val text = j.optString("text", "")
                    val ans = j.optString("audioBase64", "")
                    val voiceLine = j.optString("voice", text)
                    // A Q&A answer is transient: speak it, but DON'T overwrite the analysis's replay
                    // cache, so the ▷ icon still re-reads the written ANALYSIS (not this spoken answer).
                    speak(ans, voiceLine, lang)
                    val ekind = j.optString("errorKind").ifBlank { null }
                    val isErr = j.optBoolean("isError", false)
                    ServiceHealth.reportReachable()
                    if (isErr && ekind != null) ServiceHealth.reportAiProblem(ekind) else ServiceHealth.reportAiOk()
                    AnalysisResult(
                        text, isError = isErr,
                        errorKind = ekind,
                        logFailed = j.optBoolean("logFailed", false)
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "ask failed", e)
                ServiceHealth.reportUnreachable()
                AnalysisResult(transportMsg(lang), isError = true, errorKind = "transport")
            }
        }

    /** Sends a product photo (JPEG bytes) to Claude (mechabetics-scan): identifies it,
     *  logs the meal, and returns the dose action. Plays the spoken action. */
    suspend fun scan(jpeg: ByteArray, patientId: String?, lang: String, history: List<GlucoseReading>): AnalysisResult =
        withContext(Dispatchers.IO) {
            try {
                val readings = JSONArray()
                // Send timestamps too: without them the server can't know the trend, so at a high it
                // skipped the correction (the user scanned a food at 215 and got only the meal bolus).
                history.takeLast(12).forEach { readings.put(JSONObject().apply { put("ts", it.timestampMs); put("value", it.valueMgDl) }) }
                val body = JSONObject().apply {
                    put("imageBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP))
                    put("mime", "image/jpeg")
                    put("readings", readings)
                    put("lang", lang)
                    if (!patientId.isNullOrBlank()) put("subject", sha256Hex(patientId))
                    putAiFlags()
                }
                val req = Request.Builder()
                    .url("$FUNCTIONS_BASE/mechabetics-scan")
                    .addHeader("Authorization", "Bearer $ANON_KEY")
                    .addHeader("content-type", "application/json")
                    .post(body.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(req).execute().use { res ->
                    val raw = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        Log.e(TAG, "scan http ${res.code}")
                        ServiceHealth.reportUnreachable()
                        return@withContext AnalysisResult(transportMsg(lang), isError = true, errorKind = "transport")
                    }
                    val j = JSONObject(raw)
                    val text = j.optString("text", "")
                    val ans = j.optString("audioBase64", "")
                    val voiceLine = j.optString("voice", text)
                    lastVoice = voiceLine; lastAudioB64 = ans; lastLang = lang
                    speak(ans, voiceLine, lang)
                    val ekind = j.optString("errorKind").ifBlank { null }
                    val isErr = j.optBoolean("isError", false)
                    ServiceHealth.reportReachable()
                    if (isErr && ekind != null) ServiceHealth.reportAiProblem(ekind) else ServiceHealth.reportAiOk()
                    AnalysisResult(
                        text, isError = isErr,
                        errorKind = ekind,
                        logFailed = j.optBoolean("logFailed", false)
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "scan failed", e)
                ServiceHealth.reportUnreachable()
                AnalysisResult(transportMsg(lang), isError = true, errorKind = "transport")
            }
        }

    /** Loads the full saved history (readings over N days + past AI analyses) for the history screen. */
    suspend fun history(patientId: String?, days: Int = 14, lang: String = "fr"): HistoryResult =
        withContext(Dispatchers.IO) {
            if (patientId.isNullOrBlank()) return@withContext HistoryResult(emptyList(), emptyList(), emptyList())
            try {
                val body = JSONObject().apply {
                    put("subject", sha256Hex(patientId))
                    put("days", days)
                    put("lang", lang) // ANALYSES tab follows the current language (bilingual prefetch stores both)
                }
                val req = Request.Builder()
                    .url("$FUNCTIONS_BASE/mechabetics-history")
                    .addHeader("Authorization", "Bearer $ANON_KEY")
                    .addHeader("content-type", "application/json")
                    .post(body.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(req).execute().use { res ->
                    val raw = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        Log.e(TAG, "history http ${res.code}")
                        ServiceHealth.reportUnreachable()
                        return@withContext HistoryResult(emptyList(), emptyList(), emptyList())
                    }
                    ServiceHealth.reportReachable()
                    val j = JSONObject(raw)
                    val readings = mutableListOf<GlucoseReading>()
                    j.optJSONArray("readings")?.let { arr ->
                        for (i in 0 until arr.length()) {
                            val o = arr.getJSONObject(i)
                            readings.add(GlucoseReading(o.optLong("ts"), o.optInt("value")))
                        }
                    }
                    val analyses = mutableListOf<PastAnalysis>()
                    j.optJSONArray("analyses")?.let { arr ->
                        for (i in 0 until arr.length()) {
                            val o = arr.getJSONObject(i)
                            analyses.add(
                                PastAnalysis(
                                    o.optLong("ts"),
                                    o.optString("message"),
                                    if (o.isNull("glucose")) null else o.optInt("glucose")
                                )
                            )
                        }
                    }
                    val insulin = mutableListOf<InsulinDose>()
                    j.optJSONArray("insulin")?.let { arr ->
                        for (i in 0 until arr.length()) {
                            val o = arr.getJSONObject(i)
                            insulin.add(
                                InsulinDose(
                                    o.optLong("ts"),
                                    o.optDouble("units"),
                                    if (o.isNull("name")) null else o.optString("name"),
                                    o.optLong("id"),
                                    if (o.isNull("kind")) null else o.optString("kind")
                                )
                            )
                        }
                    }
                    val meals = mutableListOf<RecentMeal>()
                    j.optJSONArray("meals")?.let { arr ->
                        for (i in 0 until arr.length()) {
                            val o = arr.getJSONObject(i)
                            meals.add(RecentMeal(
                                o.optLong("ts"), o.optBoolean("planned", false),
                                if (o.isNull("description")) null else o.optString("description"),
                                if (o.isNull("carbs_g")) null else o.optInt("carbs_g")
                            ))
                        }
                    }
                    val stats = j.optJSONObject("stats")
                    fun stat(k: String): Int? = if (stats != null && !stats.isNull(k)) stats.optInt(k) else null
                    HistoryResult(
                        readings, analyses, insulin, meals,
                        avg24h = stat("avg_24h"), tir24h = stat("tir_24h"),
                        pctHigh24h = stat("pct_high_24h"), pctLow24h = stat("pct_low_24h")
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "history failed", e)
                ServiceHealth.reportUnreachable()
                HistoryResult(emptyList(), emptyList(), emptyList())
            }
        }

    private fun playBase64(b64: String) {
        try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val file = File(context.cacheDir, "coach.mp3")
            FileOutputStream(file).use { it.write(bytes) }
            player?.release()
            player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                setDataSource(file.absolutePath)
                setOnPreparedListener { _speaking.value = true; it.start() }
                setOnCompletionListener { _speaking.value = false }
                setOnErrorListener { _, what, extra -> Log.e(TAG, "MediaPlayer error $what/$extra"); _speaking.value = false; false }
                prepareAsync()
            }
        } catch (e: Exception) {
            Log.e(TAG, "play failed", e)
        }
    }

    fun stopSpeaking() {
        try { player?.release() } catch (_: Exception) {}
        player = null
        nativeTts.stop()
        _speaking.value = false
    }

    /** Full teardown (call from Activity.onDestroy). */
    fun release() {
        stopSpeaking()
        nativeTts.shutdown()
    }

    /** Asks the server to suggest refined ICR/ISF from the logged data (read-only, never applied). */
    suspend fun autotune(patientId: String?, lang: String): RatioSuggestion? =
        withContext(Dispatchers.IO) {
            if (patientId.isNullOrBlank()) return@withContext null
            try {
                val body = JSONObject().apply { put("subject", sha256Hex(patientId)); put("lang", lang) }
                val req = Request.Builder()
                    .url("$FUNCTIONS_BASE/mechabetics-autotune")
                    .addHeader("Authorization", "Bearer $ANON_KEY")
                    .addHeader("content-type", "application/json")
                    .post(body.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(req).execute().use { res ->
                    val raw = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        ServiceHealth.reportUnreachable()
                        return@withContext null
                    }
                    ServiceHealth.reportReachable()
                    val j = JSONObject(raw)
                    RatioSuggestion(
                        message = j.optString("message"),
                        carbRatio = if (j.isNull("suggestedCarbRatio")) null else j.optInt("suggestedCarbRatio"),
                        correctionFactor = if (j.isNull("suggestedCorrectionFactor")) null else j.optInt("suggestedCorrectionFactor"),
                        confidence = if (j.isNull("confidence")) null else j.optString("confidence"),
                        reason = j.optString("reason")
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "autotune failed", e)
                ServiceHealth.reportUnreachable()
                null
            }
        }

    companion object {
        private const val TAG = "Coach"
        private const val FUNCTIONS_BASE = "https://vzafttfgrxpjdraveihh.supabase.co/functions/v1"
        // Public anon key — safe to ship; protected by RLS + edge function logic.
        private const val ANON_KEY =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6YWZ0dGZncnhwamRyYXZlaWhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMTQ3MDAsImV4cCI6MjA5MjY5MDcwMH0.LX0TVh4BaCLnowQd8wnQLZ95iS_mxeJTaPRn-s7zKko"

        fun sha256Hex(input: String): String {
            val md = MessageDigest.getInstance("SHA-256")
            return md.digest(input.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        }
    }
}
