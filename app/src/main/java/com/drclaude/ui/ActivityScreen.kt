package com.drclaude.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drclaude.ai.MealsService
import com.drclaude.ui.theme.*
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// The ACTIVITÉ tab. `mechabetics_activity` had been read by the coach, the Q&A and the scan for a
// long time, but the only way to WRITE a row was to say it out loud and hope the model extracted it
// — so the table was empty for every patient and an afternoon of football had never once changed a
// dose. This screen is the missing door, and it exists to feed doseGuard's activity section:
// a logged session trims the proposed insulin and raises the fall-watch threshold.

/** The quick picks. Deliberately short: the fewer taps between "he's going to football" and a row
 *  in the table, the more often it actually gets logged. Free text stays available underneath. */
private data class ActivityPreset(val label: String, val kind: String, val intensity: String, val durationMin: Int)

private val PRESETS = listOf(
    ActivityPreset("⚽ Foot", "foot", "high", 90),
    ActivityPreset("🏃 Course", "course", "high", 45),
    ActivityPreset("🏊 Natation", "natation", "high", 60),
    ActivityPreset("🚲 Vélo", "vélo", "moderate", 60),
    ActivityPreset("🤸 Gym", "gym", "moderate", 60),
    ActivityPreset("🚶 Marche", "marche", "low", 45),
)

@Composable
fun ActivityScreen(
    patientId: String?,
    meals: MealsService,
    header: @Composable () -> Unit = {},
    /** Bumped by the header's refresh chip (MainActivity) to re-run the loader below. */
    refreshKey: Int = 0,
    /** So the dashboard re-runs its analysis: a new session changes the next dose immediately. */
    onDataChanged: () -> Unit = {},
) {
    val s = LocalStrings.current
    // The sport labels live in their own holder: `Strings` is one property short of the dex
    // invoke-range ceiling, and putting them there crashed the app at launch (VerifyError).
    val a = activityStringsFor(LocalLang.current)
    val scope = rememberCoroutineScope()
    var items by remember(patientId) { mutableStateOf<List<MealsService.Activity>>(emptyList()) }
    var loading by remember(patientId) { mutableStateOf(true) }
    var showAdd by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf("") }
    var saveError by remember { mutableStateOf(false) }

    suspend fun reload() {
        val id = patientId ?: return
        items = meals.listActivity(id)
    }

    LaunchedEffect(patientId, refreshKey) {
        loading = true
        reload()
        loading = false
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(LightBg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        header()


        Surface(
            color = CardWhite, shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(a.activityTitle, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                Text(a.activitySub, color = InkMuted, fontSize = 11.sp, lineHeight = 16.sp)
            }
        }

        Button(
            onClick = { showAdd = true },
            enabled = patientId != null,
            colors = ButtonDefaults.buttonColors(containerColor = AccentGreen, contentColor = OnColor),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) { Text(a.activityAdd, fontWeight = FontWeight.Bold, letterSpacing = 1.sp) }

        if (msg.isNotBlank()) {
            Text(
                msg,
                color = if (saveError) DangerRose else AccentGreen,
                fontSize = 12.sp, fontWeight = FontWeight.Bold,
            )
        }

        when {
            loading -> Row(Modifier.fillMaxWidth().padding(24.dp), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator(color = AccentGreen, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
            }
            items.isEmpty() -> Surface(
                color = CardWhite, shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    a.activityEmpty, color = InkMuted, fontSize = 12.sp, lineHeight = 17.sp,
                    modifier = Modifier.padding(16.dp),
                )
            }
            else -> items.forEach { item ->
                ActivityRow(item, a) {
                    scope.launch {
                        val id = patientId ?: return@launch
                        val ok = meals.deleteActivity(id, item.id)
                        saveError = !ok
                        msg = if (ok) "" else s.saveFailed
                        if (ok) { reload(); onDataChanged() }
                    }
                }
            }
        }
    }

    if (showAdd) {
        AddActivityDialog(
            s = s, t = a,
            onDismiss = { showAdd = false },
            onSave = { kind, intensity, duration, planned, whenMs, outdoor ->
                scope.launch {
                    val id = patientId ?: return@launch
                    val ok = meals.addActivity(id, kind, kind, intensity, duration, planned, whenMs, outdoor)
                    saveError = !ok
                    msg = if (ok) a.activitySaved else s.saveFailed
                    if (ok) {
                        showAdd = false
                        reload()
                        onDataChanged()
                    }
                }
            },
        )
    }
}

@Composable
private fun ActivityRow(a: MealsService.Activity, t: ActivityStrings, onDelete: () -> Unit) {
    val fmt = remember { SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()) }
    val ms = remember(a.ts) { runCatching { java.time.Instant.parse(a.ts).toEpochMilli() }.getOrNull() }
    val intensityLabel = when (a.intensity) {
        "high" -> t.activityIntensityHigh
        "moderate" -> t.activityIntensityModerate
        "low" -> t.activityIntensityLow
        else -> ""
    }
    Surface(
        color = CardWhite, shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    (a.description ?: a.kind ?: "—"),
                    color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(3.dp))
                val bits = buildList {
                    if (ms != null) add(fmt.format(Date(ms)))
                    if (intensityLabel.isNotBlank()) add(intensityLabel)
                    a.durationMin?.let { add("$it min") }
                }
                Text(bits.joinToString(" · "), color = InkMuted, fontSize = 11.sp)
            }
            IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Filled.Close, contentDescription = t.activityDelete, tint = InkDim, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun AddActivityDialog(
    s: Strings,
    t: ActivityStrings,
    onDismiss: () -> Unit,
    onSave: (kind: String, intensity: String, durationMin: Int?, planned: Boolean, whenMs: Long?, outdoor: Boolean) -> Unit,
) {
    var kind by remember { mutableStateOf("") }
    var intensity by remember { mutableStateOf("moderate") }
    var duration by remember { mutableStateOf("") }
    var planned by remember { mutableStateOf(false) }
    // OUTDOORS, SAID — not inferred. The alternative was geofencing the air-conditioned places and
    // guessing the rest, which is wrong most of the time (a car, a shop, a friend's house) and would
    // mean tracking a child continuously. One tap, honest, nothing followed.
    var outdoor by remember { mutableStateOf(true) }
    // Future times are allowed on purpose: "foot à 16 h" entered at 14 h is exactly what lets the
    // lunch before it be dosed for the match instead of at rest.
    var whenMs by remember { mutableStateOf<Long?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = CardWhite,
        title = { Text(t.activityAdd, color = InkPrimary, fontSize = 15.sp, fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // One tap fills everything for the six activities a child actually does.
                FlowChips(PRESETS.map { it.label }, selected = PRESETS.firstOrNull { it.kind == kind }?.label) { label ->
                    PRESETS.firstOrNull { it.label == label }?.let {
                        kind = it.kind
                        intensity = it.intensity
                        duration = it.durationMin.toString()
                    }
                }
                OutlinedTextField(
                    value = kind, onValueChange = { kind = it },
                    label = { Text(t.activityKind, fontSize = 12.sp) },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Text(t.activityIntensity, color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                FlowChips(
                    listOf(t.activityIntensityLow, t.activityIntensityModerate, t.activityIntensityHigh),
                    selected = when (intensity) {
                        "low" -> t.activityIntensityLow
                        "high" -> t.activityIntensityHigh
                        else -> t.activityIntensityModerate
                    },
                ) { label ->
                    intensity = when (label) {
                        t.activityIntensityLow -> "low"
                        t.activityIntensityHigh -> "high"
                        else -> "moderate"
                    }
                }
                OutlinedTextField(
                    value = duration, onValueChange = { duration = it.filter { c -> c.isDigit() }.take(3) },
                    label = { Text(t.activityDuration, fontSize = 12.sp) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(
                        checked = planned, onCheckedChange = { planned = it },
                        colors = SwitchDefaults.colors(checkedTrackColor = AccentGreen),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(if (planned) t.activityPlanned else t.activityDone, color = InkPrimary, fontSize = 13.sp)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(
                        checked = outdoor, onCheckedChange = { outdoor = it },
                        colors = SwitchDefaults.colors(checkedTrackColor = AccentGreen),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(if (outdoor) t.activityOutdoor else t.activityIndoor, color = InkPrimary, fontSize = 13.sp)
                }
                WhenPicker(whenMs, { whenMs = it }, AccentGreen, allowFuture = true)
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onSave(kind.trim(), intensity, duration.toIntOrNull(), planned, whenMs, outdoor)
                },
                enabled = kind.isNotBlank(),
            ) { Text(s.saveProfile, color = AccentGreen, fontWeight = FontWeight.Bold) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(s.cancel, color = InkMuted) } },
    )
}

/** A simple wrapping row of selectable chips — no extra dependency, and the lists here are short. */
@Composable
private fun FlowChips(labels: List<String>, selected: String?, onPick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        labels.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { label ->
                    val on = label == selected
                    Surface(
                        color = if (on) AccentGreen.copy(alpha = 0.15f) else LightBg,
                        shape = RoundedCornerShape(8.dp),
                        border = BorderStroke(1.dp, if (on) AccentGreen else BorderLight),
                        modifier = Modifier.weight(1f).clickable { onPick(label) },
                    ) {
                        Text(
                            label,
                            color = if (on) AccentGreen else InkMuted,
                            fontSize = 11.sp,
                            fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                            modifier = Modifier.padding(vertical = 8.dp, horizontal = 4.dp),
                        )
                    }
                }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}
