package com.drclaude.ui

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
import com.drclaude.ai.AnalysisService
import com.drclaude.data.GlucoseAlert
import com.drclaude.data.GlucoseReading
import com.drclaude.data.cleanGlucoseSeries
import com.drclaude.ui.theme.*
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
    initialTab: Int = 0,
    /** Tapping a marker on the curve opens THAT meal / dose, exactly as on the home graph. */
    onEventClick: (GraphEvent) -> Unit = {},
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
        when (tab) {
            // GÉNÉRAL : fixed 24 h stat boxes + TIR bar, plus a graph (last 7 days) carrying its OWN
            // day filter — the chips inside the graph card scope the GRAPH ONLY; the boxes/bar stay
            // on the last 24 h. The HISTORIQUE tab keeps its separate day filter for the list.
            0 -> GeneralTab(allData, keyFmt, chipFmt, s, signalStale, events, now, onEventClick)
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

/** GÉNÉRAL tab: a stats snapshot (3 boxes + TIR bar) and a trend graph, BOTH driven by ONE shared
 *  day filter at the top of the stats card. The chips pick "Tout" (the whole 7-day window, labelled
 *  "N DERNIERS JOURS") or a single day ("LE jj/MM"); that selection scopes the boxes, the TIR bar AND
 *  the graph together — nothing is locked to a rolling 24 h anymore. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GeneralTab(
    allData: List<GlucoseReading>,
    keyFmt: SimpleDateFormat,
    chipFmt: SimpleDateFormat,
    s: Strings,
    signalStale: Boolean,
    events: List<GraphEvent>,
    now: Long,
    onEventClick: (GraphEvent) -> Unit = {},
) {
    // ONE day filter drives the whole tab. It covers up to the last 7 distinct days (bucketed at the
    // 08:00 boundary); "Tout" = the whole span, a chip = that single day. The SAME filtered set
    // (periodData) feeds the stat boxes, the TIR bar AND the graph, so they always describe the same
    // period — the boxes/TIR are no longer pinned to the last 24 h.
    val dayKeyOf = { ms: Long -> keyFmt.format(Date(ms - DAY_SHIFT_MS)) }
    val days7 = remember(allData) { allData.map { dayKeyOf(it.timestampMs) }.distinct().sortedDescending().take(7) }
    val last7days = remember(allData, days7) { val set = days7.toSet(); allData.filter { dayKeyOf(it.timestampMs) in set } }
    var graphDay by remember { mutableStateOf<String?>(null) } // null = "Tout" (whole 7-day span)
    // Drop a stale selection if that day scrolled out of the 7-day window.
    LaunchedEffect(days7) { val g = graphDay; if (g != null && g !in days7) graphDay = null }
    val gd = graphDay // capture once (a delegated var doesn't smart-cast) for the reads below
    val periodData = remember(last7days, gd) {
        if (gd == null) last7days else last7days.filter { dayKeyOf(it.timestampMs) == gd }
    }
    val periodLabel = when {
        gd != null -> s.periodOnDay.format(chipFmt.format(runCatching { keyFmt.parse(gd) }.getOrNull() ?: Date()))
        days7.size >= 2 -> s.periodOverDays.format(days7.size)
        else -> s.periodLast24h
    }
    // Hide the curve during signal loss only when it would reach "now" (Tout or today); a past day's
    // graph is genuinely historical, so keep it. The filter/stats stay visible either way.
    val graphHidden = signalStale && (gd == null || gd == dayKeyOf(now))

    // Scrollable, with even 14 dp breathing room between the 2 cards (stats · graph) and a shared
    // 16 dp side margin so nothing floats loose on the background.
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        // STATS CARD — the shared filter sits at its top (chips + period label) and drives BOTH the
        // boxes/TIR here and the graph below. Always rendered so the chips stay reachable even when the
        // picked day has too little data for stats. The target/low/high split lives ONLY in the TIR bar
        // (the 3 boxes that duplicated it were removed), so this is 3 boxes, not 6.
        Surface(
            color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(vertical = 8.dp)) {
                DayFilterRow(days7, graphDay, { graphDay = it }, chipFmt, keyFmt, s)
                Column(
                    Modifier.padding(horizontal = 18.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    Text(periodLabel, color = InkDim, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp)
                    if (periodData.size >= 2) {
                        val (pctLow, tir, pctHigh) = tirSplit(periodData)
                        DayStats(periodData)
                        HorizontalDivider(color = BorderLight)
                        TimeInRangeBar(pctLow, tir, pctHigh)
                    } else {
                        Text(s.waiting, color = InkDim, fontSize = 13.sp)
                    }
                }
            }
        }

        // GRAPH CARD — the curve for the SAME selected period (the filter + label live in the stats
        // card above, so this card is just the chart).
        Surface(
            color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(vertical = 10.dp)) {
                if (graphHidden) {
                    Box(Modifier.fillMaxWidth().height(210.dp), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Filled.Warning, contentDescription = null, tint = SignalLostTop, modifier = Modifier.size(28.dp))
                            Spacer(Modifier.height(8.dp))
                            Text(s.noSignal, color = SignalLostTop, fontSize = 20.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
                            Spacer(Modifier.height(4.dp))
                            Text(s.graphHidden, color = InkMuted, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp))
                        }
                    }
                } else if (periodData.size >= 2) {
                    GlucoseGraph(
                        periodData, Modifier.fillMaxWidth().height(220.dp).padding(10.dp),
                        events = events, onEventClick = onEventClick,
                    )
                } else {
                    Box(Modifier.fillMaxWidth().height(210.dp), contentAlignment = Alignment.Center) {
                        Text(s.waiting, color = InkDim, fontSize = 13.sp)
                    }
                }
            }
        }
    }
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

/** The 3 value boxes — moyenne / min / max — for the window. The time-in-range split (target / low /
 *  high %) is NOT here: it's the TIR bar above, so the 3 boxes that duplicated it were removed. */
@Composable
private fun DayStats(readings: List<GlucoseReading>) {
    if (readings.size < 2) return
    val s = LocalStrings.current
    val values = readings.map { it.valueMgDl }
    val avg = values.average().toInt()
    val mn = values.min()
    val mx = values.max()
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        MiniStat("MIN", "$mn", colorFor(mn), Modifier.weight(1f))
        MiniStat(s.average, "$avg", InkPrimary, Modifier.weight(1f))
        MiniStat("MAX", "$mx", colorFor(mx), Modifier.weight(1f))
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

/** One borderless stat (label over value), centred. Borderless on purpose — these sit INSIDE the
 *  24 h card, so a bordered box here would read as a card-in-a-card and clutter the page. */
@Composable
private fun MiniStat(label: String, value: String, color: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, color = InkDim, fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
        Spacer(Modifier.height(3.dp))
        Text(value, color = color, fontSize = 22.sp, fontWeight = FontWeight.Black)
    }
}
