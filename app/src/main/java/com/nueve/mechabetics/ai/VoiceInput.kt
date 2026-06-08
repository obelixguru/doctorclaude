package com.nueve.mechabetics.ai

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/**
 * On-device / Google speech recognition — NO keyboard, NO system dialog, NO text field.
 * The app shows its own mic UI; we just listen and hand back the transcribed TEXT.
 *
 * Replaces the old audio-upload path: DeepSeek can't read audio, and the phone's
 * built-in recognizer is free, fast and great in FR/ES. The spoken answer is still
 * voiced by ElevenLabs (server-side TTS). Must be created/started on the main thread.
 */
class VoiceInput(private val context: Context) {

    private var recognizer: SpeechRecognizer? = null
    var isListening: Boolean = false
        private set

    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    /**
     * Start listening. [lang] is "fr" or "es". On success calls [onText] with the
     * transcript; on failure calls [onError] with a short localized message.
     * Callbacks fire on the main thread.
     */
    fun start(lang: String, onText: (String) -> Unit, onError: (String) -> Unit) {
        stop()
        if (!available()) {
            onError(if (lang == "es") "Reconocimiento de voz no disponible." else "Reconnaissance vocale indisponible.")
            return
        }
        val sr = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = sr
        val locale = if (lang == "es") "es-ES" else "fr-FR"
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onError(error: Int) {
                isListening = false
                cleanup()
                onError(errorText(error, lang))
            }

            override fun onResults(results: Bundle?) {
                isListening = false
                val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = list?.firstOrNull()?.trim().orEmpty()
                cleanup()
                if (text.isEmpty()) onError(if (lang == "es") "No te he entendido." else "Je n'ai pas compris.")
                else onText(text)
            }
        })
        isListening = true
        try {
            sr.startListening(intent)
        } catch (e: Exception) {
            Log.e("VoiceInput", "startListening failed", e)
            isListening = false
            cleanup()
            onError(if (lang == "es") "Error al escuchar." else "Erreur micro.")
        }
    }

    /** User tapped again: stop capturing and let onResults fire with what was heard. */
    fun stopListening() {
        try { recognizer?.stopListening() } catch (_: Exception) {}
    }

    /** Hard cancel + release. */
    fun stop() {
        isListening = false
        try { recognizer?.cancel() } catch (_: Exception) {}
        cleanup()
    }

    private fun cleanup() {
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
    }

    private fun errorText(error: Int, lang: String): String {
        val es = lang == "es"
        return when (error) {
            SpeechRecognizer.ERROR_NO_MATCH ->
                if (es) "No te he entendido, ¿puedes repetir?" else "Je n'ai pas compris, tu peux répéter ?"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                if (es) "No he oído nada." else "Je n'ai rien entendu."
            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                if (es) "Sin conexión para reconocer la voz." else "Pas de connexion pour la reconnaissance vocale."
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
                if (es) "Falta el permiso de micrófono." else "Permission micro manquante."
            else ->
                if (es) "Error de reconocimiento de voz." else "Erreur de reconnaissance vocale."
        }
    }
}
