package com.nueve.mechabetics

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Doze-proof watchdog for [MonitorService].
 *
 * The service holds a partial wakelock so its 60 s poll loop keeps ticking while the screen is off,
 * but Samsung One UI (the Galaxy A32) can still freeze or outright kill a foreground service in deep
 * sleep. This receiver fires ~every 10 min via an allow-while-idle alarm — which the OS delivers
 * even in Doze — re-asserts the service (restarting it if it was killed) + pokes an immediate
 * refresh, then reschedules the next tick.
 *
 * [AlarmManager.setAndAllowWhileIdle] needs NO exact-alarm permission (same as MealReminderReceiver)
 * and is rate-limited to ~once / 9 min in Doze, so a 10 min cadence is honoured. The restart can
 * only start a foreground service from the background once the app is battery-optimization-exempt
 * (see [PowerExemption]); [MonitorService.poke] swallows the block otherwise.
 */
class MonitorWatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as? MechabeticsApp ?: return
        if (app.store.token != null) {
            MonitorService.poke(context) // restart-if-dead + immediate refresh
            schedule(context)            // chain the next tick
        }
    }

    companion object {
        private const val TAG = "MonitorWatchdog"
        private const val REQ = 4400
        private const val INTERVAL_MS = 10 * 60_000L

        private fun pending(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context, REQ,
            Intent(context, MonitorWatchdogReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        /** (Re)arm the next watchdog tick. Safe to call repeatedly — it just resets the one alarm. */
        fun schedule(context: Context) {
            val am = context.getSystemService(AlarmManager::class.java) ?: return
            val at = System.currentTimeMillis() + INTERVAL_MS
            try {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context))
            } catch (e: Exception) {
                Log.e(TAG, "schedule failed", e)
            }
        }

        fun cancel(context: Context) {
            context.getSystemService(AlarmManager::class.java)?.cancel(pending(context))
        }
    }
}
