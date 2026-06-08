package com.nueve.mechabetics.ai

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * App-wide health of the Doctor Claude BACKEND (the Supabase edge functions: coach / ask / scan /
 * history / meals / profile…). The glucose feed + alarms are INDEPENDENT (LibreLinkUp-direct) and
 * have their own NO-SIGNAL handling, so this is purely "can we reach our server, and is the AI ok".
 *
 * Every backend call reports its outcome here so that if ANYTHING falls — the DB, the history, the
 * stats, the AI, the credits — the app SHOWS it (a global banner) instead of failing silently.
 * Two INDEPENDENT facts, so a success of one kind never wrongly clears a problem of the other:
 *  - reachable: did the last call reach the backend at all? (false = network/timeout/5xx = "service down")
 *  - ai: when the backend WAS reached but the model failed — out of credits / quota / bad key / down.
 */
object ServiceHealth {
    enum class Ai { OUT_OF_CREDITS, RATE_LIMITED, AUTH, DOWN }

    data class Health(val reachable: Boolean = true, val ai: Ai? = null) {
        val ok: Boolean get() = reachable && ai == null
    }

    private val _state = MutableStateFlow(Health())
    val state: StateFlow<Health> = _state.asStateFlow()

    /** A backend call got an HTTP response (even an error body) → the server is reachable. */
    fun reportReachable() = _state.update { if (it.reachable) it else it.copy(reachable = true) }

    /** A backend call could not reach the server (IOException / timeout / DNS / 5xx gateway). */
    fun reportUnreachable() = _state.update { if (!it.reachable) it else it.copy(reachable = false) }

    /** An AI call (coach/ask/scan) succeeded → clear any AI problem (and mark reachable). */
    fun reportAiOk() = _state.update { if (it.reachable && it.ai == null) it else it.copy(reachable = true, ai = null) }

    /** Backend reached but the model failed — map the server's errorKind to a cause. */
    fun reportAiProblem(errorKind: String?) {
        val k = when (errorKind) {
            "out_of_credits" -> Ai.OUT_OF_CREDITS
            "rate_limited" -> Ai.RATE_LIMITED
            "auth" -> Ai.AUTH
            else -> Ai.DOWN
        }
        _state.update { it.copy(reachable = true, ai = k) }
    }
}
