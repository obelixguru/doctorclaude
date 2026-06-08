package com.nueve.mechabetics.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nueve.mechabetics.AlarmService
import com.nueve.mechabetics.data.CredentialsStore
import com.nueve.mechabetics.ui.theme.*
import java.util.Locale

/** How the phone alerts: sound+vibration, vibration only, or silent (notification only). Maps onto
 *  the store's [CredentialsStore.alarmSoundEnabled] + [CredentialsStore.alarmVibrate] flags. */
private enum class AlarmMode { SOUND, VIBRATE, SILENT }

/**
 * Full "Notifications & alarmes" page (reached from a card in Profile). Lets the user pick how loud
 * the hypo/hyper alarm is, switch to vibreur/silencieux, set quiet hours (during which a HIGH only
 * vibrates while a LOW still sounds), turn individual alert types on/off, and TEST the alarm so the
 * loudness is previewable before a real alert. Everything writes straight to [CredentialsStore]; the
 * ring sites (UI + MonitorService) resolve it via AlarmPolicy. The parent's Telegram alert is
 * independent of all of this, which is why the phone can be freely quieted (note at the bottom).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationSettingsScreen(
    store: CredentialsStore,
    lang: Lang,
    onBack: () -> Unit
) {
    val s = LocalStrings.current
    Column(modifier = Modifier.fillMaxSize().background(LightBg)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, tint = InkPrimary)
            }
            Text(s.notifPageTitle, color = InkPrimary, fontSize = 18.sp, fontWeight = FontWeight.Black)
        }
        NotificationSettingsContent(store, lang, Modifier.weight(1f))
    }
}

/** The notifications & alarms settings content (no header) — reused as a tab inside Profile. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationSettingsContent(store: CredentialsStore, lang: Lang, modifier: Modifier = Modifier) {
    val s = LocalStrings.current
    val context = LocalContext.current

    var mode by remember {
        mutableStateOf(
            when {
                store.alarmSoundEnabled -> AlarmMode.SOUND
                store.alarmVibrate -> AlarmMode.VIBRATE
                else -> AlarmMode.SILENT
            }
        )
    }
    var volume by remember { mutableStateOf(store.alarmVolumePct.toFloat()) }
    var quietOn by remember { mutableStateOf(store.quietHoursEnabled) }
    var quietStart by remember { mutableStateOf(store.quietStartMin) }
    var quietEnd by remember { mutableStateOf(store.quietEndMin) }
    var hyperOn by remember { mutableStateOf(store.alarmHyperEnabled) }
    var hypoOn by remember { mutableStateOf(store.alarmHypoEnabled) }
    var fallOn by remember { mutableStateOf(store.alarmRapidFallEnabled) }
    var hypoAlwaysOn by remember { mutableStateOf(store.alarmHypoAlwaysSounds) }
    var showHypoVibrateConfirm by remember { mutableStateOf(false) }

    // A mode choice sets the sound + vibrate flags together; muting also stops any current ring.
    fun applyMode(m: AlarmMode) {
        mode = m
        store.alarmSoundEnabled = m == AlarmMode.SOUND
        store.alarmVibrate = m != AlarmMode.SILENT
        if (m != AlarmMode.SOUND) AlarmService.stop(context)
    }

    Column(
        modifier = modifier.verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
            // ── Sound mode + volume + test ──────────────────────────────────────────────
            SettingsCard {
                SectionTitle(s.notifModeTitle)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    ModeChip(s.notifModeSound, mode == AlarmMode.SOUND, Modifier.weight(1f)) { applyMode(AlarmMode.SOUND) }
                    ModeChip(s.notifModeVibrate, mode == AlarmMode.VIBRATE, Modifier.weight(1f)) { applyMode(AlarmMode.VIBRATE) }
                    ModeChip(s.notifModeSilent, mode == AlarmMode.SILENT, Modifier.weight(1f)) { applyMode(AlarmMode.SILENT) }
                }
                if (mode == AlarmMode.SOUND) {
                    Text("${s.notifVolumeLabel} : ${volume.toInt()}%", color = InkMuted, fontSize = 12.sp)
                    Slider(
                        value = volume,
                        onValueChange = { volume = it },
                        onValueChangeFinished = { store.alarmVolumePct = volume.toInt() },
                        valueRange = 10f..100f,
                        colors = SliderDefaults.colors(
                            thumbColor = AccentGreen,
                            activeTrackColor = AccentGreen,
                            inactiveTrackColor = BorderLight
                        )
                    )
                }
                OutlinedButton(
                    onClick = {
                        // Preview EXACTLY what a real alert would do under the current mode/volume.
                        val vol = if (mode == AlarmMode.SOUND) volume.toInt() else 0
                        val vib = mode != AlarmMode.SILENT
                        AlarmService.start(context, s.notifPageTitle, s.notifTestBtn, vol, vib)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp),
                    border = BorderStroke(1.dp, AccentGreen)
                ) { Text(s.notifTestBtn, color = AccentGreen, fontWeight = FontWeight.Bold, fontSize = 13.sp) }
            }

            // ── Quiet hours ─────────────────────────────────────────────────────────────
            SettingsCard {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(s.notifQuietTitle, color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    Switch(checked = quietOn, onCheckedChange = { quietOn = it; store.quietHoursEnabled = it })
                }
                Text(s.notifQuietSub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
                if (quietOn) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(s.notifQuietFrom, color = InkMuted, fontSize = 13.sp)
                        TimeField(quietStart, AccentGreen) { quietStart = it; store.quietStartMin = it }
                        Text(s.notifQuietTo, color = InkMuted, fontSize = 13.sp)
                        TimeField(quietEnd, AccentGreen) { quietEnd = it; store.quietEndMin = it }
                    }
                    HorizontalDivider(color = BorderLight)
                    // Hypo pierces quiet hours and still chimes by default. Switching it OFF (hypo →
                    // vibrate-only at night) is a safety trade-off, so it's gated behind a confirmation.
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.weight(1f).padding(end = 8.dp)) {
                            Text(s.notifHypoAlwaysLabel, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                            Text(s.notifHypoAlwaysSub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
                        }
                        Switch(checked = hypoAlwaysOn, onCheckedChange = { on ->
                            if (on) { hypoAlwaysOn = true; store.alarmHypoAlwaysSounds = true }
                            else showHypoVibrateConfirm = true
                        })
                    }
                    if (!hypoAlwaysOn) Text(s.notifHypoVibrateActive, color = GlucoseStatus.DANGER.strong, fontSize = 11.sp, lineHeight = 15.sp, fontWeight = FontWeight.Bold)
                }
            }

            // ── Per-type switches ───────────────────────────────────────────────────────
            SettingsCard {
                SectionTitle(s.notifTypesTitle)
                SwitchRow(s.notifHyperLabel, s.notifHyperSub, hyperOn) { hyperOn = it; store.alarmHyperEnabled = it }
                SwitchRow(s.notifHypoLabel, s.notifHypoSub, hypoOn) { hypoOn = it; store.alarmHypoEnabled = it }
                if (!hypoOn) Text(s.notifHypoWarn, color = GlucoseStatus.DANGER.strong, fontSize = 11.sp, lineHeight = 15.sp, fontWeight = FontWeight.Bold)
                SwitchRow(s.notifFallLabel, s.notifFallSub, fallOn) { fallOn = it; store.alarmRapidFallEnabled = it }
            }

            Text(s.notifTelegramNote, color = InkMuted, fontSize = 11.sp, lineHeight = 16.sp)
            Spacer(Modifier.height(8.dp))
        }

    if (showHypoVibrateConfirm) {
        AlertDialog(
            onDismissRequest = { showHypoVibrateConfirm = false },
            title = { Text(s.notifHypoVibrateTitle, fontWeight = FontWeight.Bold) },
            text = { Text(s.notifHypoVibrateBody, fontSize = 13.sp, lineHeight = 18.sp) },
            confirmButton = {
                TextButton(onClick = {
                    hypoAlwaysOn = false; store.alarmHypoAlwaysSounds = false; showHypoVibrateConfirm = false
                }) { Text(s.notifHypoVibrateConfirm, color = GlucoseStatus.DANGER.strong, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { showHypoVibrateConfirm = false }) { Text(s.cancel, color = InkMuted) } },
            containerColor = CardWhite
        )
    }
}

@Composable
private fun SettingsCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        color = CardWhite, shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

@Composable
private fun SectionTitle(text: String) =
    Text(text, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)

@Composable
private fun ModeChip(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, fontSize = 12.sp, fontWeight = FontWeight.Bold) },
        modifier = modifier,
        colors = FilterChipDefaults.filterChipColors(
            selectedContainerColor = AccentGreen,
            selectedLabelColor = OnColor
        )
    )
}

@Composable
private fun SwitchRow(label: String, sub: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(sub, color = InkMuted, fontSize = 11.sp)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** Tappable HH:mm that opens a 24-h time picker. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeField(minutes: Int, accent: Color, onPicked: (Int) -> Unit) {
    var show by remember { mutableStateOf(false) }
    Surface(
        color = accent.copy(alpha = 0.10f), shape = RoundedCornerShape(8.dp),
        modifier = Modifier.clickable { show = true }
    ) {
        Text(
            String.format(Locale.US, "%02d:%02d", minutes / 60, minutes % 60),
            color = accent, fontWeight = FontWeight.Bold, fontSize = 15.sp,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
        )
    }
    if (show) {
        val state = rememberTimePickerState(initialHour = minutes / 60, initialMinute = minutes % 60, is24Hour = true)
        AlertDialog(
            onDismissRequest = { show = false },
            confirmButton = {
                TextButton(onClick = { onPicked(state.hour * 60 + state.minute); show = false }) {
                    Text("OK", color = accent, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = { TextButton(onClick = { show = false }) { Text(LocalStrings.current.cancel, color = InkMuted) } },
            text = { TimePicker(state = state) },
            containerColor = CardWhite
        )
    }
}
