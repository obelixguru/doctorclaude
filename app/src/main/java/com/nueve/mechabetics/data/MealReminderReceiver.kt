package com.nueve.mechabetics.data

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.nueve.mechabetics.MainActivity
import java.util.Calendar

/**
 * Meal-time reminders every 4h between 08:00 and 20:00 (08, 12, 16, 20). Each is a one-shot
 * alarm that reschedules the next slot on fire, so no exact-alarm permission is needed.
 * Toggleable in the Profile page (persisted in CredentialsStore.mealRemindersEnabled).
 */
class MealReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (CredentialsStore(context).mealRemindersEnabled) {
            postReminder(context)
            schedule(context) // chain the next slot
        }
    }

    private fun postReminder(context: Context) {
        val es = CredentialsStore(context).language == "es"
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, if (es) "Recordatorios" else "Rappels", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("Dr Claude")
            .setContentText(
                if (es) "Hora de revisar la glucosa y registrar la comida."
                else "C'est l'heure de vérifier la glycémie et de loguer le repas."
            )
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        nm.notify(NOTIF_ID, n)
    }

    companion object {
        private const val CHANNEL_ID = "mechabetics_reminders"
        private const val NOTIF_ID = 4300
        private const val REQ = 4301
        private val HOURS = intArrayOf(8, 12, 16, 20)

        private fun pending(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context, REQ,
            Intent(context, MealReminderReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        /** Schedule the next 08/12/16/20 slot (tomorrow's 08:00 if the day is over). */
        fun schedule(context: Context) {
            val am = context.getSystemService(AlarmManager::class.java) ?: return
            val next = Calendar.getInstance()
            val currentHour = next.get(Calendar.HOUR_OF_DAY)
            val slot = HOURS.firstOrNull { it > currentHour }
            if (slot != null) {
                next.set(Calendar.HOUR_OF_DAY, slot)
            } else {
                next.add(Calendar.DAY_OF_YEAR, 1)
                next.set(Calendar.HOUR_OF_DAY, HOURS.first())
            }
            next.set(Calendar.MINUTE, 0)
            next.set(Calendar.SECOND, 0)
            next.set(Calendar.MILLISECOND, 0)
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.timeInMillis, pending(context))
        }

        fun cancel(context: Context) {
            context.getSystemService(AlarmManager::class.java)?.cancel(pending(context))
        }

        fun apply(context: Context, enabled: Boolean) {
            if (enabled) schedule(context) else cancel(context)
        }
    }
}
