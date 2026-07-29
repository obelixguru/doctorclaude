package com.nueve.mechabetics.data

import com.nueve.mechabetics.data.local.LocalHistoryDb
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class GlucoseRepository(
    private val client: LibreLinkUpClient,
    private val store: CredentialsStore,
    private val localDb: LocalHistoryDb? = null
) {
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    // Recent rapid-insulin doses (epoch-ms, units, insulin name), pushed by the UI from the server
    // history. The app is the ONLY thing that logs insulin, so while it's backgrounded these can't
    // change — the background MonitorService can compute an accurate IOB just by decaying them
    // forward. The name lets IOB use each dose's insulin-type duration (Fiasp ≈ 4 h, regular ≈ 6 h).
    @Volatile private var insulinDoses: List<Triple<Long, Double, String?>> = emptyList()

    fun setInsulinDoses(doses: List<Triple<Long, Double, String?>>) { insulinDoses = doses }

    /** Insulin-on-board now (units), insulin-type-aware linear decay — mirrors the UI's IOB. */
    fun iobNow(nowMs: Long): Double = iobFromDoses(insulinDoses, nowMs)

    // Epoch-ms of the last EATEN (non-planned) carbs/sugar, pushed by the UI from the server history,
    // so the BACKGROUND MonitorService's LOW alarm can be rescue-aware (say "let it act" instead of
    // "take sugar now") exactly like the foreground banner + the spoken analysis. 0 = none known.
    // True once we've asked Abbott for the followed-people list in THIS process. See refresh().
    @Volatile private var connectionsTried: Boolean = false

    @Volatile private var lastRescueMs: Long = 0L
    fun setLastRescueMs(ms: Long) { lastRescueMs = ms }
    /** True if sugar was eaten within the rule-of-15 window — mirror of the dose guard's sugar_recent. */
    fun rescueRecent(nowMs: Long): Boolean {
        val ms = lastRescueMs
        return ms > 0L && (nowMs - ms) in 0L..(GlucoseAlert.RESCUE_WINDOW_MIN * 60_000L)
    }

    data class State(
        val isLoggedIn: Boolean = false,
        val isLoading: Boolean = false,
        val current: GlucoseReading? = null,
        val history: List<GlucoseReading> = emptyList(),
        val patientName: String = "",
        val patientId: String? = null,
        val error: String? = null,
        val lastUpdateMs: Long = 0,
        // End of the sensor's 14-day life (from LibreLinkUp), null when unknown. now > sensorEndMs
        // → CAPTEUR EXPIRÉ (the cause of a lost signal) on the dashboard + flagged to the AI.
        val sensorEndMs: Long? = null,
        // Every patient this LibreLinkUp account follows. Usually one, but a parent account can follow
        // several — the Profile tab uses this to offer a patient switcher. Populated on login/refresh.
        val connections: List<PatientConnection> = emptyList()
    )

    fun bootstrap() {
        // Seed the graph from the on-device history (the CGM cloud only serves a ~12-24h window).
        val seed = store.patientId?.let { localDb?.recent(it) }.orEmpty()
        // Restore the saved patientId into state RIGHT AWAY (not only after the first network
        // refresh) so the Profile/Insulin/Meals screens can load their server data immediately on
        // relaunch — otherwise patientId is null at launch and the profile shows blank until a poll
        // completes (or never, if offline), which read as "my profile data disappeared".
        _state.value = _state.value.copy(
            isLoggedIn = store.token != null,
            patientId = store.patientId,
            history = seed
        )
    }

    suspend fun login(email: String, password: String): Boolean {
        connectionsTried = false
        _state.value = _state.value.copy(isLoading = true, error = null)
        val r = client.login(email, password)
        return when (r) {
            is LibreResult.Success -> {
                // Resolve THIS account's patient fresh (don't inherit a previous account's id),
                // and drop any data still shown from a prior profile.
                store.patientId = null
                _state.value = State(isLoggedIn = true, isLoading = true)
                refresh()
                true
            }
            is LibreResult.Error -> {
                _state.value = _state.value.copy(isLoading = false, error = r.message)
                false
            }
        }
    }

    fun logout() {
        // Keep the saved profiles so the user can switch/log back in from the login screen.
        store.clearActiveSession()
        _state.value = State(isLoggedIn = false)
    }

    fun clearError() {
        _state.value = _state.value.copy(error = null)
    }

    /** Wipe the on-device glucose history for the active profile and clear the shown graph.
     *  The next refresh re-seeds the last ~24 h from the cloud — this removes stale/old local points
     *  the user wants gone (the Profile "clear local data" button). */
    fun clearLocalData() {
        localDb?.clear(store.patientId)
        _state.value = _state.value.copy(history = emptyList(), current = null)
    }

    fun savedProfiles(): List<SavedAccount> = store.accounts()

    /**
     * Switch the ACTIVE profile to a saved account. Clears the previous person's data
     * immediately (no bleed), reuses the saved token, and silently re-logs in with the
     * saved password if that token has expired.
     */
    suspend fun switchProfile(email: String): Boolean {
        val acc = store.activateAccount(email) ?: return false
        _state.value = State(
            isLoggedIn = true,
            isLoading = true,
            patientId = acc.patientId,
            patientName = acc.patientName ?: ""
        )
        if (store.token.isNullOrEmpty()) {
            val r = client.login(acc.email, acc.password)
            if (r is LibreResult.Error) {
                _state.value = _state.value.copy(isLoading = false, isLoggedIn = false, error = r.message)
                return false
            }
            store.patientId = acc.patientId // keep the saved patient after a fresh login
        }
        refresh()
        // A 401 during refresh logs us out (handleError). Re-login once with the saved creds.
        if (!_state.value.isLoggedIn && store.hasCredentials) {
            val r = client.login(acc.email, acc.password)
            if (r is LibreResult.Success) {
                store.patientId = acc.patientId
                _state.value = _state.value.copy(isLoggedIn = true)
                refresh()
            }
        }
        return _state.value.isLoggedIn
    }

    /** Re-read the list of patients this account follows (for the Profile switcher), without touching
     *  the active patient/data. Best-effort: a failure keeps whatever list we already have. */
    suspend fun refreshConnections() {
        connectionsTried = false
        if (store.token == null) return
        when (val conns = client.listConnections()) {
            is LibreResult.Success -> _state.value = _state.value.copy(connections = conns.data)
            is LibreResult.Error -> { /* keep the current list */ }
        }
    }

    /**
     * Switch the active PATIENT inside the CURRENT LibreLinkUp account (one follower account can
     * follow several people). Data is already isolated per patient server-side (subject =
     * sha256(patientId)), so this only re-points the active id, wipes the previous person's shown
     * data, resets the (global) alarm episode so a stale HIGH/LOW can't bleed across people, and
     * refreshes. The token re-claim + per-patient caches are keyed on patientId elsewhere and follow
     * automatically. No-op if it's already the active patient.
     */
    suspend fun switchPatient(pid: String, name: String): Boolean {
        if (pid.isBlank() || pid == store.patientId) return false
        store.patientId = pid
        // Alarm bookkeeping is global (one ongoing episode), so drop it — otherwise a "fired HIGH"
        // remembered for the previous patient could suppress or mis-fire the new patient's alarm.
        store.firedAlert = null
        store.ackAlert = null
        store.lastAlarmMs = 0L
        store.lastAlarmValue = 0
        val seed = localDb?.recent(pid).orEmpty()
        _state.value = _state.value.copy(
            isLoggedIn = true,
            isLoading = true,
            error = null,
            patientId = pid,
            patientName = name,
            current = null,
            history = seed
        )
        // No need to rewrite the saved account here — refresh() persists the (account, patient, name)
        // via upsertActiveAccount, and the choice also survives relaunch through store.patientId.
        refresh()
        return _state.value.isLoggedIn
    }

    /**
     * Log in a NEW account while already signed into another. On failure, restore the
     * previously-active profile so the app stays consistent.
     */
    suspend fun addAccount(email: String, password: String): Boolean {
        val previous = store.email
        _state.value = _state.value.copy(isLoading = true, error = null)
        return when (val r = client.login(email, password)) {
            is LibreResult.Success -> {
                store.patientId = null
                _state.value = State(isLoggedIn = true, isLoading = true)
                refresh()
                true
            }
            is LibreResult.Error -> {
                if (!previous.isNullOrBlank() && !previous.equals(email, ignoreCase = true)) {
                    store.activateAccount(previous)
                }
                _state.value = _state.value.copy(isLoading = false, error = r.message)
                false
            }
        }
    }

    /** Forget a saved profile. If it was the active one, switch to another or go to login. */
    suspend fun removeProfile(email: String) {
        val wasActive = store.email.equals(email, ignoreCase = true)
        store.removeAccountFromList(email)
        if (wasActive) {
            store.clearActiveSession()
            val next = store.accounts().firstOrNull()
            if (next != null) switchProfile(next.email)
            else _state.value = State(isLoggedIn = false)
        }
    }

    suspend fun refresh(reloginTried: Boolean = false) {
        _state.value = _state.value.copy(isLoading = true, error = null)

        // Resolve patient id if missing
        var patientId = store.patientId
        var patientName = _state.value.patientName
        if (patientId.isNullOrEmpty()) {
            when (val conns = client.listConnections()) {
                is LibreResult.Error -> {
                    handleError(conns, reloginTried)
                    return
                }
                is LibreResult.Success -> {
                    val first = conns.data.firstOrNull()
                    if (first == null) {
                        _state.value = _state.value.copy(
                            isLoading = false,
                            error = "Aucun capteur lié à ce compte LibreLinkUp"
                        )
                        return
                    }
                    // Remember EVERY followed patient so the Profile tab can offer a switcher.
                    _state.value = _state.value.copy(connections = conns.data)
                    store.patientId = first.patientId
                    patientId = first.patientId
                    patientName = "${first.firstName} ${first.lastName}".trim()
                }
            }
        } else if (_state.value.connections.isEmpty() && !connectionsTried) {
            // ONE-SHOT, and that matters more than it looks. An earlier version also retried whenever
            // the name was blank — but the name stays blank whenever the active patient isn't in the
            // returned list, so the condition never cleared and this fired on EVERY 60 s poll. That
            // doubles the call rate against Abbott's follower API and earns an HTTP 429 within a
            // couple of app launches: the app rate-limits itself. Guarded by a flag so a genuinely
            // empty list costs exactly one extra call per process, never a per-poll retry.
            // The followed-people list lives only in memory and used to be fetched ONLY on the branch
            // above — i.e. only while the active patient was still unknown. After any restart the saved
            // patientId short-circuits it, so the list stayed empty and the name blank: the header read
            // "Capteur FreeStyle" instead of the person, and the Profile switcher (shown only when
            // size > 1) silently vanished — a parent following two people lost access to the second.
            connectionsTried = true
            (client.listConnections() as? LibreResult.Success)?.let { c ->
                _state.value = _state.value.copy(connections = c.data)
                c.data.firstOrNull { it.patientId == patientId }?.let { me ->
                    patientName = "${me.firstName} ${me.lastName}".trim()
                }
            }
        }

        // SELF-HEAL A STALE PATIENT ID. Abbott answers HTTP 200 with an EMPTY graph — no points, no
        // live measurement — when the id we ask for is no longer one of this account's connections.
        // Nothing looks broken from the outside: no error, no 429, a perfectly successful call that
        // simply contains nothing. The saved id then keeps being used forever, so the dial sits on
        // NO SIGNAL, the header shows "Capteur FreeStyle" instead of the person, and the switcher
        // disappears — while the server, which resolves the patient fresh every run, works fine.
        // On an empty graph we re-read the connections once and adopt a valid patient.
        var g0 = client.fetchGraph(patientId!!)
        if (g0 is LibreResult.Success && g0.data.history.isEmpty() && g0.data.current == null) {
            (client.listConnections() as? LibreResult.Success)?.let { c ->
                _state.value = _state.value.copy(connections = c.data)
                // NO connections at all: the account authenticates (every call answers 200) but nobody
                // shares a sensor with it any more — a revoked or expired LibreLinkUp invitation. The
                // graph is then legitimately empty forever, and "NO SIGNAL / rescan your sensor" sends
                // the user chasing hardware that is working. Say the real cause instead.
                if (c.data.isEmpty()) {
                    _state.value = _state.value.copy(
                        isLoading = false,
                        error = "Aucun capteur partagé avec ce compte LibreLinkUp. Dans l'app LibreLink du téléphone qui scanne, vérifie que ce compte est bien accepté comme suiveur (invitation révoquée ou expirée)."
                    )
                    return
                }
                val valid = c.data.firstOrNull { it.patientId == patientId } ?: c.data.firstOrNull()
                if (valid != null && valid.patientId != patientId) {
                    store.patientId = valid.patientId
                    patientId = valid.patientId
                    patientName = ("" + valid.firstName + " " + valid.lastName).trim()
                    g0 = client.fetchGraph(patientId)
                } else if (valid != null && patientName.isBlank()) {
                    patientName = ("" + valid.firstName + " " + valid.lastName).trim()
                }
            }
        }
        when (val g = g0) {
            is LibreResult.Error -> handleError(g, reloginTried)
            is LibreResult.Success -> {
                val snapshot = g.data
                // Merge cloud graph history + the live measurement + our existing in-memory
                // history, dedupe per-minute, keep the NEWEST point as "current". Including
                // snapshot.current makes the fresh live value win over an older graph point
                // (LibreLinkUp's live glucoseMeasurement updates more often than graphData).
                val merged = (snapshot.history + listOfNotNull(snapshot.current) + _state.value.history)
                    .associateBy { it.timestampMs / 60000L }.values
                    .sortedBy { it.timestampMs }
                    .takeLast(400)
                val cur = merged.lastOrNull() ?: snapshot.current
                _state.value = _state.value.copy(
                    isLoading = false,
                    current = cur,
                    history = merged,
                    patientName = patientName,
                    patientId = patientId,
                    // Show WHEN the reading was actually measured (not the poll time), so a
                    // stale sensor shows an old time instead of looking "just updated".
                    lastUpdateMs = cur?.timestampMs ?: System.currentTimeMillis(),
                    // Keep the last known expiry when a poll omits the sensor block (it's a fixed
                    // property of the worn sensor, not per-reading data).
                    sensorEndMs = snapshot.sensorEndMs ?: _state.value.sensorEndMs,
                    error = null
                )
                // Persist this account (token/patient/name) so it stays in the profile switcher.
                store.upsertActiveAccount(patientName)
                // Keep a local copy so history survives beyond the cloud's rolling window (on-device).
                localDb?.save(patientId, merged)
            }
        }
    }

    private suspend fun handleError(err: LibreResult.Error, reloginTried: Boolean = false) {
        if (err.needsLogin) {
            // Token expired/rotated mid-session. Before dropping to the login screen (which silently
            // STOPS background monitoring), try ONE silent re-login with the stored creds and retry
            // the fetch. Only give up — and log out — if that also fails. The reloginTried guard
            // prevents an infinite re-login loop.
            val em = store.email
            val pw = store.password
            if (!reloginTried && !em.isNullOrBlank() && !pw.isNullOrBlank()) {
                if (client.login(em, pw) is LibreResult.Success) {
                    _state.value = _state.value.copy(isLoggedIn = true, error = null)
                    refresh(reloginTried = true) // retry with the fresh token
                    return
                }
            }
            store.clearSession()
            _state.value = _state.value.copy(
                isLoading = false,
                isLoggedIn = false,
                error = err.message
            )
        } else {
            _state.value = _state.value.copy(isLoading = false, error = err.message)
        }
    }

    // Poll every 60 s — the SWEET SPOT. The Libre sensor only produces ONE value per minute, so
    // polling faster returns the same reading again (zero new data) while doubling load on Abbott's
    // follower API. Research note: LibreLinkUp "data cuts" (HTTP 403) come from STALE HEADERS
    // (app version + the now-mandatory account-id), NOT from interval — both are sent by
    // LibreLinkUpClient. Freshness on demand is covered by the immediate refresh on app foreground
    // (MainActivity.onResume) + the manual refresh button.
    suspend fun startPolling(intervalMs: Long = 60_000L) {
        while (true) {
            if (_state.value.isLoggedIn) refresh()
            // BACK OFF ON 429. Abbott answers "too many requests" once an account has asked too often,
            // and carrying on at 60 s then pins the account against its own limit so the block never
            // lifts — the app punishes itself. A 429 is NOT a lost session (401/403 are, and those do
            // trigger a re-login); it means stop asking for a while, so waiting is the only correct
            // response.
            val limited = _state.value.error?.contains("429") == true
            delay(if (limited) RATE_LIMIT_BACKOFF_MS else intervalMs)
        }
    }

    companion object {
        /** How long to stand down after an HTTP 429 before polling again. */
        const val RATE_LIMIT_BACKOFF_MS = 10 * 60_000L
    }
}
