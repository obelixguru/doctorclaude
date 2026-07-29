package com.nueve.mechabetics.data

import com.nueve.mechabetics.data.local.LocalHistoryDb
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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

    // --- Call-rate control. See refresh(). ---
    /** Held for the duration of one refresh so two never run against Abbott at the same time. */
    private val refreshLock = Mutex()
    /** Start of the last refresh, routine or not — the spacing gate reads it. */
    @Volatile private var lastRefreshMs: Long = 0L
    /** While now < this, every automatic call to Abbott is skipped (set on HTTP 429). */
    @Volatile private var rateLimitedUntilMs: Long = 0L
    /** Consecutive polls that came back with "this account follows nobody". See doRefresh(). */
    @Volatile private var emptyConnectionsStreak: Int = 0
    /** Last time an empty graph made us re-read the connection list (throttled — it is a second
     *  request on top of every empty poll, and an empty graph is a completely normal state). */
    @Volatile private var lastEmptyGraphProbeMs: Long = 0L

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
        // ...AND the big number with it. Seeding `history` but leaving `current` null meant the
        // dashboard came back from a relaunch showing a full 24 h curve and a full history list under
        // a dial reading "--": every screen agreed there was data except the one number the app exists
        // to show. It lasted until the first SUCCESSFUL network refresh, so a cold start that hit a
        // 429 (or no network) sat like that for minutes. Restoring lastUpdateMs from the reading's own
        // measurement time is what makes this honest rather than a lie: fresh → the value; older than
        // FRESHNESS_WINDOW_MS → the dashboard's NO SIGNAL card, same as any stale reading. It cannot
        // ring a false alarm either — GlucoseAlert.evaluate drops anything past that same window.
        val last = seed.lastOrNull()
        // Restore the saved patientId into state RIGHT AWAY (not only after the first network
        // refresh) so the Profile/Insulin/Meals screens can load their server data immediately on
        // relaunch — otherwise patientId is null at launch and the profile shows blank until a poll
        // completes (or never, if offline), which read as "my profile data disappeared".
        _state.value = _state.value.copy(
            isLoggedIn = store.token != null,
            patientId = store.patientId,
            history = seed,
            current = last,
            lastUpdateMs = last?.timestampMs ?: 0L
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
                refreshExclusive()
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
        refreshExclusive()
        // A 401 during refresh logs us out (handleError). Re-login once with the saved creds.
        if (!_state.value.isLoggedIn && store.hasCredentials) {
            val r = client.login(acc.email, acc.password)
            if (r is LibreResult.Success) {
                store.patientId = acc.patientId
                _state.value = _state.value.copy(isLoggedIn = true)
                refreshExclusive()
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
        refreshExclusive()
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
                refreshExclusive()
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

    /**
     * The ROUTINE refresh — the 60 s poll, the on-foreground refresh, the Doze watchdog poke. It is
     * deliberately allowed to do nothing.
     *
     * A cold start used to fire three of these within about a second: onStart boots MonitorService
     * (whose poll loop refreshes immediately), onResume refreshes again, and the watchdog pokes a
     * third. Each is up to two calls to Abbott, they overlap, and the followed-people probe below
     * races itself on top — roughly six requests in one breath, from an account that had just been
     * force-restarted. That is the 429 the user sees on relaunch: nothing external rate-limits this
     * app, the app rate-limits itself. Worse, the old stand-down lived only in [startPolling]'s
     * delay, so onResume and the watchdog kept calling right through it and kept the block alive.
     *
     * Three gates, all of them here so every caller gets them: stand down while Abbott is saying 429,
     * never run two refreshes at once ([Mutex.tryLock] — a second caller drops out rather than
     * queueing, because it would only ask for the same value again), and keep a minimum gap between
     * routine refreshes so the launch burst collapses into a single call.
     */
    suspend fun refresh() {
        val now = System.currentTimeMillis()
        if (now < rateLimitedUntilMs) return
        if (now - lastRefreshMs < MIN_REFRESH_GAP_MS) return
        if (!refreshLock.tryLock()) return
        try { doRefresh() } finally { refreshLock.unlock() }
    }

    /**
     * The refresh button. Waits its turn instead of dropping out, and ignores the spacing gate — the
     * user asked, so "nothing happened" is not an acceptable answer. It still honours the 429
     * stand-down: calling Abbott again during a block only re-arms it, and the red banner already
     * says the data is coming back by itself.
     */
    suspend fun refreshManual() {
        if (System.currentTimeMillis() < rateLimitedUntilMs) return
        refreshLock.withLock { doRefresh() }
    }

    /** Login / profile / patient switch: must actually fetch — returning early would leave the screen
     *  showing the previous person. Waits its turn, bypasses both gates. */
    private suspend fun refreshExclusive() = refreshLock.withLock { doRefresh() }

    private suspend fun doRefresh(reloginTried: Boolean = false) {
        lastRefreshMs = System.currentTimeMillis()
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
        //
        // THROTTLED, because an empty graph is not rare: a sensor being changed, the scanning phone
        // out of Bluetooth range, the cloud briefly behind. Probing on every empty poll doubles the
        // request rate for the whole duration of an ordinary signal gap — precisely when the app is
        // least able to afford being rate-limited.
        var g0 = client.fetchGraph(patientId!!)
        val nowMs = System.currentTimeMillis()
        if (g0 is LibreResult.Success && g0.data.history.isEmpty() && g0.data.current == null &&
            nowMs - lastEmptyGraphProbeMs > EMPTY_GRAPH_PROBE_GAP_MS
        ) {
            lastEmptyGraphProbeMs = nowMs
            (client.listConnections() as? LibreResult.Success)?.let { c ->
                // NO connections at all: the account authenticates (every call answers 200) but nobody
                // shares a sensor with it any more — a revoked or expired LibreLinkUp invitation. The
                // graph is then legitimately empty forever, and "NO SIGNAL / rescan your sensor" sends
                // the user chasing hardware that is working. Say the real cause instead.
                //
                // But CONFIRM IT FIRST. This accusation was firing on a single empty answer, and an
                // empty answer is exactly what a soft-throttled or otherwise odd 200 body produced —
                // so the sequence the user actually hit was: 429, block lifts, one strange reply, and
                // a red banner telling them their sharing invitation had been revoked while the graph
                // and the history right under it were fine. Sending someone to reset a working sensor
                // is the worst outcome this screen can produce, so it now takes several consecutive
                // empty answers. A genuine revocation is permanent and still surfaces within minutes.
                if (c.data.isEmpty()) {
                    emptyConnectionsStreak++
                    if (emptyConnectionsStreak >= EMPTY_CONNECTIONS_CONFIRM) {
                        _state.value = _state.value.copy(
                            isLoading = false,
                            error = "Aucun capteur partagé avec ce compte LibreLinkUp. Dans l'app LibreLink du téléphone qui scanne, vérifie que ce compte est bien accepté comme suiveur (invitation révoquée ou expirée)."
                        )
                        return
                    }
                    // Not confirmed yet: leave the shown data — and the known connection list, which
                    // an unconditional copy() used to wipe, taking the parent's patient switcher with
                    // it — exactly as they are, and say nothing.
                    _state.value = _state.value.copy(isLoading = false)
                    return
                }
                emptyConnectionsStreak = 0
                _state.value = _state.value.copy(connections = c.data)
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
                // Real data came back, so any run of "follows nobody" answers was noise, not a
                // revoked invitation.
                emptyConnectionsStreak = 0
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
        // STAND DOWN ON 429, for every caller at once. Abbott says "too many requests" once an account
        // has asked too often; carrying on pins the account against its own limit so the block never
        // lifts. This used to be a delay inside startPolling only, which the on-foreground refresh and
        // the Doze watchdog poke walked straight past. A 429 is NOT a lost session (401/403 are, and
        // those re-login above) — it means stop asking for a while, so waiting is the whole fix.
        if (err.rateLimited) rateLimitedUntilMs = System.currentTimeMillis() + RATE_LIMIT_BACKOFF_MS
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
                    doRefresh(reloginTried = true) // retry with the fresh token
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
            // Sleep long while standing down after a 429. refresh() already refuses to call Abbott
            // during the block, so this only avoids spinning the loop pointlessly — the guarantee
            // lives in the gate, not here. The old version read the stand-down off a substring match
            // on the error text ("429"), which also meant a rate limit hit anywhere else in the app
            // left this loop none the wiser.
            val limited = System.currentTimeMillis() < rateLimitedUntilMs
            delay(if (limited) RATE_LIMIT_BACKOFF_MS else intervalMs)
        }
    }

    companion object {
        /** How long to stand down after an HTTP 429 before polling again. */
        const val RATE_LIMIT_BACKOFF_MS = 10 * 60_000L
        /** Floor between two ROUTINE refreshes. Collapses the launch burst (service start + onResume
         *  + watchdog poke, all within a second or two) into a single call to Abbott. Well under the
         *  60 s poll, so normal polling is untouched. */
        const val MIN_REFRESH_GAP_MS = 15_000L
        /** How long an empty graph is left alone before it may trigger another connections probe. */
        const val EMPTY_GRAPH_PROBE_GAP_MS = 5 * 60_000L
        /** Consecutive "this account follows nobody" answers before the app is willing to tell the
         *  user their sharing invitation was revoked. */
        const val EMPTY_CONNECTIONS_CONFIRM = 3
    }
}
