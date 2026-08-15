package com.drclaude

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * Battery-optimization (Doze) exemption helpers.
 *
 * On stock Android — and ESPECIALLY on Samsung One UI (the Galaxy A32 this app targets) — an app
 * that isn't whitelisted is frozen in standby: the foreground service is killed, the monitoring
 * wakelock is ignored and network is cut, so glucose only refreshes when the screen is unlocked.
 * That is exactly the "it only scans when I open it" failure. Whitelisting the app is what lets
 * [MonitorService] keep its CPU wakelock honoured and its network reachable through deep sleep.
 */
object PowerExemption {

    /** True if the OS will NOT throttle this app in Doze (user granted the exemption). */
    fun isExempt(context: Context): Boolean {
        val pm = context.getSystemService(PowerManager::class.java) ?: return true
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Show the system "let the app always run in the background?" dialog. Falls back to the
     * battery-optimization settings list if the direct request isn't available on this OEM build.
     * Best-effort — never throws.
     */
    fun request(context: Context) {
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }.onFailure { openSettings(context) }
    }

    /** Open the OS battery-optimization list (manual fallback). */
    fun openSettings(context: Context) {
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
    }
}
