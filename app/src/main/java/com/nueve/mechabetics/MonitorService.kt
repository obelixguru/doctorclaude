package com.nueve.mechabetics

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.nueve.mechabetics.data.AlarmEngine
import com.nueve.mechabetics.data.AlarmPolicy
import com.nueve.mechabetics.data.AlertKind
import com.nueve.mechabetics.data.CredentialsStore
import com.nueve.mechabetics.data.GlucoseAlert
import com.nueve.mechabetics.data.GlucoseRepository
import com.nueve.mechabetics.ui.langFromCode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/**
 * Always-on glucose monitor. This is what makes the app keep watching when it's backgrounded, the
 * screen is off, or the task is swiped away — the previous design ran polling + alarm evaluation
 * inside Compose, so monitoring died exactly when it mattered most (a child going low overnight).
 *
 * It is the SOLE poller (the UI no longer polls) and it owns the BACKGROUND alarm: while the app is
 * in the foreground the on-screen logic rings (and shows the banner / speaks); the moment the app
 * goes to the background ([appForeground] = false) this service takes over ringing, sharing the same
 * snooze/escalation bookkeeping (in CredentialsStore) so the handover is seamless. It reuses the
 * exact same [GlucoseAlert.evaluate] + [AlarmEngine.decide] the UI uses, so the two never disagree.
 *
 * Deep-Doze hardening (the "it only scans when I unlock the phone" fix): a foreground service alone
 * keeps the PROCESS alive but not the CPU, so the moment the device deep-sleeps the [delay]-based
 * poll loop is frozen and glucose stops refreshing until the screen comes back on. Three things keep
 * it polling through standby: (1) a partial [PowerManager.WakeLock] held here keeps the CPU awake so
 * the 60 s loop keeps firing screen-off; (2) the user whitelisting the app from battery optimization
 * ([PowerExemption]) stops Samsung One UI from freezing/killing it and unblocks network in Doze;
 * (3) [MonitorWatchdogReceiver] re-asserts + re-polls every ~10 min in case the OS killed it anyway.
 */
class MonitorService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var repo: GlucoseRepository
    private lateinit var store: CredentialsStore
    private var pollJob: Job? = null
    private var watchJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val app = application as MechabeticsApp
        repo = app.repo
        store = app.store
        startForegroundCompat(buildOngoing(repo.state.value.current?.valueMgDl))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }
        // Re-assert foreground (Android may redeliver) and (re)start the loops if not already running.
        startForegroundCompat(buildOngoing(repo.state.value.current?.valueMgDl))
        ensureRunning()
        // A watchdog wake (Doze) asks for a refresh RIGHT NOW so a 10 min tick doesn't have to wait a
        // full poll cycle for fresh data after the device thaws.
        if (intent?.action == ACTION_POKE) {
            scope.launch {
                try { if (repo.state.value.isLoggedIn) repo.refresh() }
                catch (e: Exception) { Log.e(TAG, "poke refresh failed", e) }
            }
        }
        return START_STICKY
    }

    private fun ensureRunning() {
        // Keep the CPU awake so the poll loop's delay() keeps firing screen-off, and arm the Doze
        // watchdog. Both are idempotent (no-op if already held / scheduled).
        acquireWakeLock()
        MonitorWatchdogReceiver.schedule(this)
        if (pollJob?.isActive != true) {
            pollJob = scope.launch {
                try { repo.startPolling() } catch (e: Exception) { Log.e(TAG, "polling stopped", e) }
            }
        }
        if (watchJob?.isActive != true) {
            watchJob = scope.launch {
                repo.state.collect { st ->
                    evaluateAndRing(st)
                    runCatching { notify(buildOngoing(st.current?.valueMgDl)) }
                }
            }
        }
    }

    /** Background alarm. No-op while the app is in the foreground (the UI rings there). */
    private fun evaluateAndRing(st: GlucoseRepository.State) {
        if (appForeground) return
        if (!st.isLoggedIn) return
        val now = System.currentTimeMillis()
        val alert = GlucoseAlert.evaluate(st.current, st.history, repo.iobNow(now), now)
        val book = AlarmEngine.Bookkeeping(store.firedAlert, store.lastAlarmMs, store.lastAlarmValue)
        val dec = AlarmEngine.decide(alert, book, now)
        // Persist the (possibly updated) bookkeeping so the foreground UI continues the same episode.
        store.firedAlert = dec.book.firedKind
        store.lastAlarmMs = dec.book.lastAlarmMs
        store.lastAlarmValue = dec.book.lastAlarmValue
        if (dec.recovered) {
            store.ackAlert = null
            AlarmService.stop(this)
            return
        }
        if (dec.ring) {
            store.ackAlert = null
            // Resolve the user's notification settings (per-type, volume, vibrate, quiet hours) the
            // same way the foreground does. eff.ring=false → this type is switched off entirely.
            val eff = AlarmPolicy.effect(alert.kind, store.alarmSettings(), minuteOfDay(now))
            if (eff.ring) {
                val lang = langFromCode(store.language)
                val (title, body) = alarmTitleBody(alert, lang, repo.rescueRecent(now))
                AlarmService.start(this, title, body, eff.volumePct, eff.vibrate)
            }
        }
    }

    /** Hold the CPU awake so the 60 s poll loop's delay() keeps firing with the screen off. Without
     *  this the coroutine is frozen the instant the device deep-sleeps and glucose stops refreshing
     *  until the screen is unlocked — the reported "only scans when I open it" bug. Battery cost is
     *  the accepted trade-off for a continuous glucose monitor (and is mitigated by the radio only
     *  waking ~once a minute). Released on stop/destroy. */
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        try {
            val pm = getSystemService(PowerManager::class.java)
            wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG)?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.e(TAG, "wakelock acquire failed", e)
        }
    }

    private fun releaseWakeLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
    }

    private fun startForegroundCompat(n: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIF_ID, n)
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed", e)
        }
    }

    private fun notify(n: Notification) {
        getSystemService(NotificationManager::class.java)?.notify(NOTIF_ID, n)
    }

    private fun buildOngoing(lastValue: Int?): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Surveillance glycémie", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Notification discrète pendant que la glycémie est surveillée en continu."
                setShowBadge(false)
            }
            nm?.createNotificationChannel(ch)
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val text = if (lastValue != null) "Glycémie suivie · dernière mesure $lastValue mg/dL"
                   else "Surveillance de la glycémie active"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Doctor Claude")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .build()
    }

    private fun stopEverything() {
        pollJob?.cancel(); pollJob = null
        watchJob?.cancel(); watchJob = null
        MonitorWatchdogReceiver.cancel(this)
        releaseWakeLock()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else @Suppress("DEPRECATION") stopForeground(true)
        stopSelf()
    }

    override fun onDestroy() {
        // Always free the wakelock even if we're killed without an explicit stop.
        releaseWakeLock()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MonitorService"
        private const val CHANNEL_ID = "mechabetics_monitor"
        private const val NOTIF_ID = 4202
        private const val WAKELOCK_TAG = "mechabetics:monitor"
        const val ACTION_STOP = "com.nueve.mechabetics.MONITOR_STOP"
        const val ACTION_POKE = "com.nueve.mechabetics.MONITOR_POKE"

        /** Set by MainActivity (onStart/onStop). While true the UI owns the ring; while false the
         *  service rings. Shared so only ONE of them sounds at a time. */
        @Volatile
        var appForeground = false

        /** Start (or re-assert) continuous monitoring. Safe to call repeatedly. */
        fun start(context: Context) {
            val i = Intent(context, MonitorService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
                else context.startService(i)
            } catch (e: Exception) {
                Log.e(TAG, "start failed", e)
            }
        }

        /** Watchdog wake: (re)start monitoring AND fetch immediately. Starts the service as a
         *  foreground service so it's allowed to run; if a background-FGS-start is blocked (app not
         *  yet battery-exempt on Android 12+) the exception is swallowed — the next foreground or the
         *  battery-exemption grant recovers it. */
        fun poke(context: Context) {
            val i = Intent(context, MonitorService::class.java).setAction(ACTION_POKE)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
                else context.startService(i)
            } catch (e: Exception) {
                Log.e(TAG, "poke failed", e)
            }
        }

        fun stop(context: Context) {
            try {
                context.startService(Intent(context, MonitorService::class.java).setAction(ACTION_STOP))
            } catch (_: Exception) { /* not running */ }
        }
    }
}
