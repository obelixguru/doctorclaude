package com.drclaude.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt
import com.drclaude.ai.AnalysisService
import com.drclaude.data.GlucoseReading
import com.drclaude.ui.theme.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.hypot

/** A meal or insulin event drawn as a dot ON the glucose curve. Tapping it opens a preview badge;
 *  tapping the badge's line opens THAT record. [id] is the row id of the meal / dose it stands for
 *  (0 when unknown — then the badge is read-only and the record can't be opened from here). */
data class GraphEvent(val ts: Long, val insulin: Boolean, val label: String, val id: Long = 0)

// Meal = RED (it sends glucose UP), insulin = GREEN (it brings glucose DOWN) — the user's mnemonic.
private val InsulinMarker = Color(0xFF16A34A)
private val MealMarker = Color(0xFFDC2626)

/** How close a tap must land to count as hitting a marker. In DP so the target is a finger's width
 *  on every screen density. */
private val TAP_SLOP_DP = 24.dp

/** Events close in time are grouped so a meal + a dose logged together (≈ same minute) show as one
 *  concentric marker instead of one hiding the other. */
private class EventCluster(val ts: Long, val events: List<GraphEvent>) {
    val hasMeal get() = events.any { !it.insulin }
    val hasInsulin get() = events.any { it.insulin }
}

private fun clusterEvents(events: List<GraphEvent>, gapMs: Long = 3 * 60_000): List<EventCluster> {
    if (events.isEmpty()) return emptyList()
    val sorted = events.sortedBy { it.ts }
    val out = ArrayList<EventCluster>()
    var bucket = mutableListOf(sorted[0])
    for (i in 1 until sorted.size) {
        if (sorted[i].ts - bucket.last().ts <= gapMs) bucket.add(sorted[i])
        else { out.add(EventCluster(bucket.first().ts, bucket.toList())); bucket = mutableListOf(sorted[i]) }
    }
    out.add(EventCluster(bucket.first().ts, bucket.toList()))
    return out
}

private fun fmtUnitsShort(u: Double): String =
    if (u == u.toLong().toDouble()) u.toLong().toString() else u.toString().replace('.', ',')

/** Build chart markers from the logged doses + EATEN meals (planned meals aren't on board yet).
 *  A FUTURE-dated (planned) dose is skipped the same way: the curve has no point at its time yet —
 *  the marker appears naturally once that time arrives. */
fun buildGraphEvents(
    insulin: List<AnalysisService.InsulinDose>,
    meals: List<AnalysisService.RecentMeal>
): List<GraphEvent> {
    val now = System.currentTimeMillis()
    val out = ArrayList<GraphEvent>(insulin.size + meals.size)
    for (d in insulin) {
        if (d.units <= 0 || d.ts > now + 120_000L) continue
        out += GraphEvent(d.ts, true, "${fmtUnitsShort(d.units)} u${d.name?.takeIf { it.isNotBlank() }?.let { " $it" } ?: ""}", d.id)
    }
    for (m in meals) {
        // A meal is on the curve once its time has passed — `planned` alone would hide an announced
        // meal for ever, since nothing ever flips that flag back (see isEatenBy on the server side).
        if (m.planned && m.ts > now) continue
        val desc = m.description?.takeIf { it.isNotBlank() }
        val carbs = m.carbsG?.takeIf { it > 0 }?.let { "≈ $it g" }
        val label = listOfNotNull(desc, carbs).joinToString(" · ").ifBlank { "Repas" }
        out += GraphEvent(m.ts, false, label, m.id)
    }
    return out
}

/**
 * Modern glucose graph (shadcn-style): soft target band, light gridlines, muted labels, a faint area
 * gradient under the curve, and a line COLOURED BY ZONE — green inside 70–180, orange near the edges,
 * red in hypo/hyper. Meal (red) and insulin (green) events are drawn as solid dots ON the curve at
 * their time; a meal + dose logged together render as a concentric marker (a dot inside a ring) so
 * both stay visible. Tapping a marker shows a closeable preview over the chart. Shared by dashboard
 * + history.
 */
@Composable
fun GlucoseGraph(
    readings: List<GlucoseReading>,
    modifier: Modifier = Modifier,
    lineColor: Color = AccentGreen,
    events: List<GraphEvent> = emptyList(),
    onBackgroundClick: () -> Unit = {},
    /** A LINE OF THE PREVIEW BADGE was tapped — opens THAT meal / dose. Never fired by the tap on
     *  the dot itself: that only opens the badge, so reading the curve never throws you into a form. */
    onEventClick: (GraphEvent) -> Unit = {},
) {
    val pts = remember(readings) { readings.sortedBy { it.timestampMs } }
    if (pts.size < 2) {
        Box(modifier)
        return
    }
    val sdfTime = remember { SimpleDateFormat("HH:mm", Locale.getDefault()) }
    val sdfDate = remember { SimpleDateFormat("dd/MM", Locale.getDefault()) }
    val sdfFull = remember { SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()) }

    val leftPad = 44f
    val bottomPad = 26f
    val topPad = 10f
    val rightPad = 10f

    val t0 = pts.first().timestampMs
    val t1 = pts.last().timestampMs
    val span = (t1 - t0).coerceAtLeast(1L)

    val dataMax = pts.maxOf { it.valueMgDl }.toFloat()
    val dataMin = pts.minOf { it.valueMgDl }.toFloat()
    val maxV = maxOf(220f, kotlin.math.ceil((dataMax + 15f) / 20f) * 20f)
    val minV = minOf(50f, kotlin.math.floor((dataMin - 10f) / 10f) * 10f).coerceAtLeast(10f)
    val rangeV = (maxV - minV).coerceAtLeast(1f)

    val clusters = remember(events, t0, t1) {
        clusterEvents(events.filter { it.ts in t0..t1 })
    }

    fun valueAt(ts: Long): Float {
        if (ts <= pts.first().timestampMs) return pts.first().valueMgDl.toFloat()
        if (ts >= pts.last().timestampMs) return pts.last().valueMgDl.toFloat()
        for (k in 0 until pts.size - 1) {
            val a = pts[k]; val b = pts[k + 1]
            if (ts in a.timestampMs..b.timestampMs) {
                val f = (ts - a.timestampMs).toFloat() / (b.timestampMs - a.timestampMs).coerceAtLeast(1L).toFloat()
                return a.valueMgDl + f * (b.valueMgDl - a.valueMgDl)
            }
        }
        return pts.last().valueMgDl.toFloat()
    }

    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    // WHICH marker is open, held as its TIMESTAMP rather than as the cluster object. Keyed on
    // `readings`/`events`, the open badge was wiped every time a new glucose arrived — every five
    // minutes, mid-read. That was a nuisance while a tap opened the editor directly; now that the
    // badge IS the way into the editor, it would make the record unreachable in the seconds before
    // the sensor speaks. A timestamp survives the list being rebuilt, and resolves to nothing when
    // the event itself is gone (deleted, or scrolled out of the window).
    var selectedTs by remember { mutableStateOf<Long?>(null) }
    var badgeSize by remember { mutableStateOf(IntSize.Zero) }
    val selected = selectedTs?.let { ts -> clusters.firstOrNull { it.ts == ts } }

    Box(modifier) {
        Canvas(
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { canvasSize = it }
                .pointerInput(clusters, t0, span, canvasSize, maxV, minV) {
                    // The tap target is sized in DP, not raw pixels. It used to be 44 px, which on a
                    // 3x screen is under 15 dp — well below the ~44 dp a finger needs — so most taps
                    // aimed at a dot missed it and fell through to "open the whole history".
                    val slopPx = TAP_SLOP_DP.toPx()
                    detectTapGestures { off ->
                        val cand = if (canvasSize.width == 0 || clusters.isEmpty()) null else {
                            val w = canvasSize.width.toFloat()
                            val hh = canvasSize.height.toFloat()
                            val plotW = (w - leftPad - rightPad).coerceAtLeast(1f)
                            val plotH = (hh - topPad - bottomPad).coerceAtLeast(1f)
                            clusters
                                .map {
                                    val ex = leftPad + (it.ts - t0).toFloat() / span * plotW
                                    val ey = topPad + (maxV - valueAt(it.ts).coerceIn(minV, maxV)) / rangeV * plotH
                                    Triple(it, Offset(ex, ey), hypot((off.x - ex).toDouble(), (off.y - ey).toDouble()))
                                }
                                .filter { it.third <= slopPx }
                                .minByOrNull { it.third }
                        }
                        val cluster = cand?.first
                        when {
                            // TAPPING A MARKER SHOWS IT, IT DOES NOT OPEN IT. A single identified
                            // record used to jump straight into its editor, so a finger landing on a
                            // dot while reading the curve threw the user into a form they never
                            // asked for — and the preview that says WHAT the dot is never appeared.
                            // Look first, then decide: the badge itself is the door to the editor.
                            cluster != null -> selectedTs = cluster.ts
                            selected != null -> selectedTs = null
                            else -> onBackgroundClick()
                        }
                    }
                }
        ) {
            val w = size.width
            val h = size.height
            val plotW = (w - leftPad - rightPad).coerceAtLeast(1f)
            val plotH = (h - topPad - bottomPad).coerceAtLeast(1f)
            val useDate = span > 30L * 3600_000

            fun yOf(v: Float) = topPad + (maxV - v.coerceIn(minV, maxV)) / rangeV * plotH
            fun xOf(t: Long) = leftPad + (t - t0).toFloat() / span.toFloat() * plotW

            val y70 = yOf(70f)
            val y180 = yOf(180f)
            drawRect(
                GlucoseStatus.GOOD.strong.copy(alpha = 0.08f),
                topLeft = Offset(leftPad, y180),
                size = Size(plotW, y70 - y180)
            )

            val labelPaint = android.graphics.Paint().apply {
                color = android.graphics.Color.argb(150, 120, 130, 145)
                textSize = 21f
                isAntiAlias = true
            }

            val ticks = buildList {
                add(70); add(180)
                var v = 100
                while (v <= maxV.toInt()) { add(v); v += 100 }
                if (minV <= 50f) add(50)
            }.filter { it in (minV.toInt())..(maxV.toInt()) }.distinct().sorted()
            for (v in ticks) {
                val y = yOf(v.toFloat())
                val band = v == 70 || v == 180
                drawLine(
                    BorderLight.copy(alpha = if (band) 0.9f else 0.45f),
                    Offset(leftPad, y), Offset(w - rightPad, y),
                    strokeWidth = 1f
                )
                drawContext.canvas.nativeCanvas.drawText(v.toString(), 6f, y + 7f, labelPaint)
            }

            // The window's PEAK and TROUGH on the left axis, in their zone colour + bold, so the high
            // and the low of the shown period read at a glance (drawn last → on top of the grey ticks).
            val hiLoPaint = android.graphics.Paint().apply {
                textSize = 22f; isAntiAlias = true; isFakeBoldText = true
            }
            val peak = dataMax.toInt(); val trough = dataMin.toInt()
            hiLoPaint.color = colorFor(peak).toArgb()
            drawContext.canvas.nativeCanvas.drawText(peak.toString(), 6f, yOf(dataMax) + 7f, hiLoPaint)
            if (trough != peak) {
                hiLoPaint.color = colorFor(trough).toArgb()
                drawContext.canvas.nativeCanvas.drawText(trough.toString(), 6f, yOf(dataMin) + 7f, hiLoPaint)
            }

            for (i in 0..4) {
                val frac = i / 4f
                val x = leftPad + frac * plotW
                val t = t0 + (frac * span).toLong()
                val lbl = if (useDate) sdfDate.format(Date(t)) else sdfTime.format(Date(t))
                val tw = labelPaint.measureText(lbl)
                val tx = (x - tw / 2f).coerceIn(leftPad, (w - rightPad - tw).coerceAtLeast(leftPad))
                drawContext.canvas.nativeCanvas.drawText(lbl, tx, h - 6f, labelPaint)
            }

            val gapMs = 45L * 60_000
            val baselineY = topPad + plotH
            var i = 0
            while (i < pts.size) {
                var j = i
                while (j + 1 < pts.size && (pts[j + 1].timestampMs - pts[j].timestampMs) <= gapMs) j++
                if (j > i) {
                    // NO area fill under the curve (the user asked to drop the green/red/orange "inner
                    // background"): just the zone-coloured line over the target band + gridlines.
                    for (k in i until j) {
                        val a = pts[k]; val b = pts[k + 1]
                        val segColor = colorFor((a.valueMgDl + b.valueMgDl) / 2)
                        drawLine(
                            segColor,
                            Offset(xOf(a.timestampMs), yOf(a.valueMgDl.toFloat())),
                            Offset(xOf(b.timestampMs), yOf(b.valueMgDl.toFloat())),
                            strokeWidth = 3.5f, cap = StrokeCap.Round
                        )
                    }
                }
                i = j + 1
            }

            // Event markers ON the curve, big + solid (no border). A meal + dose logged together show
            // as two SAME-SIZE circles, almost on top of each other: the OLDER one sits BEHIND, offset
            // ~4px, so it peeks as a thin crescent moon; the NEWER one is drawn on top, centred. So it
            // reads as nearly one circle with a sliver of the other — sometimes red-on-green, sometimes
            // green-on-red (whichever is older is behind).
            for (cl in clusters) {
                val x = xOf(cl.ts)
                val y = yOf(valueAt(cl.ts))
                if (cl.hasMeal && cl.hasInsulin) {
                    val ordered = cl.events.sortedBy { it.ts }
                    val older = ordered.first(); val newer = ordered.last()
                    // older BEHIND, 8 px left; newer in FRONT nudged 2 px right (so more of the back
                    // crescent shows) with a 2 px white ring separating the two.
                    drawCircle(if (older.insulin) InsulinMarker else MealMarker, 14f, Offset(x - 8f, y))
                    drawCircle(Color.White, 16f, Offset(x + 2f, y))
                    drawCircle(if (newer.insulin) InsulinMarker else MealMarker, 14f, Offset(x + 2f, y))
                } else {
                    drawCircle(if (cl.hasMeal) MealMarker else InsulinMarker, 14f, Offset(x, y))
                }
            }

            val last = pts.last()
            drawCircle(colorFor(last.valueMgDl), 5.5f, Offset(xOf(last.timestampMs), yOf(last.valueMgDl.toFloat())))
        }

        // Tap preview over the chart (closeable). Lists every event in the tapped cluster, so a
        // coincident meal + dose both show.
        selected?.let { cl ->
            // Place the badge ~6 px from the marker (above-right), not at the chart centre, clamped
            // so it never spills off the chart. Flips below the marker if there's no room above.
            // Recomputed from the event's TIME rather than from the pixel the finger landed on, so it
            // stays glued to its dot when a new reading re-scales the curve under it.
            val plotW = (canvasSize.width - leftPad - rightPad).coerceAtLeast(1f)
            val plotH = (canvasSize.height - topPad - bottomPad).coerceAtLeast(1f)
            val mx = leftPad + (cl.ts - t0).toFloat() / span * plotW
            val my = topPad + (maxV - valueAt(cl.ts).coerceIn(minV, maxV)) / rangeV * plotH
            val bx = (mx + 6f).coerceIn(0f, (canvasSize.width - badgeSize.width).coerceAtLeast(0).toFloat())
            val above = my - badgeSize.height - 6f
            val by = (if (above >= 0f) above else my + 18f)
                .coerceIn(0f, (canvasSize.height - badgeSize.height).coerceAtLeast(0).toFloat())
            Surface(
                color = CardWhite,
                shape = RoundedCornerShape(10.dp),
                border = BorderStroke(1.dp, if (cl.hasMeal) MealMarker else InsulinMarker),
                modifier = Modifier
                    .offset { IntOffset(bx.roundToInt(), by.roundToInt()) }
                    .onSizeChanged { badgeSize = it }
            ) {
                Row(
                    verticalAlignment = Alignment.Top,
                    modifier = Modifier.padding(start = 10.dp, end = 2.dp, top = 4.dp, bottom = 4.dp)
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (e in cl.events.sortedBy { it.ts }) {
                            // Each line opens ITS OWN record — the only way into the editor, and how
                            // a meal and a dose logged at the same minute stay separately reachable.
                            val openable = e.id != 0L
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = if (openable) Modifier.clickable { selectedTs = null; onEventClick(e) } else Modifier
                            ) {
                                Box(
                                    Modifier.padding(end = 8.dp).size(10.dp)
                                        .background(if (e.insulin) InsulinMarker else MealMarker, RoundedCornerShape(50))
                                )
                                Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                                    Text(e.label, color = InkPrimary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                    Text(sdfFull.format(Date(e.ts)), color = InkDim, fontSize = 10.sp)
                                }
                                // A chevron, because "tap this line to edit it" has to be visible now
                                // that the tap on the dot no longer does it. No text: this badge sits
                                // over the chart in both languages.
                                if (openable) {
                                    Icon(
                                        Icons.Filled.ChevronRight, contentDescription = null,
                                        tint = if (e.insulin) InsulinMarker else MealMarker,
                                        modifier = Modifier.padding(start = 6.dp).size(16.dp)
                                    )
                                }
                            }
                        }
                    }
                    IconButton(onClick = { selectedTs = null }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Outlined.Close, contentDescription = "Fermer", tint = InkMuted, modifier = Modifier.size(15.dp))
                    }
                }
            }
        }
    }
}
