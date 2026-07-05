package com.nueve.mechabetics

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide view of whether the PHONE has an internet path (Wi-Fi or mobile data). Doctor Claude
 * is online-only: the glucose feed comes from the LibreLinkUp cloud and the coach / history / saves
 * go to our backend — with no network NOTHING new comes in. We surface that with a banner
 * ([com.nueve.mechabetics.ui.NetworkBanner]) instead of silently freezing, so the user knows the app
 * is limited until the connection returns.
 *
 * This is the DEVICE's connectivity (a real ConnectivityManager callback), distinct from
 * [com.nueve.mechabetics.ai.ServiceHealth] which answers "could we reach OUR backend / is the AI ok".
 */
object NetworkMonitor {
    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    @Volatile private var started = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { _online.value = true }
        override fun onLost(network: Network) { _online.value = false }
        override fun onUnavailable() { _online.value = false }
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            // Same capability the dashboard's online/offline dot uses, so they always agree.
            _online.value = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        }
    }

    /** Idempotent — safe to call on every MainActivity.onCreate (e.g. after a config change). */
    fun start(context: Context) {
        if (started) return
        val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return
        // Seed the current truth BEFORE the first callback so the banner is right immediately.
        _online.value = try {
            cm.getNetworkCapabilities(cm.activeNetwork)
                ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        } catch (_: Exception) {
            true // query failed → assume online; don't cry wolf on a transient error
        }
        try {
            cm.registerDefaultNetworkCallback(callback)
            started = true
        } catch (_: Exception) {
            // Couldn't register → keep the seeded value (it just won't update reactively).
        }
    }
}
