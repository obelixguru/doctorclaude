package com.nueve.mechabetics.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChildCare
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nueve.mechabetics.ui.theme.AccentGreen
import com.nueve.mechabetics.ui.theme.BorderLight
import com.nueve.mechabetics.ui.theme.CardWhite
import com.nueve.mechabetics.ui.theme.GlucoseStatus
import com.nueve.mechabetics.ui.theme.InkDim
import com.nueve.mechabetics.ui.theme.InkMuted
import com.nueve.mechabetics.ui.theme.InkPrimary
import com.nueve.mechabetics.ui.theme.LightBg

/**
 * One-time "whose phone is this?" question, asked once the account is connected.
 *
 * One LibreLinkUp account can follow several people, and the Profile tab lets you switch between
 * them. On the child's own phone that switch is a hazard rather than a feature: insulin and meals
 * logged from it landed on the parent's record — the wrong person's history, and the wrong basis for
 * every later dose calculation. Answering here pins a child device to the person it was set up for.
 *
 * Deliberately NOT a silent default: guessing wrong is exactly the failure this prevents, so the app
 * waits for an explicit answer. It stays changeable afterwards from Profile.
 */
@Composable
fun DeviceRoleScreen(
    lang: Lang,
    patientLabel: String?,
    onPick: (parent: Boolean) -> Unit,
) {
    val s = roleStringsFor(lang)
    Surface(color = LightBg, modifier = Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Spacer(Modifier.height(24.dp))
            Text(
                s.title,
                color = InkPrimary, fontSize = 26.sp, fontWeight = FontWeight.Black, lineHeight = 30.sp
            )
            Text(s.intro, color = InkMuted, fontSize = 14.sp, lineHeight = 20.sp)

            RoleCard(
                icon = Icons.Outlined.Shield,
                title = s.parentTitle,
                body = s.parentBody,
                onClick = { onPick(true) }
            )
            RoleCard(
                icon = Icons.Outlined.ChildCare,
                title = s.childTitle,
                // Name the person this phone will be pinned to — picking the wrong one is the whole
                // risk, so the choice is never abstract.
                body = if (!patientLabel.isNullOrBlank())
                    String.format(s.childBodyNamed, patientLabel) else s.childBody,
                onClick = { onPick(false) }
            )

            Text(s.changeLater, color = InkDim, fontSize = 12.sp, lineHeight = 17.sp)
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun RoleCard(icon: ImageVector, title: String, body: String, onClick: () -> Unit) {
    Surface(
        color = CardWhite,
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(1.dp, BorderLight),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)
    ) {
        Row(
            Modifier.padding(16.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier.size(44.dp).background(AccentGreen.copy(alpha = 0.12f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = AccentGreen, modifier = Modifier.size(22.dp))
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp), modifier = Modifier.weight(1f)) {
                Text(title, color = InkPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text(body, color = InkMuted, fontSize = 12.sp, lineHeight = 17.sp)
            }
        }
    }
}

/**
 * Small badge shown in Profile so the current role is always visible, never a hidden mode.
 *
 * The role alone answers "whose PHONE is this?", and that was being read as an answer to "whose DATA
 * am I looking at?" — a parent phone showed "Mon téléphone (parent)" directly above the child's
 * glucose and the child's profile form. [recordLabel] answers the second question explicitly, and
 * says so plainly when the person can't be identified (a connections list the app failed to read
 * leaves the app showing a record it cannot name).
 */
@Composable
fun DeviceRoleBadge(
    lang: Lang,
    isChild: Boolean,
    patientLabel: String?,
    recordLabel: String?,
    onChange: () -> Unit
) {
    val s = roleStringsFor(lang)
    Surface(
        color = CardWhite,
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, BorderLight),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                s.badgeTitle,
                color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    if (isChild) Icons.Outlined.ChildCare else Icons.Outlined.Shield,
                    contentDescription = null, tint = AccentGreen, modifier = Modifier.size(18.dp)
                )
                Text(
                    if (isChild) (patientLabel?.takeIf { it.isNotBlank() }
                        ?.let { String.format(s.badgeChildNamed, it) } ?: s.badgeChild)
                    else s.badgeParent,
                    color = InkPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium
                )
            }
            Text(
                if (!recordLabel.isNullOrBlank()) String.format(s.badgeRecord, recordLabel)
                else s.badgeRecordUnknown,
                color = if (recordLabel.isNullOrBlank()) GlucoseStatus.WARNING.strong else InkPrimary,
                fontSize = 12.sp, fontWeight = FontWeight.Medium, lineHeight = 16.sp
            )
            Text(
                if (isChild) s.badgeChildNote else s.badgeParentNote,
                color = InkMuted, fontSize = 11.sp, lineHeight = 15.sp
            )
            Text(
                s.change,
                color = AccentGreen, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.clickable(onClick = onChange).padding(top = 2.dp)
            )
        }
    }
}
