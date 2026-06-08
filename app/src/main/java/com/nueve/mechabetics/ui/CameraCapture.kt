package com.nueve.mechabetics.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.nueve.mechabetics.ui.theme.*
import java.io.File

/**
 * In-app camera for the product scan (CameraX). Reliable across Android versions: it asks
 * for the CAMERA permission itself, shows a live preview, and captures straight to a file —
 * no dependency on an external camera app (which was launching nothing on recent Android).
 */
@Composable
fun CameraCapture(lang: Lang, onCancel: () -> Unit, onCaptured: (File) -> Unit, onPickGallery: (() -> Unit)? = null) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val es = lang == Lang.ES

    var hasPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        )
    }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasPermission = granted
    }
    LaunchedEffect(Unit) { if (!hasPermission) permLauncher.launch(Manifest.permission.CAMERA) }
    // Re-check on resume so returning from the system dialog OR from app Settings updates the state.
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                hasPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    if (!hasPermission) {
        Column(
            modifier = Modifier.fillMaxSize().background(LightBg).padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                if (es) "Autoriza la cámara para escanear el producto." else "Autorise la caméra pour scanner le produit.",
                color = InkPrimary, fontSize = 15.sp, fontWeight = FontWeight.Bold
            )
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = { permLauncher.launch(Manifest.permission.CAMERA) },
                colors = ButtonDefaults.buttonColors(containerColor = AccentGreen, contentColor = LightBg),
                shape = RoundedCornerShape(12.dp)
            ) { Text(if (es) "PERMITIR" else "AUTORISER", fontWeight = FontWeight.Black, letterSpacing = 1.sp) }
            Spacer(Modifier.height(12.dp))
            Text(
                if (es) "¿No pasa nada al pulsar? Actívala a mano:" else "Rien ne se passe au clic ? Active-la à la main :",
                color = InkMuted, fontSize = 12.sp
            )
            Spacer(Modifier.height(6.dp))
            OutlinedButton(
                onClick = {
                    val intent = Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null)
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(intent)
                },
                shape = RoundedCornerShape(12.dp)
            ) { Text(if (es) "ABRIR AJUSTES" else "OUVRIR LES RÉGLAGES", color = AccentGreen, fontWeight = FontWeight.Bold) }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onCancel) { Text(if (es) "Cancelar" else "Annuler", color = InkMuted) }
        }
        return
    }

    val imageCapture = remember { ImageCapture.Builder().build() }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                val previewView = PreviewView(ctx)
                val future = ProcessCameraProvider.getInstance(ctx)
                future.addListener({
                    val provider = future.get()
                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                    try {
                        provider.unbindAll()
                        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture)
                    } catch (_: Exception) { /* camera unavailable */ }
                }, ContextCompat.getMainExecutor(ctx))
                previewView
            },
            modifier = Modifier.fillMaxSize()
        )

        Row(
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(24.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            TextButton(onClick = onCancel) {
                Text(if (es) "Cancelar" else "Annuler", color = Color.White, fontWeight = FontWeight.Bold)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                // Discreet gallery pick (reliable fallback when the live camera misbehaves).
                if (onPickGallery != null) {
                    IconButton(onClick = onPickGallery) {
                        Icon(Icons.Outlined.PhotoLibrary, contentDescription = if (es) "Galería" else "Galerie", tint = Color.White, modifier = Modifier.size(26.dp))
                    }
                }
                Button(
                    onClick = {
                        val file = File(context.cacheDir, "scan_${System.currentTimeMillis()}.jpg")
                        val output = ImageCapture.OutputFileOptions.Builder(file).build()
                        imageCapture.takePicture(
                            output,
                            ContextCompat.getMainExecutor(context),
                            object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(results: ImageCapture.OutputFileResults) = onCaptured(file)
                                override fun onError(exc: ImageCaptureException) = onCancel()
                            }
                        )
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = InkPrimary),
                    shape = RoundedCornerShape(30.dp),
                    modifier = Modifier.height(56.dp)
                ) {
                    Text(if (es) "TOMAR FOTO" else "PRENDRE LA PHOTO", fontWeight = FontWeight.Black, letterSpacing = 1.sp)
                }
            }
        }
    }
}
