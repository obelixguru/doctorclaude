package com.drclaude.data

import com.drclaude.ai.AnalysisService

/**
 * CARBS ON BOARD — the food half of the picture the app already draws for insulin.
 *
 * Insulin-on-board answers "how much insulin is still working"; without the matching carb figure,
 * a dose taken WITH the meal it covers reads as a pure drop heading for a hypo, and the user has no
 * way to see that the sugar of a meal eaten 40 minutes ago is still going up. This is the
 * "sucre encore actif" counterpart of [iobFromDoses].
 *
 * Mirrors carbsOnBoard / mealCarbSpeed / cobWindowMin in supabase/functions/_shared/doseGuard.ts —
 * same windows, same word lists, same linear decay — so the screen can never contradict the spoken
 * analysis. Keep the two in step when either changes.
 */

/** Absorption windows, by carb speed. */
private const val COB_WINDOW_FAST_MIN = 120.0   // simple sugars: mostly absorbed within ~2 h
private const val COB_WINDOW_NORMAL_MIN = 180.0 // mixed meal
private const val COB_WINDOW_SLOW_MIN = 240.0   // pasta/legumes/whole-grain/fatty: long, late tail

enum class CarbSpeed { FAST, SLOW, FATTY, NORMAL }

// Fat dominates: it slows gastric emptying, so the rise arrives late whatever the carbs are.
private val FATTY_WORDS = listOf(
    "mcdo", "mcdonald", "burger", "hamburger", "cheeseburger", "royal", "big mac", "whopper",
    "pizza", "frite", "fries", "kebab", "nugget", "tacos", "fromage", "cheese", "gras", "friture",
    "beurre", "bacon", "charcuterie", "raclette", "crème", "creme", "mayo", "pané", "panee", "panée",
)

// Slow carbs are checked BEFORE fast ones, so "pain complet" never falls through to "pain blanc".
private val SLOW_WORDS = listOf(
    "pâtes", "pates", "pasta", "spaghetti", "espagueti", "macaroni", "macarrones", "lasagne", "lasaña", "lasagna",
    "tagliatelle", "penne", "nouilles", "fideos", "ravioli", "gnocchi", "ñoqui",
    "lentille", "lenteja", "lentil", "pois chiche", "garbanzo", "chickpea",
    "haricot", "judía", "judia", "frijol", "alubia", "fève", "haba", "légumineuse", "legumbre",
    "quinoa", "avoine", "avena", "oatmeal", "porridge", "flocons d", "muesli",
    "complet", "intégral", "integral", "complète", "completo", "whole grain", "wholemeal", "wholewheat",
    "riz complet", "riz brun", "arroz integral", "brown rice",
    "patate douce", "boniato", "batata", "sweet potato",
    "pomme de terre", "pommes de terre", "patate", "patates", "patata", "patatas", "papas", "potato",
    "boulgour", "bulgur", "épeautre", "spelt", "orge", "barley", "cebada", "sarrasin", "buckwheat",
)

private val FAST_WORDS = listOf(
    "sucre", "azúcar", "azucar", "sugar", "terrón", "terron", "terrones",
    "bonbon", "caramelo", "caramel", "sucette", "dragée", "dragee",
    "miel", "honey", "confiture", "mermelada", "sirop", "sirope", "syrup",
    "jus de", "jus d'", "zumo", "juice", "soda", "coca", "cola", "fanta", "sprite", "pepsi",
    "limonade", "limonada", "refresco", "ice tea", "thé glacé", "smoothie",
    "pain blanc", "pan blanco", "baguette", "biscotte",
    "corn flakes", "cornflakes", "galette de riz", "riz soufflé", "rice cake",
    "purée", "puré", "datte", "dátil", "datil", "pastèque", "sandía", "sandia", "watermelon",
    "glace", "helado", "sorbet", "sorbete", "compote", "compota",
)

/** Classify a meal's carb speed from its description — no schema, works on every meal already
 *  logged. Fat dominates, then slow signals, then fast; "normal" when nothing matches. */
fun mealCarbSpeed(desc: String?): CarbSpeed {
    val d = (desc ?: "").lowercase()
    if (d.isBlank()) return CarbSpeed.NORMAL
    if (FATTY_WORDS.any { d.contains(it) }) return CarbSpeed.FATTY
    if (SLOW_WORDS.any { d.contains(it) }) return CarbSpeed.SLOW
    if (FAST_WORDS.any { d.contains(it) }) return CarbSpeed.FAST
    return CarbSpeed.NORMAL
}

fun cobWindowMin(speed: CarbSpeed): Double = when (speed) {
    CarbSpeed.FAST -> COB_WINDOW_FAST_MIN
    CarbSpeed.SLOW, CarbSpeed.FATTY -> COB_WINDOW_SLOW_MIN
    CarbSpeed.NORMAL -> COB_WINDOW_NORMAL_MIN
}

/** Grams of [carbsG] eaten at [tsMs] still being absorbed at [nowMs] — linear decay over that
 *  food's own window. 0 once absorbed, and 0 for a meal that hasn't been eaten yet. */
fun carbsStillActive(carbsG: Int?, description: String?, tsMs: Long, nowMs: Long): Double {
    val g = (carbsG ?: 0).toDouble()
    if (g <= 0) return 0.0
    val mins = (nowMs - tsMs) / 60000.0
    if (mins < 0) return 0.0
    val window = cobWindowMin(mealCarbSpeed(description))
    if (mins > window) return 0.0
    return g * (1 - mins / window)
}

/**
 * Total carbs still on board across [meals], in grams.
 *
 * A meal announced for LATER is not counted — it hasn't been eaten. One whose stated time has
 * PASSED is, whatever its stored `planned` flag still says: nothing ever clears that flag, so an
 * announced meal used to stay invisible to this figure for ever. Mirrors isEatenBy on the server.
 */
fun carbsOnBoard(meals: List<AnalysisService.RecentMeal>, nowMs: Long): Double =
    meals.sumOf { m ->
        if (m.ts > nowMs) 0.0 else carbsStillActive(m.carbsG, m.description, m.ts, nowMs)
    }.coerceAtLeast(0.0)

/** Share of the carbs-still-digesting we bank on when asking where the glucose is heading.
 *  MIRRORS COB_TRUST_FRACTION in supabase/functions/_shared/doseGuard.ts — change both together.
 *  Carb absorption is less predictable than insulin action, so the two sides of the balance do not
 *  get equal trust: under-counting food keeps a warning up, over-counting it silences a real one. */
private const val COB_TRUST_FRACTION = 0.7

/**
 * The tug-of-war as one number — the mirror of `glucoseBalance` on the server.
 *
 * Sugar pulls up, insulin pulls down, and the only question that matters is where the rope ends up
 * FROM WHERE THE GLUCOSE IS NOW. Comparing the two forces without the current value is how a widget
 * can announce "insulin leads" at 250 and at 80 with equal conviction: true both times, and useful
 * neither time. `landingMgdl` is deliberately UNCLAMPED — a negative landing is exactly the signal
 * that the fall owed is bigger than the distance to zero.
 *
 * Returns null when it cannot be computed honestly (no reading, or no correction factor to turn
 * units into mg/dL). A caller that gets null must not pretend the sides are even.
 */
data class GlucoseBalance(
    val glucoseMgdl: Int,
    val iobUnits: Double,
    val cobGrams: Double,
    val dropMgdl: Int,      // iob × correction factor
    val riseMgdl: Int,      // (cob / carb ratio) × correction factor, discounted
    val landingMgdl: Int,   // glucose + rise − drop
    val headroomMgdl: Int,  // how far above 70 that lands (negative = under)
    // The same question over the next hour. Totals cannot answer "am I going low", because the two
    // sides do not arrive at the same speed — a pizza's grams land after the insulin has done its
    // work. MIRRORS the soon-half of glucoseBalance on the server.
    val riseSoonMgdl: Int = riseMgdl,
    val dropSoonMgdl: Int = dropMgdl,
    val landingSoonMgdl: Int = landingMgdl,
) {
    val headroomSoonMgdl get() = landingSoonMgdl - 70
    /** The total lands fine but the hour does not: food that arrives too late to stop the fall. */
    val slowFoodMismatch get() = headroomMgdl >= 0 && headroomSoonMgdl < 0
    /** MIRRORS the server's `late` test, which is broader than the mismatch flag: food whose
     *  near-term delivery is less than half its total is arriving late whether or not the totals
     *  happen to balance. Without this the widget stayed silent on the flagship pizza case. */
    val foodArrivesLate get() = slowFoodMismatch || (riseMgdl > 0 && riseSoonMgdl * 2 < riseMgdl)
    val sugarWins get() = riseMgdl > dropMgdl * 1.15
    val insulinWins get() = dropMgdl > riseMgdl * 1.15
}

fun glucoseBalance(
    glucoseMgdl: Int?,
    iobUnits: Double,
    cobGrams: Double,
    carbRatio: Int?,
    correctionFactor: Int?,
    /** Grams landing / units acting within the hour ([carbsLandingWithin], [insulinActingWithin]).
     *  Null → the near-term half falls back to the totals. */
    gramsSoon: Double? = null,
    unitsSoon: Double? = null,
): GlucoseBalance? {
    val g = glucoseMgdl ?: return null
    if (g <= 0) return null
    val isf = correctionFactor?.takeIf { it > 0 } ?: return null
    val drop = iobUnits.coerceAtLeast(0.0) * isf
    // No carb ratio: the food counts as zero here — the safe side, never a guessed rise.
    val rise = carbRatio?.takeIf { it > 0 }?.let { cobGrams.coerceAtLeast(0.0) / it * isf * COB_TRUST_FRACTION } ?: 0.0
    val landing = g + rise - drop
    val riseSoon = gramsSoon?.let { gs ->
        carbRatio?.takeIf { it > 0 }?.let { gs.coerceAtLeast(0.0) / it * isf * COB_TRUST_FRACTION } ?: 0.0
    } ?: rise
    val dropSoon = unitsSoon?.let { it.coerceAtLeast(0.0) * isf } ?: drop
    return GlucoseBalance(
        glucoseMgdl = g, iobUnits = iobUnits.coerceAtLeast(0.0), cobGrams = cobGrams.coerceAtLeast(0.0),
        dropMgdl = Math.round(drop).toInt(), riseMgdl = Math.round(rise).toInt(),
        landingMgdl = Math.round(landing).toInt(), headroomMgdl = Math.round(landing).toInt() - 70,
        riseSoonMgdl = Math.round(riseSoon).toInt(), dropSoonMgdl = Math.round(dropSoon).toInt(),
        landingSoonMgdl = Math.round(g + riseSoon - dropSoon).toInt(),
    )
}

/** The window the "next hour" half of the balance looks at. MIRRORS BALANCE_HORIZON_MIN. */
const val BALANCE_HORIZON_MIN = 60

/** How long before a food STARTS delivering. MIRRORS carbOnsetMin on the server.
 *  A longer window is not a slower start: pasta's 4 h matches rapid insulin's 4 h, so duration alone
 *  can never explain why a pizza drops you at two hours. The delay is what does. */
private fun carbOnsetMin(speed: CarbSpeed): Int = when (speed) {
    CarbSpeed.FAST -> 10
    CarbSpeed.FATTY -> 35
    CarbSpeed.SLOW -> 25
    else -> 15
}

/** Grams that will actually be absorbed within [horizonMin] — the food's delivery ramped from its
 *  onset to the end of its window, integrated over that horizon. NOT a share of what is left:
 *  [carbsOnBoard] says how much has yet to arrive, this says how much arrives in time to matter. */
fun carbsLandingWithin(
    meals: List<AnalysisService.RecentMeal>, nowMs: Long, horizonMin: Int = BALANCE_HORIZON_MIN,
): Double = meals.sumOf { m ->
    val carbs = (m.carbsG ?: 0).toDouble()
    if (carbs <= 0 || m.ts > nowMs) return@sumOf 0.0
    val speed = mealCarbSpeed(m.description)
    val win = cobWindowMin(speed).toDouble()
    val onset = minOf(carbOnsetMin(speed).toDouble(), win - 1)
    val mins = (nowMs - m.ts) / 60000.0
    fun doneBy(x: Double) = ((x - onset) / (win - onset)).coerceIn(0.0, 1.0)
    // Never more than carbsOnBoard says is left: the ramp and the plain decay are two curves over
    // the same food, and near the end of a long window the ramp overtakes it.
    val stillLeft = carbs * (1 - mins / win).coerceAtLeast(0.0)
    minOf(carbs * (doneBy(mins + horizonMin) - doneBy(mins)), stillLeft)
}.coerceAtLeast(0.0)

/** Units that will act within [horizonMin]: what is on board now minus what will still be then. */
fun insulinActingWithin(
    doses: List<AnalysisService.InsulinDose>, nowMs: Long, horizonMin: Int = BALANCE_HORIZON_MIN,
    /** The profile's rapid insulin, used for a dose logged without a name — the server does the
     *  same. Left out, a nameless dose of Actrapid (6 h) was treated as a 4 h analog, and since this
     *  figure is a one-hour SLICE the 3% error on the total became 50% on the slice. */
    profileInsulin: String? = null,
): Double {
    fun iobAt(t: Long) = doses.filter { it.kind != "basal" && it.ts <= nowMs }.sumOf { d ->
        val dur = (insulinActionMinutes(d.name) ?: insulinActionMinutes(profileInsulin) ?: DEFAULT_INSULIN_ACTION_MIN).toDouble()
        val mins = (t - d.ts) / 60000.0
        if (mins in 0.0..dur) d.units * (1 - mins / dur) else 0.0
    }
    return (iobAt(nowMs) - iobAt(nowMs + horizonMin * 60_000L)).coerceAtLeast(0.0)
}
