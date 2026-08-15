package com.drclaude

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restart continuous glucose monitoring after a reboot. Without this, a phone restart silently ends
 * monitoring until the user happens to reopen the app. We only start the service if a session is
 * stored (otherwise there's nothing to poll). Starting a foreground service from BOOT_COMPLETED is
 * an allowed exemption to the background-FGS restrictions.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED ||
            action == "android.intent.action.QUICKBOOT_POWERON"
        ) {
            val app = context.applicationContext as? MechabeticsApp ?: return
            if (app.store.token != null) MonitorService.start(context)
        }
    }
}
