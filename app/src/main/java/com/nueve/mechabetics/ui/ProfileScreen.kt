package com.nueve.mechabetics.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import com.nueve.mechabetics.ai.ProfileService
import com.nueve.mechabetics.data.CredentialsStore
import com.nueve.mechabetics.data.HealthConnectManager
import com.nueve.mechabetics.data.HealthSnapshot
import com.nueve.mechabetics.data.MealReminderReceiver
import com.nueve.mechabetics.ui.theme.*
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Donation link (Ko-fi → routes to the maintainer's PayPal). */
private const val DONATE_URL = "https://ko-fi.com/doctorclaude"
/** The Health Connect app on the Play Store (Google's data-sync hub; Samsung Health feeds into it). */
private const val HEALTH_CONNECT_PKG = "com.google.android.apps.healthdata"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(
    patientId: String?,
    service: ProfileService,
    lang: Lang,
    store: CredentialsStore,
    profiles: List<ProfileItem>,
    onSwitchProfile: (String) -> Unit,
    onAddProfile: () -> Unit,
    onRemoveProfile: (String) -> Unit,
    health: HealthConnectManager,
    onVoiceChange: (Boolean) -> Unit = {},
    onAiSettingsChange: () -> Unit = {},
    onClearLocalData: () -> Unit = {},
    onOpenNotifications: () -> Unit = {},
    header: @Composable () -> Unit = {}
) {
    val s = LocalStrings.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var toRemove by remember { mutableStateOf<String?>(null) }
    var profileTab by remember { mutableStateOf(0) } // 0 = PROFIL, 1 = NOTIFS, 2 = RÉGLAGES

    var byok by remember { mutableStateOf(store.geminiApiKey ?: "") }
    var nativeVoice by remember { mutableStateOf(store.useNativeVoice) }
    var hosted by remember { mutableStateOf(store.hostedMode) }
    var healthOn by remember { mutableStateOf(store.healthConnectEnabled) }
    var clearMsg by remember { mutableStateOf("") }
    var healthSnap by remember { mutableStateOf<HealthSnapshot?>(null) }
    val healthLauncher = rememberLauncherForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { scope.launch { healthSnap = health.snapshot() } }
    // Only read Health Connect when the user has it switched ON.
    LaunchedEffect(healthOn) { healthSnap = if (healthOn) health.snapshot() else null }

    var nickname by remember { mutableStateOf("") }
    var age by remember { mutableStateOf("") }
    var weight by remember { mutableStateOf("") }
    var dxYears by remember { mutableStateOf("") }
    var rapidName by remember { mutableStateOf("") }
    var rapidUnits by remember { mutableStateOf("") }
    var basalName by remember { mutableStateOf("") }
    var basalUnits by remember { mutableStateOf("") }
    var carbRatio by remember { mutableStateOf("") }
    var correction by remember { mutableStateOf("") }
    var target by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var reminders by remember { mutableStateOf(store.mealRemindersEnabled) }
    var voiceOn by remember { mutableStateOf(store.voiceEnabled) }

    LaunchedEffect(patientId) {
        if (patientId != null) {
            val p = service.load(patientId) ?: return@LaunchedEffect
            if (!p.isNull("nickname")) nickname = p.optString("nickname")
            if (!p.isNull("age")) age = p.optInt("age").toString()
            if (!p.isNull("weight_kg")) weight = trimNum(p.optDouble("weight_kg"))
            if (!p.isNull("diagnosis_date")) {
                val y = p.optString("diagnosis_date").take(4).toIntOrNull()
                if (y != null) {
                    val cur = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)
                    dxYears = (cur - y).coerceAtLeast(0).toString()
                }
            }
            if (!p.isNull("rapid_insulin")) rapidName = p.optString("rapid_insulin")
            if (!p.isNull("rapid_units_per_day")) rapidUnits = trimNum(p.optDouble("rapid_units_per_day"))
            if (!p.isNull("basal_insulin")) basalName = p.optString("basal_insulin")
            if (!p.isNull("basal_units_per_day")) basalUnits = trimNum(p.optDouble("basal_units_per_day"))
            // Always prefill the ratio fields from whatever is stored (doctor's OR estimated) so the
            // values the user typed never look "empty" when they come back. Editing + saving makes
            // them the user's own ratios (the server then marks them as not-estimated).
            if (!p.isNull("carb_ratio")) carbRatio = p.optInt("carb_ratio").toString()
            if (!p.isNull("correction_factor")) correction = p.optInt("correction_factor").toString()
            if (!p.isNull("target_mgdl")) target = p.optInt("target_mgdl").toString()
            if (!p.isNull("notes")) notes = p.optString("notes")
        }
    }

    // ONE save action for the whole page (profile fields + the AI key), driven by the pinned button.
    val saveAll: () -> Unit = saveAll@{
        if (patientId == null || saving) return@saveAll
        saving = true; message = ""
        // The AI key is saved together with everything else — a single button controls all of it.
        store.geminiApiKey = byok.ifBlank { null }
        onAiSettingsChange()
        scope.launch {
            val fields = JSONObject().apply {
                putOpt("nickname", nickname.ifBlank { null })
                putOpt("age", age.toIntOrNull())
                putOpt("weight_kg", weight.replace(',', '.').toDoubleOrNull())
                putOpt("diagnosis_years", dxYears.replace(',', '.').toDoubleOrNull())
                putOpt("rapid_insulin", rapidName.ifBlank { null })
                putOpt("rapid_units_per_day", rapidUnits.replace(',', '.').toDoubleOrNull())
                putOpt("basal_insulin", basalName.ifBlank { null })
                putOpt("basal_units_per_day", basalUnits.replace(',', '.').toDoubleOrNull())
                // Doctor ratios (optional). Carb-ratio + correction are enough for the server to store
                // them as the user's own (ratios_estimated=false); blank → it keeps estimating.
                putOpt("carb_ratio", carbRatio.toIntOrNull())
                putOpt("correction_factor", correction.toIntOrNull())
                putOpt("target_mgdl", target.toIntOrNull())
                putOpt("notes", notes.ifBlank { null })
                put("lang", lang.code.lowercase())
            }
            val res = service.save(patientId, fields)
            saving = false
            message = res.error ?: s.profileSaved
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(LightBg)) {
        // Shared app header (same as the home), pinned above the scrollable profile content.
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp)) { header() }
        TabRow(selectedTabIndex = profileTab, containerColor = LightBg, contentColor = AccentGreen) {
            ProfTab(s.profTabProfile, profileTab == 0) { profileTab = 0 }
            ProfTab(s.profTabNotifs, profileTab == 1) { profileTab = 1 }
            ProfTab(s.profTabSettings, profileTab == 2) { profileTab = 2 }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
          when (profileTab) {
            // ── NOTIFS — full notifications & alarms settings ──
            1 -> NotificationSettingsContent(store, lang, Modifier.fillMaxSize())
            // ── PROFIL — accounts + the patient form ──
            0 -> Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
            // --- Multi-profils : comptes LibreLinkUp mémorisés ---
            Surface(
                color = CardWhite,
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, BorderLight),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(s.accountsTitle, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                    Text(s.accountsSub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
                    profiles.forEach { p ->
                        Surface(
                            color = if (p.active) AccentGreen.copy(alpha = 0.08f) else CardWhite,
                            shape = RoundedCornerShape(10.dp),
                            border = BorderStroke(1.dp, if (p.active) AccentGreen else BorderLight),
                            modifier = Modifier
                                .fillMaxWidth()
                                .then(if (!p.active) Modifier.clickable { onSwitchProfile(p.email) } else Modifier)
                        ) {
                            Row(
                                modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(
                                    if (p.active) Icons.Filled.Check else Icons.Outlined.Person,
                                    contentDescription = null,
                                    tint = if (p.active) AccentGreen else InkMuted,
                                    modifier = Modifier.size(20.dp)
                                )
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(p.label, color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                                    Text(
                                        if (p.active) s.accountActive else p.email,
                                        color = if (p.active) AccentGreen else InkMuted,
                                        fontSize = 11.sp
                                    )
                                }
                                IconButton(onClick = { toRemove = p.email }) {
                                    Icon(Icons.Outlined.Delete, contentDescription = s.foodDelete, tint = InkMuted, modifier = Modifier.size(18.dp))
                                }
                            }
                        }
                    }
                    OutlinedButton(
                        onClick = onAddProfile,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, AccentGreen)
                    ) {
                        Icon(Icons.Outlined.Add, contentDescription = null, tint = AccentGreen, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(s.addAccount, color = AccentGreen, fontWeight = FontWeight.Bold, fontSize = 13.sp, letterSpacing = 0.5.sp)
                    }
                }
            }

            Text(s.profileIntro, color = InkMuted, fontSize = 12.sp, lineHeight = 17.sp)

            Field(s.fieldNickname, nickname) { nickname = it }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.weight(1f)) { Field(s.fieldAge, age, number = true) { age = it } }
                Box(Modifier.weight(1f)) { Field(s.fieldWeight, weight, number = true) { weight = it } }
            }
            Field(s.fieldDxYears, dxYears, number = true) { dxYears = it }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.weight(2f)) { Field(s.fieldRapidName, rapidName) { rapidName = it } }
                Box(Modifier.weight(1f)) { Field(s.fieldRapidUnits, rapidUnits, number = true) { rapidUnits = it } }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.weight(2f)) { Field(s.fieldBasalName, basalName) { basalName = it } }
                Box(Modifier.weight(1f)) { Field(s.fieldBasalUnits, basalUnits, number = true) { basalUnits = it } }
            }
            Text(s.ratiosOptional, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.weight(1f)) { Field(s.fieldCarbRatio, carbRatio, number = true) { carbRatio = it } }
                Box(Modifier.weight(1f)) { Field(s.fieldCorrection, correction, number = true) { correction = it } }
            }
            Field(s.fieldTarget, target, number = true) { target = it }
            Field(s.fieldNotes, notes, singleLine = false) { notes = it }
                Spacer(Modifier.height(8.dp))
            }
            // ── RÉGLAGES — app & data settings ──
            else -> Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {

            Surface(
                color = CardWhite,
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, BorderLight),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp).fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(s.remindersLabel, color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        Text(s.remindersSub, color = InkMuted, fontSize = 11.sp)
                    }
                    Switch(
                        checked = reminders,
                        onCheckedChange = {
                            reminders = it
                            store.mealRemindersEnabled = it
                            MealReminderReceiver.apply(context, it)
                        }
                    )
                }
            }

            Surface(
                color = CardWhite,
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, BorderLight),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp).fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(s.voiceLabel, color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        Text(s.voiceSub, color = InkMuted, fontSize = 11.sp)
                    }
                    Switch(
                        checked = voiceOn,
                        onCheckedChange = {
                            voiceOn = it
                            store.voiceEnabled = it
                            onVoiceChange(it)
                        }
                    )
                }
            }

            // --- free on-device voice (cost lever) ---
            SwitchCard(s.nativeVoiceLabel, s.nativeVoiceSub, nativeVoice) {
                nativeVoice = it; store.useNativeVoice = it; onAiSettingsChange()
            }

            // --- Hosted mode (premium cloud voice + sync; ready-to-activate) ---
            SwitchCard(s.hostedTitle, s.hostedSub, hosted) {
                hosted = it; store.hostedMode = it; onAiSettingsChange()
            }

            // --- AI key (BYOK) — saved by the single button at the bottom (no separate button) ---
            Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(s.byokTitle, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                    Text(s.byokSub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
                    Field(s.byokHint, byok) { byok = it }
                    Text(s.byokHelp, color = InkDim, fontSize = 10.sp, lineHeight = 14.sp)
                }
            }

            // --- Health Connect (heart rate + steps; needs a wearable) — togglable ON/OFF ---
            Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Column(Modifier.weight(1f)) {
                            Text(s.healthUseLabel, color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                            Text(s.healthUseSub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
                        }
                        Switch(checked = healthOn, onCheckedChange = { healthOn = it; store.healthConnectEnabled = it })
                    }
                    if (healthOn) {
                        val snap = healthSnap
                        when {
                            // Health Connect app missing/disabled → explain + send the user to install it
                            // (NOT this app's own settings, which is unrelated and confused the user).
                            snap == null || !snap.available -> {
                                Text(s.healthUnavailable, color = InkDim, fontSize = 11.sp, lineHeight = 15.sp)
                                OutlinedButton(
                                    onClick = { openPlayStore(context, HEALTH_CONNECT_PKG) },
                                    modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, AccentGreen)
                                ) { Text(s.healthInstall, color = AccentGreen, fontWeight = FontWeight.Bold, fontSize = 12.sp) }
                            }
                            !snap.granted -> {
                                OutlinedButton(
                                    onClick = {
                                        // The in-app permission dialog silently does nothing on some Health
                                        // Connect versions — if it throws, open Health Connect directly so
                                        // the user can grant there instead of being stuck.
                                        try { healthLauncher.launch(health.permissions) } catch (_: Exception) { openHealthConnectSettings(context) }
                                    },
                                    modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, AccentGreen)
                                ) { Text(s.healthConnect, color = AccentGreen, fontWeight = FontWeight.Bold) }
                                // Guaranteed manual route if the dialog above doesn't appear.
                                Text(
                                    s.healthOpenApp,
                                    color = InkDim, fontSize = 11.sp, lineHeight = 15.sp,
                                    modifier = Modifier.fillMaxWidth().clickable { openHealthConnectSettings(context) }
                                )
                            }
                            else -> {
                                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                                    Text("${s.healthHr} : ${snap.avgHeartRate ?: "—"}", color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                                    Text("${s.healthSteps} : ${snap.steps ?: "—"}", color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                                }
                                // Review / REVOKE the permission inside Health Connect itself.
                                OutlinedButton(
                                    onClick = { openHealthConnectSettings(context) },
                                    modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, BorderLight)
                                ) { Text(s.healthManage, color = InkMuted, fontWeight = FontWeight.Bold, fontSize = 12.sp) }
                            }
                        }
                    }
                }
            }

            // --- Donations ---
            Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(s.donateTitle, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                    Text(s.donateSub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
                    Button(
                        onClick = { try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DONATE_URL))) } catch (_: Exception) {} },
                        colors = ButtonDefaults.buttonColors(containerColor = AccentGreen, contentColor = LightBg),
                        shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()
                    ) { Text(s.donateBtn, fontWeight = FontWeight.Bold) }
                }
            }

            // --- Clear local data (on-device history) — kept LAST, the bottom-most box ---
            Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(s.clearDataTitle, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                    Text(s.clearDataSub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
                    OutlinedButton(
                        onClick = { onClearLocalData(); clearMsg = s.clearDataDone },
                        modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, GlucoseStatus.DANGER.strong)
                    ) { Text(s.clearDataBtn, color = GlucoseStatus.DANGER.strong, fontWeight = FontWeight.Bold, fontSize = 12.sp) }
                    if (clearMsg.isNotEmpty()) Text(clearMsg, color = AccentGreen, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }

            Spacer(Modifier.height(8.dp))
            }
          }
        }

        // --- Single SAVE button, pinned to the bottom (PROFIL + RÉGLAGES only; the NOTIFS tab
        // applies its toggles immediately, so it needs no save button). ---
        // imePadding() lifts it above the soft keyboard (the app is edge-to-edge on Android 15+, so
        // the window doesn't resize on its own — without this the keyboard hides the SAVE button).
        if (profileTab != 1) Surface(color = CardWhite, shadowElevation = 12.dp, modifier = Modifier.fillMaxWidth().imePadding()) {
            Column(
                Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (message.isNotEmpty()) Text(message, color = AccentGreen, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Button(
                    onClick = saveAll,
                    enabled = !saving,
                    colors = ButtonDefaults.buttonColors(containerColor = AccentGreen, contentColor = LightBg),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().height(52.dp)
                ) {
                    if (saving) CircularProgressIndicator(Modifier.size(22.dp), color = LightBg, strokeWidth = 2.dp)
                    else Text(s.saveProfile, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
                }
            }
        }
    }

    if (toRemove != null) {
        AlertDialog(
            onDismissRequest = { toRemove = null },
            confirmButton = {
                TextButton(onClick = { onRemoveProfile(toRemove!!); toRemove = null }) {
                    Text(s.foodDelete, color = GlucoseStatus.DANGER.strong)
                }
            },
            dismissButton = {
                TextButton(onClick = { toRemove = null }) { Text(s.cancel, color = InkMuted) }
            },
            title = { Text(s.removeAccountConfirm, fontSize = 15.sp) },
            containerColor = CardWhite
        )
    }
}

/** Open an app's Play Store listing (market:// then a https:// fallback). */
private fun openPlayStore(context: Context, pkg: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {}
    }
}

/** Open Health Connect's own settings to review/revoke permissions. If the app isn't there, send
 *  the user to install it (NOT to this app's own settings, which is unrelated and confusing). */
private fun openHealthConnectSettings(context: Context) {
    try {
        context.startActivity(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {
        openPlayStore(context, HEALTH_CONNECT_PKG)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProfTab(label: String, selected: Boolean, onClick: () -> Unit) {
    Tab(selected = selected, onClick = onClick) {
        Text(
            label,
            color = if (selected) AccentGreen else InkMuted,
            fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp,
            modifier = Modifier.padding(vertical = 12.dp)
        )
    }
}

/** A tappable settings row that navigates to a sub-page (leading icon + title/sub + chevron). */
@Composable
private fun NavCard(title: String, sub: String, onClick: () -> Unit) {
    Surface(
        color = CardWhite, shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, BorderLight),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)
    ) {
        Row(
            modifier = Modifier.padding(start = 14.dp, end = 12.dp, top = 14.dp, bottom = 14.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Outlined.Notifications, contentDescription = null, tint = AccentGreen, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                Text(sub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
            }
            Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = InkMuted, modifier = Modifier.size(22.dp))
        }
    }
}

@Composable
private fun SwitchCard(label: String, sub: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp).fillMaxWidth(),
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
}

private fun trimNum(d: Double): String = if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Field(label: String, value: String, number: Boolean = false, singleLine: Boolean = true, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label, color = InkMuted, fontSize = 12.sp) },
        singleLine = singleLine,
        keyboardOptions = if (number) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
        modifier = Modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = InkPrimary, unfocusedTextColor = InkPrimary,
            focusedContainerColor = CardWhite, unfocusedContainerColor = CardWhite,
            focusedBorderColor = AccentGreen, unfocusedBorderColor = BorderLight,
            cursorColor = AccentGreen
        )
    )
}
