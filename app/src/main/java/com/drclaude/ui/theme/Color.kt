package com.drclaude.ui.theme

import androidx.compose.ui.graphics.Color

val BgDeep = Color(0xFF020617)
val SurfaceCard = Color(0xFF0F172A)
val BorderSubtle = Color(0xFF1E293B)
val AccentGreen = Color(0xFF059669)   // brand accent (emerald) — the app's primary interactive colour (buttons, tabs, links)
val AccentEmerald = Color(0xFF10B981)
val AccentAmber = Color(0xFFF59E0B)
val DangerRose = Color(0xFFF43F5E)
val TextPrimary = Color(0xFFE2E8F0)
val TextMuted = Color(0xFF94A3B8)
val TextDim = Color(0xFF64748B)

// ── Light theme base ─────────────────────────────────────────────
val LightBg = Color(0xFFF8FAFC)
val CardWhite = Color(0xFFFFFFFF)
val BorderLight = Color(0xFFE6ECF3)
val InkPrimary = Color(0xFF0F172A)
val InkMuted = Color(0xFF64748B)
val InkDim = Color(0xFF94A3B8)
val OnColor = Color(0xFFFFFFFF)

// "Signal lost" gradient — strong RED so NO SIGNAL reads as a clear stop/danger state (you must not
// dose off it; do a fingerstick). It's a deliberate alarm colour, not a glucose-status colour.
val SignalLostTop = Color(0xFFEF4444)    // red-500
val SignalLostBottom = Color(0xFFB91C1C) // red-700

// ── Status palettes: strong colour, gradient end, light wash ─────
enum class GlucoseStatus(val strong: Color, val strong2: Color, val wash: Color) {
    GOOD(Color(0xFF10B981), Color(0xFF059669), Color(0xFFEAFBF3)),     // green
    WARNING(Color(0xFFF59E0B), Color(0xFFEA8A0C), Color(0xFFFEF5E6)),  // orange / yellow
    DANGER(Color(0xFFFB7185), Color(0xFFE11D48), Color(0xFFFDEAEE)),   // red / pink
}

// Five-zone colour scheme (user request), the SAME zones the alarms use — see the ALARM_* constants
// in data/GlucoseAlert.kt. Colour and sound must agree: red is what sounds, orange is what is merely
// watched.
//   <60       red (hypo)        60-69   orange (near-low)
//   70-170    green (in range)  171-180 orange (near-high)   >180  red (hyper)
fun statusOf(value: Int?): GlucoseStatus = when {
    value == null -> GlucoseStatus.GOOD
    value < 60 -> GlucoseStatus.DANGER      // 59 and below -> red
    value < 70 -> GlucoseStatus.WARNING     // 60-69 near-low -> orange
    value > 180 -> GlucoseStatus.DANGER     // above 180 -> red
    value > 170 -> GlucoseStatus.WARNING    // 171-180 near-high -> orange
    else -> GlucoseStatus.GOOD              // 70-170 in range -> green
}
