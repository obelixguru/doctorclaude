package com.nueve.mechabetics.data

/** Insulin-on-board math — a pure-Kotlin mirror of the server's insulinActionMinutes / activeIob
 *  (supabase/functions/_shared/doseGuard.ts) so the app and the dose guard always agree on IOB. */

/** Default duration of insulin action (minutes) when the insulin type is unknown — 4 h linear. */
const val DEFAULT_INSULIN_ACTION_MIN = 240

/**
 * Effective duration of insulin action (minutes) for a named insulin, for the linear IOB decay.
 * Returns null for an unknown name so the caller falls back to [DEFAULT_INSULIN_ACTION_MIN].
 *
 * Rapid/ultra-rapid analogs ≈ 4 h working time. Fiasp/Lyumjev act FASTER with a SHORTER tail than
 * older analogs, but 4 h linear already tails high — keeping them at 4 h overestimates late IOB,
 * which BLOCKS dose-stacking (the safe direction) rather than causing it. Regular human insulin
 * lasts ~6 h and inhaled (Afrezza) ~3 h — those genuinely need a different duration.
 */
fun insulinActionMinutes(name: String?): Int? {
    val n = (name ?: "").lowercase()
    if (n.isBlank()) return null
    if (n.contains("afrezza") || n.contains("inhal")) return 180 // inhaled — very short
    if (n.contains("actrapid") || n.contains("humulin r") || n.contains("humulin s") ||
        n.contains("insuman") || n.contains("novolin r") || n.contains("insulatard") ||
        n.contains("regular") || n.contains("humaine") || n.contains("humana")
    ) return 360 // regular/human short-acting — long tail (~6 h)
    if (n.contains("fiasp") || n.contains("lyumjev") || n.contains("novorapid") || n.contains("novolog") ||
        n.contains("humalog") || n.contains("apidra") || n.contains("admelog") || n.contains("trurapi") ||
        n.contains("kirsty") || n.contains("aspart") || n.contains("lispro") || n.contains("glulisine") ||
        n.contains("rapid") || n.contains("rápid") || n.contains("rapide")
    ) return 240 // rapid & ultra-rapid analogs — ~4 h
    return null // unknown → caller's default
}

/** Insulin-on-board (units) from rapid doses, linear decay over each dose's own action duration
 *  (insulin-type-aware via [insulinActionMinutes], fallback 4 h). Doses are (epoch-ms, units, name). */
fun iobFromDoses(doses: List<Triple<Long, Double, String?>>, nowMs: Long): Double =
    doses.sumOf { (ts, units, name) ->
        val dur = (insulinActionMinutes(name) ?: DEFAULT_INSULIN_ACTION_MIN).toDouble()
        val mins = (nowMs - ts) / 60000.0
        if (mins in 0.0..dur) units * (1 - mins / dur) else 0.0
    }.coerceAtLeast(0.0)
