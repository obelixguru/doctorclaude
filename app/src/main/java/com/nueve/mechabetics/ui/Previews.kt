package com.nueve.mechabetics.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.nueve.mechabetics.data.GlucoseReading
import com.nueve.mechabetics.data.Trend
import com.nueve.mechabetics.ui.theme.BgDeep
import com.nueve.mechabetics.ui.theme.DoctorClaudeTheme

/* -----------------------------------------------------------------------
 * Aperçus Compose. Ouvre ce fichier dans Android Studio → split view
 * (icône en haut à droite de l'éditeur) pour voir le rendu sans lancer
 * l'app. Build > Make Project une fois pour activer le Preview.
 * -------------------------------------------------------------------- */

private val MOCK_HISTORY = listOf(
    115, 122, 130, 138, 145, 152, 158, 162, 160, 155,
    148, 142, 138, 135, 132, 128, 125, 130, 138, 145,
    150, 148, 142, 138, 142
).mapIndexed { i, v ->
    GlucoseReading(
        timestampMs = System.currentTimeMillis() - (24 - i) * 5 * 60_000L,
        valueMgDl = v,
        trend = when {
            i < 5 -> Trend.RISING
            i < 10 -> Trend.RISING_FAST
            i < 15 -> Trend.FALLING
            else -> Trend.STABLE
        }
    )
}

@Preview(
    name = "Login",
    showBackground = true,
    backgroundColor = 0xFF020617,
    widthDp = 412,
    heightDp = 915
)
@Composable
private fun LoginPreview() {
    DoctorClaudeTheme {
        LoginScreen(
            isLoading = false,
            error = null,
            onLogin = { _, _ -> }
        )
    }
}

@Preview(
    name = "Login — loading",
    showBackground = true,
    backgroundColor = 0xFF020617,
    widthDp = 412,
    heightDp = 915
)
@Composable
private fun LoginLoadingPreview() {
    DoctorClaudeTheme {
        LoginScreen(
            isLoading = true,
            error = null,
            onLogin = { _, _ -> }
        )
    }
}

@Preview(
    name = "Login — error",
    showBackground = true,
    backgroundColor = 0xFF020617,
    widthDp = 412,
    heightDp = 915
)
@Composable
private fun LoginErrorPreview() {
    DoctorClaudeTheme {
        LoginScreen(
            isLoading = false,
            error = "Identifiants invalides",
            onLogin = { _, _ -> }
        )
    }
}

@Preview(
    name = "Dashboard — in range",
    showBackground = true,
    backgroundColor = 0xFF020617,
    widthDp = 412,
    heightDp = 1800
)
@Composable
private fun DashboardInRangePreview() {
    DoctorClaudeTheme {
        DashboardScreen(
            patientName = "Maria Dupont",
            current = GlucoseReading(
                timestampMs = System.currentTimeMillis(),
                valueMgDl = 142,
                trend = Trend.STABLE
            ),
            history = MOCK_HISTORY,
            isLoading = false,
            lastUpdateMs = System.currentTimeMillis(),
            error = null,
            aiText = "Glycémie stable à 142 mg/dL, dans la cible. Sur les 2 dernières heures, " +
                "moyenne de 140 avec une oscillation modérée — typique d'un post-repas en " +
                "redescente. Garde ton hydratation et une activité légère pour stabiliser.",
            aiLoading = false,
            isRecording = false,
            lang = Lang.FR,
            onToggleLang = {},
            onRefresh = {},
            onLogout = {},
            onAnalyze = {},
            onMicClick = {},
            onOpenHistory = {},
        )
    }
}

@Preview(
    name = "Dashboard — hypo",
    showBackground = true,
    backgroundColor = 0xFF020617,
    widthDp = 412,
    heightDp = 1800
)
@Composable
private fun DashboardHypoPreview() {
    DoctorClaudeTheme {
        DashboardScreen(
            patientName = "Maria Dupont",
            current = GlucoseReading(
                timestampMs = System.currentTimeMillis(),
                valueMgDl = 58,
                trend = Trend.FALLING_FAST,
                isLow = true
            ),
            history = MOCK_HISTORY.map { it.copy(valueMgDl = (it.valueMgDl - 80).coerceAtLeast(50)) },
            isLoading = false,
            lastUpdateMs = System.currentTimeMillis(),
            error = null,
            aiText = "ALERTE : hypoglycémie à 58 mg/dL en chute rapide. Resucre " +
                "immédiatement (15g de glucides rapides : jus, sucre, gel). " +
                "Recontrôle dans 15 min.",
            aiLoading = false,
            isRecording = false,
            lang = Lang.FR,
            onToggleLang = {},
            onRefresh = {},
            onLogout = {},
            onAnalyze = {},
            onMicClick = {},
            onOpenHistory = {},
        )
    }
}

@Preview(
    name = "Dashboard — hyper",
    showBackground = true,
    backgroundColor = 0xFF020617,
    widthDp = 412,
    heightDp = 1800
)
@Composable
private fun DashboardHyperPreview() {
    DoctorClaudeTheme {
        DashboardScreen(
            patientName = "Maria Dupont",
            current = GlucoseReading(
                timestampMs = System.currentTimeMillis(),
                valueMgDl = 245,
                trend = Trend.RISING,
                isHigh = true
            ),
            history = MOCK_HISTORY.map { it.copy(valueMgDl = it.valueMgDl + 80) },
            isLoading = false,
            lastUpdateMs = System.currentTimeMillis(),
            error = null,
            aiText = "Hyperglycémie marquée à 245 mg/dL et toujours en hausse. " +
                "Vérifie ton dernier bolus, hydrate-toi (eau plate), et marche 15 min. " +
                "Recontrôle dans 1 h.",
            aiLoading = false,
            isRecording = false,
            lang = Lang.FR,
            onToggleLang = {},
            onRefresh = {},
            onLogout = {},
            onAnalyze = {},
            onMicClick = {},
            onOpenHistory = {},
        )
    }
}

@Preview(
    name = "Dashboard — empty",
    showBackground = true,
    backgroundColor = 0xFF020617,
    widthDp = 412,
    heightDp = 1200
)
@Composable
private fun DashboardEmptyPreview() {
    DoctorClaudeTheme {
        DashboardScreen(
            patientName = "Maria Dupont",
            current = null,
            history = emptyList(),
            isLoading = true,
            lastUpdateMs = 0,
            error = null,
            aiText = "",
            aiLoading = false,
            isRecording = false,
            lang = Lang.FR,
            onToggleLang = {},
            onRefresh = {},
            onLogout = {},
            onAnalyze = {},
            onMicClick = {},
            onOpenHistory = {},
        )
    }
}
