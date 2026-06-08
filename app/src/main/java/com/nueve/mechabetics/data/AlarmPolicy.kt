package com.nueve.mechabetics.data

/**
 * Pure mapping from "an alarm wants to ring" to "HOW it should actually alert THIS user right now",
 * honouring their volume / vibrate / quiet-hours / per-type choices. No Android dependencies, so it's
 * unit-testable and the foreground UI ([com.nueve.mechabetics.MainActivity]) and the background
 * [com.nueve.mechabetics.MonitorService] resolve the alarm identically.
 *
 * Safety stance: the loud PHONE alarm is a CONVENIENCE layer. The parent's Telegram alert (the
 * server cron, independent of the phone and of these settings) is the real safety net, so the user
 * may freely quiet the phone. By DEFAULT every alert sounds, all the time; the silencing levers are
 * all EXPLICIT opt-ins owned by the user — per-type switches, the vibreur/silencieux mode, and quiet
 * hours (a vibrate-only window — except a hypo still chimes through it by default). The UI warns when
 * hypo is turned off or switched to vibrate-only.
 */
object AlarmPolicy {

    data class Settings(
        val soundEnabled: Boolean,      // master: may the alarm chime at all
        val volumePct: Int,             // 0..100 chime loudness
        val vibrate: Boolean,           // vibrate on an alarm
        val hypoEnabled: Boolean,       // LOW alarms on
        val hyperEnabled: Boolean,      // HIGH alarms on
        val rapidFallEnabled: Boolean,  // fast-fall alarms on
        val hypoAlwaysSounds: Boolean,  // LOW chimes even inside quiet hours (default ON; safety)
        val quietHoursEnabled: Boolean,
        val quietStartMin: Int,         // minutes from midnight (0..1439)
        val quietEndMin: Int
    )

    /** ring=false → do not alert at all (this type is switched off). Otherwise raise the alert and
     *  chime at [volumePct] (0 = silent / notification + vibration only) with [vibrate] as resolved. */
    data class Effect(
        val ring: Boolean,
        val volumePct: Int,
        val vibrate: Boolean
    )

    private val NO_RING = Effect(ring = false, volumePct = 0, vibrate = false)

    /** True if [minute] (0..1439) is inside the quiet window, handling a window that wraps midnight
     *  (e.g. 22:00 → 07:00). An empty window (start == end) is treated as "off". */
    fun inQuietWindow(minute: Int, startMin: Int, endMin: Int): Boolean {
        if (startMin == endMin) return false
        return if (startMin < endMin) minute in startMin until endMin
               else minute >= startMin || minute < endMin
    }

    fun effect(kind: AlertKind, settings: Settings, minuteOfDay: Int): Effect {
        val typeOn = when (kind) {
            AlertKind.LOW -> settings.hypoEnabled
            AlertKind.HIGH -> settings.hyperEnabled
            AlertKind.RAPID_FALL -> settings.rapidFallEnabled
            else -> false // NONE / RAPID_RISE never raise a loud alarm
        }
        if (!typeOn) return NO_RING
        // Quiet hours = a vibrate-only window (chime off), opt-in, default OFF. EXCEPTION: a hypo (LOW)
        // pierces it and still CHIMES by default (hypoAlwaysSounds) — the dangerous direction isn't
        // muted by a clock. The user can turn that off (a confirmation modal warns first) to make hypo
        // vibrate-only at night too. HIGH / RAPID_FALL are always quieted inside the window.
        val piercesQuiet = kind == AlertKind.LOW && settings.hypoAlwaysSounds
        val quieted = settings.quietHoursEnabled && !piercesQuiet &&
            inQuietWindow(minuteOfDay, settings.quietStartMin, settings.quietEndMin)
        val chime = settings.soundEnabled && settings.volumePct > 0 && !quieted
        return Effect(
            ring = true,
            volumePct = if (chime) settings.volumePct else 0,
            vibrate = settings.vibrate
        )
    }
}
