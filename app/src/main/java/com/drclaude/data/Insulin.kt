package com.drclaude.data

import kotlin.math.exp

/**
 * What every insulin does, and insulin still working: a pure-Kotlin mirror of
 * supabase/functions/_shared/insulins.ts and activeIob, so the screen and the dose engine always
 * agree. Change both together.
 *
 * Rapid insulins run on the published exponential curve (the one Loop uses); a straight line over four
 * hours said half a dose was left at two hours when Fiasp has a third left. Background insulins never
 * count as insulin still working.
 */

data class InsulinCurve(val peakMin: Double, val durationMin: Double, val delayMin: Double)

enum class InsulinClass { ULTRA_RAPID, RAPID, REGULAR, INHALED, NPH, LONG, ULTRA_LONG, WEEKLY, PREMIX }

data class InsulinInfo(
    val id: String,
    val label: String,
    val cls: InsulinClass,
    val match: List<String>,
    val curve: InsulinCurve?,
    /** Background insulins: how long one dose lasts, in hours, as the label states it. */
    val lastsHours: Int? = null,
    /** Background insulins: days before a change has settled. */
    val settlesDays: Int? = null,
)

private val FIASP = InsulinCurve(55.0, 360.0, 10.0)
/** Loop's adult preset, for everybody: what is left of a dose is never understated. */
private val ANALOG = InsulinCurve(75.0, 360.0, 10.0)
private val REGULAR = InsulinCurve(150.0, 480.0, 20.0)
private val INHALED = InsulinCurve(29.0, 300.0, 10.0)

// Order matters: premixes before "humalog", Toujeo before "glargin".
val INSULINS: List<InsulinInfo> = listOf(
    InsulinInfo("premix", "Mélange", InsulinClass.PREMIX, listOf("novomix", "humalog mix", "mixtard", "actraphane", "humulin m3", "humulina 30", "umuline profil", "insuman comb", "truvelog mix", "mix 25", "mix25", "mix 30", "mix30", "mix 50", "mix50", "ryzodeg"), ANALOG),
    InsulinInfo("fiasp", "Fiasp", InsulinClass.ULTRA_RAPID, listOf("fiasp"), FIASP),
    InsulinInfo("lyumjev", "Lyumjev", InsulinClass.ULTRA_RAPID, listOf("lyumjev", "liumjev"), FIASP),
    InsulinInfo("novorapid", "NovoRapid", InsulinClass.RAPID, listOf("novorapid", "novolog", "novo rapid", "trurapi", "truvelog", "kirsty", "kixelle", "dazparda", "aspart"), ANALOG),
    InsulinInfo("humalog", "Humalog", InsulinClass.RAPID, listOf("humalog", "liprolog", "admelog", "bysumlog", "lispro"), ANALOG),
    InsulinInfo("apidra", "Apidra", InsulinClass.RAPID, listOf("apidra", "glulisin"), ANALOG),
    InsulinInfo("actrapid", "Actrapid", InsulinClass.REGULAR, listOf("actrapid", "humulin r", "humulin s", "humulina regular", "umuline rapide", "insuman rapid", "insuman infusat", "novolin r", "insulina regular", "insuline humaine", "insulina humana", "ordinaire"), REGULAR),
    InsulinInfo("afrezza", "Afrezza", InsulinClass.INHALED, listOf("afrezza", "inhal"), INHALED),
    InsulinInfo("nph", "Insulatard", InsulinClass.NPH, listOf("insulatard", "humulin n", "humulina nph", "insuman basal", "protaphane", "umuline nph", "nph"), null, 24),
    InsulinInfo("toujeo", "Toujeo", InsulinClass.ULTRA_LONG, listOf("toujeo", "optisulin", "u300", "u-300", "glargine 300"), null, 36, 4),
    InsulinInfo("lantus", "Lantus", InsulinClass.LONG, listOf("lantus", "abasaglar", "abasria", "basaglar", "semglee", "ondibta", "rezvoglar", "glargin"), null, 24, 4),
    InsulinInfo("levemir", "Levemir", InsulinClass.LONG, listOf("levemir", "detemir", "détémir"), null, 24),
    InsulinInfo("tresiba", "Tresiba", InsulinClass.ULTRA_LONG, listOf("tresiba", "degludec", "dégludec", "degludeg"), null, 42, 3),
    InsulinInfo("awiqli", "Awiqli", InsulinClass.WEEKLY, listOf("awiqli", "icodec", "onswik", "efsitora"), null, 168, 28),
)

fun insulinByName(name: String?): InsulinInfo? {
    val n = (name ?: "").lowercase().trim()
    if (n.isEmpty()) return null
    return INSULINS.firstOrNull { i -> i.match.any { n.contains(it) } }
}

/** A dose logged under a background insulin never counts as still working, whatever its row says. */
fun isBasalInsulin(name: String?): Boolean = insulinByName(name)?.let { it.curve == null } ?: false

/** The curve for a dose of this insulin; for an unknown name, the slower analog, so what is left is
 *  never understated. */
fun curveOf(name: String?): InsulinCurve {
    return insulinByName(name)?.curve ?: ANALOG
}

/** Share of a dose still to act after [minutes], from 1 down to 0. Fiasp at 30 / 60 / 90 / 120 / 180 /
 *  240 min: 94 / 75 / 54 / 36 / 14 / 4 %. */
fun fractionRemaining(minutes: Double, c: InsulinCurve): Double {
    val t = minutes - c.delayMin
    if (t <= 0) return 1.0
    val tp = c.peakMin
    val td = c.durationMin
    if (t >= td) return 0.0
    val tau = tp * (1 - tp / td) / (1 - 2 * tp / td)
    val a = 2 * tau / td
    val s = 1 / (1 - a + (1 + a) * exp(-td / tau))
    val left = 1 - s * (1 - a) * ((t * t / (tau * td * (1 - a)) - t / tau - 1) * exp(-t / tau) + 1)
    return left.coerceIn(0.0, 1.0)
}

/** What is left of one dose, in units. [name] may be null: [fallback] is the patient's usual insulin.
 *  Zero for a background insulin and for a dose not injected yet. */
fun doseUnitsLeft(units: Double, name: String?, tsMs: Long, nowMs: Long, fallback: String? = null): Double {
    val n = name ?: fallback
    if (isBasalInsulin(n)) return 0.0
    val mins = (nowMs - tsMs) / 60000.0
    if (mins < 0) return 0.0
    return units * fractionRemaining(mins, curveOf(n))
}

/** Insulin still working (units) from rapid doses (epoch-ms, units, name), each on its own curve. */
fun iobFromDoses(doses: List<Triple<Long, Double, String?>>, nowMs: Long): Double =
    doses.sumOf { (ts, units, name) -> doseUnitsLeft(units, name, ts, nowMs) }.coerceAtLeast(0.0)

/** One line for the profile screen: says the app knows this insulin, and what it does with it. */
fun insulinInfoLine(name: String?, spanish: Boolean): String? {
    if (name.isNullOrBlank()) return null
    val i = insulinByName(name)
        ?: return if (spanish) "Insulina no reconocida: el cálculo usa una curva prudente."
        else "Insuline non reconnue : le calcul prend une courbe prudente."
    val lasts = i.lastsHours
    if (i.curve == null && lasts != null) {
        val what = when {
            i.cls == InsulinClass.WEEKLY -> if (spanish) "una semana" else "une semaine"
            i.id == "tresiba" -> if (spanish) "más de 42 h" else "plus de 42 h"
            else -> if (spanish) "hasta $lasts h" else "jusqu'à $lasts h"
        }
        return if (spanish) "${i.label}: insulina lenta, dura $what. Nunca cuenta como insulina activa."
        else "${i.label} : insuline lente, dure $what. Ne compte jamais comme insuline active."
    }
    val kind = when (i.cls) {
        InsulinClass.ULTRA_RAPID -> if (spanish) "ultrarrápida" else "ultra-rapide"
        InsulinClass.RAPID -> if (spanish) "rápida" else "rapide"
        InsulinClass.REGULAR -> if (spanish) "humana regular" else "humaine ordinaire"
        InsulinClass.INHALED -> if (spanish) "inhalada" else "inhalée"
        else -> if (spanish) "mezcla" else "mélange"
    }
    return if (spanish) "${i.label}: insulina $kind, actúa sobre todo las primeras 2 h." else "${i.label} : insuline $kind, agit surtout les 2 premières heures."
}
