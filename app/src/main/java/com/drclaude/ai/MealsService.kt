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

    suspend fun add(patientId: String, description: String, carbsG: Int?, planned: Boolean, tsMs: Long? = null, quantity: Int = 1): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val meal = JSONObject().put("description", description).put("planned", planned).put("quantity", quantity)
                if (carbsG != null) meal.put("carbsG", carbsG) // per-unit; server stores per-unit × quantity
                if (tsMs != null) meal.put("ts", tsMs) // backdate a forgotten meal
                val j = post(JSONObject().put("action", "add").put("subject", subjectOf(patientId)).put("meal", meal))
                j != null && !(j.has("error") && !j.isNull("error"))
            } catch (e: Exception) {
                Log.e(TAG, "add failed", e); false
            }
        }

    /** Log an insulin dose (the Insulin page). Inserted into mechabetics_insulin → IOB.
     *  kind = "rapid" (counts toward insulin-on-board) or "basal" (slow; excluded from IOB). */
    suspend fun addInsulin(patientId: String, units: Double, name: String?, kind: String = "rapid", tsMs: Long? = null): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val ins = JSONObject().put("units", units).put("kind", if (kind == "basal") "basal" else "rapid")
                if (!name.isNullOrBlank()) ins.put("name", name)
                if (tsMs != null) ins.put("ts", tsMs) // backdate a forgotten dose
                val j = post(JSONObject().put("action", "addInsulin").put("subject", subjectOf(patientId)).put("insulin", ins))
                j != null && !(j.has("error") && !j.isNull("error"))
            } catch (e: Exception) {
                Log.e(TAG, "addInsulin failed", e); false
            }
        }

    /** Edit a meal already in the list (description / carbs / time). */
    suspend fun update(patientId: String, id: Long, description: String, carbsG: Int?, tsMs: Long? = null, quantity: Int = 1): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val meal = JSONObject().put("description", description).put("quantity", quantity)
                if (carbsG != null) meal.put("carbsG", carbsG) // per-unit; server stores per-unit × quantity
                if (tsMs != null) meal.put("ts", tsMs)
                val j = post(JSONObject().put("action", "update").put("subject", subjectOf(patientId)).put("id", id).put("meal", meal))
                j != null && !(j.has("error") && !j.isNull("error"))
            } catch (e: Exception) {
                Log.e(TAG, "update failed", e); false
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
