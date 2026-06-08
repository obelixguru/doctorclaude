package com.nueve.mechabetics.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.automirrored.outlined.VolumeUp
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import androidx.compose.ui.platform.LocalContext
import com.nueve.mechabetics.data.AlertKind
import com.nueve.mechabetics.data.GlucoseAlert
import com.nueve.mechabetics.data.GlucoseReading
import com.nueve.mechabetics.data.Trend
import com.nueve.mechabetics.data.PredictKind
import com.nueve.mechabetics.data.Prediction
import com.nueve.mechabetics.ai.ServiceHealth
import com.nueve.mechabetics.ui.theme.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun DashboardScreen(
    patientName: String,
    current: GlucoseReading?,
    alert: GlucoseAlert = GlucoseAlert(AlertKind.NONE, 0.0, 0),
    history: List<GlucoseReading>,
    events: List<GraphEvent> = emptyList(),
    isLoading: Boolean,
    lastUpdateMs: Long,
    error: String?,
    aiText: String,
    aiAt: Long = 0L,
    aiLoading: Boolean,
    isRecording: Boolean,
    lang: Lang,
    onToggleLang: () -> Unit,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    onAnalyze: () -> Unit,
    onMicClick: () -> Unit,
    onOpenHistory: () -> Unit,
    // "VOIR TOUT L'HISTORIQUE" opens the advanced view straight on the HISTORIQUE (list) tab, not
    // Général. Defaults to onOpenHistory so previews/other callers stay valid.
    onSeeAllHistory: () -> Unit = onOpenHistory,
    onStopAlarm: () -> Unit = {},
    onStopVoice: () -> Unit = {},
    onReplayVoice: () -> Unit = {},
    isSpeaking: Boolean = false,
    predictive: Prediction? = null,
    mealNudge: Boolean = false,
    onLogMeal: () -> Unit = {},
    // A hypo rescue was eaten in the last ~15 min: the LOW banner then says "let it act, recheck"
    // instead of "take sugar now" (it stays red — the glucose IS low; only the action text changes).
    rescueRecent: Boolean = false,
    serverAvg: Int? = null,
    serverTir: Int? = null,
    serverHigh: Int? = null,
    serverLow: Int? = null
) {
    val s = LocalStrings.current
    // A ticking clock so "signal lost" / NO SIGNAL appears on its own as the data ages, even when no
    // new reading arrives to trigger a recomposition (a frozen sensor emits no state change at all).
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(30_000) } }
    // Single source of truth for "the live value is too old to trust" — same 5-min window the alarm
    // uses, so the big number disappears at the exact moment the alarms go quiet.
    val signalStale = lastUpdateMs > 0L && now - lastUpdateMs > GlucoseAlert.FRESHNESS_WINDOW_MS
    // On NO SIGNAL we don't KNOW the status, so the whole home goes NEUTRAL (grey) instead of
    // green/orange/red — only the NO SIGNAL card itself stays red (CurrentReadingCard). A stale
    // "all green" screen used to imply everything was fine while we had no live value at all.
    val liveStatus = statusOf(current?.valueMgDl)
    val bg by animateColorAsState(if (signalStale) LightBg else liveStatus.wash, tween(700), label = "bg")
    val c1 by animateColorAsState(if (signalStale) InkMuted else liveStatus.strong, tween(700), label = "c1")
    val c2 by animateColorAsState(if (signalStale) InkDim else liveStatus.strong2, tween(700), label = "c2")

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(bg)
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 20.dp)
    ) {
        item {
            AppHeader(
                title = "Doctor Claude",
                subtitle = if (patientName.isNotBlank()) patientName else s.sensor,
                lang = lang,
                onToggleLang = onToggleLang,
                onRefresh = onRefresh,
                // Logout moved to the Profile tab only — not on the home header anymore.
                isLoading = isLoading,
                accent = c1
            )
        }
        // Conditional banners grouped in ONE item, emitted ONLY when at least one would show. A calm
        // in-range screen now has NO big empty gap — previously the 5 collapsed banner items each
        // still added the list's 16dp spacing (~80dp of void above "100% En ligne"). Each banner
        // keeps its own enter/exit animation inside the plain Column.
        // When the signal is lost the predictive/meal nudges are based on a frozen curve — hide them so
        // the screen says one clear thing (NO SIGNAL) instead of also "hyper soon" off stale data.
        // The orange "signal perdu" banner is GONE: the big NO SIGNAL card already carries its own
        // "⚠ signal perdu X min" timing badge, so a second orange banner was redundant noise.
        val showBanners = alert.isUrgent ||
            (predictive?.isActionable == true && !alert.isUrgent && !signalStale) ||
            (mealNudge && !alert.isUrgent && !signalStale) ||
            error != null
        if (showBanners) {
            item {
                Column {
                    RapidAlertBanner(alert, rescueRecent, onStopAlarm)
                    PredictiveBanner(predictive, alert.isUrgent || signalStale)
                    MealNudgeChip(mealNudge && !alert.isUrgent && !signalStale, onLogMeal)
                    ErrorBanner(error)
                }
            }
        }
        item { DeviceStatusRow(lastUpdateMs, signalStale) }
        item { CurrentReadingCard(current, lastUpdateMs, now, c1, c2, serverAvg, onOpenHistory) }
        // "DERNIÈRES 24 H" now labels the 24 h graph (moved here, just above it). The % time-in-range
        // bar moved to History › Général (under that tab's chart) to keep the homepage uncluttered.
        if (!signalStale) item {
            Text(
                s.statsPeriod, color = InkDim, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                letterSpacing = 1.5.sp, modifier = Modifier.padding(start = 4.dp, top = 4.dp)
            )
        }
        // No signal → hide the curve: a graph implies a live trend, and its last point is the same
        // stale value we're refusing to show. The history list/stats below stay (clearly past data).
        if (!signalStale) item { ChartCard(history, c1, onOpenHistory, events) }
        // Faint hairline (very transparent black) between the graph and the PARLER/ANALYSE buttons,
        // with ~10dp breathing room each side. Only when the graph is shown.
        if (!signalStale) item {
            HorizontalDivider(thickness = 1.dp, color = Color.Black.copy(alpha = 0.04f), modifier = Modifier.padding(vertical = 10.dp))
        }
        item {
            AnalysisCard(
                aiText = aiText,
                aiAt = aiAt,
                aiLoading = aiLoading,
                enabled = history.size >= 3,
                accent = c1,
                isRecording = isRecording,
                onAnalyze = onAnalyze,
                onMicClick = onMicClick,
                onOpenHistory = onOpenHistory,
                onReplayVoice = onReplayVoice,
                onStopVoice = onStopVoice,
                isSpeaking = isSpeaking
            )
        }
        if (history.isNotEmpty()) {
            item {
                Text(
                    s.history,
                    color = InkDim,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.sp,
                    modifier = Modifier.padding(start = 4.dp, top = 8.dp)
                )
            }
            items(history.reversed().take(10)) { reading ->
                HistoryRow(reading)
            }
            if (history.size > 10) {
                item {
                    Surface(
                        color = CardWhite,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, BorderLight),
                        modifier = Modifier.fillMaxWidth().clickable(onClick = onSeeAllHistory)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp).fillMaxWidth(),
                            horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(Icons.Outlined.History, contentDescription = null, tint = c1, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "${s.seeAllHistory} (${history.size})",
                                color = c1,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = 1.sp
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
// Shared app header — used on EVERY tab so the app feels harmonious (same top bar, same buttons).
// Only the title changes per page (home = "Doctor Claude"; other tabs = the page name). The accent
// defaults to the brand green; the dashboard passes the live glucose-status colour instead.
fun AppHeader(
    title: String,
    subtitle: String,
    lang: Lang,
    onToggleLang: () -> Unit,
    // Refresh lives only on Home + advanced History; logout only on Profile. A null callback hides
    // that chip — so the header stays harmonious (same FR toggle everywhere) without redundant icons.
    onRefresh: (() -> Unit)? = null,
    onLogout: (() -> Unit)? = null,
    isLoading: Boolean = false,
    accent: Color = AccentGreen
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column {
            Text(title, color = InkPrimary, fontSize = 22.sp, fontWeight = FontWeight.Black, letterSpacing = (-0.5).sp)
            Text(
                subtitle,
                color = accent,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            IconChip(onClick = onToggleLang) {
                Text(lang.code, color = accent, fontSize = 12.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
            }
            if (onRefresh != null) IconChip(onClick = onRefresh) {
                if (isLoading) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), color = accent, strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = InkPrimary, modifier = Modifier.size(18.dp))
                }
            }
            if (onLogout != null) IconChip(onClick = onLogout) {
                Icon(Icons.Default.Logout, contentDescription = "Logout", tint = InkMuted, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun IconChip(onClick: () -> Unit, content: @Composable () -> Unit) {
    Surface(
        color = CardWhite,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, BorderLight),
        modifier = Modifier.size(40.dp).clickable(onClick = onClick)
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) { content() }
    }
}

/** Big pulsing red banner: hypo/hyper or a genuinely steep curve — the user's "red flag".
 *  When the alarm is ringing it shows an unmistakable STOP button; tapping anywhere also stops it. */
@Composable
private fun RapidAlertBanner(alert: GlucoseAlert, rescueRecent: Boolean, onStop: () -> Unit) {
    val s = LocalStrings.current
    AnimatedVisibility(
        visible = alert.isUrgent,
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically()
    ) {
        val infinite = rememberInfiniteTransition(label = "alert")
        val pulse by infinite.animateFloat(
            initialValue = 0.55f, targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "pulse"
        )
        val title = when (alert.kind) {
            AlertKind.LOW -> s.alertLow
            AlertKind.HIGH -> s.alertHigh
            AlertKind.RAPID_RISE -> s.alertRapidRise
            AlertKind.RAPID_FALL -> s.alertRapidFall
            else -> ""
        }
        // A clear, kind-specific instruction (replaces the old vague "Vérifie tout de suite").
        // If sugar was just eaten, a LOW says "let it act, recheck" instead of "take sugar now" —
        // matching the server dose guard (sugar_recent) so the banner can't contradict the analysis.
        val sub = when (alert.kind) {
            AlertKind.LOW -> if (rescueRecent) s.alertActLowWait else s.alertActLow
            AlertKind.HIGH -> s.alertActHigh
            AlertKind.RAPID_RISE -> s.alertActRise
            AlertKind.RAPID_FALL -> s.alertActFall
            else -> ""
        }
        Surface(
            color = GlucoseStatus.DANGER.strong.copy(alpha = pulse),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth().clickable { onStop() }
        ) {
            Column(
                modifier = Modifier.padding(14.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Icon(Icons.Filled.Warning, contentDescription = null, tint = OnColor, modifier = Modifier.size(26.dp))
                    Column {
                        Text(
                            "$title  ·  ${alert.value} mg/dL",
                            color = OnColor, fontSize = 16.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp
                        )
                        Text(sub, color = OnColor.copy(alpha = 0.9f), fontSize = 11.sp)
                    }
                }
                if (alert.ringsAlarm) {
                    Surface(
                        color = OnColor,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth().clickable { onStop() }
                    ) {
                        Row(
                            modifier = Modifier.padding(vertical = 11.dp).fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center
                        ) {
                            Icon(Icons.Outlined.Stop, contentDescription = null, tint = GlucoseStatus.DANGER.strong, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(s.alertStop, color = GlucoseStatus.DANGER.strong, fontWeight = FontWeight.Black, fontSize = 14.sp, letterSpacing = 1.sp)
                        }
                    }
                }
            }
        }
    }
}

/** Calm, non-alarming heads-up that the curve is heading toward a hypo/hyper soon. SUGGESTION
 *  only (sugar before a hypo / get ready to correct) — distinct from the red alarm banner, and
 *  hidden while a real out-of-range alarm is showing. */
@Composable
private fun PredictiveBanner(p: Prediction?, suppressed: Boolean) {
    val s = LocalStrings.current
    AnimatedVisibility(
        visible = p != null && p.isActionable && !suppressed,
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically()
    ) {
        val pr = p ?: return@AnimatedVisibility
        val proj = pr.projected ?: 0
        val text = when (pr.kind) {
            PredictKind.HIGH_SOON -> String.format(s.predictHighSoon, proj, pr.minutes)
            PredictKind.WATCH_FALL -> s.predictWatchFall
            PredictKind.WATCH_RISE -> s.predictWatchRise
            else -> ""
        }
        val danger = pr.kind == PredictKind.WATCH_FALL
        val color = if (danger) GlucoseStatus.DANGER.strong else GlucoseStatus.WARNING.strong
        Surface(
            color = color.copy(alpha = 0.12f),
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, color),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier.padding(12.dp).fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
                Column {
                    Text(s.predictTitle, color = color, fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 1.5.sp)
                    Text(text, color = InkPrimary, fontSize = 13.sp, lineHeight = 18.sp)
                }
            }
        }
    }
}

/** "You're climbing with no logged meal — log it for a precise dose." A nudge, never a dose.
 *  RED-toned to grab attention (same style as the signal-lost notice) and dismissible with a ✕
 *  (hidden until this rising episode clears and a new one appears). */
@Composable
private fun MealNudgeChip(show: Boolean, onLog: () -> Unit) {
    val s = LocalStrings.current
    var dismissed by remember { mutableStateOf(false) }
    LaunchedEffect(show) { if (!show) dismissed = false } // reset once the rise resolves
    val color = GlucoseStatus.DANGER.strong
    AnimatedVisibility(
        visible = show && !dismissed,
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically()
    ) {
        Surface(
            color = color.copy(alpha = 0.12f),
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, color),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp).fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
                Text(s.mealNudgeText, color = InkPrimary, fontSize = 12.sp, lineHeight = 16.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = onLog, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                    Text(s.mealNudgeLog, color = color, fontWeight = FontWeight.Black, fontSize = 11.sp, letterSpacing = 0.5.sp)
                }
                IconButton(onClick = { dismissed = true }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Outlined.Close, contentDescription = "Fermer", tint = color, modifier = Modifier.size(16.dp))
                }
            }
        }
    }
}

@Composable
private fun ErrorBanner(error: String?) {
    AnimatedVisibility(
        visible = error != null,
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically()
    ) {
        Surface(
            color = GlucoseStatus.DANGER.wash,
            shape = RoundedCornerShape(10.dp),
            border = BorderStroke(1.dp, GlucoseStatus.DANGER.strong),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(error.orEmpty(), color = GlucoseStatus.DANGER.strong2, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
        }
    }
}

/** GLOBAL backend-health banner, shown on EVERY tab. If ANY Doctor Claude backend call falls —
 *  history/stats/DB unreachable, or the AI is down / out of credits / rate-limited / bad key — we
 *  say so here instead of failing silently. The glucose feed + alarms are independent (LibreLinkUp-
 *  direct) and keep working, so we reassure that. Clears automatically on the next successful call. */
@Composable
fun ServiceHealthBanner() {
    val s = LocalStrings.current
    val health by ServiceHealth.state.collectAsState()
    val msg = when {
        !health.reachable -> s.serviceDownReach
        health.ai == ServiceHealth.Ai.OUT_OF_CREDITS -> s.serviceDownCredits
        health.ai == ServiceHealth.Ai.RATE_LIMITED -> s.serviceDownRate
        health.ai == ServiceHealth.Ai.AUTH -> s.serviceDownAuth
        health.ai == ServiceHealth.Ai.DOWN -> s.serviceDownAi
        else -> null
    }
    val severe = !health.reachable // unreachable = red; an AI-only issue (glucose still fine) = amber
    AnimatedVisibility(
        visible = msg != null,
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically()
    ) {
        val color = if (severe) GlucoseStatus.DANGER else GlucoseStatus.WARNING
        Surface(
            color = color.wash,
            shape = RoundedCornerShape(10.dp),
            border = BorderStroke(1.dp, color.strong),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)
        ) {
            Row(
                modifier = Modifier.padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top
            ) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = color.strong, modifier = Modifier.size(18.dp))
                Text(msg.orEmpty(), color = color.strong2, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

/** Compact device status: battery (with charge state) + network. Lets the user know at a glance
 *  whether the PHONE RUNNING the app needs charging / has internet. (The remote sensor phone's
 *  battery isn't available via the LibreLinkUp API; data freshness above is the proxy for that.) */
@Composable
private fun DeviceStatusRow(lastUpdateMs: Long, signalStale: Boolean) {
    val context = LocalContext.current
    val s = LocalStrings.current
    val status = remember(lastUpdateMs) { readDeviceStatus(context) }
    val pct = status.first
    val charging = status.second
    val online = status.third
    val battColor = when {
        pct < 0 -> InkDim
        pct <= 15 -> GlucoseStatus.DANGER.strong
        pct <= 30 -> GlucoseStatus.WARNING.strong
        else -> GlucoseStatus.GOOD.strong
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(8.dp).background(battColor, RoundedCornerShape(4.dp)))
        Text(
            if (pct < 0) "—" else "$pct%" + (if (charging) " · ${s.charging}" else ""),
            color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Bold
        )
        Spacer(Modifier.width(8.dp))
        if (signalStale) {
            // No SENSOR signal → the phone-internet "En ligne" dot next to a NO SIGNAL glucose is
            // misleading, so show a red "Pas de signal" instead (the phone may well be online).
            Box(Modifier.size(8.dp).background(GlucoseStatus.DANGER.strong, RoundedCornerShape(4.dp)))
            Text(s.noSignalShort, color = GlucoseStatus.DANGER.strong, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        } else {
            Box(Modifier.size(8.dp).background(if (online) GlucoseStatus.GOOD.strong else GlucoseStatus.DANGER.strong, RoundedCornerShape(4.dp)))
            Text(if (online) s.online else s.offline, color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
    }
}

private fun readDeviceStatus(context: Context): Triple<Int, Boolean, Boolean> {
    val bm = try { context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) } catch (_: Exception) { null }
    val level = bm?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = bm?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    val pct = if (level >= 0 && scale > 0) level * 100 / scale else -1
    val st = bm?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    val charging = st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL
    val online = try {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        cm?.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } catch (_: Exception) { false }
    return Triple(pct, charging, online)
}

@Composable
private fun CurrentReadingCard(reading: GlucoseReading?, lastUpdateMs: Long, now: Long, c1: Color, c2: Color, serverAvg: Int? = null, onClick: () -> Unit = {}) {
    val s = LocalStrings.current
    val ageMs = if (lastUpdateMs > 0) now - lastUpdateMs else -1L
    val staleMin = if (ageMs >= 0) (ageMs / 60000L).toInt() else -1
    // SAME (5-min) freshness window the alarm uses → the number and the alarms agree to the second.
    val stale = ageMs >= 0 && ageMs > GlucoseAlert.FRESHNESS_WINDOW_MS
    Surface(
        shape = RoundedCornerShape(24.dp),
        modifier = Modifier.fillMaxWidth().clickable { onClick() },
        color = Color.Transparent
    ) {
        Column(
            modifier = Modifier
                .background(
                    // Strong-red gradient when stale so NO SIGNAL reads as a clear danger/stop state
                    // (don't dose — fingerstick); the live status gradient only when it's trustworthy.
                    // NO SIGNAL uses the SAME red as a hyper glucose card (DANGER) — the user finds
                    // that red clearer than the old pure-red gradient.
                    if (stale) Brush.verticalGradient(listOf(GlucoseStatus.DANGER.strong, GlucoseStatus.DANGER.strong2))
                    else Brush.verticalGradient(listOf(c1, c2)),
                    RoundedCornerShape(24.dp)
                )
                .padding(28.dp)
                .fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (stale) {
                // SIGNAL LOST — never show the (possibly hours-old) number: a stale value read as live
                // once led to an insulin dose on a real hypo. Show an unmistakable NO SIGNAL and tell
                // the user to confirm with a fingerstick before doing anything.
                Icon(Icons.Filled.Warning, contentDescription = null, tint = OnColor, modifier = Modifier.size(34.dp))
                Spacer(Modifier.height(10.dp))
                Text(
                    s.noSignal,
                    color = OnColor,
                    fontSize = 40.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 1.sp,
                    lineHeight = 44.sp,
                    textAlign = TextAlign.Center
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    s.noSignalSub,
                    color = OnColor.copy(alpha = 0.95f),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 18.sp,
                    textAlign = TextAlign.Center
                )
                if (staleMin >= 0) {
                    Spacer(Modifier.height(14.dp))
                    Surface(color = OnColor.copy(alpha = 0.20f), shape = RoundedCornerShape(8.dp)) {
                        Text(
                            "⚠ ${s.signalLost} $staleMin min",
                            color = OnColor, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp)
                        )
                    }
                }
            } else {
                Text(s.current, color = OnColor.copy(alpha = 0.85f), fontSize = 11.sp, letterSpacing = 3.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        if (reading != null) reading.valueMgDl.toString() else "--",
                        color = OnColor,
                        fontSize = 80.sp,
                        fontWeight = FontWeight.Black,
                        letterSpacing = (-3).sp
                    )
                    if (reading != null) {
                        Text(
                            reading.trend.arrow,
                            color = OnColor,
                            fontSize = 30.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(bottom = 20.dp)
                        )
                    }
                }
                Text("mg/dL", color = OnColor.copy(alpha = 0.9f), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                if (serverAvg != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "${s.average} 24 H · $serverAvg mg/dL",
                        color = OnColor.copy(alpha = 0.85f), fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp
                    )
                }
                if (reading != null) {
                    Spacer(Modifier.height(12.dp))
                    Surface(color = OnColor.copy(alpha = 0.18f), shape = RoundedCornerShape(20.dp)) {
                        Text(
                            statusTrendLabel(reading.valueMgDl, reading.trend, s),
                            color = OnColor,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 0.5.sp,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)
                        )
                    }
                }
                if (lastUpdateMs > 0) {
                    Spacer(Modifier.height(10.dp))
                    val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(lastUpdateMs))
                    Text("${s.updated} $time", color = OnColor.copy(alpha = 0.75f), fontSize = 9.sp, letterSpacing = 1.5.sp)
                }
            }
        }
    }
}

@Composable
private fun ChartCard(history: List<GlucoseReading>, line: Color, onClick: () -> Unit = {}, events: List<GraphEvent> = emptyList()) {
    val s = LocalStrings.current
    Surface(
        color = CardWhite,
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, BorderLight),
        modifier = Modifier.fillMaxWidth().height(210.dp).clickable { onClick() }
    ) {
        Box(modifier = Modifier.fillMaxSize().padding(10.dp)) {
            if (history.size < 2) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(s.waiting, color = InkDim, fontSize = 12.sp)
                }
            } else {
                GlucoseGraph(history, Modifier.fillMaxSize(), line, events, onBackgroundClick = onClick)
            }
        }
    }
}

// (The compact GlucoseChart was replaced by the shared axed GlucoseGraph in ui/GlucoseGraph.kt.)

/** Time-in-range bar: one horizontal bar split into 3 proportional segments summing to 100% —
 *  % BAS (red) | CIBLE (green) | % HAUT (red), left to right. Both out-of-range bands are red
 *  (matching the value-colour zones: >180 reads red, not orange). Replaces the 4 stat boxes. */
// % time-in-range bar (low | target | high) + legend. NO title here, so it can sit under any chart.
// Shared by the dashboard's former homepage bar AND the History › Général tab (under its chart).
@Composable
internal fun TimeInRangeBar(low: Int?, target: Int?, high: Int?) {
    val s = LocalStrings.current
    val red = GlucoseStatus.DANGER.strong
    val green = GlucoseStatus.GOOD.strong
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        if (target == null) {
            // Server 24h stats still loading.
            Box(
                Modifier.fillMaxWidth().height(26.dp).clip(RoundedCornerShape(13.dp)).background(BorderLight),
                contentAlignment = Alignment.Center
            ) { Text("…", color = InkDim, fontSize = 13.sp) }
        } else {
            val lo = (low ?: 0).coerceAtLeast(0)
            val hi = (high ?: 0).coerceAtLeast(0)
            val tg = target.coerceAtLeast(0)
            Row(modifier = Modifier.fillMaxWidth().height(26.dp).clip(RoundedCornerShape(13.dp))) {
                if (lo > 0) Box(Modifier.weight(lo.toFloat()).fillMaxHeight().background(red))
                if (tg > 0) Box(Modifier.weight(tg.toFloat()).fillMaxHeight().background(green))
                if (hi > 0) Box(Modifier.weight(hi.toFloat()).fillMaxHeight().background(red))
                if (lo + tg + hi == 0) Box(Modifier.weight(1f).fillMaxHeight().background(BorderLight))
            }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TirLegend(s.statLow, lo, red)
                TirLegend(s.target, tg, green)
                TirLegend(s.statHigh, hi, red)
            }
        }
    }
}

@Composable
private fun TirLegend(label: String, pct: Int, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(color))
            Text(label, color = InkDim, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
        }
        Text("$pct%", color = color, fontSize = 16.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun AnalysisCard(
    aiText: String,
    aiAt: Long = 0L,
    aiLoading: Boolean,
    enabled: Boolean,
    accent: Color,
    isRecording: Boolean,
    onAnalyze: () -> Unit,
    onMicClick: () -> Unit,
    onOpenHistory: () -> Unit = {},
    onReplayVoice: () -> Unit = {},
    onStopVoice: () -> Unit = {},
    isSpeaking: Boolean = false
) {
    val s = LocalStrings.current
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // PARLER (voix/micro) + ANALYSE côte à côte sur une seule ligne.
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            Button(
                onClick = onMicClick,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isRecording) GlucoseStatus.DANGER.strong else accent,
                    contentColor = OnColor
                ),
                shape = RoundedCornerShape(14.dp),
                contentPadding = PaddingValues(horizontal = 10.dp),
                modifier = Modifier.weight(1f).height(54.dp)
            ) {
                Icon(
                    if (isRecording) Icons.Outlined.Stop else Icons.Outlined.Mic,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(Modifier.width(6.dp))
                Text(if (isRecording) s.listening else s.talkToMom, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp, maxLines = 1)
            }
            Button(
                onClick = onAnalyze,
                enabled = enabled && !aiLoading,
                // Outlined, NO fill — just a status-coloured border + text (red when high/low, green in
                // range, orange near the edges; it follows the glucose), keeping that colour while
                // analysing too. The interior stays empty/transparent.
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color.Transparent,
                    contentColor = accent,
                    disabledContainerColor = Color.Transparent,
                    disabledContentColor = accent
                ),
                elevation = ButtonDefaults.buttonElevation(0.dp, 0.dp, 0.dp, 0.dp, 0.dp),
                border = BorderStroke(1.dp, accent),
                shape = RoundedCornerShape(14.dp),
                contentPadding = PaddingValues(horizontal = 10.dp),
                modifier = Modifier.weight(1f).height(54.dp)
            ) {
                if (aiLoading) CircularProgressIndicator(modifier = Modifier.size(18.dp), color = accent, strokeWidth = 2.dp)
                else Text(s.analyze, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp, maxLines = 1)
            }
        }
        if (aiText.isNotEmpty()) {
            Surface(
                color = CardWhite,
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, accent.copy(alpha = 0.4f)),
                // Tap the report to open the full history; the speaker icon reads it aloud (tap again to stop).
                modifier = Modifier.fillMaxWidth().clickable { onOpenHistory() }
            ) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(s.momTitle, color = accent, fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 2.sp)
                        if (aiAt > 0L) {
                            Spacer(Modifier.width(8.dp))
                            Text(
                                SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(aiAt)),
                                color = InkDim, fontSize = 10.sp
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        // Replay this analysis out loud — reuses the cached audio, no recompute.
                        IconButton(onClick = { if (isSpeaking) onStopVoice() else onReplayVoice() }, modifier = Modifier.size(30.dp)) {
                            Icon(
                                if (isSpeaking) Icons.Filled.Stop else Icons.AutoMirrored.Outlined.VolumeUp,
                                contentDescription = if (isSpeaking) s.stopVoice else s.replayVoice,
                                tint = accent, modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(aiText, color = InkPrimary, fontSize = 15.sp, lineHeight = 22.sp)
                    Spacer(Modifier.height(10.dp))
                    DoseDisclaimer()
                }
            }
        }
    }
}

@Composable
fun HistoryRow(reading: GlucoseReading) {
    val time = SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()).format(Date(reading.timestampMs))
    val color = colorFor(reading.valueMgDl)
    Surface(
        color = CardWhite,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, BorderLight),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(time, color = InkMuted, fontSize = 13.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(reading.trend.arrow, color = InkMuted, fontSize = 14.sp)
                Text(reading.valueMgDl.toString(), color = color, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text("mg/dL", color = InkDim, fontSize = 10.sp)
            }
        }
    }
}

/** Étiquette de plage : BAS / DANS LA CIBLE / ÉLEVÉ. */
private fun rangeLabelOf(value: Int, s: Strings): String = when {
    value > 180 -> s.statusHigh
    value < 70 -> s.statusLow
    else -> s.statusInRange
}

/** Status + trend for the live pill. A FLAT trend while OUT of range is "stuck high / stuck low",
 *  NOT a reassuring "Stable": a 273 that isn't moving is high AND not coming down. "Stable" is kept
 *  only when actually in range; an unknown trend (no arrow) shows no word at all. */
private fun statusTrendLabel(value: Int, trend: Trend, s: Strings): String {
    val range = rangeLabelOf(value, s)
    val word = when (trend) {
        Trend.UNKNOWN -> ""
        Trend.STABLE -> when {
            value > 180 -> s.trendStuckHigh
            value < 70 -> s.trendStuckLow
            else -> s.trendStable
        }
        else -> s.trend(trend)
    }
    return if (word.isBlank()) range else "$range  ·  $word"
}

// Same five zones as statusOf() — delegate so the two never drift apart.
fun colorFor(value: Int): Color = when (statusOf(value)) {
    GlucoseStatus.DANGER -> GlucoseStatus.DANGER.strong2
    GlucoseStatus.WARNING -> GlucoseStatus.WARNING.strong
    GlucoseStatus.GOOD -> GlucoseStatus.GOOD.strong
}
