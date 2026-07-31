package com.drclaude.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drclaude.ai.AnalysisService
import com.drclaude.ai.MealsService
import com.drclaude.ai.ProfileService
import com.drclaude.data.CredentialsStore
import com.drclaude.data.insulinActionMinutes
import com.drclaude.data.DEFAULT_INSULIN_ACTION_MIN
import com.drclaude.data.carbsOnBoard
import com.drclaude.data.carbsStillActive
import com.drclaude.ui.theme.*
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Dedicated insulin page, written in plain language (no jargon):
 *  - "Insuline encore active" (IOB) with a one-line explanation of what it is and why,
 *  - log a rapid-insulin dose,
 *  - "Tes réglages d'insuline" — the doctor's/estimated ratios expressed in words,
 *  - "Améliorer les réglages" — the suggestion engine (autotune), and the suggestion PERSISTS
 *    (saved per patient) so it no longer vanishes on every tab switch,
 *  - the recent injections.
 * The logged doses feed the server's IOB so coach/ask never stack a correction on top of insulin
 * already on board.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsulinScreen(
    patientId: String?,
    meals: MealsService,
    ai: AnalysisService,
    profileSvc: ProfileService,
    lang: Lang,
    store: CredentialsStore,
    header: @Composable () -> Unit = {},
    onDataChanged: () -> Unit = {},
    /** Dose id to open the edit dialog on as soon as the doses are loaded — set when the user taps
     *  that dose's marker on the glucose curve. Consumed once, via [onOpenEditConsumed]. */
    openEditId: Long? = null,
    onOpenEditConsumed: () -> Unit = {},
) {
    val s = LocalStrings.current
    val bgS = bgStringsFor(lang)
    val scope = rememberCoroutineScope()
    var doses by remember { mutableStateOf<List<AnalysisService.InsulinDose>>(emptyList()) }
    var recentMeals by remember { mutableStateOf<List<AnalysisService.RecentMeal>>(emptyList()) } // for the sugar-vs-insulin tug (NB: `meals` is the MealsService param)
    var units by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    // The two insulins from the profile (rapid + slow/basal) for the add-dose dropdown, and which
    // KIND the entered name is — a basal dose must NOT count toward rapid insulin-on-board.
    var rapidName by remember { mutableStateOf("") }
    var basalName by remember { mutableStateOf("") }
    var doseKind by remember { mutableStateOf("rapid") }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf("") }
    var saveError by remember { mutableStateOf(false) } // a write failed → show it (no silent close)

    // Insulin settings (the doctor's or estimated ratios) — shown here in plain words.
    var carbRatio by remember { mutableStateOf<Int?>(null) }
    var correction by remember { mutableStateOf<Int?>(null) }
    var target by remember { mutableStateOf<Int?>(null) }
    var ratiosEstimated by remember { mutableStateOf(true) }
    var hasSettings by remember { mutableStateOf(false) }

    // "Améliorer les réglages" suggestion — persisted per patient so it survives tab switches.
    var tuning by remember { mutableStateOf(false) }
    var suggestion by remember {
        mutableStateOf(if (store.ratioSuggestionPatient == patientId) store.ratioSuggestionText else null)
    }
    // Suggested ratio NUMBERS (for the "use these settings" button) + a brief "applied" confirmation.
    var suggestionData by remember {
        mutableStateOf(
            if (store.ratioSuggestionPatient == patientId && store.ratioSuggestionCarb != null)
                AnalysisService.RatioSuggestion(store.ratioSuggestionText ?: "", store.ratioSuggestionCarb, store.ratioSuggestionCorr, null, "")
            else null
        )
    }
    var applied by remember { mutableStateOf(false) }
    var tab by remember { mutableStateOf(0) }          // 0 = INJECTIONS, 1 = RÉGLAGES
    var showAdd by remember { mutableStateOf(false) }   // add-dose fields live in a dialog now
    var doseWhen by remember { mutableStateOf<Long?>(null) } // null = now; set to backdate a forgotten dose
    var editingDose by remember { mutableStateOf<AnalysisService.InsulinDose?>(null) } // non-null = the dialog edits this dose

    LaunchedEffect(patientId) {
        // BLANK THE SETTINGS FIRST — they belong to whoever was on screen a moment ago. Each line
        // below only overwrites when the NEW profile carries that key, so a patient without stored
        // ratios kept showing the previous one's: an adult's carb ratio displayed on a child's
        // Insulin tab, next to their doses. Same defect as the Profile screen, same repair.
        rapidName = ""; basalName = ""
        carbRatio = null; correction = null; target = null
        ratiosEstimated = true; hasSettings = false
        if (patientId != null) {
            profileSvc.load(patientId)?.let { p ->
                if (!p.isNull("rapid_insulin")) { rapidName = p.optString("rapid_insulin"); if (name.isBlank()) name = rapidName }
                if (!p.isNull("basal_insulin")) basalName = p.optString("basal_insulin")
                if (!p.isNull("carb_ratio")) { carbRatio = p.optInt("carb_ratio"); hasSettings = true }
                if (!p.isNull("correction_factor")) correction = p.optInt("correction_factor")
                if (!p.isNull("target_mgdl")) target = p.optInt("target_mgdl")
                ratiosEstimated = p.optBoolean("ratios_estimated", true)
            }
            val h = ai.history(patientId, 14)
            doses = h.insulin
            recentMeals = h.meals
            suggestion = if (store.ratioSuggestionPatient == patientId) store.ratioSuggestionText else null
            suggestionData = if (store.ratioSuggestionPatient == patientId && store.ratioSuggestionCarb != null)
                AnalysisService.RatioSuggestion(store.ratioSuggestionText ?: "", store.ratioSuggestionCarb, store.ratioSuggestionCorr, null, "") else null
        }
        loading = false
    }

    // Arriving from a tap on the curve: open that dose's editor once the list is in.
    LaunchedEffect(openEditId, doses) {
        val id = openEditId ?: return@LaunchedEffect
        val d = doses.firstOrNull { it.id == id } ?: return@LaunchedEffect
        tab = 0 // the doses live on the INJECTIONS tab
        editingDose = d
        units = fmtUnits(d.units)
        name = d.name ?: ""
        doseKind = d.kind ?: "rapid"
        doseWhen = d.ts
        showAdd = true
        onOpenEditConsumed()
    }

    // Estimated insulin-on-board: linear decay over each dose's insulin-type duration (Fiasp ≈ 4 h,
    // regular ≈ 6 h) — mirrors the server's activeIob / insulinActionMinutes.
    // BASAL (slow/background, e.g. Lantus/Tresiba) is NOT correction insulin-on-board — exclude it,
    // exactly like the server's activeIob (doseGuard.ts skips kind=="basal"). Counting a 10 u Lantus
    // here overstated "insuline encore active" by ~5 u (and via an unknown name fell back to a wrong
    // 4 h decay). IOB = RAPID doses only.
    // Both figures decay with the clock, so they are recomputed on a ticker rather than frozen at
    // the moment the screen opened (they used to sit still until the screen was left and re-entered).
    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) { kotlinx.coroutines.delay(60_000); nowTick = System.currentTimeMillis() }
    }
    val iob = remember(doses, nowTick) {
        val now = nowTick
        doses.filter { it.kind != "basal" }.sumOf { d ->
            val durMin = (insulinActionMinutes(d.name) ?: DEFAULT_INSULIN_ACTION_MIN).toDouble()
            val mins = (now - d.ts) / 60000.0
            if (mins in 0.0..durMin) d.units * (1 - mins / durMin) else 0.0
        }.coerceAtLeast(0.0)
    }

    // Carbs-on-board (sugar side of the tug), now speed-aware via data/Carbs.kt: juice fades in ~2 h,
    // pasta over ~4 h — a flat 2 h window made every food decay like sugar. Meals announced for later
    // aren't digesting yet. It stays an ESTIMATE, illustrative, never a dose instruction.
    val cob = remember(recentMeals, nowTick) {
        val now = nowTick
        // A SUGAR RESCUE logged WITHOUT grams counts as ~15 g (rule of 15), so a quick "j'ai pris du
        // sucre" still registers on the 🍬 side instead of leaving the tug showing insulin only.
        val rescues = recentMeals.filter { it.ts <= now && (it.carbsG ?: 0) <= 0 && isSugarRescue(it.description) }
            .sumOf { m -> carbsStillActive(15, m.description, m.ts, now) }
        carbsOnBoard(recentMeals, now) + rescues
    }
    // Put both sides in the SAME unit (insulin-equivalents) for a fair tug-of-war: carbs ÷ ICR.
    val sugarUnits = carbRatio?.takeIf { it > 0 }?.let { cob / it } ?: 0.0

    Column(modifier = Modifier.fillMaxSize().background(LightBg)) {
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp)) { header() }
        TabRow(selectedTabIndex = tab, containerColor = LightBg, contentColor = AccentGreen) {
            Tab(selected = tab == 0, onClick = { tab = 0 }) {
                Text(s.insulinTabDoses, color = if (tab == 0) AccentGreen else InkMuted, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, modifier = Modifier.padding(vertical = 12.dp))
            }
            Tab(selected = tab == 1, onClick = { tab = 1 }) {
                Text(s.insulinTabSettings, color = if (tab == 1) AccentGreen else InkMuted, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, modifier = Modifier.padding(vertical = 12.dp))
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (tab == 0) {
                // ===== INJECTIONS : insuline active + historique des doses =====
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(s.insulinIntro, color = InkMuted, fontSize = 12.sp, lineHeight = 17.sp)
                    Surface(
                        color = AccentGreen.copy(alpha = 0.08f), shape = RoundedCornerShape(14.dp),
                        border = BorderStroke(1.dp, AccentGreen.copy(alpha = 0.4f)), modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text(s.insulinActive, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                                Text("≈ ${fmtUnits(iob)} u", color = AccentGreen, fontSize = 22.sp, fontWeight = FontWeight.Black)
                            }
                            Text(s.insulinActiveExplain, color = InkMuted, fontSize = 11.sp, lineHeight = 16.sp)
                        }
                    }
                    if (msg.isNotEmpty()) Text(msg, color = AccentGreen, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    when {
                        loading -> Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = AccentGreen, strokeWidth = 2.dp, modifier = Modifier.size(26.dp))
                        }
                        doses.isEmpty() -> Text(s.insulinEmpty, color = InkDim, fontSize = 13.sp)
                        else -> {
                            Text(s.insulinRecent, color = InkDim, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
                            doses.forEach { d ->
                                InsulinRow(d, s, bgS.dosePlanned) {
                                    editingDose = d; units = fmtUnits(d.units); name = d.name ?: ""
                                    doseKind = d.kind ?: "rapid"; doseWhen = d.ts; showAdd = true
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
            } else {
                // ===== RÉGLAGES : visuel ratio + réglages + amélioration =====
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    SugarVsInsulinTug(iob, sugarUnits, cob.toInt(), carbRatio, correction, target, ratiosEstimated, hasSettings, s)
                    Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(s.autotuneTitle, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                            Text(s.autotuneSub, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)
                            OutlinedButton(
                                onClick = {
                                    tuning = true
                                    scope.launch {
                                        val r = ai.autotune(patientId, lang.code.lowercase())
                                        if (r != null && r.message.isNotBlank()) {
                                            suggestion = r.message
                                            suggestionData = r
                                            applied = false
                                            store.ratioSuggestionText = r.message
                                            store.ratioSuggestionPatient = patientId
                                            store.ratioSuggestionCarb = r.carbRatio
                                            store.ratioSuggestionCorr = r.correctionFactor
                                        }
                                        tuning = false
                                    }
                                },
                                enabled = !tuning && patientId != null,
                                modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, AccentGreen)
                            ) {
                                if (tuning) CircularProgressIndicator(Modifier.size(18.dp), color = AccentGreen, strokeWidth = 2.dp)
                                else Text(s.autotuneBtn, color = AccentGreen, fontWeight = FontWeight.Bold)
                            }
                            suggestion?.let {
                                Surface(color = AccentGreen.copy(alpha = 0.06f), shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                                    Text(it, color = InkPrimary, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.padding(12.dp))
                                }
                            }
                            val sd = suggestionData
                            val pid = patientId
                            // Offer to apply ONLY when the proposal differs from the active ratio.
                            if (sd?.carbRatio != null && pid != null && sd.carbRatio != carbRatio) {
                                carbRatio?.let { cur ->
                                    Text(
                                        String.format(s.ratioCurrentVsProposed, cur, sd.carbRatio),
                                        color = InkPrimary, fontSize = 12.sp, fontWeight = FontWeight.Bold, lineHeight = 17.sp
                                    )
                                }
                                Button(
                                    onClick = {
                                        scope.launch {
                                            val fields = JSONObject().apply {
                                                put("carb_ratio", sd.carbRatio)
                                                sd.correctionFactor?.let { put("correction_factor", it) }
                                                target?.let { put("target_mgdl", it) }
                                                put("lang", lang.code.lowercase())
                                            }
                                            val res = profileSvc.save(pid, fields)
                                            if (res.error == null) {
                                                carbRatio = sd.carbRatio
                                                sd.correctionFactor?.let { correction = it }
                                                hasSettings = true
                                                ratiosEstimated = false
                                                applied = true
                                            }
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = AccentGreen, contentColor = LightBg),
                                    shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()
                                ) { Text(s.autotuneApply, fontWeight = FontWeight.Bold) }
                                if (applied) Text(s.ratioApplied, color = GlucoseStatus.GOOD.strong2, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
            }
        }

        // Pinned "add a dose" — fields appear in a dialog (only relevant on the INJECTIONS tab).
        if (tab == 0) {
            Surface(color = CardWhite, shadowElevation = 12.dp, modifier = Modifier.fillMaxWidth()) {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Button(
                        onClick = { showAdd = true },
                        enabled = patientId != null,
                        colors = ButtonDefaults.buttonColors(containerColor = AccentGreen, contentColor = LightBg),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth().height(50.dp)
                    ) { Text(s.foodAdd, fontWeight = FontWeight.Black, letterSpacing = 1.sp) }
                }
            }
        }
    }

    // Add-dose dialog: fields hidden until AJOUTER is tapped, then saved here.
    if (showAdd) {
        AlertDialog(
            onDismissRequest = { if (!busy) { showAdd = false; editingDose = null; saveError = false } },
            title = { Text(if (editingDose != null) s.editTitle else s.insulinAddTitle, color = InkPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (saveError) Text(s.saveFailed, color = GlucoseStatus.DANGER.strong, fontSize = 12.sp, fontWeight = FontWeight.Bold, lineHeight = 16.sp)
                    OutlinedTextField(
                        value = units, onValueChange = { units = it },
                        label = { Text(s.insulinUnitsHint, color = InkMuted, fontSize = 12.sp) },
                        singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(), colors = insColors()
                    )
                    InsulinNameField(
                        name = name, rapidName = rapidName, basalName = basalName,
                        onNameChange = { name = it; doseKind = "rapid" },
                        onPick = { n, k -> name = n; doseKind = k },
                        s = s
                    )
                    // allowFuture: a dose you're GOING to take can be logged ahead (e.g. "ce soir
                    // 19 h") — it stays out of insulin-on-board until its time arrives.
                    WhenPicker(
                        doseWhen, { doseWhen = it }, AccentGreen,
                        allowFuture = true, tomorrowLabel = bgS.whenTomorrow,
                        showSteppers = true,
                    )
                    // When editing an existing dose, allow deleting it from here.
                    editingDose?.let { ed ->
                        TextButton(onClick = {
                            if (patientId == null || busy) return@TextButton
                            busy = true; msg = ""; saveError = false
                            scope.launch {
                                val okDel = meals.deleteInsulin(patientId, ed.id)
                                if (okDel) {
                                    doses = ai.history(patientId, 14).insulin
                                    onDataChanged()
                                    editingDose = null; showAdd = false
                                } else saveError = true
                                busy = false
                            }
                        }) { Text(s.deleteEntry, color = GlucoseStatus.DANGER.strong, fontWeight = FontWeight.Bold) }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !busy && units.replace(',', '.').toDoubleOrNull()?.let { it > 0 } == true,
                    onClick = {
                        val u = units.replace(',', '.').toDoubleOrNull()
                        if (patientId == null || u == null || u <= 0 || busy) return@TextButton
                        busy = true; msg = ""; saveError = false
                        scope.launch {
                            val ed = editingDose
                            // Editing: "Maintenant" (doseWhen == null) means NOW — sending null omits
                            // the field, so the server would keep the dose's original time.
                            val editTs = doseWhen ?: System.currentTimeMillis()
                            val ok = if (ed != null) meals.updateInsulin(patientId, ed.id, u, name.trim().ifBlank { null }, doseKind, tsMs = editTs)
                                     else meals.addInsulin(patientId, u, name.trim().ifBlank { null }, doseKind, tsMs = doseWhen)
                            if (ok) {
                                msg = s.insulinLogged; units = ""; doseWhen = null; editingDose = null
                                doses = ai.history(patientId, 14).insulin
                                onDataChanged() // refresh home IOB so a HIGH alarm stops once covered
                                showAdd = false
                            } else saveError = true // keep the dialog open so the dose isn't lost silently
                            busy = false
                        }
                    }
                ) { Text(if (editingDose != null) s.editSave else s.foodAdd, color = AccentGreen, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { if (!busy) { showAdd = false; editingDose = null; saveError = false } }) { Text(s.cancel, color = InkMuted) } },
            containerColor = CardWhite
        )
    }
}

/** True when a meal description looks like a fast-sugar hypo rescue, so a rescue logged WITHOUT a
 *  carb count still registers on the tug's sugar side (assumed ~15 g, the rule of 15). */
private fun isSugarRescue(desc: String?): Boolean {
    val d = (desc ?: "").lowercase()
    return listOf("sucre", "azúcar", "azucar", "sugar", "morceau", "terrón", "terron", "jus", "zumo",
        "soda", "coca", "glucose", "resucr", "miel", "bonbon", "candy").any { d.contains(it) }
}

/** Playful tug-of-war: insulin-on-board (pulls glucose DOWN, green 💉) vs carbs-on-board (pulls UP,
 *  red 🍬), both expressed in insulin-equivalent units so it's a fair fight. The knot animates toward
 *  whoever is winning → a fun, at-a-glance hint of where the glucose is likely heading. It is a
 *  VISUAL ESTIMATE (carbs-on-board is approximate) — never a dose instruction (the disclaimer says so). */
@Composable
private fun SugarVsInsulinTug(
    iobUnits: Double, sugarUnits: Double, cobGrams: Int,
    carbRatio: Int?, correction: Int?, target: Int?, ratiosEstimated: Boolean, hasSettings: Boolean,
    s: Strings,
) {
    val total = iobUnits + sugarUnits
    val active = total > 0.05
    // Fill/knot fraction = the SUGAR share (the LEFT, red bar). A near-all-red bar therefore means
    // sugar leads — which must agree with the verdict. It used to be the INSULIN fraction, so a
    // sugar-dominated state filled the bar RED yet the text said "insulin leads" (the reported bug).
    val targetPos = if (!active) 0.5f else (sugarUnits / total).toFloat()
    val knot by animateFloatAsState(
        targetValue = targetPos.coerceIn(0.1f, 0.9f),
        animationSpec = tween(900), label = "tug"
    )
    val sugarWins = active && sugarUnits > iobUnits * 1.15
    val insulinWins = active && iobUnits > sugarUnits * 1.15
    val verdict = when {
        !active -> s.tugNeutral
        sugarWins -> s.tugSugarWins
        insulinWins -> s.tugInsulinWins
        else -> s.tugTie
    }
    val verdictColor = when {
        !active -> InkMuted
        sugarWins -> GlucoseStatus.DANGER.strong
        insulinWins -> AccentGreen
        else -> InkPrimary
    }
    Surface(color = CardWhite, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(s.tugTitle, color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("🍬 ≈ $cobGrams g", color = GlucoseStatus.DANGER.strong2, fontSize = 13.sp, fontWeight = FontWeight.Black)
                Text("≈ ${fmtUnits(iobUnits)} u 💉", color = AccentGreen, fontSize = 13.sp, fontWeight = FontWeight.Black)
            }
            BoxWithConstraints(Modifier.fillMaxWidth().height(34.dp)) {
                val w = maxWidth
                Box(Modifier.fillMaxSize().clip(RoundedCornerShape(17.dp)).background(LightBg)) {
                    Box(Modifier.fillMaxHeight().width(w * knot).align(Alignment.CenterStart).background(GlucoseStatus.DANGER.strong.copy(alpha = 0.85f)))
                    Box(Modifier.fillMaxHeight().width(w * (1f - knot)).align(Alignment.CenterEnd).background(AccentGreen.copy(alpha = 0.9f)))
                }
                Surface(
                    shape = CircleShape, color = CardWhite, shadowElevation = 4.dp,
                    border = BorderStroke(2.dp, if (sugarWins) GlucoseStatus.DANGER.strong else if (insulinWins) AccentGreen else InkDim),
                    modifier = Modifier.size(32.dp).offset(x = w * knot - 16.dp).align(Alignment.CenterStart)
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(if (sugarWins) "🍬" else if (insulinWins) "💉" else "🤝", fontSize = 15.sp)
                    }
                }
            }
            Text(verdict, color = verdictColor, fontSize = 13.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            // What to DO about it — a forward-looking, non-prescriptive nudge (never a dose).
            val tugAction = when {
                !active -> ""
                sugarWins -> s.tugActionSugar
                insulinWins -> s.tugActionInsulin
                else -> s.tugActionTie
            }
            if (tugAction.isNotEmpty()) Text(tugAction, color = InkPrimary, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Text(s.tugDisclaimer, color = InkDim, fontSize = 10.sp, lineHeight = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            // Combined in the SAME box: the carb-ratio visual, on the SAME sides as the tug above
            // (🍬 sugar LEFT, 💉 insulin RIGHT) so the two columns line up.
            if (carbRatio != null) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(BorderLight))
                val cubes = Math.max(1, Math.round(carbRatio / 4.0).toInt())
                Text(s.ratioVisualTitle, color = InkMuted, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    RatioCard("🍬", String.format(s.ratioVisualCubes, cubes), String.format(s.ratioVisualGrams, carbRatio), Modifier.weight(1f))
                    Text("=", color = AccentGreen, fontSize = 30.sp, fontWeight = FontWeight.Black)
                    RatioCard("💉", s.ratioVisualUnit, "", Modifier.weight(1f))
                }
            }
            // ===== TES RÉGLAGES — merged into this card so everything (force/équivalences/réglages) is together =====
            Box(Modifier.fillMaxWidth().height(1.dp).background(BorderLight))
            Text(s.insulinSettingsTitle, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
            if (!hasSettings || carbRatio == null) {
                Text(s.insulinSettingsNone, color = InkMuted, fontSize = 12.sp, lineHeight = 17.sp)
            } else {
                Text(if (ratiosEstimated) s.ratiosEstimated else s.ratiosDoctor, color = InkDim, fontSize = 11.sp, lineHeight = 15.sp)
                val crCubes = Math.max(1, Math.round(carbRatio / 4.0).toInt())
                SettingLine(String.format(s.insulinSettingsCarb, carbRatio, crCubes))
                correction?.let { SettingLine(String.format(s.insulinSettingsCorr, it)) }
                target?.let { SettingLine(String.format(s.insulinSettingsTarget, it)) }
            }
        }
    }
}

@Composable
private fun RatioCard(emoji: String, big: String, sub: String, modifier: Modifier) {
    Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = modifier) {
        Column(
            Modifier.padding(vertical = 16.dp, horizontal = 8.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Text(emoji, fontSize = 32.sp)
            Text(big, color = InkPrimary, fontSize = 17.sp, fontWeight = FontWeight.Black, textAlign = TextAlign.Center, lineHeight = 20.sp)
            if (sub.isNotEmpty()) Text(sub, color = InkMuted, fontSize = 11.sp, textAlign = TextAlign.Center, lineHeight = 14.sp)
        }
    }
}

@Composable
private fun SettingLine(text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Text("•  ", color = AccentGreen, fontSize = 13.sp, fontWeight = FontWeight.Black)
        Text(text, color = InkPrimary, fontSize = 13.sp, lineHeight = 18.sp)
    }
}

// Same visual style as the meal rows (bold primary line + muted sub-line + a right-side tag) so the
// two history lists feel consistent.
@Composable
private fun InsulinRow(d: AnalysisService.InsulinDose, s: Strings, plannedTag: String = "", onEdit: () -> Unit) {
    val fmt = remember { SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()) }
    val isBasal = d.kind == "basal"
    // A future-dated dose is PLANNED (not yet injected — excluded from insulin-on-board): tag it.
    val isFuture = d.ts > System.currentTimeMillis()
    Surface(
        color = CardWhite, shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 6.dp, bottom = 6.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f).clickable(onClick = onEdit)) {
                Text(
                    "${fmtUnits(d.units)} u" + if (!d.name.isNullOrBlank()) " ${d.name}" else "",
                    color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold
                )
                Text(
                    (if (isFuture && plannedTag.isNotBlank()) "$plannedTag · " else "") + fmt.format(Date(d.ts)),
                    color = if (isFuture) AccentGreen else InkDim, fontSize = 11.sp,
                    fontWeight = if (isFuture) FontWeight.Bold else FontWeight.Normal
                )
            }
            Surface(
                color = (if (isBasal) InkMuted else AccentGreen).copy(alpha = 0.15f),
                shape = RoundedCornerShape(8.dp)
            ) {
                Text(
                    if (isBasal) s.insulinSlowTag else s.insulinRapidTag,
                    color = if (isBasal) InkMuted else AccentGreen,
                    fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                )
            }
        }
    }
}

private fun fmtUnits(u: Double): String {
    val r = Math.round(u * 10.0) / 10.0
    return if (r == r.toLong().toDouble()) r.toLong().toString() else r.toString().replace('.', ',')
}

/** Insulin name picker: a dropdown of the profile's rapid + slow insulins (e.g. "Rapide · Fiasp" /
 *  "Lente · Tresiba") so the user switches in one tap; picking also tags the dose kind (basal is
 *  excluded from insulin-on-board). Falls back to a plain text field when the profile has no names. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InsulinNameField(
    name: String,
    rapidName: String,
    basalName: String,
    onNameChange: (String) -> Unit,
    onPick: (String, String) -> Unit,
    s: Strings
) {
    val options = buildList {
        if (rapidName.isNotBlank()) add(Triple(rapidName, "rapid", s.insulinRapidTag))
        if (basalName.isNotBlank()) add(Triple(basalName, "basal", s.insulinSlowTag))
    }
    if (options.isEmpty()) {
        OutlinedTextField(
            value = name, onValueChange = onNameChange,
            label = { Text(s.insulinNameHint, color = InkMuted, fontSize = 12.sp) },
            singleLine = true, modifier = Modifier.fillMaxWidth(), colors = insColors()
        )
        return
    }
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = name, onValueChange = {}, readOnly = true,
            label = { Text(s.insulinNameHint, color = InkMuted, fontSize = 12.sp) },
            singleLine = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor().fillMaxWidth(), colors = insColors()
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (nm, kind, tag) ->
                DropdownMenuItem(
                    text = { Text("$tag · $nm", color = InkPrimary, fontSize = 14.sp) },
                    onClick = { onPick(nm, kind); expanded = false }
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun insColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = InkPrimary, unfocusedTextColor = InkPrimary,
    focusedContainerColor = CardWhite, unfocusedContainerColor = CardWhite,
    focusedBorderColor = AccentGreen, unfocusedBorderColor = BorderLight,
    cursorColor = AccentGreen
)
