package com.nueve.mechabetics.ai

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import java.io.File

/** Records a short voice question to an AAC (.aac) file that Gemini accepts. */
class VoiceRecorder(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var outFile: File? = null

    fun start(): Boolean = try {
        val file = File(context.cacheDir, "question.aac")
        if (file.exists()) file.delete()
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        r.setAudioSource(MediaRecorder.AudioSource.MIC)
        r.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setAudioEncodingBitRate(64000)
        r.setAudioSamplingRate(16000)
        r.setOutputFile(file.absolutePath)
        r.prepare()
        r.start()
        recorder = r
        outFile = file
        true
    } catch (e: Exception) {
        Log.e("VoiceRecorder", "start failed", e)
        cleanup()
        false
    }

    /** Stops recording and returns the recorded file, or null on failure. */
    fun stop(): File? = try {
        recorder?.stop()
        cleanup()
        outFile?.takeIf { it.exists() && it.length() > 0 }
    } catch (e: Exception) {
        Log.e("VoiceRecorder", "stop failed", e)
        cleanup()
        null
    }

    private fun cleanup() {
        try { recorder?.release() } catch (_: Exception) {}
        recorder = null
    }
}
