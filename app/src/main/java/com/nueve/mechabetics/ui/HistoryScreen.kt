package com.nueve.mechabetics.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nueve.mechabetics.ai.AnalysisService
import com.nueve.mechabetics.data.GlucoseAlert
import com.nueve.mechabetics.data.GlucoseReading
import com.nueve.mechabetics.data.cleanGlucoseSeries
import com.nueve.mechabetics.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The HISTORIQUE list renders this many readings at a time; scrolling to the bottom loads another page. */
private const val HISTORY_PAGE = 100

/** A "day" restarts at 08:00 local (the user's wake time) instead of midnight, so a day's stats
 *  include the night that FOLLOWS it (where the evening dose/basal plays out) — and they match the
 *  coach's "today/yesterday". We bucket a reading by shifting its time back this many ms before
 *  taking the calendar date: 00:00–08:00 then falls onto the PREVIOUS day. Flip to 0 for midnight. */
private const val DAY_START_HOUR = 8
private const val DAY_SHIFT_MS = DAY_START_HOUR * 3_600_000L

/** Full history, split into 3 TABS — GÉNÉRAL (graph + day filters + the 4 stat boxes) | HISTORIQUE
 *  (the readings list) | ANALYSES. Top bar mirrors the dashboard (back · language · refresh). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(
    history: List<GlucoseReading>,
    patientId: String?,
    ai: AnalysisService,
    lang: Lang,
    // Live-feed freshness from the dashboard's state (= the live reading's time). History must judge
    // "signal lost" from the SAME source as home so the two always agree.
    lastUpdateMs: Long = 0L,
    onToggleLang: () -> Unit,
    onBack: () -> Unit,
    initialTab: Int = 0
) {
    val s = LocalStrings.current
    val keyFmt = remember { SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()) }
    val chipFmt = remember { SimpleDateFormat("dd/MM", Locale.getDefault()) }

    var serverReadings by remember { mutableStateOf<List<GlucoseReading>>(emptyList()) }
    var analyses by remember { mutableStateOf<List<AnalysisService.PastAnalysis>>(emptyList()) }
    var events by remember { mutableStateOf<List<GraphEvent>>(emptyList()) }
    var refreshKey by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    LaunchedEffect(patientId, refreshKey, lang) {
        loading = true
        val r = ai.history(patientId, 14, lang.code.lowercase())
        if (r.readings.isNotEmpty()) serverReadings = r.readings
        analyses = r.analyses
        events = buildGraphEvents(r.insulin, r.meals)
        loading = false
    }
    // MERGE the server's stored history WITH the live in-memory readings, then clean (dedupe to 5 min,
    // drop future/ancient). The server copy spans more days but can lag HOURS behind the live feed —
    // using it alone made the advanced graph stop ~4 h ago while the home (which includes live) was
    // current. Merging makes the advanced view reach the present too. Keep a 14-DAY window here (the
    // home graph keeps the 26 h default) so the day chips/graph show every stored day, not just
    // today + yesterday — the server returns up to 14 days via ai.history(patientId, 14).
    val allData = cleanGlucoseSeries(serverReadings + history, 14L * 24 * 60 * 60 * 1000)

    // Signal-loss state must match the HOME screen exactly, so it's driven by the SAME live-feed
    // freshness (lastUpdateMs = the live reading's time), NOT the stored server history — the server
    // history can lag far behind while the live feed is fresh, which made history wrongly show
    // "no signal 221 min" while home showed a fresh value. Ticking clock so it flips on its own.
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(30_000) } }
    val signalStale = lastUpdateMs > 0L && now - lastUpdateMs > GlucoseAlert.FRESHNESS_WINDOW_MS
    val staleMin = if (lastUpdateMs > 0L) ((now - lastUpdateMs) / 60000L).toInt() else -1

    // Day key = the calendar date AFTER shifting back to the 08:00 boundary (see DAY_SHIFT_MS).
    val dayKey = { ms: Long -> keyFmt.format(Date(ms - DAY_SHIFT_MS)) }
    val days = remember(allData) {
        allData.map { dayKey(it.timestampMs) }.distinct().sortedDescending()
    }
    var selected by remember { mutableStateOf<String?>(null) } // null = all

    val shown = remember(allData, selected) {
        (if (selected == null) allData else allData.filter { dayKey(it.timestampMs) == selected })
            .sortedByDescending { it.timestampMs }
    }

    var tab by remember { mutableStateOf(initialTab) } // 0 = Général (graph/stats), 1 = Historique (list), 2 = Analyses

    Column(modifier = Modifier.fillMaxSize().background(LightBg)) {
        // Top bar: back · title · language · refresh (mirrors the dashboard).
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            HistIconBtn(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = s.back, tint = InkPrimary, modifier = Modifier.size(20.dp))
            }
            Text(
                s.historyScreenTitle, color = InkPrimary, fontSize = 20.sp, fontWeight = FontWeight.Black,
                letterSpacing = 1.sp, modifier = Modifier.weight(1f)
            )
            HistIconBtn(onClick = onToggleLang) {
                Text(lang.code, color = GlucoseStatus.GOOD.strong, fontSize = 12.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
            }
            HistIconBtn(onClick = { if (!loading) refreshKey++ }) {
                if (loading) CircularProgressIndicator(modifier = Modifier.size(16.dp), color = GlucoseStatus.GOOD.strong, strokeWidth = 2.dp)
                else Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = InkPrimary, modifier = Modifier.size(18.dp))
            }
        }

        // Tabs: GÉNÉRAL | HISTORIQUE | ANALYSES (injections live on the Insulin page)
        val tabs = listOf(s.generalTab, s.historyScreenTitle, s.pastAnalyses)
        TabRow(selectedTabIndex = tab, containerColor = LightBg, contentColor = GlucoseStatus.GOOD.strong) {
            tabs.forEachIndexed { i, label ->
                Tab(
                    selected = tab == i,
                    onClick = { tab = i },
                    text = { Text(label, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp) }
                )
            }
        }

        // Red NO SIGNAL strip across every tab while the live signal is lost.
        if (signalStale) HistorySignalLostBanner(staleMin, s)
        // Hide the live curve only when the view actually reaches "now" (All or today); a specific
        // past day's graph is genuinely historical and not confusing, so keep it.
        val hideGraph = signalStale && (selected == null || selected == dayKey(now))
        when (tab) {
            // GÉNÉRAL : day filters + the 4 stat boxes + the graph.
            0 -> GeneralTab(days, selected, { selected = it }, shown, chipFmt, keyFmt, s, hideGraph, allData.lastOrNull(), signalStale, events)
            // HISTORIQUE : day filters (same as GÉNÉRAL) + the readings list, WINDOWED to 100 rows at a
            // time. Scrolling near the bottom auto-loads the next 100 older readings, so we never render
            // thousands at once and older data only loads on demand.
            1 -> {
                val listState = rememberLazyListState()
                var visibleCount by remember(shown) { mutableStateOf(HISTORY_PAGE) }
                LaunchedEffect(listState, shown) {
                    snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
                        .collect { last ->
                            if (last >= visibleCount - 5 && visibleCount < shown.size)
                                visibleCount = (visibleCount + HISTORY_PAGE).coerceAtMost(shown.size)
                        }
                }
                Column(Modifier.fillMaxSize()) {
                    DayFilterRow(days, selected, { selected = it }, chipFmt, keyFmt, s)
                    if (shown.isEmpty()) HistEmpty(s.waiting)
                    else LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        contentPadding = PaddingValues(vertical = 12.dp)
                    ) {
                        items(shown.take(visibleCount), key = { it.timestampMs }) { r -> HistoryRow(r) }
                        if (visibleCount < shown.size) {
                            item {
                                Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(Modifier.size(20.dp), color = GlucoseStatus.GOOD.strong, strokeWidth = 2.dp)
                                }
                            }
                        }
                    }
                }
            }
            // ANALYSES : past AI reports.
            else -> if (analyses.isEmpty()) HistEmpty(s.historyEmpty) else LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(vertical = 12.dp)
            ) { items(analyses, key = { "a" + it.ts }) { a -> AnalysisHistoryCard(a) } }
        }
    }
}

@Composable
private fun HistIconBtn(onClick: () -> Unit, content: @Composable () -> Unit) {
    Surface(
        color = CardWhite, shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, BorderLight),
        modifier = Modifier.size(40.dp).clickable(onClick = onClick)
    ) { Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) { content() } }
}

@Composable
private fun HistEmpty(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, color = InkDim, fontSize = 13.sp)
    }
}

/** Red NO SIGNAL strip shown across every history tab while the live signal is lost, so the past
 *  data here is never mistaken for a current reading. */
@Composable
private fun HistorySignalLostBanner(staleMin: Int, s: Strings) {
    Surface(
        color = SignalLostTop, shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Row(
            modifier = Modifier.padding(14.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(Icons.Filled.Warning, contentDescription = null, tint = OnColor, modifier = Modifier.size(26.dp))
            Column(Modifier.weight(1f)) {
                Text(s.noSignal, color = OnColor, fontSize = 18.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
                Spacer(Modifier.height(2.dp))
                Text(s.noSignalSub, color = OnColor.copy(alpha = 0.95f), fontSize = 12.sp, lineHeight = 16.sp)
                if (staleMin >= 0) {
                    Spacer(Modifier.height(4.dp))
                    Text("${s.signalLost} $staleMin min", color = OnColor.copy(alpha = 0.9f), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

/** Horizontal day-filter chips (Tout + one per day, newest first), GREEN when selected (brand,
 *  not the M3 default purple). Left/right chevrons appear when the row overflows (7-14 days) so
 *  every day stays reachable. Shared by the GÉNÉRAL and HISTORIQUE tabs. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DayFilterRow(
    days: List<String>,
    selected: String?,
    onSelect: (String?) -> Unit,
    chipFmt: SimpleDateFormat,
    keyFmt: SimpleDateFormat,
    s: Strings
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val green = GlucoseStatus.GOOD.strong
    val chipColors = FilterChipDefaults.filterChipColors(
        selectedContainerColor = green,
        selectedLabelColor = OnColor
    )
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (listState.canScrollBackward) {
            IconButton(
                onClick = { scope.launch { listState.animateScrollToItem((listState.firstVisibleItemIndex - 3).coerceAtLeast(0)) } },
                modifier = Modifier.size(32.dp)
            ) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = s.back, tint = green, modifier = Modifier.size(24.dp)) }
        }
        LazyRow(
            state = listState,
            modifier = Modifier.weight(1f),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            item {
                FilterChip(selected = selected == null, onClick = { onSelect(null) },
                    label = { Text(s.filterAll, fontSize = 12.sp) }, colors = chipColors)
            }
            items(days) { d ->
                val label = chipFmt.format(keyFmt.parse(d) ?: Date())
                FilterChip(selected = selected == d, onClick = { onSelect(d) },
                    label = { Text(label, fontSize = 12.sp) }, colors = chipColors)
            }
        }
        if (listState.canScrollForward) {
            IconButton(
                onClick = { scope.launch { listState.animateScrollToItem(listState.firstVisibleItemIndex + 3) } },
                modifier = Modifier.size(32.dp)
            ) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = green, modifier = Modifier.size(24.dp)) }
        }
    }
}

/** GÉNÉRAL tab: per-day filter chips + the 4 stat boxes + the graph. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GeneralTab(
    days: List<String>,
    selected: String?,
    onSelect: (String?) -> Unit,
    shown: List<GlucoseReading>,
    chipFmt: SimpleDateFormat,
    keyFmt: SimpleDateFormat,
    s: Strings,
    hideGraph: Boolean,
    current: GlucoseReading?,
    signalStale: Boolean,
    events: List<GraphEvent>
) {
    // Scrollable: 6 stat boxes + chart + the time-in-range bar can exceed one screen on small phones.
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    // Current glucose at the top of GÉNÉRAL (hidden during signal loss — the NO SIGNAL banner shows
    // instead). Coloured by zone so a high reads red here too.
    if (!signalStale && current != null) {
        Surface(
            color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            Row(
                Modifier.padding(horizontal = 16.dp, vertical = 12.dp).fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(s.current, color = InkDim, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp)
                Spacer(Modifier.weight(1f))
                Text("${current.valueMgDl}", color = colorFor(current.valueMgDl), fontSize = 30.sp, fontWeight = FontWeight.Black)
                Spacer(Modifier.width(6.dp))
                Text(current.trend.arrow, color = colorFor(current.valueMgDl), fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(6.dp))
                Text("mg/dL", color = InkDim, fontSize = 11.sp)
            }
        }
    }
    DayFilterRow(days, selected, onSelect, chipFmt, keyFmt, s)

    // The period the stats below ACTUALLY cover, shown as an explicit FROM→TO range so the boxes,
    // graph and TIR bar are never mistaken for a fixed "24 h": with "Tout" it spans from the oldest
    // stored reading to the newest ("DU 25/05 AU 08/06"); a day chip shows that one day ("LE 08/06").
    val periodLabel = if (selected != null) {
        val d = runCatching { keyFmt.parse(selected) }.getOrNull() ?: Date()
        s.periodOnDay.format(chipFmt.format(d))
    } else {
        val firstMs = shown.minOfOrNull { it.timestampMs }
        val lastMs = shown.maxOfOrNull { it.timestampMs }
        if (firstMs == null || lastMs == null) ""
        else {
            val f = chipFmt.format(Date(firstMs))
            val l = chipFmt.format(Date(lastMs))
            if (f == l) s.periodOnDay.format(l) else s.periodFromTo.format(f, l)
        }
    }

    DayStats(shown, periodLabel)

    if (hideGraph) {
        // No current signal → don't render a curve that ends on the stale value (it reads as "now").
        Surface(
            color = SignalLostTop.copy(alpha = 0.10f), shape = RoundedCornerShape(14.dp),
            border = BorderStroke(1.dp, SignalLostTop),
            modifier = Modifier.fillMaxWidth().padding(16.dp).height(160.dp)
        ) {
            Column(
                Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = SignalLostTop, modifier = Modifier.size(30.dp))
                Spacer(Modifier.height(8.dp))
                Text(s.noSignal, color = SignalLostTop, fontSize = 22.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
                Spacer(Modifier.height(4.dp))
                Text(s.graphHidden, color = InkMuted, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp))
            }
        }
    } else if (shown.size >= 2) {
        Text(
            periodLabel, color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Black,
            letterSpacing = 1.sp, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp)
        )
        Surface(
            color = CardWhite, shape = RoundedCornerShape(14.dp),
            border = BorderStroke(1.dp, BorderLight),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 6.dp, bottom = 16.dp).height(240.dp)
        ) {
            GlucoseGraph(shown, Modifier.fillMaxSize().padding(10.dp), events = events)
        }
    } else {
        Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
            Text(s.waiting, color = InkDim, fontSize = 13.sp)
        }
    }

    // % time-in-range bar UNDER the chart, with the SAME period label as the boxes so it's clear the
    // bar covers the selected window (the user's confusion: bar looked "24 h" while the graph showed
    // several days — they're actually the same period).
    if (!hideGraph && shown.size >= 2) {
        val (pctLow, tir, pctHigh) = tirSplit(shown)
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text(
                periodLabel, color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Black,
                letterSpacing = 1.sp, modifier = Modifier.padding(bottom = 6.dp)
            )
            TimeInRangeBar(pctLow, tir, pctHigh)
        }
    }
    Spacer(Modifier.height(12.dp))
    } // end scrollable Column
}

/** Time-weighted low / target / high % for the shown day — same method as the server + DayStats. */
private fun tirSplit(readings: List<GlucoseReading>): Triple<Int, Int, Int> {
    if (readings.size < 2) return Triple(0, 0, 0)
    val sorted = readings.sortedBy { it.timestampMs }
    var inRange = 0.0; var low = 0.0; var high = 0.0; var total = 0.0
    for (k in 0 until sorted.size - 1) {
        val w = ((sorted[k + 1].timestampMs - sorted[k].timestampMs) / 60000.0).coerceIn(0.0, 30.0)
        total += w
        val v = sorted[k].valueMgDl
        when { v < 70 -> low += w; v > 180 -> high += w; else -> inRange += w }
    }
    if (total <= 0) return Triple(0, 0, 0)
    fun pct(x: Double) = Math.round(x / total * 100).toInt()
    return Triple(pct(low), pct(inRange), pct(high))
}

@Composable
private fun DayStats(readings: List<GlucoseReading>, periodLabel: String) {
    if (readings.size < 2) return
    val s = LocalStrings.current
    val sorted = readings.sortedBy { it.timestampMs }
    val values = sorted.map { it.valueMgDl }
    val avg = values.average().toInt()
    // Time-weighted in-range / low / high (weight each reading by the gap to the next, capped 30 min)
    // — the SAME method as the server stats, so a day's % here matches the coach's figures.
    var inRange = 0.0; var low = 0.0; var high = 0.0; var total = 0.0
    for (k in 0 until sorted.size - 1) {
        val w = ((sorted[k + 1].timestampMs - sorted[k].timestampMs) / 60000.0).coerceIn(0.0, 30.0)
        total += w
        val v = sorted[k].valueMgDl
        when { v < 70 -> low += w; v > 180 -> high += w; else -> inRange += w }
    }
    fun pct(x: Double) = if (total > 0) Math.round(x / total * 100).toInt() else 0
    val tir = if (total > 0) pct(inRange) else values.count { it in 70..180 } * 100 / values.size
    val pctLow = pct(low); val pctHigh = pct(high)
    val mn = values.min()
    val mx = values.max()
    // 6 boxes, 3 per row: row 1 = the time-in-range split (target / low / high), row 2 = the value
    // spread (average / min / max). %BAS in the low colour, %HAUT in the high colour.
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        // Period header so the 6 boxes below are never ambiguous about the window they cover.
        Text(
            periodLabel, color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Black,
            letterSpacing = 1.sp
        )
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MiniStat(s.target, "$tir%", GlucoseStatus.GOOD.strong, Modifier.weight(1f))
            MiniStat(s.statLow, "$pctLow%", colorFor(60), Modifier.weight(1f))
            MiniStat(s.statHigh, "$pctHigh%", colorFor(220), Modifier.weight(1f))
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MiniStat(s.average, "$avg", InkPrimary, Modifier.weight(1f))
            MiniStat("MIN", "$mn", colorFor(mn), Modifier.weight(1f))
            MiniStat("MAX", "$mx", colorFor(mx), Modifier.weight(1f))
        }
    }
}

@Composable
private fun AnalysisHistoryCard(a: AnalysisService.PastAnalysis) {
    val fmt = remember { SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()) }
    Surface(
        color = CardWhite, shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(fmt.format(Date(a.ts)), color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                if (a.glucose != null) Text("${a.glucose} mg/dL", color = colorFor(a.glucose), fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(4.dp))
            Text(a.message, color = InkPrimary, fontSize = 13.sp, lineHeight = 18.sp)
        }
    }
}

@Composable
private fun MiniStat(label: String, value: String, color: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    Surface(
        modifier = modifier, color = CardWhite, shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, BorderLight)
    ) {
        Column(Modifier.padding(vertical = 8.dp, horizontal = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, color = InkDim, fontSize = 8.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
            Spacer(Modifier.height(2.dp))
            Text(value, color = color, fontSize = 17.sp, fontWeight = FontWeight.Black)
        }
    }
}
