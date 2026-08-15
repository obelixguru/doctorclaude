package com.drclaude

import android.app.Application
import com.drclaude.data.CredentialsStore
import com.drclaude.data.GlucoseRepository
import com.drclaude.data.LibreLinkUpClient
import com.drclaude.data.local.LocalHistoryDb

/**
 * App-scoped singletons. The monitoring core (store / client / local DB / repository) must be ONE
 * instance shared by the UI and the background [MonitorService] — otherwise the service would poll
 * into a different StateFlow than the screen observes. Everything is lazy, so first access (the
 * Activity or the service, whichever comes first) builds it exactly once and the other reuses it.
 *
 * (The encrypted prefs are keyed by a fixed file name, so even a second CredentialsStore elsewhere
 * sees the same data — but the repository's in-memory StateFlow is what genuinely must be shared.)
 */
class MechabeticsApp : Application() {
    val store: CredentialsStore by lazy { CredentialsStore(this) }
    val client: LibreLinkUpClient by lazy { LibreLinkUpClient(store) }
    val localDb: LocalHistoryDb by lazy { LocalHistoryDb(this) }
    val repo: GlucoseRepository by lazy {
        GlucoseRepository(client, store, localDb).also { it.bootstrap() }
    }
}
