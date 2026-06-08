package com.nueve.mechabetics.ai

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

/** Loads/saves the patient profile via the `mechabetics-profile` edge function.
 *  Keyed by the same pseudonymous subject hash (sha256 of patientId) as coach/ask. */
class ProfileService {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        // Hard overall cap so a hung connection can't leave the profile "Saving…" spinner forever.
        .callTimeout(40, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val t = ApiAccess.token
            chain.proceed(
                if (t != null) chain.request().newBuilder().header("x-mechabetics-access", t).build()
                else chain.request()
            )
        }
        .build()

    data class SaveResult(val profile: JSONObject?, val error: String?)

    suspend fun load(patientId: String): JSONObject? = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().put("action", "load").put("subject", subjectOf(patientId))
            val j = post(body) ?: return@withContext null
            if (j.isNull("profile")) null else j.optJSONObject("profile")
        } catch (e: Exception) {
            Log.e(TAG, "load failed", e); null
        }
    }

    suspend fun save(patientId: String, fields: JSONObject): SaveResult = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().put("action", "save").put("subject", subjectOf(patientId)).put("profile", fields)
            val j = post(body) ?: return@withContext SaveResult(null, "Reseau indisponible")
            if (j.has("error") && !j.isNull("error")) SaveResult(null, j.optString("error"))
            else SaveResult(j.optJSONObject("profile"), null)
        } catch (e: Exception) {
            Log.e(TAG, "save failed", e); SaveResult(null, e.message ?: "Erreur")
        }
    }

    private fun post(body: JSONObject): JSONObject? {
        val req = Request.Builder()
            .url("$FUNCTIONS_BASE/mechabetics-profile")
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
        private const val TAG = "Profile"
        private const val FUNCTIONS_BASE = "https://vzafttfgrxpjdraveihh.supabase.co/functions/v1"
        private const val ANON_KEY =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6YWZ0dGZncnhwamRyYXZlaWhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMTQ3MDAsImV4cCI6MjA5MjY5MDcwMH0.LX0TVh4BaCLnowQd8wnQLZ95iS_mxeJTaPRn-s7zKko"
    }
}
