package com.nueve.mechabetics.ui

import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nueve.mechabetics.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(
    isLoading: Boolean,
    error: String?,
    savedProfiles: List<ProfileItem> = emptyList(),
    addMode: Boolean = false,
    onPickProfile: (String) -> Unit = {},
    onBack: (() -> Unit)? = null,
    onLogin: (String, String) -> Unit
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }
    val s = LocalStrings.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(LightBg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        if (addMode && onBack != null) {
            Spacer(Modifier.height(16.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = s.cancel, tint = InkPrimary)
                }
                Spacer(Modifier.width(4.dp))
                Text(s.cancel, color = InkMuted, fontSize = 13.sp)
            }
        }

        Spacer(Modifier.height(20.dp))
        PulsingLogo()
        Spacer(Modifier.height(28.dp))

        Text(
            if (addMode) s.addAccountTitle else "Doctor Claude",
            color = InkPrimary,
            fontSize = 28.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = (-0.5).sp
        )
        Text(
            s.loginSubtitle,
            color = InkMuted,
            fontSize = 13.sp
        )

        Spacer(Modifier.height(32.dp))

        // Returning user: tap a saved profile to sign straight back in.
        if (!addMode && savedProfiles.isNotEmpty()) {
            Text(
                s.yourProfiles,
                color = InkPrimary,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(10.dp))
            savedProfiles.forEach { p ->
                ProfileLoginCard(p) { onPickProfile(p.email) }
                Spacer(Modifier.height(8.dp))
            }
            Spacer(Modifier.height(16.dp))
        }

        OutlinedTextField(
            value = email,
            onValueChange = { email = it.trim() },
            label = { Text(s.emailLabel, color = InkMuted) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
            colors = textFieldColors()
        )

        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(s.passwordLabel, color = InkMuted) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                IconButton(onClick = { passwordVisible = !passwordVisible }) {
                    Icon(
                        if (passwordVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = null,
                        tint = InkMuted
                    )
                }
            },
            modifier = Modifier.fillMaxWidth(),
            colors = textFieldColors()
        )

        if (error != null) {
            Spacer(Modifier.height(12.dp))
            Surface(
                color = GlucoseStatus.DANGER.wash,
                shape = RoundedCornerShape(10.dp),
                border = BorderStroke(1.dp, GlucoseStatus.DANGER.strong),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    error,
                    color = GlucoseStatus.DANGER.strong2,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(12.dp)
                )
            }
        }

        Spacer(Modifier.height(20.dp))

        Button(
            onClick = { onLogin(email, password) },
            enabled = !isLoading && email.isNotBlank() && password.isNotBlank(),
            colors = ButtonDefaults.buttonColors(
                containerColor = AccentGreen,
                contentColor = LightBg,
                disabledContainerColor = CardWhite,
                disabledContentColor = TextDim
            ),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
        ) {
            if (isLoading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(22.dp),
                    color = LightBg,
                    strokeWidth = 2.dp
                )
            } else {
                Text(s.connect, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp)
            }
        }

        Spacer(Modifier.height(20.dp))

        Surface(
            color = CardWhite,
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, BorderLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(Modifier.padding(16.dp)) {
                Text(
                    s.howItWorks,
                    color = InkPrimary,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    s.howItWorksBody,
                    color = InkMuted,
                    fontSize = 12.sp,
                    lineHeight = 18.sp
                )
            }
        }
    }
}

@Composable
private fun ProfileLoginCard(item: ProfileItem, onClick: () -> Unit) {
    Surface(
        color = CardWhite,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, BorderLight),
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
    ) {
        Row(
            Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Outlined.Person, contentDescription = null, tint = AccentGreen)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(item.label, color = InkPrimary, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text(item.email, color = InkMuted, fontSize = 11.sp)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun textFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = InkPrimary,
    unfocusedTextColor = InkPrimary,
    focusedContainerColor = CardWhite,
    unfocusedContainerColor = CardWhite,
    focusedBorderColor = AccentGreen,
    unfocusedBorderColor = BorderLight,
    cursorColor = AccentGreen
)

@Composable
private fun PulsingLogo() {
    val inf = rememberInfiniteTransition(label = "logo")
    val rot by inf.animateFloat(
        0f, 360f,
        infiniteRepeatable(tween(4000, easing = LinearEasing)), label = "rot"
    )
    val pulse by inf.animateFloat(
        0.95f, 1.05f,
        infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "pulse"
    )
    Box(modifier = Modifier.size(140.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(140.dp).graphicsLayer { scaleX = pulse; scaleY = pulse }) {
            drawCircle(AccentGreen.copy(alpha = 0.08f), radius = size.minDimension / 2)
        }
        Canvas(Modifier.size(110.dp).graphicsLayer { rotationZ = rot }) {
            drawArc(
                color = AccentGreen,
                startAngle = -90f, sweepAngle = 270f,
                useCenter = false,
                style = Stroke(width = 3.dp.toPx(), cap = StrokeCap.Round)
            )
        }
        Canvas(Modifier.size(70.dp)) {
            drawCircle(CardWhite)
            drawCircle(AccentGreen.copy(alpha = 0.4f), style = Stroke(1.dp.toPx()))
        }
        Text("DC", color = AccentGreen, fontSize = 18.sp, fontWeight = FontWeight.Black, letterSpacing = 2.sp)
    }
}
