package com.nueve.mechabetics.data

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Client for the unofficial Abbott LibreLinkUp / LibreView API.
 *
 * Auth flow:
 *  1. POST /llu/auth/login with {email, password}
 *  2. Server may respond with redirect → re-issue against api-<region>.libreview.io
 *  3. Server may respond with "step" = "tou" / "pp" → call /auth/continue/tou (or /pp)
 *  4. On success, extract token (data.authTicket.token) and accountId (data.user.id)
 *  5. account-id header = sha256_hex(accountId)
 *
 * Data flow:
 *  - GET /llu/connections → list of patients
 *  - GET /llu/connections/{patientId}/graph → current value + 5-min history
 */
class LibreLinkUpClient(private val store: CredentialsStore) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        // Overall ceiling on a single call. Without it, a half-open or byte-trickling connection can
        // hang the 60s poll loop indefinitely (read-timeout only fires between reads), silently
        // stalling glucose updates AND alarm evaluation while the UI still shows the last value.
        .callTimeout(45, TimeUnit.SECONDS)
        .build()

    private val baseHost: String
        get() = store.region?.let { "api-$it.libreview.io" } ?: "api.libreview.io"

    private fun baseUrl() = "https://$baseHost"

    // NOTE: deliberately NOT setting "accept-encoding". If we set it manually,
    // OkHttp stops transparently decompressing gzip and hands us raw bytes
    // (→ "Value <garbage> cannot be converted to JSONObject"). Letting OkHttp
    // add it automatically means it also decompresses for us.
    private fun Request.Builder.standardHeaders(): Request.Builder = this
        .addHeader("cache-control", "no-cache")
        .addHeader("connection", "Keep-Alive")
        .addHeader("content-type", "application/json")
        .addHeader("product", "llu.android")
        .addHeader("version", "4.16.0")
        .addHeader("User-Agent", "Mechabetics/1.0 (Android)")

    private fun Request.Builder.authHeaders(): Request.Builder = this.apply {
        store.token?.let { addHeader("authorization", "Bearer $it") }
        store.accountIdHash?.let { addHeader("account-id", it) }
    }

    suspend fun login(email: String, password: String): LibreResult<Unit> = withContext(Dispatchers.IO) {
        store.email = email
        store.password = password
        loginInternal(email, password, redirectsLeft = 2)
    }

    private fun loginInternal(email: String, password: String, redirectsLeft: Int): LibreResult<Unit> {
        val body = JSONObject().apply {
            put("email", email)
            put("password", password)
        }
        val req = Request.Builder()
            .url("${baseUrl()}/llu/auth/login")
            .standardHeaders()
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()

        return try {
            http.newCall(req).execute().use { res ->
                val raw = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    return LibreResult.Error("Login HTTP ${res.code}: ${raw.take(200)}")
                }
                val root = JSONObject(raw)
                val status = root.optInt("status", -1)
                val data = root.optJSONObject("data")

                // Region redirect: {data: {redirect: true, region: "eu"}}
                if (data?.optBoolean("redirect", false) == true) {
                    val region = data.optString("region", "")
                    if (region.isNotEmpty() && redirectsLeft > 0) {
                        store.region = region
                        Log.i(TAG, "Redirected to region: $region")
                        return loginInternal(email, password, redirectsLeft - 1)
                    }
                    return LibreResult.Error("Region redirect without target")
                }

                // Status 2 = TOU / PP step required
                if (status == 4) return LibreResult.Error("Identifiants invalides", needsLogin = true)
                if (data == null) return LibreResult.Error("Réponse de login vide")

                // Standard success: data.authTicket.token + data.user.id
                val authTicket = data.optJSONObject("authTicket")
                val token = authTicket?.optString("token")?.takeIf { it.isNotEmpty() }
                val userId = data.optJSONObject("user")?.optString("id")?.takeIf { it.isNotEmpty() }

                if (token == null || userId == null) {
                    // Step may be required (TOU / PP). Try the continue/tou endpoint.
                    val step = data.optJSONObject("step")
                    val stepType = step?.optString("type", "")
                    if (!stepType.isNullOrEmpty() && redirectsLeft > 0) {
                        Log.i(TAG, "Step required: $stepType")
                        // Reuse any partial token if present so /continue/tou works
                        authTicket?.optString("token")?.takeIf { it.isNotEmpty() }?.let { store.token = it }
                        return acceptStep(stepType, email, password, redirectsLeft - 1)
                    }
                    return LibreResult.Error("Token ou userId manquant dans la réponse")
                }

                store.token = token
                store.accountIdHash = sha256Hex(userId)
                LibreResult.Success(Unit)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Login failed", e)
            LibreResult.Error("Erreur réseau: ${e.message}")
        }
    }

    private fun acceptStep(stepType: String, email: String, password: String, retriesLeft: Int): LibreResult<Unit> {
        val path = when (stepType.lowercase(Locale.ROOT)) {
            "tou" -> "/auth/continue/tou"
            "pp" -> "/auth/continue/pp"
            else -> return LibreResult.Error("Step inconnu: $stepType — accepte les CGU dans l'app officielle")
        }
        val req = Request.Builder()
            .url("${baseUrl()}$path")
            .standardHeaders()
            .authHeaders()
            .post("".toRequestBody(JSON_MEDIA))
            .build()
        return try {
            http.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return LibreResult.Error("$stepType HTTP ${res.code}")
                loginInternal(email, password, retriesLeft)
            }
        } catch (e: Exception) {
            LibreResult.Error("Erreur ${stepType.uppercase()}: ${e.message}")
        }
    }

    suspend fun listConnections(): LibreResult<List<PatientConnection>> = withContext(Dispatchers.IO) {
        if (store.token == null) return@withContext LibreResult.Error("Non connecté", needsLogin = true)
        val req = Request.Builder()
            .url("${baseUrl()}/llu/connections")
            .standardHeaders()
            .authHeaders()
            .get()
            .build()
        try {
            http.newCall(req).execute().use { res ->
                val raw = res.body?.string().orEmpty()
                if (res.code == 401 || res.code == 403) {
                    return@withContext LibreResult.Error("Session expirée", needsLogin = true)
                }
                if (!res.isSuccessful) return@withContext LibreResult.Error("HTTP ${res.code}")
                val root = JSONObject(raw)
                val arr = root.optJSONArray("data")
                if (arr == null) {
                    Log.i("LLU", "connections HTTP=" + res.code + " AUCUN tableau data — compte sans patient partage")
                    return@withContext LibreResult.Success(emptyList())
                }
                val out = mutableListOf<PatientConnection>()
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val current = o.optJSONObject("glucoseMeasurement")?.let(::parseMeasurement)
                    out += PatientConnection(
                        patientId = o.optString("patientId"),
                        firstName = o.optString("firstName"),
                        lastName = o.optString("lastName"),
                        current = current
                    )
                }
                Log.i("LLU", "connections HTTP=" + res.code + " count=" + out.size)
                LibreResult.Success(out)
            }
        } catch (e: Exception) {
            LibreResult.Error("Erreur connexions: ${e.message}")
        }
    }

    suspend fun fetchGraph(patientId: String): LibreResult<GraphSnapshot> = withContext(Dispatchers.IO) {
        if (store.token == null) return@withContext LibreResult.Error("Non connecté", needsLogin = true)
        val req = Request.Builder()
            .url("${baseUrl()}/llu/connections/$patientId/graph")
            .standardHeaders()
            .authHeaders()
            .get()
            .build()
        try {
            http.newCall(req).execute().use { res ->
                val raw = res.body?.string().orEmpty()
                if (res.code == 401 || res.code == 403) {
                    return@withContext LibreResult.Error("Session expirée", needsLogin = true)
                }
                if (!res.isSuccessful) return@withContext LibreResult.Error("HTTP ${res.code}")
                val data = JSONObject(raw).optJSONObject("data")
                    ?: return@withContext LibreResult.Error("Pas de données graph")
                val connection = data.optJSONObject("connection")
                val liveCurrent = connection?.optJSONObject("glucoseMeasurement")?.let(::parseMeasurement)
                val graphArr = data.optJSONArray("graphData")
                val history = buildList {
                    if (graphArr != null) for (i in 0 until graphArr.length()) {
                        parseMeasurement(graphArr.getJSONObject(i))?.let(::add)
                    }
                }.sortedBy { it.timestampMs }
                // LibreLinkUp's live "glucoseMeasurement" is frequently null (sensor not
                // freshly scanned). Fall back to the most recent graph point so the
                // dashboard still shows a current value instead of "--".
                val current = liveCurrent ?: history.lastOrNull()
                // DIAGNOSTIC: HTTP status, how many points came back and how old the newest one is.
                // Deliberately no glucose values, no patient id, no token — enough to tell "the call
                // failed", "the call worked but returned nothing" and "the cloud itself is behind"
                // apart, which is precisely what could not be distinguished from the outside.
                val ageMin = if (current != null) (System.currentTimeMillis() - current.timestampMs) / 60000 else -1L
                Log.i("LLU", "graph HTTP=" + res.code + " points=" + history.size +
                    " live=" + (liveCurrent != null) + " newestAgeMin=" + ageMin)
                // connection.sensor.a = the sensor's activation time (epoch SECONDS); a Libre
                // sensor lives 14 days. Past that, readings stop — surfaced as CAPTEUR EXPIRÉ.
                val sensorEndMs = connection?.optJSONObject("sensor")
                    ?.optLong("a", 0L)?.takeIf { it > 0L }
                    ?.let { it * 1000L + 14L * 24 * 3600 * 1000 }
                LibreResult.Success(GraphSnapshot(current, history, sensorEndMs))
            }
        } catch (e: Exception) {
            LibreResult.Error("Erreur graph: ${e.message}")
        }
    }

    private fun parseMeasurement(o: JSONObject): GlucoseReading? {
        val value = when {
            o.has("ValueInMgPerDl") -> o.optInt("ValueInMgPerDl", -1)
            o.has("Value") -> o.optInt("Value", -1)
            else -> -1
        }
        if (value <= 0) return null
        // Prefer FactoryTimestamp (UTC) so the time is correct on ANY device timezone and matches
        // the server monitor; the `Timestamp` field is the patient's LOCAL time (only right if the
        // phone is in that same TZ). Android then displays it in the device's local zone.
        val factoryTs = o.optString("FactoryTimestamp", "")
        // Drop a reading whose timestamp we can't parse, rather than stamping it "now" — a silent
        // Abbott format change must surface as "signal perdu", never as old data passing for live.
        val ts = (if (factoryTs.isNotEmpty()) parseTimestamp(factoryTs, utc = true)
                  else parseTimestamp(o.optString("Timestamp", ""), utc = false)) ?: return null
        val trendInt = o.optInt("TrendArrow", 0).takeIf { it in 1..5 }
        return GlucoseReading(
            timestampMs = ts,
            valueMgDl = value,
            trend = Trend.fromInt(trendInt),
            isHigh = o.optBoolean("isHigh", false),
            isLow = o.optBoolean("isLow", false)
        )
    }

    private fun parseTimestamp(s: String, utc: Boolean): Long? {
        if (s.isEmpty()) return null
        // Format typique: "5/15/2026 2:32:11 PM". FactoryTimestamp is UTC; Timestamp is device-local.
        for (pattern in TIMESTAMP_PATTERNS) {
            try {
                val sdf = SimpleDateFormat(pattern, Locale.US)
                sdf.timeZone = if (utc) TimeZone.getTimeZone("UTC") else TimeZone.getDefault()
                return sdf.parse(s)?.time ?: continue
            } catch (_: Exception) {}
        }
        // Unparseable (e.g. Abbott changed the format): drop the reading instead of faking "now".
        Log.w(TAG, "Unparseable LibreLinkUp timestamp: '$s'")
        return null
    }

    companion object {
        private const val TAG = "LibreLinkUp"
        private val JSON_MEDIA = "application/json".toMediaType()
        private val TIMESTAMP_PATTERNS = arrayOf(
            "M/d/yyyy h:mm:ss a",
            "MM/dd/yyyy hh:mm:ss a",
            "yyyy-MM-dd'T'HH:mm:ss"
        )

        fun sha256Hex(input: String): String {
            val md = MessageDigest.getInstance("SHA-256")
            val bytes = md.digest(input.toByteArray(Charsets.UTF_8))
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
