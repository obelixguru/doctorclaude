package com.drclaude.ai

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * Free, offline Android text-to-speech — the DEFAULT voice for the public/free tier (the premium
 * ElevenLabs cloud voice is opt-in / Hosted only). Lazily initialised; speaks FR or ES. This is
 * the cost lever: native TTS is $0 and on-device, vs ~$170/1M chars for ElevenLabs at scale.
 */
class NativeTts(context: Context, private val onSpeaking: (Boolean) -> Unit = {}) {
    private var ready = false
    private var pending: Pair<String, String>? = null

    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (ready) {
            // Report start/end of speech so the UI can flip the speaker icon to STOP while talking
            // and back when it finishes on its own. Callbacks fire on a binder thread — fine, the
            // listener target is a thread-safe StateFlow.
            tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) { onSpeaking(true) }
                override fun onDone(utteranceId: String?) { onSpeaking(false) }
                @Deprecated("Deprecated in Java") override fun onError(utteranceId: String?) { onSpeaking(false) }
                override fun onError(utteranceId: String?, errorCode: Int) { onSpeaking(false) }
                override fun onStop(utteranceId: String?, interrupted: Boolean) { onSpeaking(false) }
            })
        }
        val p = pending
        pending = null
        if (ready && p != null) speak(p.first, p.second)
    }

    /** Speak the text in the given language ("fr"/"es"). Queues until the engine is ready. */
    fun speak(text: String, lang: String) {
        if (text.isBlank()) return
        val clean = voiceClean(text)
        if (!ready) { pending = clean to lang; return }
        try {
            tts.language = if (lang == "es") Locale("es", "ES") else Locale.FRENCH
            tts.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "dc-${clean.hashCode()}")
        } catch (e: Exception) {
            Log.e(TAG, "speak failed", e)
        }
    }

    /** Strip the glucose unit before speaking — the voice should say "128", not "128 mg/dL"
     *  ("cent-vingt-huit milligrammes par décilitre"), which breaks the spoken flow. The on-screen
     *  text keeps mg/dL; only the audio is cleaned. */
    private fun voiceClean(text: String): String =
        text.replace(Regex("""\s*mg\s*/\s*d[lL]"""), "")
            .replace(Regex("""[ \t]{2,}"""), " ")
            .trim()

    fun stop() {
        pending = null
        try { tts.stop() } catch (_: Exception) {}
        onSpeaking(false)
    }

    fun shutdown() {
        try { tts.stop(); tts.shutdown() } catch (_: Exception) {}
    }

    companion object { private const val TAG = "NativeTts" }
}
