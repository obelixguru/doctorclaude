package com.nueve.mechabetics.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Colorize
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.WaterDrop
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp
import com.nueve.mechabetics.ui.theme.AccentGreen
import com.nueve.mechabetics.ui.theme.CardWhite
import com.nueve.mechabetics.ui.theme.InkMuted

enum class Tab { GLUCOSE, MEALS, INSULIN, PROFILE }

/** One row in the profile switcher (login screen + Profile tab). */
data class ProfileItem(val email: String, val label: String, val active: Boolean)

/** One selectable PATIENT within the active LibreLinkUp account. A single follower account can
 *  follow several people (e.g. a parent following two diabetic children); this lets the user switch
 *  which one Doctor Claude is showing. Data stays isolated server-side (subject = sha256(patientId)). */
data class PatientChoice(val patientId: String, val label: String, val active: Boolean)

@Composable
fun DoctorClaudeBottomBar(current: Tab, glucoseColor: Color = AccentGreen, glucoseAlert: Boolean = false, onSelect: (Tab) -> Unit) {
    val s = LocalStrings.current
    // Brand-green active tab (selected icon/label + a light green pill) instead of Material's
    // default purple — green is the app's primary colour.
    val navColors = NavigationBarItemDefaults.colors(
        selectedIconColor = AccentGreen,
        selectedTextColor = AccentGreen,
        indicatorColor = AccentGreen.copy(alpha = 0.15f),
        unselectedIconColor = InkMuted,
        unselectedTextColor = InkMuted
    )
    // The Glucose tab becomes an ambient ALERT light ONLY when the glucose is orange/red (WARNING /
    // DANGER): then icon + label show that colour even when the tab isn't selected, so a high/low is
    // visible from any tab. In range (green), it's a normal tab — grey when inactive, brand-green when
    // active — so a calm in-range value doesn't keep it lit up.
    val glucoseColors = if (glucoseAlert) {
        NavigationBarItemDefaults.colors(
            selectedIconColor = glucoseColor,
            selectedTextColor = glucoseColor,
            indicatorColor = glucoseColor.copy(alpha = 0.18f),
            unselectedIconColor = glucoseColor,
            unselectedTextColor = glucoseColor
        )
    } else navColors
    NavigationBar(containerColor = CardWhite) {
        NavigationBarItem(
            selected = current == Tab.GLUCOSE,
            onClick = { onSelect(Tab.GLUCOSE) },
            icon = { Icon(Icons.Outlined.WaterDrop, contentDescription = s.tabGlucose) },
            label = { Text(s.tabGlucose, fontSize = 11.sp) },
            colors = glucoseColors
        )
        NavigationBarItem(
            selected = current == Tab.MEALS,
            onClick = { onSelect(Tab.MEALS) },
            icon = { Icon(Icons.Outlined.Restaurant, contentDescription = s.tabMeals) },
            label = { Text(s.tabMeals, fontSize = 11.sp) },
            colors = navColors
        )
        NavigationBarItem(
            selected = current == Tab.INSULIN,
            onClick = { onSelect(Tab.INSULIN) },
            icon = { Icon(Icons.Outlined.Colorize, contentDescription = s.tabInsulin) },
            label = { Text(s.tabInsulin, fontSize = 11.sp) },
            colors = navColors
        )
        NavigationBarItem(
            selected = current == Tab.PROFILE,
            onClick = { onSelect(Tab.PROFILE) },
            icon = { Icon(Icons.Outlined.Person, contentDescription = s.tabProfile) },
            label = { Text(s.tabProfile, fontSize = 11.sp) },
            colors = navColors
        )
    }
}
