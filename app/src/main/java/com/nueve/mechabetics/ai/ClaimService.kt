package com.nueve.mechabetics.ai

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Holds the per-device CAPABILITY TOKEN (issued by the `mechabetics-claim` edge function after it
 * proves, server-side, that this LibreLinkUp session can read the patient). Every edge-function call
 * sends it as the `x-mechabetics-access` header (via an OkHttp interceptor in each service), so the
 * server can require a secret only the proven owner holds — instead of trusting a guessable subject
 * hash. `@Volatile` because the interceptors read it from background threads.
 */
object ApiAccess {
    @Volatile
    var token: String? = null
}

/**
 * Claims a capability token for the active patient. The proof is the LibreLinkUp session itself:
 * the server calls `/llu/connections` with these credentials and only mints a token if this session
 * actually lists that patient. Non-breaking — the token is obtained + sent now, but the other
 * functions only start REQUIRING it in the later enforcement step.
 */
class ClaimService {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    /** Returns the capability token, or null on any failure (kept silent — never blocks the app). */
    suspend fun claim(patientId: String, lluToken: String, region: String?, accountIdHash: String?): String? =
        withContext(Dispatchers.IO) {
            if (patientId.isBlank() || lluToken.isBlank() || accountIdHash.isNullOrBlank()) return@withContext null
            try {
                val body = JSONObject()
                    .put("patientId", patientId)
                    .put("lluToken", lluToken)
                    .put("region", region ?: "")
                    .put("accountIdHash", accountIdHash)
                    .put("label", "android")
                    .toString()
                val req = Request.Builder()
                    .url("$FUNCTIONS_BASE/mechabetics-claim")
                    .addHeader("Authorization", "Bearer $ANON_KEY")
                    .addHeader("content-type", "application/json")
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(req).execute().use { resp ->
                    val txt = resp.body?.string() ?: return@withContext null
                    val j = JSONObject(txt)
                    if (j.optBoolean("ok", false)) j.optString("token").takeIf { it.isNotBlank() } else null
                }
            } catch (_: Exception) {
                null
            }
        }

    companion object {
        private const val FUNCTIONS_BASE = "https://vzafttfgrxpjdraveihh.supabase.co/functions/v1"
        private const val ANON_KEY =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6YWZ0dGZncnhwamRyYXZlaWhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMTQ3MDAsImV4cCI6MjA5MjY5MDcwMH0.LX0TVh4BaCLnowQd8wnQLZ95iS_mxeJTaPRn-s7zKko"
    }
}
