package com.nueve.mechabetics.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.nueve.mechabetics.ai.AnalysisService
import com.nueve.mechabetics.ai.MealsService
import com.nueve.mechabetics.data.GlucoseReading
import com.nueve.mechabetics.ui.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FoodScreen(
    patientId: String?,
    service: MealsService,
    ai: AnalysisService,
    lang: Lang,
    history: List<GlucoseReading>,
    header: @Composable () -> Unit = {},
    onDataChanged: () -> Unit = {}
) {
    val s = LocalStrings.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var meals by remember { mutableStateOf<List<MealsService.Meal>>(emptyList()) }
    var desc by remember { mutableStateOf("") }
    var carbs by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf(false) } // a write failed → show it (no silent close)
    var scanning by remember { mutableStateOf(false) }
    var scanResult by remember { mutableStateOf("") }
    var showCamera by remember { mutableStateOf(false) }
    var showAdd by remember { mutableStateOf(false) }   // manual-entry fields live in a dialog now
    var mealWhen by remember { mutableStateOf<Long?>(null) } // null = now; set to backdate a forgotten meal
    var editingMeal by remember { mutableStateOf<MealsService.Meal?>(null) } // non-null = the dialog edits this row
    var qty by remember { mutableStateOf("1") } // quantity multiplier (ate the same item N times)
    var foodTab by remember { mutableStateOf(0) } // 0 = REPAS & SUCRES (log), 1 = DIÉTÉTIQUE (analysis)

    LaunchedEffect(patientId) {
        if (patientId != null) meals = service.list(patientId)
        loading = false
    }

    // Capture handler for the in-app camera: downscale the photo + send it to the scan function.
    val runScan: (File) -> Unit = { file ->
        showCamera = false
        if (patientId != null) {
            scanning = true; scanResult = ""
            scope.launch {
                val bytes = withContext(Dispatchers.IO) { processImage(file) }
                if (bytes == null || bytes.isEmpty()) {
                    scanResult = s.foodScanFail; scanning = false
                } else {
                    val r = ai.scan(bytes, patientId, lang.code.lowercase(), history)
                    scanResult = r.text
                    meals = service.list(patientId)
                    scanning = false
                }
                runCatching { file.delete() }
            }
        }
    }

    // Reliable fallback to the (sometimes flaky) in-app camera: the Android photo picker needs NO
    // permission and works on every device — take the photo with the normal camera, then pick it.
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null && patientId != null) {
            scanning = true; scanResult = ""
            scope.launch {
                val bytes = withContext(Dispatchers.IO) { processUri(context, uri) }
                if (bytes == null || bytes.isEmpty()) {
                    scanResult = s.foodScanFail; scanning = false
                } else {
                    val r = ai.scan(bytes, patientId, lang.code.lowercase(), history)
                    scanResult = r.text
                    meals = service.list(patientId)
                    scanning = false
                }
            }
        }
    }

    if (showCamera) {
        CameraCapture(
            lang = lang,
            onCancel = { showCamera = false },
            onCaptured = runScan,
            // Gallery pick now lives as a discreet icon inside the camera: close it, open the picker.
            onPickGallery = { showCamera = false; pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
        )
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().background(LightBg).padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        header()

        // Two tabs: REPAS & SUCRES (log + scan meals) | DIÉTÉTIQUE (the AI food analysis).
        val es = lang == Lang.ES
        TabRow(selectedTabIndex = foodTab, containerColor = LightBg, contentColor = AccentGreen) {
            Tab(selected = foodTab == 0, onClick = { foodTab = 0 }) {
                Text(if (es) "COMIDAS Y AZÚCAR" else "REPAS & SUCRES",
                    color = if (foodTab == 0) AccentGreen else InkMuted, fontSize = 12.sp,
                    fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp, modifier = Modifier.padding(vertical = 12.dp))
            }
            Tab(selected = foodTab == 1, onClick = { foodTab = 1 }) {
                Text(if (es) "DIETÉTICA" else "DIÉTÉTIQUE",
                    color = if (foodTab == 1) AccentGreen else InkMuted, fontSize = 12.sp,
                    fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp, modifier = Modifier.padding(vertical = 12.dp))
            }
        }

        if (foodTab == 1) {
            DietetiqueTab(patientId, ai, lang, Modifier.weight(1f))
        } else {
        if (scanning) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(color = AccentGreen, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                Text(s.foodScanning, color = InkMuted, fontSize = 13.sp)
            }
        }
        if (scanResult.isNotEmpty()) {
            Surface(
                color = CardWhite, shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, AccentGreen.copy(alpha = 0.4f)), modifier = Modifier.fillMaxWidth()
            ) {
                Text(scanResult, color = InkPrimary, fontSize = 14.sp, lineHeight = 20.sp, modifier = Modifier.padding(14.dp))
            }
            DoseDisclaimer()
        }

        // Meal list takes the remaining space; the action buttons stay pinned below it.
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = AccentGreen, strokeWidth = 2.dp, modifier = Modifier.size(26.dp))
                }
                meals.isEmpty() -> Text(s.foodEmpty, color = InkDim, fontSize = 13.sp)
                else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(meals, key = { it.id }) { m ->
                        MealRow(m, s, lang,
                            onEdit = {
                                editingMeal = m; desc = m.description
                                qty = m.quantity.coerceAtLeast(1).toString()
                                // Show carbs PER UNIT (stored carbs_g is the total = per-unit × quantity).
                                carbs = m.carbsG?.let { (it / m.quantity.coerceAtLeast(1)).toString() } ?: ""
                                mealWhen = tsToMs(m.ts); showAdd = true
                            })
                    }
                }
            }
        }

        Text(s.foodVoiceHint, color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp)

        // Pinned bottom row: 2 ways to add — manual (opens the form) or camera scan. The gallery
        // pick now lives as a small icon INSIDE the camera screen, so this row is less cluttered.
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { if (patientId != null) { editingMeal = null; desc = ""; carbs = ""; qty = "1"; mealWhen = null; saveError = false; showAdd = true } },
                enabled = patientId != null,
                colors = ButtonDefaults.buttonColors(containerColor = AccentGreen, contentColor = LightBg),
                shape = RoundedCornerShape(12.dp), contentPadding = PaddingValues(horizontal = 4.dp),
                modifier = Modifier.weight(1f).height(48.dp)
            ) { Text(s.foodAdd, fontWeight = FontWeight.Black, fontSize = 13.sp, maxLines = 1) }

            OutlinedButton(
                onClick = { if (patientId != null && !scanning) showCamera = true },
                enabled = !scanning && patientId != null,
                border = BorderStroke(1.dp, AccentGreen), shape = RoundedCornerShape(12.dp),
                contentPadding = PaddingValues(horizontal = 4.dp),
                modifier = Modifier.weight(1f).height(48.dp)
            ) { Text(s.foodScanShort, color = AccentGreen, fontWeight = FontWeight.Black, fontSize = 13.sp, maxLines = 1) }
        }
        }
    }

    // Manual add: the fields are hidden until the user taps AJOUTER, then saved here.
    if (showAdd) {
        AlertDialog(
            onDismissRequest = { if (!busy) { showAdd = false; editingMeal = null; saveError = false } },
            title = { Text(if (editingMeal != null) s.editTitle else s.foodAddTitle, color = InkPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (saveError) Text(s.saveFailed, color = GlucoseStatus.DANGER.strong, fontSize = 12.sp, fontWeight = FontWeight.Bold, lineHeight = 16.sp)
                    OutlinedTextField(
                        value = desc, onValueChange = { desc = it },
                        label = { Text(s.foodDescHint, color = InkMuted, fontSize = 12.sp) },
                        singleLine = true, modifier = Modifier.fillMaxWidth(), colors = fdColors()
                    )
                    OutlinedTextField(
                        value = carbs, onValueChange = { carbs = it },
                        label = { Text(s.foodCarbsHint, color = InkMuted, fontSize = 12.sp) },
                        singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(), colors = fdColors()
                    )
                    // Quantity multiplier — log "ate it 3×" without re-scanning/re-typing.
                    OutlinedTextField(
                        value = qty, onValueChange = { qty = it.filter { c -> c.isDigit() }.take(2) },
                        label = { Text(s.foodQtyHint, color = InkMuted, fontSize = 12.sp) },
                        singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(), colors = fdColors()
                    )
                    val perU = carbs.toIntOrNull(); val q = qty.toIntOrNull() ?: 1
                    if (perU != null && q > 1) {
                        Text(String.format(s.foodQtyTotal, perU * q), color = AccentGreen, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                    WhenPicker(mealWhen, { mealWhen = it }, AccentGreen)
                    // Editing an existing meal → delete it from here (no separate trash icon / confirm),
                    // mirroring how the insulin-dose dialog handles deletion.
                    editingMeal?.let { em ->
                        TextButton(onClick = {
                            if (patientId == null || busy) return@TextButton
                            busy = true; saveError = false
                            scope.launch {
                                val okDel = service.delete(patientId, em.id)
                                if (okDel) {
                                    meals = service.list(patientId)
                                    onDataChanged()
                                    desc = ""; carbs = ""; qty = "1"; mealWhen = null; editingMeal = null; showAdd = false
                                } else saveError = true
                                busy = false
                            }
                        }) { Text(s.deleteEntry, color = GlucoseStatus.DANGER.strong, fontWeight = FontWeight.Bold) }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !busy && desc.isNotBlank(),
                    onClick = {
                        if (patientId == null || desc.isBlank() || busy) return@TextButton
                        busy = true; saveError = false
                        scope.launch {
                            val em = editingMeal
                            val qn = qty.toIntOrNull()?.coerceIn(1, 50) ?: 1
                            val ok = if (em != null) service.update(patientId, em.id, desc.trim(), carbs.toIntOrNull(), tsMs = mealWhen, quantity = qn)
                                     else service.add(patientId, desc.trim(), carbs.toIntOrNull(), false, tsMs = mealWhen, quantity = qn)
                            if (ok) {
                                desc = ""; carbs = ""; qty = "1"; mealWhen = null; editingMeal = null
                                meals = service.list(patientId)
                                onDataChanged() // refresh home IOB/markers (so a HIGH alarm re-evaluates)
                                showAdd = false
                            } else saveError = true // keep the dialog open so the meal isn't lost silently
                            busy = false
                        }
                    }
                ) { Text(if (editingMeal != null) s.editSave else s.foodAdd, color = AccentGreen, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { if (!busy) { showAdd = false; editingMeal = null; saveError = false } }) { Text(s.cancel, color = InkMuted) } },
            containerColor = CardWhite
        )
    }

}

@Composable
private fun MealRow(m: MealsService.Meal, s: Strings, lang: Lang, onEdit: () -> Unit) {
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
                    m.description + if (m.quantity > 1) "  ×${m.quantity}" else "",
                    color = InkPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold
                )
                val sub = buildString {
                    if (m.carbsG != null) {
                        // Make grams tangible with the sugar-cube equivalent (~4 g each).
                        val cubes = Math.max(1, Math.round(m.carbsG / 4.0).toInt())
                        val word = if (lang == Lang.ES) "terrón(es)" else "sucre(s)"
                        append("~${m.carbsG} g (≈ $cubes $word)")
                    }
                    val t = shortTime(m.ts)
                    if (t.isNotEmpty()) { if (isNotEmpty()) append("   ·   "); append(t) }
                }
                if (sub.isNotEmpty()) Text(sub, color = InkDim, fontSize = 11.sp)
            }
            Surface(
                color = (if (m.planned) AccentGreen else GlucoseStatus.GOOD.strong).copy(alpha = 0.15f),
                shape = RoundedCornerShape(8.dp)
            ) {
                Text(
                    if (m.planned) s.foodPlanned else s.foodEaten,
                    color = if (m.planned) AccentGreen else GlucoseStatus.GOOD.strong2,
                    fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                )
            }
        }
    }
}

/** Meal `ts` comes from Postgres in UTC (ISO). Parse the first 19 chars as UTC and render in the
 *  device's local time — otherwise it reads ~2 h behind for a CEST user (the raw UTC clock). */
/** The meal's stored ISO ts (UTC) as epoch ms — to prefill the "Quand ?" picker when editing. */
private fun tsToMs(ts: String): Long? = try {
    val core = ts.trim().take(19).replace('T', ' ')
    SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(core)?.time
} catch (e: Exception) { null }

private fun shortTime(ts: String): String = try {
    val core = ts.trim().take(19).replace('T', ' ')            // "2026-06-06 18:30:00"
    val parser = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()).format(parser.parse(core)!!)
} catch (e: Exception) {
    if (ts.length >= 16) ts.substring(0, 16).replace('T', ' ') else ts
}

/** Decode the captured photo, fix EXIF rotation, downscale to ~1280px, JPEG-compress. */
private fun processImage(file: File): ByteArray? {
    return try {
        val maxDim = 1280
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        var sample = 1
        while (bounds.outWidth / sample > maxDim * 2 || bounds.outHeight / sample > maxDim * 2) sample *= 2
        var bmp = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        val scale = maxDim.toFloat() / maxOf(bmp.width, bmp.height)
        if (scale < 1f) bmp = Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true)
        val deg = when (ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        if (deg != 0f) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(deg) }, true)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
        out.toByteArray()
    } catch (e: Exception) {
        null
    }
}

/** Decode a gallery-picked image (content Uri), downscale to ~1280px, JPEG-compress for the scan. */
private fun processUri(context: Context, uri: Uri): ByteArray? {
    return try {
        val bmp0 = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return null
        var bmp = bmp0
        val maxDim = 1280
        val scale = maxDim.toFloat() / maxOf(bmp.width, bmp.height)
        if (scale < 1f) bmp = Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
        out.toByteArray()
    } catch (e: Exception) {
        null
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun fdColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = InkPrimary, unfocusedTextColor = InkPrimary,
    focusedContainerColor = CardWhite, unfocusedContainerColor = CardWhite,
    focusedBorderColor = AccentGreen, unfocusedBorderColor = BorderLight,
    cursorColor = AccentGreen
)

// ───────────────────────── DIÉTÉTIQUE tab — the AI food analysis ─────────────────────────────────
// Code-owned DATA (from mechabetics-diet) in clean stat cards + the LLM's summary / alerts / good
// points / tip as compact cards. Minimalist, on-brand (green), visual — never a wall of text.

private fun spikeColor(spike: Int) = when {
    spike >= 80 -> GlucoseStatus.DANGER.strong
    spike >= 50 -> GlucoseStatus.WARNING.strong
    else -> GlucoseStatus.GOOD.strong
}

@Composable
private fun DietetiqueTab(patientId: String?, ai: AnalysisService, lang: Lang, modifier: Modifier = Modifier) {
    val es = lang == Lang.ES
    val scope = rememberCoroutineScope()
    var result by remember(patientId) { mutableStateOf<AnalysisService.DietResult?>(null) }
    var loading by remember(patientId) { mutableStateOf(false) }

    fun load() {
        if (patientId == null || loading) return
        loading = true
        scope.launch {
            result = ai.diet(patientId, lang.code.lowercase(), 7)
            loading = false
        }
    }
    // Auto-load on first show; re-fetch on a language switch (the server returns localized prose).
    LaunchedEffect(patientId, lang) { if (patientId != null) load() }

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (es) "Tu alimentación · 7 días" else "Ton alimentation · 7 jours",
                color = InkPrimary, fontSize = 15.sp, fontWeight = FontWeight.Black, modifier = Modifier.weight(1f)
            )
            Surface(
                color = CardWhite, shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, BorderLight),
                modifier = Modifier.size(38.dp).clickable { if (!loading) load() }
            ) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (loading) CircularProgressIndicator(Modifier.size(16.dp), color = AccentGreen, strokeWidth = 2.dp)
                    else Icon(Icons.Filled.Refresh, contentDescription = null, tint = InkPrimary, modifier = Modifier.size(18.dp))
                }
            }
        }

        val r = result
        when {
            loading && r == null -> Row(Modifier.padding(top = 24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(20.dp), color = AccentGreen, strokeWidth = 2.dp)
                Text(if (es) "Analizando la alimentación…" else "Analyse de l'alimentation…", color = InkMuted, fontSize = 13.sp)
            }
            r == null -> Text(if (es) "Toca actualizar." else "Touche pour actualiser.", color = InkDim, fontSize = 13.sp)
            !r.enough -> DietCard(r.summary, AccentGreen)
            else -> {
                // Top stat row — the headline numbers.
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    DietStat(if (es) "COMIDAS" else "REPAS", "${r.mealsCount}", InkPrimary, Modifier.weight(1f))
                    DietStat(if (es) "CARBS/DÍA" else "GLUCIDES/J", "${r.avgCarbsPerDay} g", AccentGreen, Modifier.weight(1f))
                    DietStat(if (es) "PICO MEDIO" else "PIC MOYEN", "+${r.avgSpike}", spikeColor(r.avgSpike), Modifier.weight(1f))
                }
                if (r.fast + r.slow + r.fatty + r.normal > 0) DietSpeedRow(r, es)
                if (r.summary.isNotBlank()) DietCard(r.summary, AccentGreen)
                if (r.alerts.isNotEmpty()) DietList(if (es) "A VIGILAR" else "À SURVEILLER", r.alerts, GlucoseStatus.DANGER.strong)
                if (r.goodPoints.isNotEmpty()) DietList(if (es) "PUNTOS FUERTES" else "POINTS FORTS", r.goodPoints, GlucoseStatus.GOOD.strong)
                if (r.topSpikers.isNotEmpty()) DietTopFoods(if (es) "LO QUE MÁS SUBE" else "CE QUI FAIT LE PLUS MONTER", r.topSpikers, es)
                if (r.tip.isNotBlank()) DietTip(if (es) "CONSEJO" else "CONSEIL", r.tip)
                if (r.isError) Text(
                    if (es) "(análisis parcial: IA no disponible; los datos siguen siendo válidos)" else "(analyse partielle : IA indisponible ; les données restent valables)",
                    color = InkDim, fontSize = 10.sp
                )
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

@Composable
private fun DietStat(label: String, value: String, color: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    Surface(modifier = modifier, color = CardWhite, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, BorderLight)) {
        Column(Modifier.padding(vertical = 10.dp, horizontal = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, color = InkDim, fontSize = 8.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp, maxLines = 1)
            Spacer(Modifier.height(3.dp))
            Text(value, color = color, fontSize = 18.sp, fontWeight = FontWeight.Black, maxLines = 1)
        }
    }
}

/** Fast / slow / fatty / normal meal mix, as labelled colour-dot chips. */
@Composable
private fun DietSpeedRow(r: AnalysisService.DietResult, es: Boolean) {
    val items = listOf(
        Triple(if (es) "Rápidas" else "Rapides", r.fast, GlucoseStatus.DANGER.strong),
        Triple(if (es) "Lentas" else "Lents", r.slow, GlucoseStatus.GOOD.strong),
        Triple(if (es) "Grasas" else "Gras", r.fatty, GlucoseStatus.WARNING.strong),
        Triple(if (es) "Normales" else "Normaux", r.normal, InkDim),
    ).filter { it.second > 0 }
    Surface(color = CardWhite, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            for ((label, n, c) in items) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(Modifier.size(8.dp).background(c, RoundedCornerShape(4.dp)))
                    Text("$label $n", color = InkPrimary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun DietCard(text: String, accent: androidx.compose.ui.graphics.Color) {
    Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, accent.copy(alpha = 0.35f)), modifier = Modifier.fillMaxWidth()) {
        Text(text, color = InkPrimary, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.padding(14.dp))
    }
}

/** A titled list (alerts / good points) — each line led by a colour dot. */
@Composable
private fun DietList(title: String, items: List<String>, accent: androidx.compose.ui.graphics.Color) {
    Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, color = accent, fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 1.5.sp)
            for (it in items) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.padding(top = 5.dp).size(7.dp).background(accent, RoundedCornerShape(4.dp)))
                    Text(it, color = InkPrimary, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

/** The foods that raised glucose the most — desc on the left, the +mg/dL rise on the right. */
@Composable
private fun DietTopFoods(title: String, foods: List<AnalysisService.DietFood>, es: Boolean) {
    Surface(color = CardWhite, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, BorderLight), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, color = InkDim, fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 1.5.sp)
            for (f in foods) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(f.desc.ifBlank { if (es) "Comida" else "Repas" }, color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                        if (f.carbs != null && f.carbs > 0) Text("~${f.carbs} g", color = InkDim, fontSize = 11.sp)
                    }
                    Text("+${f.spike}", color = spikeColor(f.spike), fontSize = 16.sp, fontWeight = FontWeight.Black)
                }
            }
        }
    }
}

@Composable
private fun DietTip(title: String, text: String) {
    Surface(color = AccentGreen.copy(alpha = 0.08f), shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, AccentGreen.copy(alpha = 0.4f)), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, color = AccentGreen, fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 1.5.sp)
            Text(text, color = InkPrimary, fontSize = 13.sp, lineHeight = 19.sp)
        }
    }
}
