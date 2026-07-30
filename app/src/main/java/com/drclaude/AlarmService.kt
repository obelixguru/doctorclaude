package com.drclaude

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat

/**
 * Foreground service that shows a glucose-alert notification and plays a SHORT REPEATED chime
 * (a two-note "ding-dong" on the ALARM stream so it's actually audible and not silenced by
 * Do-Not-Disturb, repeated a few times then it stops by itself — audible but deliberately not
 * house-waking) plus a short vibration, and a full-screen intent so a locked screen lights up.
 * The notification carries a STOP action and opens the app on tap.
 *
 * Whether it sounds AT ALL is the caller's decision (gated on the user's "alarm sound" setting in
 * Profile). It is silenced by: the STOP action, tapping the notification (opens app → onResume
 * stops it), or opening the app. It also self-clears after a short delay so nothing lingers.
 */
class AlarmService : Service() {

    @Volatile private var playing = false
    private var audioTrack: AudioTrack? = null
    private var toneThread: Thread? = null
    private var vibrator: Vibrator? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val autoStop = Runnable { stopEverything(); stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            stopSelf()
            return START_NOT_STICKY
        }
        val wasRinging = isRinging
        isRinging = true
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Alerte glycémie"
        val body = intent?.getStringExtra(EXTRA_BODY).orEmpty()
        // The caller (AlarmPolicy via the UI / MonitorService) resolves the user's volume + vibrate.
        val volumePct = (intent?.getIntExtra(EXTRA_VOLUME, 70) ?: 70).coerceIn(0, 100)
        val vibrate = intent?.getBooleanExtra(EXTRA_VIBRATE, true) ?: true
        startForeground(NOTIF_ID, buildNotification(title, body))
        // Chime + buzz ONCE per episode; an OS redelivery / refresh never restarts them.
        if (!wasRinging) chimeOnce(volumePct, vibrate)
        // Self-clear after a bit so the notification/service never lingers indefinitely.
        mainHandler.removeCallbacks(autoStop)
        mainHandler.postDelayed(autoStop, MAX_RING_MS)
        // NOT sticky: a redelivery after the process is killed arrives with a null intent, i.e. an
        // alarm with no glucose reading behind it, chiming the defaults for a situation nobody
        // measured. If a real alert still stands, the next reading raises it again.
        return START_NOT_STICKY
    }

    private fun buildNotification(title: String, body: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Alertes glycémie", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Alerte hypo / hyper et chute rapide (chime doux)"
                enableVibration(false) // we fire one short, gentle vibration ourselves
                setSound(null, null)   // we play a soft chime ourselves
            }
            nm.createNotificationChannel(ch)
        }
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, AlarmService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .setFullScreenIntent(openApp, true) // wake / illuminate a locked screen for a real alert
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "STOP", stop)
            .build()
    }

    // ── Soft chime ("ding-dong"), played at the user's chosen volume + optional vibration ─────────
    private fun chimeOnce(volumePct: Int, vibrate: Boolean) {
        // volumePct == 0 → no sound at all (the caller resolved "vibreur"/"silencieux" or quiet hours);
        // we still vibrate if asked. Otherwise scale the ALARM-stream track to the chosen loudness.
        if (volumePct > 0) {
            playing = true
            val gain = (volumePct / 100f).coerceIn(0f, 1f)
            val t = Thread {
                try {
                    val sr = 44100
                    val chime = buildChime(sr)
                    val minBuf = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
                    val track = AudioTrack.Builder()
                        .setAudioAttributes(
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ALARM) // alarm stream: audible + not DND-silenced
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                .build()
                        )
                        .setAudioFormat(
                            AudioFormat.Builder()
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setSampleRate(sr)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .build()
                        )
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .setBufferSizeInBytes(maxOf(minBuf, chime.size * 2))
                        .build()
                    audioTrack = track
                    track.setVolume(gain) // user-set loudness on top of the system alarm volume
                    track.play()
                    val silence = ShortArray(sr * 650 / 1000) // ~0.65 s between repeats
                    var cycles = 0
                    while (playing && cycles < CHIME_REPEATS) {
                        var idx = 0
                        while (playing && idx < chime.size) {
                            val end = minOf(idx + 1024, chime.size)
                            val written = track.write(chime, idx, end - idx)
                            if (written < 0) break
                            idx = end
                        }
                        cycles++
                        if (playing && cycles < CHIME_REPEATS) {
                            var g = 0
                            while (playing && g < silence.size) {
                                val end = minOf(g + 1024, silence.size)
                                if (track.write(silence, g, end - g) < 0) break
                                g = end
                            }
                        }
                    }
                    playing = false // repeats done
                } catch (_: Exception) { /* sound best-effort; vibration still fires */ }
            }
            toneThread = t
            t.start()
        }
        if (vibrate) gentleVibrate()
    }

    /** Two soft notes (G5 → C6), low amplitude, with fades → a calm "ding-dong". */
    private fun buildChime(sr: Int): ShortArray {
        val n1 = tone(sr, 784.0, 180, amp = 0.45)   // G5
        val gap = ShortArray(sr * 70 / 1000)
        val n2 = tone(sr, 1047.0, 260, amp = 0.42)  // C6
        return concat(n1, gap, n2)
    }

    private fun tone(sr: Int, freqHz: Double, ms: Int, amp: Double): ShortArray {
        val n = sr * ms / 1000
        val out = ShortArray(n)
        val fade = (sr * 12 / 1000).coerceAtLeast(1) // 12ms fade in/out = soft attack/decay
        for (i in 0 until n) {
            val s = Math.sin(2.0 * Math.PI * freqHz * i / sr) * amp
            val env = when {
                i < fade -> i.toDouble() / fade
                i > n - fade -> (n - i).toDouble() / fade
                else -> 1.0
            }
            out[i] = (s * env * Short.MAX_VALUE).toInt().toShort()
        }
        return out
    }

    private fun concat(vararg arrays: ShortArray): ShortArray {
        val total = arrays.sumOf { it.size }
        val out = ShortArray(total)
        var pos = 0
        for (a in arrays) {
            System.arraycopy(a, 0, out, pos, a.size)
            pos += a.size
        }
        return out
    }

    /** One short, soft buzz — not a repeating waveform. */
    private fun gentleVibrate() {
        try {
            vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                getSystemService(VibratorManager::class.java).defaultVibrator
            } else {
                @Suppress("DEPRECATION") getSystemService(VIBRATOR_SERVICE) as Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createOneShot(250, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION") vibrator?.vibrate(250)
            }
        } catch (_: Exception) { }
    }

    private fun stopEverything() {
        playing = false
        isRinging = false
        mainHandler.removeCallbacks(autoStop)
        try { audioTrack?.pause() } catch (_: Exception) {}
        try { audioTrack?.flush() } catch (_: Exception) {}
        try { audioTrack?.stop() } catch (_: Exception) {}
        try { audioTrack?.release() } catch (_: Exception) {}
        audioTrack = null
        try { toneThread?.interrupt() } catch (_: Exception) {}
        try { toneThread?.join(200) } catch (_: Exception) {}
        toneThread = null
        try { vibrator?.cancel() } catch (_: Exception) {}
        vibrator = null
    }

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "mechabetics_alarm"
        private const val NOTIF_ID = 4201
        private const val MAX_RING_MS = 60_000L // self-clear after a minute if nothing else does
        private const val CHIME_REPEATS = 2     // ding-dong repeats per alert (was 4 — "plusieurs bips")
        const val ACTION_STOP = "com.drclaude.ALARM_STOP"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_BODY = "body"
        private const val EXTRA_VOLUME = "volume_pct"
        private const val EXTRA_VIBRATE = "vibrate"

        /** True while the alert notification is up — lets the app no-op a stop when idle. */
        @Volatile
        private var isRinging = false

        fun start(context: Context, title: String, body: String, volumePct: Int = 70, vibrate: Boolean = true) {
            val i = Intent(context, AlarmService::class.java)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_BODY, body)
                .putExtra(EXTRA_VOLUME, volumePct)
                .putExtra(EXTRA_VIBRATE, vibrate)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
            else context.startService(i)
        }

        fun stop(context: Context) {
            if (!isRinging) return
            try {
                context.startService(Intent(context, AlarmService::class.java).setAction(ACTION_STOP))
            } catch (_: Exception) { /* not running */ }
        }
    }
}
