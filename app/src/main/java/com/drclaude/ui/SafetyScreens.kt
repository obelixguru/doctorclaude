package com.drclaude.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.drclaude.ui.theme.AccentGreen
import com.drclaude.ui.theme.BorderLight
import com.drclaude.ui.theme.CardWhite
import com.drclaude.ui.theme.GlucoseStatus
import com.drclaude.ui.theme.InkDim
import com.drclaude.ui.theme.InkMuted
import com.drclaude.ui.theme.InkPrimary
import com.drclaude.ui.theme.LightBg
import com.drclaude.ui.theme.OnColor

/** Safety constants. Bump [CONSENT_VERSION] when the disclaimer text materially changes,
 *  so every user is re-prompted to read and accept it again. */
object Safety {
    const val CONSENT_VERSION = 1
    /** How often to re-show the "don't follow the AI blindly" reminder. */
    const val SAFETY_PROMPT_INTERVAL_MS = 7L * 24 * 3600 * 1000 // weekly
}

/**
 * First-launch medical disclaimer. Blocks the whole app (shown before login) until the user
 * ticks the box and accepts. This is both a safety measure and the non-prescriptive framing:
 * Doctor Claude is an assistant, not a certified medical device.
 */
@Composable
fun ConsentScreen(onAccept: () -> Unit) {
    val s = LocalStrings.current
    var checked by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(LightBg)
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)
    ) {
        Spacer(Modifier.height(8.dp))
        Text(
            "Dr Claude",
            color = InkPrimary,
            fontSize = 26.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = (-0.5).sp
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Filled.Warning, contentDescription = null, tint = GlucoseStatus.WARNING.strong, modifier = Modifier.size(22.dp))
            Text(s.consentTitle, color = InkPrimary, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        Surface(
            color = CardWhite,
            shape = RoundedCornerShape(14.dp),
            border = BorderStroke(1.dp, BorderLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                s.consentBody,
                color = InkPrimary,
                fontSize = 14.sp,
                lineHeight = 21.sp,
                modifier = Modifier.padding(16.dp)
            )
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Checkbox(
                checked = checked,
                onCheckedChange = { checked = it },
                colors = CheckboxDefaults.colors(checkedColor = AccentGreen)
            )
            Text(s.consentCheck, color = InkPrimary, fontSize = 13.sp, lineHeight = 18.sp)
        }
        Button(
            onClick = onAccept,
            enabled = checked,
            colors = ButtonDefaults.buttonColors(
                containerColor = AccentGreen,
                contentColor = OnColor,
                disabledContainerColor = BorderLight,
                disabledContentColor = InkDim
            ),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth().height(54.dp)
        ) {
            Text(s.consentAccept, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
        }
        Spacer(Modifier.height(8.dp))
    }
}

/** Small inline reminder shown directly under any AI dose/sugar advice. */
@Composable
fun DoseDisclaimer(modifier: Modifier = Modifier) {
    val s = LocalStrings.current
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Icon(
            Icons.Filled.Warning,
            contentDescription = null,
            tint = GlucoseStatus.WARNING.strong,
            modifier = Modifier.size(14.dp).padding(top = 1.dp)
        )
        Text(s.doseDisclaimer, color = InkDim, fontSize = 11.sp, lineHeight = 15.sp)
    }
}

/** Periodic "don't follow the AI blindly" reminder, shown every [Safety.SAFETY_PROMPT_INTERVAL_MS]. */
@Composable
fun SafetyModal(onDismiss: () -> Unit) {
    val s = LocalStrings.current
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(s.safetyOk, color = AccentGreen, fontWeight = FontWeight.Bold)
            }
        },
        icon = { Icon(Icons.Filled.Warning, contentDescription = null, tint = GlucoseStatus.WARNING.strong) },
        title = { Text(s.safetyTitle, color = InkPrimary, fontSize = 17.sp, fontWeight = FontWeight.Bold) },
        text = { Text(s.safetyBody, color = InkMuted, fontSize = 14.sp, lineHeight = 20.sp) },
        containerColor = CardWhite
    )
}
