package com.drclaude.ai

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Lists/adds meals via the `mechabetics-meals` edge function (subject-keyed). */
class MealsService {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        // Hard overall cap: without it a half-open connection could hang a meal/dose write far past
        // the dialog's spinner — and a dose the user thinks is logged might never land.
        .callTimeout(45, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val t = ApiAccess.token
            chain.proceed(
                if (t != null) chain.request().newBuilder().header("x-mechabetics-access", t).build()
                else chain.request()
            )
        }
        .build()

    data class Meal(val id: Long, val ts: String, val description: String, val carbsG: Int?, val planned: Boolean, val quantity: Int = 1)

    suspend fun list(patientId: String): List<Meal> = withContext(Dispatchers.IO) {
        try {
            val j = post(JSONObject().put("action", "list").put("subject", subjectOf(patientId)))
                ?: return@withContext emptyList()
            val arr = j.optJSONArray("meals") ?: return@withContext emptyList()
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Meal(
                    id = o.optLong("id"),
                    ts = o.optString("ts"),
                    description = o.optString("description"),
                    carbsG = if (o.isNull("carbs_g")) null else o.optInt("carbs_g"),
                    planned = o.optBoolean("planned"),
                    quantity = o.optInt("quantity", 1).coerceAtLeast(1)
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "list failed", e); emptyList()
        }
    }

    /** WHERE the carb figure came from, so a label and a guess are never shown the same way.
     *  "user" typed it · "label_barcode" read off the product · "product_db" a country listing ·
     *  "estimate" the model · "kept" the figure already stored (an edit that didn't touch carbs).
     *  Null when an older server doesn't say.
     *
     *  [planLine] is the code-computed answer to "if I eat this, how much insulin?" — units, when to
     *  inject, and where the food would take the glucose uncovered. Every number in it comes from
     *  the server's dose guard; the app only displays it. Null when there are no carbs to dose, when
     *  the profile has no carb ratio, or against a server that predates it. */
    data class AddResult(
        val ok: Boolean,
        val carbSource: String? = null,
        val productName: String? = null,
        val planLine: String? = null,
        val totalUnits: Double? = null,
        val carbsG: Int? = null,
        /** The PER-UNIT figure the server used, when it had to work it out. Preferred over dividing
         *  [carbsG] back down: the total is clamped at 2000 g, so the division can silently return a
         *  smaller number than the food actually has. */
        val carbsPerUnit: Int? = null,
        /** The meal's time is already past: the prospective question doesn't apply, and no amount of
         *  retrying will produce a dose. Distinguishes "no answer" from "the answer is: too late". */
        val alreadyEaten: Boolean = false,
        /** The meal is SAVED but its carb figure is still being worked out server-side and will be
         *  written onto the row shortly (the server answers fast instead of holding the parent on a
         *  slow model — see the 2026-08-05 « Échec de l'enregistrement » incident). The screen
         *  re-reads the list a few seconds later so the number appears on its own. */
        val carbsPending: Boolean = false,
        /** Row id of the meal that was saved, so the screen can watch THAT row for its carbs
         *  instead of guessing which entry the pending figure belongs to. 0 when unknown. */
        val mealId: Long = 0L,
    )

    /** org.json turns a JSON `null` into the SENTINEL object JSONObject.NULL, and optString on it
     *  returns the four-character string "null" — which would have been rendered to the user, inside
     *  a bordered card, as the dose for their meal. Every nullable field goes through here. */
    private fun str(o: JSONObject?, key: String): String? =
        o?.let { if (it.isNull(key)) null else it.optString(key) }?.takeIf { it.isNotBlank() }

    private fun resultOf(j: JSONObject?): AddResult {
        val ok = j != null && !(j.has("error") && !j.isNull("error"))
        val plan = j?.optJSONObject("plan")
        return AddResult(
            ok = ok,
            carbSource = str(j, "carbSource"),
            productName = str(j?.optJSONObject("carbFact"), "name"),
            planLine = str(j, "planLine"),
            totalUnits = plan?.let { if (it.isNull("totalUnits")) null else it.optDouble("totalUnits") }
                ?.takeIf { !it.isNaN() },
            // The `plan` action returns the carbs at the top level; add/update nest them in `plan`.
            carbsG = plan?.let { if (it.isNull("carbsG")) null else it.optInt("carbsG") }
                ?: j?.let { if (it.isNull("carbsG")) null else it.optInt("carbsG", -1).takeIf { n -> n >= 0 } },
            carbsPerUnit = j?.let { if (it.isNull("carbsPerUnit")) null else it.optInt("carbsPerUnit", -1).takeIf { n -> n >= 0 } },
            // The meal is already eaten: there is no dose to give for it, and no point retrying.
            alreadyEaten = j?.optBoolean("alreadyEaten", false) ?: false,
            carbsPending = j?.optBoolean("carbsPending", false) ?: false,
            mealId = j?.optJSONObject("meal")?.optLong("id", 0L) ?: 0L,
        )
    }

    suspend fun add(patientId: String, description: String, carbsG: Int?, planned: Boolean, tsMs: Long? = null, quantity: Int = 1, lang: String = "fr", carbSource: String? = null): AddResult =
        withContext(Dispatchers.IO) {
            try {
                val meal = JSONObject().put("description", description).put("planned", planned).put("quantity", quantity)
                if (carbsG != null) meal.put("carbsG", carbsG) // per-unit; server stores per-unit × quantity
                if (carbSource != null) meal.put("carbSource", carbSource) // the preview filled the field
                if (tsMs != null) meal.put("ts", tsMs) // backdate a forgotten meal
                resultOf(post(JSONObject().put("action", "add").put("subject", subjectOf(patientId)).put("meal", meal).put("lang", lang)))
            } catch (e: Exception) {
                Log.e(TAG, "add failed", e); AddResult(false)
            }
        }

    /** "If I eat this, how much insulin?" — asked BEFORE anything is written, from the meal form.
     *  Nothing is logged and nothing has to be undone; the server estimates the carbs if they
     *  weren't typed and answers with the same engine the voice path uses. */
    suspend fun plan(patientId: String, description: String, carbsG: Int?, tsMs: Long? = null, quantity: Int = 1, lang: String = "fr"): AddResult =
        withContext(Dispatchers.IO) {
            try {
                val meal = JSONObject().put("description", description).put("quantity", quantity)
                if (carbsG != null) meal.put("carbsG", carbsG)
                if (tsMs != null) meal.put("ts", tsMs) // eating LATER moves the injection, not the maths
                resultOf(post(JSONObject().put("action", "plan").put("subject", subjectOf(patientId)).put("meal", meal).put("lang", lang)))
            } catch (e: Exception) {
                Log.e(TAG, "plan failed", e); AddResult(false)
            }
        }

    /** "No rapid insulin in the last 3 h": what lets a conditional dose become a firm one. */
    suspend fun confirmNoInsulin(patientId: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val j = post(JSONObject().put("action", "confirmNoInsulin").put("subject", subjectOf(patientId)))
            j != null && !(j.has("error") && !j.isNull("error"))
        } catch (e: Exception) {
            Log.e(TAG, "confirmNoInsulin failed", e); false
        }
    }

    /** "The dose you named was not done": closes the question, the next analysis decides afresh. */
    suspend fun doseNotDone(patientId: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val j = post(JSONObject().put("action", "doseNotDone").put("subject", subjectOf(patientId)))
            j != null && !(j.has("error") && !j.isNull("error"))
        } catch (e: Exception) {
            Log.e(TAG, "doseNotDone failed", e); false
        }
    }

    /** Log an insulin dose (the Insulin page). Inserted into mechabetics_insulin → IOB.
     *  kind = "rapid" (counts toward insulin-on-board) or "basal" (slow; excluded from IOB). */
    suspend fun addInsulin(patientId: String, units: Double, name: String?, kind: String = "rapid", tsMs: Long? = null, answersQuestion: Boolean = false): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val ins = JSONObject().put("units", units).put("kind", if (kind == "basal") "basal" else "rapid")
                if (!name.isNullOrBlank()) ins.put("name", name)
                if (tsMs != null) ins.put("ts", tsMs) // backdate a forgotten dose
                if (answersQuestion) ins.put("answersQuestion", true) // from the card asking "was it done?"
                val j = post(JSONObject().put("action", "addInsulin").put("subject", subjectOf(patientId)).put("insulin", ins))
                j != null && !(j.has("error") && !j.isNull("error"))
            } catch (e: Exception) {
                Log.e(TAG, "addInsulin failed", e); false
            }
        }

    /** Edit a meal already in the list (description / carbs / time). Returns the same result as
     *  [add] — an edit changes the carbs, the quantity or the hour, so it changes the dose too, and
     *  returning a bare Boolean is why an edited meal never showed where its carb figure came from. */
    suspend fun update(patientId: String, id: Long, description: String, carbsG: Int?, tsMs: Long? = null, quantity: Int = 1, lang: String = "fr", carbSource: String? = null): AddResult =
        withContext(Dispatchers.IO) {
            try {
                val meal = JSONObject().put("description", description).put("quantity", quantity)
                if (carbsG != null) meal.put("carbsG", carbsG) // per-unit; server stores per-unit × quantity
                if (carbSource != null) meal.put("carbSource", carbSource)
                if (tsMs != null) meal.put("ts", tsMs)
                resultOf(post(JSONObject().put("action", "update").put("subject", subjectOf(patientId)).put("id", id).put("meal", meal).put("lang", lang)))
            } catch (e: Exception) {
                Log.e(TAG, "update failed", e); AddResult(false)
            }
        }

    /** Edit a logged insulin dose (units / name / kind / time). */
    suspend fun updateInsulin(patientId: String, id: Long, units: Double, name: String?, kind: String = "rapid", tsMs: Long? = null): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val ins = JSONObject().put("units", units).put("kind", if (kind == "basal") "basal" else "rapid")
                if (!name.isNullOrBlank()) ins.put("name", name)
                if (tsMs != null) ins.put("ts", tsMs)
                val j = post(JSONObject().put("action", "updateInsulin").put("subject", subjectOf(patientId)).put("id", id).put("insulin", ins))
                j != null && !(j.has("error") && !j.isNull("error"))
            } catch (e: Exception) {
                Log.e(TAG, "updateInsulin failed", e); false
            }
        }

    suspend fun deleteInsulin(patientId: String, id: Long): Boolean = withContext(Dispatchers.IO) {
        try {
            val j = post(JSONObject().put("action", "deleteInsulin").put("subject", subjectOf(patientId)).put("id", id))
            j != null && j.optBoolean("ok", false)
        } catch (e: Exception) {
            Log.e(TAG, "deleteInsulin failed", e); false
        }
    }

    suspend fun delete(patientId: String, id: Long): Boolean = withContext(Dispatchers.IO) {
        try {
            val j = post(JSONObject().put("action", "delete").put("subject", subjectOf(patientId)).put("id", id))
            j != null && j.optBoolean("ok", false)
        } catch (e: Exception) {
            Log.e(TAG, "delete failed", e); false
        }
    }

    // ---- PHYSICAL ACTIVITY ----------------------------------------------------------------------
    // Sport lowers glucose during a session and for hours after. The server has read this table for
    // a long time, but nothing could WRITE to it except the voice Q&A guessing an activity out of a
    // sentence — so it stayed empty and football never once reached a dose. These are the door.
    // `id` is a uuid here (not the bigint the meal/insulin rows use), hence String.

    /** [intensity] is "low" | "moderate" | "high" — the server falls back to the SMALLEST cut when
     *  it is null, so an unknown effort can never over-reduce a child's bolus. */
    data class Activity(
        val id: String,
        val ts: String,
        val kind: String?,
        val description: String?,
        val intensity: String?,
        val durationMin: Int?,
        val planned: Boolean,
    )

    suspend fun listActivity(patientId: String): List<Activity> = withContext(Dispatchers.IO) {
        try {
            val j = post(JSONObject().put("action", "listActivity").put("subject", subjectOf(patientId)))
                ?: return@withContext emptyList()
            val arr = j.optJSONArray("activity") ?: return@withContext emptyList()
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Activity(
                    id = o.optString("id"),
                    ts = o.optString("ts"),
                    kind = o.optString("kind").ifBlank { null },
                    description = o.optString("description").ifBlank { null },
                    intensity = o.optString("intensity").ifBlank { null },
                    durationMin = if (o.isNull("duration_min")) null else o.optInt("duration_min"),
                    planned = o.optBoolean("planned"),
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "listActivity failed", e); emptyList()
        }
    }

    /** [tsMs] null = now. A FUTURE time is meaningful here and kept (the server allows up to +36 h):
     *  "foot à 16 h" logged at 14 h is what lets the meal before it be dosed for the match. */
    suspend fun addActivity(
        patientId: String,
        kind: String,
        description: String?,
        intensity: String?,
        durationMin: Int?,
        planned: Boolean,
        tsMs: Long? = null,
        /** Was he OUTSIDE? Only the user can say — nothing here infers it from a position. */
        outdoor: Boolean? = null,
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val a = JSONObject()
                .put("kind", kind)
                .put("description", description ?: kind)
                .put("planned", planned)
            if (intensity != null) a.put("intensity", intensity)
            if (durationMin != null && durationMin > 0) a.put("durationMin", durationMin)
            if (tsMs != null) a.put("ts", tsMs)
            if (outdoor != null) a.put("outdoor", outdoor)
            val j = post(
                JSONObject().put("action", "addActivity").put("subject", subjectOf(patientId))
                    .put("lang", "fr").put("activity", a)
            )
            j != null && j.optBoolean("ok", false)
        } catch (e: Exception) {
            Log.e(TAG, "addActivity failed", e); false
        }
    }

    suspend fun deleteActivity(patientId: String, id: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val j = post(JSONObject().put("action", "deleteActivity").put("subject", subjectOf(patientId)).put("id", id))
            j != null && j.optBoolean("ok", false)
        } catch (e: Exception) {
            Log.e(TAG, "deleteActivity failed", e); false
        }
    }

    private fun post(body: JSONObject): JSONObject? {
        val req = Request.Builder()
            .url("$FUNCTIONS_BASE/mechabetics-meals")
            .addHeader("Authorization", "Bearer $ANON_KEY")
            .addHeader("content-type", "application/json")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        val res = try { http.newCall(req).execute() } catch (e: Exception) { ServiceHealth.reportUnreachable(); throw e }
        res.use {
            ServiceHealth.reportReachable() // got an HTTP response → backend is reachable
            val raw = res.body?.string().orEmpty()
            if (raw.isBlank()) return null
            return JSONObject(raw)
        }
    }

    private fun subjectOf(patientId: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        return md.digest(patientId.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val TAG = "Meals"
        private const val FUNCTIONS_BASE = "https://vzafttfgrxpjdraveihh.supabase.co/functions/v1"
        private const val ANON_KEY =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6YWZ0dGZncnhwamRyYXZlaWhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMTQ3MDAsImV4cCI6MjA5MjY5MDcwMH0.LX0TVh4BaCLnowQd8wnQLZ95iS_mxeJTaPRn-s7zKko"
    }
}
