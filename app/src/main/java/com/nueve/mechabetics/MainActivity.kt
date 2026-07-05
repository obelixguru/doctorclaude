package com.nueve.mechabetics

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.nueve.mechabetics.ai.AnalysisService
import com.nueve.mechabetics.ai.VoiceInput
import com.nueve.mechabetics.data.AlarmPolicy
import com.nueve.mechabetics.data.AlertKind
import com.nueve.mechabetics.data.CredentialsStore
import com.nueve.mechabetics.data.GlucoseAlert
import com.nueve.mechabetics.data.GlucoseReading
import com.nueve.mechabetics.data.GlucoseRepository
import com.nueve.mechabetics.data.HealthConnectManager
import com.nueve.mechabetics.data.LibreLinkUpClient
import com.nueve.mechabetics.data.MealReminderReceiver
import com.nueve.mechabetics.data.Predictor
import com.nueve.mechabetics.data.Trend
import com.nueve.mechabetics.data.cleanGlucoseSeries
import com.nueve.mechabetics.data.glucoseRisingNow
import com.nueve.mechabetics.data.insulinActionMinutes
import com.nueve.mechabetics.data.DEFAULT_INSULIN_ACTION_MIN
import com.nueve.mechabetics.data.local.LocalHistoryDb
import com.nueve.mechabetics.ui.AppHeader
import com.nueve.mechabetics.ui.ConsentScreen
import com.nueve.mechabetics.ui.DashboardScreen
import com.nueve.mechabetics.ui.NetworkBanner
import com.nueve.mechabetics.ui.ServiceHealthBanner
import com.nueve.mechabetics.ui.colorFor
import com.nueve.mechabetics.ui.theme.AccentGreen
import com.nueve.mechabetics.ui.theme.GlucoseStatus
import com.nueve.mechabetics.ui.theme.statusOf
import com.nueve.mechabetics.ui.Safety
import com.nueve.mechabetics.ui.SafetyModal
import com.nueve.mechabetics.ui.BatteryExemptionDialog
import com.nueve.mechabetics.ui.HistoryScreen
import com.nueve.mechabetics.ui.NotificationSettingsScreen
import com.nueve.mechabetics.ui.Lang
import com.nueve.mechabetics.ui.LocalStrings
import com.nueve.mechabetics.ui.LoginScreen
import com.nueve.mechabetics.ui.langFromCode
import com.nueve.mechabetics.ui.stringsFor
import com.nueve.mechabetics.ui.theme.DoctorClaudeTheme
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import com.nueve.mechabetics.ai.MealsService
import com.nueve.mechabetics.ai.ApiAccess
import com.nueve.mechabetics.ai.ClaimService
import com.nueve.mechabetics.ai.ProfileService
import com.nueve.mechabetics.ui.DoctorClaudeBottomBar
import com.nueve.mechabetics.ui.FoodScreen
import com.nueve.mechabetics.ui.InsulinScreen
import com.nueve.mechabetics.ui.PatientChoice
import com.nueve.mechabetics.ui.ProfileItem
import com.nueve.mechabetics.ui.ProfileScreen
import com.nueve.mechabetics.ui.Tab

class MainActivity : ComponentActivity() {

    private lateinit var store: CredentialsStore
    private lateinit var client: LibreLinkUpClient
    private lateinit var repo: GlucoseRepository
    private lateinit var ai: AnalysisService
    private lateinit var voice: VoiceInput
    private lateinit var health: HealthConnectManager
    private lateinit var localDb: LocalHistoryDb
    private val profile = ProfileService()
    private val meals = MealsService()
    private val claim = ClaimService()
    private val micPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private val notifPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val app = application as MechabeticsApp
        store = app.store
        client = app.client
        localDb = app.localDb
        repo = app.repo // app-scoped, shared with MonitorService; bootstrap() ran in its lazy init
        ai = AnalysisService(this)
        ai.speakEnabled = store.voiceEnabled
        applyAiSettings()
        health = HealthConnectManager(this)
        voice = VoiceInput(this)
        // Restore the capability token for the current patient so the very first edge-function calls
        // already carry it (per-user auth, Phase B).
        ApiAccess.token = store.accessToken?.takeIf { store.accessTokenPatient == store.patientId }

        // Needed so the hypo/hyper alarm notification + full-screen alert can show (API 33+).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        // Meal-time reminders (08/12/16/20h) — only if the user kept them on in Profile.
        if (store.mealRemindersEnabled) MealReminderReceiver.schedule(this)

        // Track real phone connectivity so the global "réseau perdu" banner can warn that the app is
        // limited (online-only: glucose, coach + saves all need the network) until it comes back.
        NetworkMonitor.start(this)

        // Start always-on monitoring so polling + hypo/hyper alarms keep running when the app is
        // backgrounded / the screen is off (the MonitorService is the sole poller now).
        if (store.token != null) MonitorService.start(this)

        setContent {
            DoctorClaudeTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    AppRoot()
                }
            }
        }

        // Auto-login if we have stored credentials but token is gone (e.g. session expired)
        if (store.hasCredentials && store.token == null) {
            lifecycleScope.launch {
                store.email?.let { e -> store.password?.let { p -> repo.login(e, p) } }
            }
        }
    }

    /** Push the current AI/voice prefs into the service (call after any settings change). */
    private fun applyAiSettings() {
        ai.byokKey = store.geminiApiKey
        ai.premiumVoice = store.premiumVoice
        ai.useNativeVoice = store.useNativeVoice
        ai.hostedMode = store.hostedMode
    }

    @Composable
    private fun AppRoot() {
        val state by repo.state.collectAsStateWithLifecycle()
        val isSpeaking by ai.speaking.collectAsStateWithLifecycle()
        // Sensor past its 14-day life (LibreLinkUp activation + 14 d). Drives the home CAPTEUR
        // EXPIRÉ card (via sensorEndMs below) and is flagged to every AI call so a lost signal is
        // explained by its real cause (replace the sensor — not "re-scan"). Recomputed on every
        // state emission (each 60 s poll flips isLoading, so this stays fresh even with no reading).
        val sensorExpired = state.sensorEndMs?.let { System.currentTimeMillis() > it } == true
        LaunchedEffect(sensorExpired) { ai.sensorExpired = sensorExpired }
        // Pre-fill the last saved analysis (per patient) so the homepage report is shown immediately
        // and never "disappears" — it persists across restarts and stays visible with its timestamp.
        var aiText by remember { mutableStateOf(if (store.lastReportPatient == store.patientId) store.lastReportText.orEmpty() else "") }
        var aiAt by remember { mutableStateOf(if (store.lastReportPatient == store.patientId) store.lastReportAt else 0L) }
        // The language the on-screen analysis was written in. A report in a language other than the
        // current UI language must NOT be shown (or reused) — we regenerate it in the new language.
        var aiLang by remember { mutableStateOf(if (store.lastReportPatient == store.patientId) store.lastReportLang.orEmpty() else "") }
        // True when the on-screen text is a full ANALYSIS report (coach), false for a Q&A answer (ask).
        // Only reports get pre-translated to the other language for instant language switching.
        var aiIsReport by remember { mutableStateOf(store.lastReportPatient == store.patientId && !store.lastReportText.isNullOrEmpty()) }
        var aiLoading by remember { mutableStateOf(false) }
        var isRecording by remember { mutableStateOf(false) }
        var lang by remember { mutableStateOf(langFromCode(store.language)) }
        var tab by remember { mutableStateOf(Tab.GLUCOSE) }
        var showAllHistory by remember { mutableStateOf(false) }
        // Full notifications-&-alarms management page, opened from a card in Profile.
        var showNotifSettings by remember { mutableStateOf(false) }
        // Which tab the advanced history opens on: 0 = Général, 1 = Historique (list), 2 = Analyses.
        var historyInitialTab by remember { mutableStateOf(0) }
        // Bilingual analysis cache for the current data window: when a report is shown we also fetch
        // the OTHER language (silent, text-only) so flipping FR<->ES is instant, never a reload.
        val reports = remember { mutableStateMapOf<String, String>() } // lang code -> report text
        var reportsPatient by remember { mutableStateOf<String?>(null) }
        var reportsAt by remember { mutableStateOf(0L) }
        var stat24Avg by remember { mutableStateOf<Int?>(null) }
        var stat24Tir by remember { mutableStateOf<Int?>(null) }
        var stat24High by remember { mutableStateOf<Int?>(null) }
        var stat24Low by remember { mutableStateOf<Int?>(null) }
        var addingAccount by remember { mutableStateOf(false) }
        var consented by remember { mutableStateOf(store.consentVersion >= Safety.CONSENT_VERSION) }
        var showSafety by remember { mutableStateOf(false) }
        // One-time prompt to whitelist the app from battery optimization so monitoring keeps polling
        // with the screen off (Doze). Shown once per install when logged in and not yet exempt.
        var showBatteryPrompt by remember { mutableStateOf(false) }
        var mealNudge by remember { mutableStateOf(false) }
        // Insulin-on-board from recent rapid doses — silences the HIGH alarm/banner when a
        // correction is already working (so it stops nagging after you've taken insulin).
        var recentInsulinIob by remember { mutableStateOf(0.0) }
        // Meal/insulin markers for the home chart, and a bump-counter so adding a dose/meal re-reads
        // IOB immediately (otherwise the HIGH alarm keeps ringing until the next glucose reading).
        var homeEvents by remember { mutableStateOf<List<com.nueve.mechabetics.ui.GraphEvent>>(emptyList()) }
        var dataVersion by remember { mutableStateOf(0) }
        // True once the first history fetch has computed IOB. The HIGH alarm depends on IOB, so until
        // it's known we must NOT fire a HIGH off the initial IOB=0 (the relaunch race: the alarm rang
        // for a high that the insulin-on-board was actually already covering).
        var iobReady by remember { mutableStateOf(false) }
        // True when a non-planned meal (hypo rescue / eaten carbs) was logged within the last 15 min
        // — the client-side mirror of the server's minutesSinceLastRescue. When low, the red banner
        // then says "you already took sugar, let it act" instead of "take sugar now" (the banner
        // stays red — the glucose IS low; only the action subtext changes).
        var rescueRecent by remember { mutableStateOf(false) }
        // Live proactive prediction (client-side mirror of the server's predictiveAdvice) —
        // computed on the recent LIVE window so the slope reflects right now.
        val prediction = remember(state.history) { Predictor.of(state.history) }

        // Voice capture extracted so the mic-permission launcher can start it DIRECTLY after the user
        // grants permission — no more "tap PARLER, grant, then tap PARLER again".
        fun startVoiceCapture() {
            ai.stopSpeaking()
            val code = lang.code.lowercase()
            isRecording = true
            voice.start(
                lang = code,
                onText = { q ->
                    isRecording = false
                    // A spoken Q&A answer is SPOKEN ONLY — it must NOT overwrite the written analysis
                    // report. The user can ask anything (even off-topic, like a companion) without
                    // losing the bilan. ai.ask() speaks the answer itself; we don't touch aiText/aiLoading.
                    lifecycleScope.launch {
                        try {
                            val r = ai.ask(q, state.history, state.patientId, code)
                            // Normally a spoken answer is voice-only. EXCEPTION: a dictated meal/dose
                            // that FAILED to save is safety-critical (esp. insulin → IOB) and the spoken
                            // reply alone wouldn't mention it — surface the warning on the card so it
                            // isn't lost silently.
                            if (r.logFailed && r.text.isNotBlank()) {
                                aiText = r.text; aiAt = System.currentTimeMillis(); aiLang = code; aiIsReport = false
                            }
                        } catch (e: Exception) {
                            android.util.Log.e("Dashboard", "voice ask failed", e)
                        }
                    }
                },
                onError = { isRecording = false }
            )
        }
        val micPermLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { granted -> if (granted) startVoiceCapture() }

        // The homepage is a 24h view: pull the last 24h of readings from the server (the CGM cloud
        // only serves a short live window) and merge with the live points for the graph + list.
        var history24 by remember { mutableStateOf<List<GlucoseReading>>(emptyList()) }
        // Re-fetch the 24h server history whenever a new live reading lands (not only at login), so
        // the homepage curve stays as fresh as the history screen instead of freezing at login time.
        LaunchedEffect(state.isLoggedIn, state.patientId, state.current?.timestampMs, dataVersion) {
            if (state.isLoggedIn && state.patientId != null) {
                val h = ai.history(state.patientId, 1)
                if (h.readings.isNotEmpty()) history24 = h.readings
                homeEvents = com.nueve.mechabetics.ui.buildGraphEvents(h.insulin, h.meals)
                // Stats come from the (ungated) history endpoint so the average + TIR bar show even
                // when the AI is gated (no Hosted mode / no Gemini key).
                h.avg24h?.let { stat24Avg = it }
                h.tir24h?.let { stat24Tir = it }
                h.pctHigh24h?.let { stat24High = it }
                h.pctLow24h?.let { stat24Low = it }
                // Insulin-on-board (recent RAPID doses, ~4 h linear decay). BASAL (slow/background,
                // e.g. Lantus) is NOT correction IOB and must be EXCLUDED — mirrors the server's
                // activeIob (which skips kind=="basal"). Otherwise a 10 u Lantus both inflated the IOB
                // and SILENCED the HIGH alarm for hours (recentInsulinIob gates the HIGH alarm/banner).
                val iNow = System.currentTimeMillis()
                val rapidDoses = h.insulin.filter { it.kind != "basal" }
                recentInsulinIob = rapidDoses.sumOf { d ->
                    val dur = (insulinActionMinutes(d.name) ?: DEFAULT_INSULIN_ACTION_MIN).toDouble()
                    val mins = (iNow - d.ts) / 60000.0
                    if (mins in 0.0..dur) d.units * (1 - mins / dur) else 0.0
                }.coerceAtLeast(0.0)
                iobReady = true // IOB now known → the HIGH alarm may evaluate (see the alert effect)
                // Share the RAPID doses (name kept for type-aware decay) with the repo so the
                // background MonitorService computes the same IOB for its HIGH-alarm suppression while
                // the app is closed. Basal is filtered out HERE (the Triple carries no kind, so the
                // monitor could not exclude it itself) — it must never silence the HIGH alarm.
                repo.setInsulinDoses(rapidDoses.map { Triple(it.ts, it.units, it.name) })
                // Last EATEN (non-planned) meal, in minutes, mirroring the server's
                // minutesSinceLastRescue (drop planned, ignore >1 min future, round to minutes) so the
                // LOW banner agrees with the spoken analysis.
                val lastRescueMs = h.meals.filter { !it.planned && it.ts <= iNow + 60_000L }.maxOfOrNull { it.ts }
                val minSinceRescue = lastRescueMs?.let { Math.round((iNow - it) / 60000.0) }
                rescueRecent = minSinceRescue != null && minSinceRescue in 0..RESCUE_WINDOW_MIN
                // Share it with the repo so the BACKGROUND MonitorService's LOW alarm is rescue-aware too.
                repo.setLastRescueMs(lastRescueMs ?: 0L)
                // Meal nudge ("ça monte sans repas enregistré") — computed LIVE here, every reading,
                // instead of trusting the server's sticky flag. Two bugs came from the old flag:
                //  (1) it was set on a rising trend and NEVER cleared when the rise ended, so it
                //      lingered on the home screen for hours (stale); (2) its 90-min window was shorter
                //      than how long a meal keeps glucose up (~2–3 h), so it nagged "log a meal" long
                //      after breakfast WAS logged. Now the nudge shows ONLY while glucose is actually
                //      rising, > 140, signal fresh, not at night, AND no meal logged in the last 3 h —
                //      re-evaluated on every reading, so it appears/disappears with the real situation
                //      and can never go stale. (Server still computes its own mealNudge for the AI's
                //      WORDING; the banner no longer depends on it.)
                val lastMealMs = h.meals.maxOfOrNull { it.ts }
                val mealLoggedRecently = lastMealMs != null && iNow - lastMealMs <= 180 * 60_000L
                val localHour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
                val isNight = localHour < 7 || localHour >= 23
                val liveFresh = state.current?.let { iNow - it.timestampMs <= GlucoseAlert.FRESHNESS_WINDOW_MS } ?: false
                val curVal = state.current?.valueMgDl
                mealNudge = !isNight && liveFresh && !mealLoggedRecently &&
                    curVal != null && curVal > 140 && glucoseRisingNow(state.history)
            }
        }
        val graph24 = remember(history24, state.history, state.current) {
            val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000
            // Include the LIVE `current` so the curve always reaches the latest value — the cloud grid
            // and the server-stored history can lag a few minutes behind the live measurement, which
            // is why the home graph used to stop short (e.g. at 160) while the big number showed 214.
            // dedupe to 5-min buckets + drop noisy-source up-spikes (same filter as the server).
            cleanGlucoseSeries((history24 + state.history + listOfNotNull(state.current)).filter { it.timestampMs >= cutoff })
        }

        fun profileItems(): List<ProfileItem> = store.accounts().map {
            ProfileItem(
                email = it.email,
                label = it.patientName?.takeIf { n -> n.isNotBlank() } ?: it.email,
                active = it.email.equals(store.email, ignoreCase = true)
            )
        }
        var profiles by remember { mutableStateOf(profileItems()) }
        LaunchedEffect(state.patientId, state.isLoggedIn, state.patientName) { profiles = profileItems() }

        // The MonitorService is the sole poller now (it keeps polling when the app is backgrounded),
        // so the UI no longer launches its own poll loop — it just ensures the service is running.
        LaunchedEffect(state.isLoggedIn) {
            if (state.isLoggedIn) MonitorService.start(this@MainActivity)
        }

        // Per-user auth: once the patient is known, use (then refresh) a capability token that proves
        // LibreLinkUp ownership; the OkHttp interceptors attach it to every call. The server now REQUIRES
        // it, so AI/history/profile/meals need a valid token (glucose polling + alarms are independent).
        LaunchedEffect(state.patientId, state.isLoggedIn) {
            val pid = state.patientId
            if (state.isLoggedIn && pid != null) {
                // Immediately use the stored token for THIS patient (so the first calls already carry it)…
                ApiAccess.token = store.accessToken?.takeIf { store.accessTokenPatient == pid }
                // …then (re)claim a fresh token, even if a stored one exists. Claims rotate per (patient,
                // account), so a device whose token was rotated away by another install would be stranded
                // on a stale token forever now that the server requires a valid one. Re-claiming on each
                // cold open makes it self-heal. Best-effort: on failure the stored token (applied above)
                // is kept, never wiped, so a transient LLU outage can't lock the user out.
                if (store.token != null) {
                    val tok = claim.claim(pid, store.token!!, store.region, store.accountIdHash)
                    if (tok != null) {
                        store.accessToken = tok
                        store.accessTokenPatient = pid
                        ApiAccess.token = tok
                    }
                }
            }
        }

        // Maman IA parle d'elle-même au lancement, dès que les données sont prêtes.
        var autoGreeted by remember { mutableStateOf(false) }
        LaunchedEffect(state.history.size, state.patientId, state.isLoggedIn) {
            if (!autoGreeted && state.isLoggedIn && state.patientId != null && state.history.size >= 3) {
                autoGreeted = true
                // Don't burn an AI call if a recent report is already on screen — but reuse it ONLY when
                // it's the same patient, the SAME LANGUAGE, and < 10 min old. Otherwise regenerate
                // (keeping the old one visible meanwhile for everything except a language mismatch).
                val haveFresh = store.lastReportPatient == state.patientId &&
                    aiText.isNotEmpty() && aiLang == lang.code.lowercase() &&
                    System.currentTimeMillis() - aiAt < 10 * 60_000L
                if (!haveFresh) {
                    if (!store.aiReady) {
                        // No Hosted mode and no Gemini key → only show the "enable AI" hint if there's
                        // no saved report to keep showing.
                        if (aiText.isEmpty()) { aiText = stringsFor(lang).aiNeedsKey; aiLang = lang.code.lowercase() }
                    } else {
                        // SILENT launch greeting — runs in the background and must NOT spin the ANALYSE
                        // button (that spinner is reserved for an explicit ANALYSE tap). The previously
                        // saved report stays on screen until this one lands. Wrapped in try/catch: a new
                        // reading arriving mid-call cancels this effect, and a slow/failed call must never
                        // leave the UI wedged — here we simply keep the old report.
                        try {
                            val r = ai.coach(state.history, state.patientId, lang.code.lowercase(), playVoice = false)
                            if (!r.isError && r.text.isNotEmpty()) {
                                aiText = r.text; aiAt = System.currentTimeMillis(); aiLang = lang.code.lowercase(); aiIsReport = true
                                store.lastReportText = r.text; store.lastReportAt = aiAt; store.lastReportPatient = state.patientId
                                store.lastReportLang = lang.code.lowercase()
                                r.avg24h?.let { stat24Avg = it }
                                r.tir24h?.let { stat24Tir = it }
                                r.pctHigh24h?.let { stat24High = it }
                                r.pctLow24h?.let { stat24Low = it }
                            }
                        } catch (e: Exception) {
                            android.util.Log.e("Dashboard", "auto-greet analyze failed", e)
                        }
                    }
                }
            }
        }

        // Changing the UI language must not leave a report on screen in the PREVIOUS language. The
        // other language is normally PRE-GENERATED (see the prefetch effect below), so flipping just
        // swaps to the cached text INSTANTLY — no AI call, no spinner, no reload. Only when nothing is
        // cached yet (e.g. flipped within the first seconds) do we fall back to regenerating.
        LaunchedEffect(lang) {
            val code = lang.code.lowercase()
            if (aiLang.lowercase() == code) return@LaunchedEffect // already in this language
            // Language changed → drop the cached replay audio so tapping ANALYSE/▷ never reads the
            // new-language text aloud in the OLD language's voice (FR text spoken with the ES voice).
            ai.clearVoiceCache()
            // 1) INSTANT path: the report was already translated for this same data window.
            val cached = reports[code]
            val fresh = reportsPatient == state.patientId && (System.currentTimeMillis() - reportsAt) < 10 * 60_000L
            if (aiIsReport && !cached.isNullOrEmpty() && fresh) {
                ai.stopSpeaking()
                aiText = cached; aiAt = reportsAt; aiLang = code
                store.lastReportText = cached; store.lastReportAt = reportsAt
                store.lastReportPatient = state.patientId; store.lastReportLang = code
                return@LaunchedEffect
            }
            // 2) Fallback: regenerate in the new language (only if a report/hint was on screen).
            if (aiText.isNotEmpty() && aiLang.isNotEmpty() && aiLang != code) {
                ai.stopSpeaking()
                if (!store.aiReady) {
                    aiText = stringsFor(lang).aiNeedsKey; aiAt = 0L; aiLang = code; aiIsReport = false
                } else {
                    aiText = ""; aiAt = 0L
                    if (state.isLoggedIn && state.patientId != null && state.history.size >= 3) {
                        aiLoading = true
                        try {
                            val r = ai.coach(state.history, state.patientId, code, playVoice = false)
                            aiText = r.text; aiAt = System.currentTimeMillis(); aiLang = code; aiIsReport = true
                            if (!r.isError && r.text.isNotEmpty()) {
                                store.lastReportText = r.text; store.lastReportAt = aiAt
                                store.lastReportPatient = state.patientId; store.lastReportLang = code
                            }
                            r.avg24h?.let { stat24Avg = it }
                            r.tir24h?.let { stat24Tir = it }
                            r.pctHigh24h?.let { stat24High = it }
                            r.pctLow24h?.let { stat24Low = it }
                        } catch (e: Exception) {
                            android.util.Log.e("Dashboard", "lang-change analyze failed", e)
                            if (aiText.isBlank()) { aiText = stringsFor(lang).aiError; aiLang = code }
                        } finally {
                            aiLoading = false
                        }
                    } else {
                        aiLang = "" // nothing to regenerate yet — cleared so the stale language never shows
                    }
                }
            }
        }

        // Keep BOTH languages of the current analysis ready, so a language switch is instant. Whenever
        // a REPORT is shown (in aiLang), record it and silently fetch the OTHER language's text in the
        // background (text-only, no voice → cheap; BYOK Gemini = free to us). Skips Q&A answers
        // (aiIsReport=false) and the no-AI case. Runs once per new report (cached afterwards).
        LaunchedEffect(aiText, aiLang, aiIsReport, state.patientId) {
            val code = aiLang.lowercase()
            if (!aiIsReport || aiText.isEmpty() || code.isEmpty() || state.patientId == null) return@LaunchedEffect
            if (!store.aiReady || state.history.size < 3) return@LaunchedEffect
            val isNew = reports[code] != aiText || reportsPatient != state.patientId
            reports[code] = aiText
            reportsPatient = state.patientId
            reportsAt = if (aiAt > 0) aiAt else System.currentTimeMillis()
            val other = if (code == "fr") "es" else "fr"
            if (isNew) reports.remove(other) // the report changed → the other-language copy is now stale
            if (!reports[other].isNullOrEmpty()) return@LaunchedEffect // already pre-generated
            try {
                val r = ai.coach(state.history, state.patientId, other, playVoice = false)
                if (!r.isError && r.text.isNotEmpty()) reports[other] = r.text
            } catch (e: Exception) {
                android.util.Log.e("Dashboard", "prefetch other-language report failed", e)
            }
        }

        // Hypo/hyper + fast-curve watchdog. We remember (persisted) which alert we've already
        // alarmed for and which the user dismissed, so the alarm does NOT re-ring on every app
        // launch while still out of range, and the red banner stays hidden after STOP until the
        // glucose recovers. On recovery (NONE) we re-arm for the next episode.
        var currentAlert by remember { mutableStateOf(GlucoseAlert(AlertKind.NONE, 0.0, 0)) }
        var firedAlert by remember { mutableStateOf(store.firedAlert) }
        var ackAlert by remember { mutableStateOf(store.ackAlert) }
        LaunchedEffect(state.current?.timestampMs, state.current?.valueMgDl, recentInsulinIob, iobReady) {
            val raw = GlucoseAlert.of(state.current, state.history)
            // A HIGH only rings when there's actually something to DO (mirrors the dose guard's
            // "aucune insuline" cases), so the alarm never contradicts the analysis:
            //   - IOB not loaded yet (relaunch) -> wait, don't fire off a momentary IOB=0;
            //   - insulin on board and not still climbing -> it's being handled;
            //   - already coming down (falling) -> no correction needed, it self-resolves.
            // A high that keeps RISING despite insulin still alarms. Lows / fast-falls always alert.
            val highHandled = raw.kind == AlertKind.HIGH && (
                !iobReady ||
                (recentInsulinIob >= 0.5 && raw.slope < HIGH_RISING_SLOPE) ||
                raw.slope <= -0.5
            )
            val alert = if (highHandled) GlucoseAlert(AlertKind.NONE, raw.slope, raw.value) else raw
            currentAlert = alert
            val kindName = alert.kind.name
            if (alert.kind == AlertKind.NONE) {
                // Stop any sound, but RE-ARM the episode only with hysteresis (mirrors AlarmEngine.decide
                // used by the background service): a hyper still hovering at the edge after settling
                // under 180 must not re-arm, or a small bounce back over 180 re-rings instantly as a
                // "new" episode — the "ça sonnait en revenant à la normale" bug. The banner is driven by
                // currentAlert (already NONE here), so this only governs the loud ring.
                val v = alert.value
                val stillSettling =
                    (firedAlert == AlertKind.HIGH.name && v > GlucoseAlert.HIGH - GlucoseAlert.RECOVERY_MARGIN) ||
                    (firedAlert == AlertKind.LOW.name && v in 1 until GlucoseAlert.LOW + GlucoseAlert.RECOVERY_MARGIN) ||
                    (v == 0 && firedAlert != null)
                if (!stillSettling) {
                    if (firedAlert != null) { firedAlert = null; store.firedAlert = null }
                    if (store.lastAlarmValue != 0) store.lastAlarmValue = 0 // re-arm hypo escalation for next episode
                }
                if (ackAlert != null) { ackAlert = null; store.ackAlert = null }
                AlarmService.stop(this@MainActivity)
                return@LaunchedEffect
            }
            // Sound on a NEW episode, then SNOOZE: don't re-sound the same kind for ALARM_SNOOZE_MS
            // (you've already seen it). After the snooze, if still out of range, it sounds again. The
            // red banner stays meanwhile (until STOP). This stops the every-reading nagging — and a
            // genuinely new episode (or a worse kind) always sounds the first time.
            if (alert.ringsAlarm) {
                val nowA = System.currentTimeMillis()
                val newEpisode = firedAlert != kindName
                // A LOW that keeps DROPPING breaks the snooze and re-sounds (escalation): it fell
                // another ≥10 mg/dL since we last rang, or it just crossed into severe hypo (<54).
                // Without this, a 68→45 slide stays muted for the whole 20-min snooze window.
                val worseningHypo = alert.kind == AlertKind.LOW && store.lastAlarmValue > 0 && (
                    alert.value <= store.lastAlarmValue - HYPO_ESCALATE_DROP ||
                    (alert.value < SEVERE_LOW && store.lastAlarmValue >= SEVERE_LOW)
                )
                val snoozed = !newEpisode && !worseningHypo && (nowA - store.lastAlarmMs) < ALARM_SNOOZE_MS
                if (!snoozed) {
                    firedAlert = kindName; store.firedAlert = kindName
                    store.lastAlarmMs = nowA
                    store.lastAlarmValue = alert.value
                    ackAlert = null; store.ackAlert = null
                    // The local ring is resolved against the user's notification settings (per-type
                    // on/off, volume, vibrate, quiet hours). The red banner and the auto-spoken hypo
                    // analysis below stay regardless of how the phone alarm is configured.
                    val eff = AlarmPolicy.effect(alert.kind, store.alarmSettings(), minuteOfDay(nowA))
                    if (eff.ring) {
                        val (title, body) = alarmTitleBody(alert, lang, rescueRecent)
                        AlarmService.start(this@MainActivity, title, body, eff.volumePct, eff.vibrate)
                    }
                    // Auto-run the spoken analysis ONLY for a real hypo (LOW) — safety-critical, worth
                    // the interruption. For HIGH / rapid-fall, the alarm + banner are enough; we don't
                    // auto-replace the report (the user disliked it "reloading a new analysis" by itself).
                    if (alert.kind == AlertKind.LOW && store.voiceEnabled && state.patientId != null && store.aiReady) {
                        aiLoading = true
                        aiText = ""
                        val code = lang.code.lowercase()
                        val q = urgentQuestion(alert, lang, rescueRecent)
                        lifecycleScope.launch {
                            try {
                                val r = ai.ask(q, state.history, state.patientId, code)
                                aiText = r.text; aiAt = System.currentTimeMillis(); aiLang = code; aiIsReport = false
                            } catch (e: Exception) {
                                android.util.Log.e("Dashboard", "hypo auto-analyze failed", e)
                                // Fresh timestamp so the error is shown as current, not instantly aged
                                // out into the "refaire une analyse" prompt by the 20-min freshness rule.
                                if (aiText.isBlank()) { aiText = stringsFor(lang).aiError; aiAt = System.currentTimeMillis(); aiLang = code }
                            } finally {
                                aiLoading = false
                            }
                        }
                    }
                }
            }
        }

        // Periodic safety reminder: nudge the user not to follow the AI blindly.
        LaunchedEffect(state.isLoggedIn, consented) {
            if (consented && state.isLoggedIn &&
                System.currentTimeMillis() - store.lastSafetyPromptMs > Safety.SAFETY_PROMPT_INTERVAL_MS
            ) showSafety = true
        }

        // One-time "let the app run in the background" prompt — the keystone for monitoring to keep
        // scanning in standby (esp. Samsung One UI). Offered once; thereafter it's in Notifications.
        LaunchedEffect(state.isLoggedIn, consented) {
            if (consented && state.isLoggedIn && !store.batteryPromptShown &&
                !PowerExemption.isExempt(this@MainActivity)
            ) showBatteryPrompt = true
        }

        CompositionLocalProvider(LocalStrings provides stringsFor(lang)) {
        if (!consented) {
            ConsentScreen(onAccept = {
                store.consentVersion = Safety.CONSENT_VERSION
                store.lastSafetyPromptMs = System.currentTimeMillis()
                consented = true
            })
        } else {
        if (state.isLoggedIn && !addingAccount) {
            Scaffold(bottomBar = {
                // Bottom nav is ALWAYS visible. Profil's ENREGISTRER lifts above the keyboard on its
                // own via Modifier.imePadding() (it clears the keyboard; the nav bar just sits behind
                // it). Do NOT gate the bar on WindowInsets.isImeVisible — that experimental inset
                // misreports as "visible" on some OEM builds (Samsung One UI / Galaxy A32), which made
                // the whole footer vanish permanently.
                // The Glucose tab's icon + pill follow the live glucose colour. On NO SIGNAL it turns
                // RED (same danger colour as the NO SIGNAL banner) — not knowing the glucose is itself a
                // safety state, so it must stand out from any tab, not sit as a calm neutral green.
                val navStale = state.lastUpdateMs > 0L &&
                    System.currentTimeMillis() - state.lastUpdateMs > GlucoseAlert.FRESHNESS_WINDOW_MS
                val navGlucoseColor = when {
                    navStale -> GlucoseStatus.DANGER.strong
                    else -> state.current?.let { colorFor(it.valueMgDl) } ?: AccentGreen
                }
                // Light the Glucose tab up (coloured even when inactive) on NO SIGNAL, or for a live
                // WARNING/DANGER value; a calm in-range glucose keeps it a normal grey/green tab.
                val navGlucoseAlert = navStale ||
                    (state.current?.let { statusOf(it.valueMgDl) != GlucoseStatus.GOOD } ?: false)
                DoctorClaudeBottomBar(tab, navGlucoseColor, navGlucoseAlert) { tab = it; showAllHistory = false; showNotifSettings = false }
            }) { pad ->
                Box(Modifier.padding(pad)) {
                  Column(Modifier.fillMaxSize()) {
                    // GLOBAL "phone offline" banner — visible on EVERY tab. Shown FIRST because no
                    // network is the root cause; the backend-health banner stays hidden while offline.
                    NetworkBanner(lang)
                    // GLOBAL "something fell" banner — visible on EVERY tab. Any backend call that
                    // fails (history/stats/DB/AI/credits) raises it; a later success clears it.
                    ServiceHealthBanner()
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                    if (showNotifSettings) {
                        NotificationSettingsScreen(
                            store = store,
                            lang = lang,
                            onBack = { showNotifSettings = false }
                        )
                    } else if (showAllHistory) {
                        HistoryScreen(
                            history = state.history,
                            patientId = state.patientId,
                            ai = ai,
                            lang = lang,
                            lastUpdateMs = state.lastUpdateMs,
                            onToggleLang = {
                                lang = if (lang == Lang.FR) Lang.ES else Lang.FR
                                store.language = lang.code.lowercase()
                            },
                            onBack = { showAllHistory = false },
                            initialTab = historyInitialTab
                        )
                    } else {
                    // The SAME header as the home, on every tab — only the title changes (the page
                    // name). Keeps the app harmonious. Defined here so it shares the home's callbacks.
                    val tabHeaderSubtitle = if (state.patientName.isNotBlank()) state.patientName else stringsFor(lang).sensor
                    val tabHeader: @Composable (String, Boolean) -> Unit = { title, showLogout ->
                        AppHeader(
                            title = title,
                            subtitle = tabHeaderSubtitle,
                            lang = lang,
                            onToggleLang = {
                                lang = if (lang == Lang.FR) Lang.ES else Lang.FR
                                store.language = lang.code.lowercase()
                            },
                            // Refresh only on Home + advanced History; logout only on Profile.
                            onRefresh = null,
                            onLogout = if (showLogout) {
                                {
                                    MonitorService.stop(this@MainActivity)
                                    ai.stopSpeaking()
                                    AlarmService.stop(this@MainActivity)
                                    aiText = ""; aiLang = ""
                                    addingAccount = false
                                    repo.logout()
                                }
                            } else null
                        )
                    }
                    when (tab) {
                        Tab.GLUCOSE -> DashboardScreen(
                patientName = state.patientName,
                current = state.current,
                alert = if (currentAlert.isUrgent && currentAlert.kind.name != ackAlert) currentAlert
                        else GlucoseAlert(AlertKind.NONE, 0.0, 0),
                history = graph24,
                events = homeEvents,
                serverAvg = stat24Avg,
                serverTir = stat24Tir,
                serverHigh = stat24High,
                serverLow = stat24Low,
                isLoading = state.isLoading,
                lastUpdateMs = state.lastUpdateMs,
                sensorEndMs = state.sensorEndMs,
                error = state.error,
                aiText = aiText,
                aiAt = aiAt,
                aiLoading = aiLoading,
                isRecording = isRecording,
                lang = lang,
                onToggleLang = {
                    // Flip the UI language. The LaunchedEffect(lang) above then drops any on-screen
                    // analysis written in the previous language and regenerates it in the new one, so
                    // we never show a French report while the app is in Spanish (or vice-versa).
                    lang = if (lang == Lang.FR) Lang.ES else Lang.FR
                    store.language = lang.code.lowercase()
                },
                onRefresh = { lifecycleScope.launch { repo.refresh() } },
                onLogout = {
                    MonitorService.stop(this@MainActivity)
                    ai.stopSpeaking()
                    AlarmService.stop(this@MainActivity)
                    aiText = ""; aiLang = ""
                    addingAccount = false
                    repo.logout()
                },
                onAnalyze = {
                    // ANALYSE always generates a FRESH analysis — the user expects a new one each tap.
                    // The server's own 10-min cache still avoids AI cost when nothing changed; re-
                    // listening to the existing report is the speaker ▷ icon's job, not this button.
                    if (!store.aiReady) {
                        aiText = stringsFor(lang).aiNeedsKey; aiLang = lang.code.lowercase(); aiIsReport = false
                    } else {
                        aiLoading = true
                        aiText = ""
                        lifecycleScope.launch {
                            // try/finally guarantees the spinner ALWAYS clears — even if a call throws
                            // or is cut by the 80s callTimeout — so "Analyse…" can never hang forever.
                            try {
                                val r = ai.coach(state.history, state.patientId, lang.code.lowercase(), force = true)
                                aiText = r.text; aiAt = System.currentTimeMillis(); aiLang = lang.code.lowercase(); aiIsReport = true
                                if (!r.isError && r.text.isNotEmpty()) {
                                    store.lastReportText = r.text; store.lastReportAt = aiAt; store.lastReportPatient = state.patientId
                                    store.lastReportLang = lang.code.lowercase()
                                }
                                r.avg24h?.let { stat24Avg = it }
                                r.tir24h?.let { stat24Tir = it }
                                r.pctHigh24h?.let { stat24High = it }
                                r.pctLow24h?.let { stat24Low = it }
                                val h = ai.history(state.patientId, 1)
                                if (h.readings.isNotEmpty()) history24 = h.readings
                                h.avg24h?.let { stat24Avg = it }
                                h.tir24h?.let { stat24Tir = it }
                                h.pctHigh24h?.let { stat24High = it }
                                h.pctLow24h?.let { stat24Low = it }
                            } catch (e: Exception) {
                                android.util.Log.e("Dashboard", "analyze failed", e)
                                // Fresh timestamp so the error is shown as current, not instantly aged
                                // out into the "refaire une analyse" prompt by the 20-min freshness rule.
                                if (aiText.isBlank()) { aiText = stringsFor(lang).aiError; aiAt = System.currentTimeMillis(); aiLang = lang.code.lowercase() }
                            } finally {
                                aiLoading = false
                            }
                        }
                    }
                },
                onMicClick = {
                    // Tapping PARLER cuts off whatever Doctor Claude is reading aloud right now, so the
                    // mic doesn't record over the AI's own voice (and it's what the user expects).
                    ai.stopSpeaking()
                    when {
                        !store.aiReady -> { aiText = stringsFor(lang).aiNeedsKey; aiLang = lang.code.lowercase() }
                        ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ->
                            // On grant, the launcher starts recording itself — no second tap needed.
                            micPermLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        !isRecording -> startVoiceCapture()
                        else -> { isRecording = false; voice.stopListening() }
                    }
                },
                onOpenHistory = { historyInitialTab = 0; showAllHistory = true },
                // "VOIR TOUT L'HISTORIQUE" lands straight on the HISTORIQUE (readings list) tab.
                onSeeAllHistory = { historyInitialTab = 1; showAllHistory = true },
                onStopAlarm = {
                    AlarmService.stop(this@MainActivity)
                    ai.stopSpeaking()
                    val k = currentAlert.kind.name
                    ackAlert = k; store.ackAlert = k
                },
                onStopVoice = { ai.stopSpeaking() },
                // Read the report aloud: reuse the cached audio if we have it, otherwise speak the
                // text with the on-device voice — so the speaker button still works (and flips to
                // STOP) even after a restart, when the audio is no longer cached in memory.
                onReplayVoice = { if (ai.hasVoice()) ai.replay() else ai.speakText(aiText, lang.code.lowercase()) },
                isSpeaking = isSpeaking,
                predictive = prediction,
                mealNudge = mealNudge,
                onLogMeal = { tab = Tab.MEALS; mealNudge = false },
                rescueRecent = rescueRecent,
                        )
                        Tab.MEALS -> FoodScreen(state.patientId, meals, ai, lang, state.history, header = { tabHeader(stringsFor(lang).tabMeals, false) }, onDataChanged = { dataVersion++ })
                        Tab.INSULIN -> InsulinScreen(state.patientId, meals, ai, profile, lang, store, header = { tabHeader(stringsFor(lang).tabInsulin, false) }, onDataChanged = { dataVersion++ })
                        Tab.PROFILE -> ProfileScreen(
                            patientId = state.patientId,
                            service = profile,
                            lang = lang,
                            store = store,
                            profiles = profiles,
                            onSwitchProfile = { em ->
                                lifecycleScope.launch {
                                    ai.stopSpeaking()
                                    AlarmService.stop(this@MainActivity)
                                    aiText = ""; aiLang = ""; autoGreeted = false
                                    repo.switchProfile(em)
                                    profiles = profileItems()
                                    tab = Tab.GLUCOSE
                                }
                            },
                            onAddProfile = { repo.clearError(); addingAccount = true },
                            health = health,
                            onAiSettingsChange = { applyAiSettings() },
                            onVoiceChange = { ai.speakEnabled = it },
                            onRemoveProfile = { em ->
                                lifecycleScope.launch {
                                    repo.removeProfile(em)
                                    profiles = profileItems()
                                }
                            },
                            onClearLocalData = { repo.clearLocalData() },
                            onOpenNotifications = { showNotifSettings = true },
                            patients = state.connections.map { c ->
                                PatientChoice(
                                    patientId = c.patientId,
                                    label = "${c.firstName} ${c.lastName}".trim().ifBlank { c.patientId },
                                    active = c.patientId == state.patientId
                                )
                            },
                            onSwitchPatient = { pid ->
                                val nm = state.connections.firstOrNull { it.patientId == pid }
                                    ?.let { "${it.firstName} ${it.lastName}".trim() }
                                    .orEmpty()
                                lifecycleScope.launch {
                                    ai.stopSpeaking()
                                    AlarmService.stop(this@MainActivity)
                                    aiText = ""; aiLang = ""; autoGreeted = false
                                    repo.switchPatient(pid, nm)
                                    MonitorService.start(this@MainActivity)
                                    tab = Tab.GLUCOSE
                                }
                            },
                            onRefreshPatients = {
                                lifecycleScope.launch { if (state.isLoggedIn) repo.refreshConnections() }
                            },
                            header = { tabHeader(stringsFor(lang).tabProfile, true) }
                        )
                    }
                    }
                    }
                  }
                }
            }
        } else if (addingAccount) {
            LoginScreen(
                isLoading = state.isLoading,
                error = state.error,
                addMode = true,
                onBack = { repo.clearError(); addingAccount = false },
                onLogin = { email, password ->
                    lifecycleScope.launch {
                        val ok = repo.addAccount(email, password)
                        if (ok) {
                            addingAccount = false
                            aiText = ""; aiLang = ""
                            autoGreeted = false
                            tab = Tab.GLUCOSE
                        }
                        profiles = profileItems()
                    }
                }
            )
        } else {
            LoginScreen(
                isLoading = state.isLoading,
                error = state.error,
                savedProfiles = profiles,
                onPickProfile = { em ->
                    lifecycleScope.launch {
                        aiText = ""; aiLang = ""
                        autoGreeted = false
                        repo.switchProfile(em)
                        profiles = profileItems()
                    }
                },
                onLogin = { email, password ->
                    lifecycleScope.launch {
                        repo.login(email, password)
                        profiles = profileItems()
                    }
                }
            )
        }
        if (showSafety) {
            SafetyModal(onDismiss = {
                store.lastSafetyPromptMs = System.currentTimeMillis()
                showSafety = false
            })
        }
        if (showBatteryPrompt) {
            BatteryExemptionDialog(
                lang = lang,
                onAllow = {
                    // Mark BEFORE launching the system dialog (it bounces us through onStop/onResume,
                    // which would otherwise re-trigger the prompt).
                    store.batteryPromptShown = true
                    showBatteryPrompt = false
                    PowerExemption.request(this@MainActivity)
                },
                onLater = {
                    store.batteryPromptShown = true
                    showBatteryPrompt = false
                }
            )
        }
        }
        }
    }

    override fun onStart() {
        super.onStart()
        // App is in the foreground → the on-screen logic owns the alarm; keep monitoring running.
        MonitorService.appForeground = true
        if (store.token != null) MonitorService.start(this)
    }

    override fun onResume() {
        super.onResume()
        // Opening the app — including tapping the alarm notification — silences the alarm.
        AlarmService.stop(this)
        // Refresh immediately on every foreground so the data is current the instant the user looks,
        // instead of waiting up to a poll cycle — covers "I open the app right after LibreLink got
        // the signal back and it finally works".
        if (store.token != null) lifecycleScope.launch { repo.refresh() }
    }

    override fun onStop() {
        // App going to the background → hand the hypo/hyper alarm over to the MonitorService.
        MonitorService.appForeground = false
        super.onStop()
    }

    override fun onDestroy() {
        super.onDestroy()
        // Deliberately do NOT stop MonitorService here — monitoring must outlive the UI; it stops
        // only on explicit logout.
        ai.release()
        voice.stop()
    }
}

// Alarm ring-policy values are CANONICAL in GlucoseAlert (shared with MonitorService); aliased here
// so the on-screen alarm effect keeps reading the same single source of truth.
private const val ALARM_SNOOZE_MS = GlucoseAlert.SNOOZE_MS
private const val HYPO_ESCALATE_DROP = GlucoseAlert.HYPO_ESCALATE_DROP
private const val SEVERE_LOW = GlucoseAlert.SEVERE_LOW
private const val HIGH_RISING_SLOPE = GlucoseAlert.HIGH_RISING_SLOPE

/** Carbs eaten within this many minutes are still being absorbed (the clinical "rule of 15"): a LOW
 *  after a recent rescue tells the user to let it act, not to take more. Same value AND same
 *  round-to-minutes rule as RESCUE_WINDOW_MIN / minutesSinceLastRescue in _shared/doseGuard.ts, so
 *  the banner can never contradict the server's spoken analysis. */
private val RESCUE_WINDOW_MIN = GlucoseAlert.RESCUE_WINDOW_MIN.toLong()

/** The urgent, auto-spoken question sent to Doctor Claude (ask) when an alert fires. When sugar was
 *  JUST taken, the question asks whether to wait or re-treat (the server's guard then answers
 *  "let it act" — unless it's a severe low), so the spoken reply matches the on-screen banner. */
private fun urgentQuestion(a: GlucoseAlert, lang: Lang, rescueRecent: Boolean = false): String {
    val es = lang == Lang.ES
    val v = a.value
    val rate = String.format(java.util.Locale.US, "%.1f", kotlin.math.abs(a.slope))
    return when (a.kind) {
        AlertKind.LOW ->
            if (rescueRecent)
                (if (es) "Mi glucosa está en $v mg/dL, por debajo de 70, pero acabo de tomar azúcar hace unos minutos. ¿Espero a que actúe o tomo más?"
                 else "Ma glycémie est à $v mg/dL, sous 70, mais je viens de prendre du sucre il y a quelques minutes. Je laisse agir ou j'en reprends ?")
            else if (es) "Urgencia: mi glucosa está en $v mg/dL, por debajo de 70 (hipo). ¿Qué hago AHORA y cuántos terrones de azúcar?"
            else "Urgence : ma glycémie est à $v mg/dL, sous 70 (hypo). Que dois-je faire MAINTENANT et combien de morceaux de sucre ?"
        AlertKind.HIGH ->
            if (es) "Mi glucosa está en $v mg/dL, por encima de 180. ¿Qué hago ahora? ¿Insulina y cuánta?"
            else "Ma glycémie est à $v mg/dL, au-dessus de 180. Que dois-je faire maintenant ? Insuline et combien ?"
        AlertKind.RAPID_FALL ->
            if (es) "Mi glucosa está en $v mg/dL (aún en rango) pero baja rápido (~$rate mg/dL por minuto). No estoy en hipo. ¿Debo preocuparme y qué vigilo?"
            else "Ma glycémie est à $v mg/dL (encore dans la cible) mais descend vite (~$rate mg/dL par minute). Je ne suis pas en hypo. Dois-je m'inquiéter et que dois-je surveiller ?"
        AlertKind.RAPID_RISE ->
            if (es) "Mi glucosa sube rápido (~$rate mg/dL por minuto), ahora $v mg/dL. ¿Qué hago?"
            else "Ma glycémie monte vite (~$rate mg/dL par minute), actuellement $v mg/dL. Que faire ?"
        AlertKind.NONE -> ""
    }
}

/** Notification title + body for the looping alarm (FR/ES). Used by the UI and the MonitorService.
 *  The LOW body is rescue-aware so it never contradicts the analysis: if sugar was JUST taken (and
 *  it's not a SEVERE low) it says "let it act / recheck" instead of "take sugar now"; a severe low
 *  (< SEVERE_LOW) always says take sugar — a deep hypo must never wait on the AI. */
internal fun alarmTitleBody(a: GlucoseAlert, lang: Lang, rescueRecent: Boolean = false): Pair<String, String> {
    val es = lang == Lang.ES
    return when (a.kind) {
        AlertKind.LOW -> {
            val title = if (es) "⚠ Glucosa BAJA : ${a.value} mg/dL" else "⚠ Glycémie BASSE : ${a.value} mg/dL"
            val severe = a.value in 1 until SEVERE_LOW
            val body = when {
                severe -> if (es) "Hipo. Toma azúcar rápido ya. Toca para el análisis."
                          else "Hypo. Prends du sucre rapide tout de suite. Touche pour l'analyse."
                rescueRecent -> if (es) "Ya tomaste azúcar — deja que actúe y vuelve a medir. Toca para el análisis."
                                else "Tu as déjà pris du sucre — laisse-le agir et recontrôle. Touche pour l'analyse."
                else -> if (es) "Hipo. Toma azúcar rápido. Toca para el análisis."
                        else "Hypo. Prends du sucre rapide. Touche pour l'analyse."
            }
            title to body
        }
        AlertKind.HIGH ->
            (if (es) "⚠ Glucosa ALTA : ${a.value} mg/dL" else "⚠ Glycémie HAUTE : ${a.value} mg/dL") to
                (if (es) "Glucosa alta. Toca para ver si hay que corregir." else "Glycémie haute. Touche pour voir s'il faut corriger.")
        AlertKind.RAPID_FALL ->
            (if (es) "⚠ BAJADA RÁPIDA : ${a.value} mg/dL" else "⚠ CHUTE RAPIDE : ${a.value} mg/dL") to
                (if (es) "Baja rápido. Ten azúcar a mano y vigila. Toca para saber más." else "Ça descend vite. Garde du sucre à portée et surveille. Touche pour en savoir plus.")
        else -> "Doctor Claude" to ""
    }
}

/** Local wall-clock minute of day (0..1439) for the alarm's quiet-hours check. Shared by the UI and
 *  the MonitorService so both resolve the same window. */
internal fun minuteOfDay(nowMs: Long): Int {
    val c = java.util.Calendar.getInstance()
    c.timeInMillis = nowMs
    return c.get(java.util.Calendar.HOUR_OF_DAY) * 60 + c.get(java.util.Calendar.MINUTE)
}
