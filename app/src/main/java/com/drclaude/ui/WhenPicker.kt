package com.drclaude.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drclaude.ui.theme.*
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** Compact "Quand ?" selector for backdating a meal/dose logged late — or, with [allowFuture],
 *  PLANNING one ahead (a dose you're going to take, a meal you're going to eat). `whenMs == null`
 *  means "now" (the server stamps the current time). Without [allowFuture] a time chosen for
 *  "today" that lands in the future is treated as yesterday, so you can't accidentally log into the
 *  future; with it, a third "Demain" day chip appears ([tomorrowLabel], from BgStrings) and future
 *  times are kept as-is — the day is whatever chip the user explicitly picked. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WhenPicker(
    whenMs: Long?,
    onChange: (Long?) -> Unit,
    accent: Color,
    allowFuture: Boolean = false,
    tomorrowLabel: String = "",
    /** Show the − 5 min / + 5 min steppers under the field. */
    showSteppers: Boolean = false,
) {
    val s = LocalStrings.current
    var show by remember { mutableStateOf(false) }
    val fmt = remember { SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()) }

    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(s.whenLabel, color = InkMuted, fontSize = 12.sp, modifier = Modifier.weight(1f))
        TextButton(onClick = { show = true }) {
            Text(
                if (whenMs == null) s.whenNow else fmt.format(Date(whenMs)),
                color = accent, fontWeight = FontWeight.Bold, fontSize = 13.sp
            )
        }
    }
    // Nudge the time in 5-minute steps, right under the field — no dialog, no clock face. Each tap
    // moves it further: three taps on "− 5 min" is a quarter of an hour ago. Starts from NOW, so the
    // common "I forgot to log it" case is a couple of taps.
    if (showSteppers) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            val chip = FilterChipDefaults.filterChipColors(
                selectedContainerColor = accent, selectedLabelColor = OnColor
            )
            val step = { deltaMin: Int ->
                val base = whenMs ?: System.currentTimeMillis()
                val next = base + deltaMin * 60_000L
                // Backdating-only callers can't be pushed into the future by the "+" button.
                onChange(if (!allowFuture && next > System.currentTimeMillis()) System.currentTimeMillis() else next)
            }
            FilterChip(
                selected = false, onClick = { step(-STEP_MIN) },
                label = { Text("− $STEP_MIN min", fontSize = 12.sp) }, colors = chip
            )
            FilterChip(
                selected = false, onClick = { step(STEP_MIN) },
                label = { Text("+ $STEP_MIN min", fontSize = 12.sp) }, colors = chip
            )
            // The running offset, so the effect of a tap is legible without reading the clock.
            val offset = relativeLabel(whenMs)
            Text(
                offset.ifBlank { s.whenNow },
                color = if (offset.isBlank()) InkMuted else accent,
                fontSize = 12.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f)
            )
            if (whenMs != null) {
                TextButton(onClick = { onChange(null) }, contentPadding = PaddingValues(horizontal = 6.dp)) {
                    Text(s.whenNow, color = InkMuted, fontSize = 12.sp)
                }
            }
        }
    }

    if (show) {
        val initCal = remember { Calendar.getInstance().apply { whenMs?.let { timeInMillis = it } } }
        val tState = rememberTimePickerState(
            initialHour = initCal.get(Calendar.HOUR_OF_DAY),
            initialMinute = initCal.get(Calendar.MINUTE),
            is24Hour = true
        )
        // Day chip: -1 = yesterday, 0 = today, +1 = tomorrow (planning, only with allowFuture).
        var dayOffset by remember {
            mutableStateOf(
                when {
                    whenMs == null -> 0
                    isSameDay(whenMs, System.currentTimeMillis()) -> 0
                    allowFuture && isSameDay(whenMs, System.currentTimeMillis() + 86_400_000L) -> 1
                    else -> -1
                }
            )
        }
        AlertDialog(
            onDismissRequest = { show = false },
            title = { Text(s.whenTitle, color = InkPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold) },
            text = {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    val chip = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = accent, selectedLabelColor = OnColor
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = dayOffset == -1, onClick = { dayOffset = -1 },
                            label = { Text(s.whenYesterday) }, colors = chip)
                        FilterChip(selected = dayOffset == 0, onClick = { dayOffset = 0 },
                            label = { Text(s.whenToday) }, colors = chip)
                        if (allowFuture && tomorrowLabel.isNotBlank()) {
                            FilterChip(selected = dayOffset == 1, onClick = { dayOffset = 1 },
                                label = { Text(tomorrowLabel) }, colors = chip)
                        }
                    }
                    TimePicker(state = tState)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val c = Calendar.getInstance()
                    c.set(Calendar.HOUR_OF_DAY, tState.hour)
                    c.set(Calendar.MINUTE, tState.minute)
                    c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
                    if (dayOffset != 0) c.add(Calendar.DAY_OF_YEAR, dayOffset)
                    // Backdating-only mode keeps the old guard: a future "today" time means yesterday.
                    if (!allowFuture && c.timeInMillis > System.currentTimeMillis()) c.add(Calendar.DAY_OF_YEAR, -1)
                    onChange(c.timeInMillis)
                    show = false
                }) { Text("OK", color = accent, fontWeight = FontWeight.Bold) }
            },
            dismissButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { onChange(null); show = false }) { Text(s.whenNow, color = InkMuted) }
                    TextButton(onClick = { show = false }) { Text(s.cancel, color = InkMuted) }
                }
            },
            containerColor = CardWhite
        )
    }
}

/** How much one tap on the − / + buttons moves the time. */
private const val STEP_MIN = 5

/** "− 15 min" / "+ 10 min" for a chosen time, or "" when it is (about) now. Uses the same digits in
 *  both languages, so it needs no translation. */
private fun relativeLabel(whenMs: Long?): String {
    if (whenMs == null) return ""
    val deltaMin = Math.round((whenMs - System.currentTimeMillis()) / 60_000.0).toInt()
    return when {
        deltaMin <= -1 -> "− ${-deltaMin} min"
        deltaMin >= 1 -> "+ $deltaMin min"
        else -> ""
    }
}

private fun isSameDay(a: Long, b: Long): Boolean {
    val ca = Calendar.getInstance().apply { timeInMillis = a }
    val cb = Calendar.getInstance().apply { timeInMillis = b }
    return ca.get(Calendar.YEAR) == cb.get(Calendar.YEAR) &&
        ca.get(Calendar.DAY_OF_YEAR) == cb.get(Calendar.DAY_OF_YEAR)
}
