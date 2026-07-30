package com.drclaude.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val DoctorClaudeLight = lightColorScheme(
    primary = GlucoseStatus.GOOD.strong,
    onPrimary = OnColor,
    secondary = GlucoseStatus.WARNING.strong,
    background = LightBg,
    onBackground = InkPrimary,
    surface = CardWhite,
    onSurface = InkPrimary,
    error = GlucoseStatus.DANGER.strong,
    onError = OnColor
)

@Composable
fun DoctorClaudeTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DoctorClaudeLight,
        typography = DoctorClaudeTypography,
        content = content
    )
}
