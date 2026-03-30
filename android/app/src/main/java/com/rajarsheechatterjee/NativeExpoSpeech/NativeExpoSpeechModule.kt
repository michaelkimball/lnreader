package com.rajarsheechatterjee.NativeExpoSpeech

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.lnreader.spec.NativeExpoSpeechSpec
import java.io.File
import java.net.URI
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

private const val TAG = "NativeExpoSpeech"

class NativeExpoSpeechModule(private val appContext: ReactApplicationContext) :
    NativeExpoSpeechSpec(appContext) {

    private var tts: TextToSpeech? = null
    private var isInitialized = false
    private val pendingOperations = mutableListOf<() -> Unit>()

    // Map from utteranceId → Promise, resolved/rejected in UtteranceProgressListener.
    // synthesizeToFile() on Android is ASYNC: SUCCESS from the API only means the job
    // was queued, not that the file has been written. The file is ready only when
    // onDone() fires. Using ConcurrentHashMap because the listener runs on a bg thread.
    private val pendingPromises = ConcurrentHashMap<String, Pair<Promise, File>>()

    init {
        initializeTTS()
    }

    override fun getName(): String = "NativeExpoSpeech"

    private fun initializeTTS() {
        Log.d(TAG, "initializeTTS() called")
        tts = TextToSpeech(appContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                Log.d(TAG, "TTS engine initialized successfully")
                isInitialized = true
                // Execute any operations that arrived before init completed
                pendingOperations.forEach { it.invoke() }
                pendingOperations.clear()
            } else {
                Log.e(TAG, "TTS engine initialization failed with status=$status")
                isInitialized = false
            }
        }

        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                Log.d(TAG, "onStart: utteranceId=$utteranceId")
                sendEventToReactNative("onSynthesisStart", Arguments.createMap().apply {
                    putString("utteranceId", utteranceId)
                })
            }

            override fun onDone(utteranceId: String?) {
                Log.d(TAG, "onDone: utteranceId=$utteranceId")
                val entry = utteranceId?.let { pendingPromises.remove(it) }
                if (entry != null) {
                    val (promise, file) = entry
                    // Return the file:// URI so the JS layer can use it with expo-file-system
                    val fileUri = file.toURI().toString()
                    Log.d(TAG, "onDone: resolving promise with uri=$fileUri (size=${file.length()} bytes)")
                    promise.resolve(fileUri)
                } else {
                    Log.w(TAG, "onDone: no pending promise found for utteranceId=$utteranceId")
                }
                sendEventToReactNative("onSynthesisDone", Arguments.createMap().apply {
                    putString("utteranceId", utteranceId)
                })
            }

            @Deprecated("Deprecated in API level 21")
            override fun onError(utteranceId: String?) {
                Log.e(TAG, "onError (legacy): utteranceId=$utteranceId")
                val entry = utteranceId?.let { pendingPromises.remove(it) }
                entry?.first?.reject("SYNTHESIS_ERROR", "TTS synthesis failed (onError)")
                sendEventToReactNative("onSynthesisError", Arguments.createMap().apply {
                    putString("utteranceId", utteranceId)
                    putString("error", "Synthesis failed")
                })
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                Log.e(TAG, "onError: utteranceId=$utteranceId, errorCode=$errorCode")
                val entry = utteranceId?.let { pendingPromises.remove(it) }
                entry?.first?.reject("SYNTHESIS_ERROR", "TTS synthesis failed (errorCode=$errorCode)")
                sendEventToReactNative("onSynthesisError", Arguments.createMap().apply {
                    putString("utteranceId", utteranceId)
                    putString("error", "Synthesis failed (errorCode=$errorCode)")
                })
            }
        })
    }

    @ReactMethod
    override fun synthesizeToFile(
        text: String,
        voiceId: String,
        pitch: Double,
        rate: Double,
        outputPath: String,
        promise: Promise
    ) {
        Log.d(TAG, "synthesizeToFile: voiceId=$voiceId, pitch=$pitch, rate=$rate, outputPath=$outputPath")

        fun performSynthesis() {
            try {
                val ttsEngine = tts ?: throw Exception("TTS engine not initialized")

                // Set voice if not system default
                if (voiceId != "system") {
                    val voices = ttsEngine.voices
                    val voice = voices?.find { it.name == voiceId }
                    if (voice != null) {
                        Log.d(TAG, "performSynthesis: setting voice=${voice.name}")
                        ttsEngine.voice = voice
                    } else {
                        Log.w(TAG, "performSynthesis: voice '$voiceId' not found, using engine default")
                    }
                }

                ttsEngine.setPitch(pitch.toFloat())
                ttsEngine.setSpeechRate(rate.toFloat())

                // outputPath arrives as a file:// URI (e.g. "file:///data/.../cache/tts_expo_xxx.wav").
                // java.io.File() cannot parse URI strings — it needs a plain filesystem path.
                // Use java.net.URI to extract the path component correctly.
                val filePath = try {
                    URI(outputPath).path
                } catch (e: Exception) {
                    Log.w(TAG, "performSynthesis: failed to parse outputPath as URI, using raw string. error=${e.message}")
                    outputPath
                }
                Log.d(TAG, "performSynthesis: resolved file path=$filePath")

                val file = File(filePath)
                file.parentFile?.mkdirs()

                val utteranceId = "utterance_${System.currentTimeMillis()}"
                Log.d(TAG, "performSynthesis: starting synthesis, utteranceId=$utteranceId")

                // Store the promise BEFORE calling synthesizeToFile so the listener
                // can always find it, even if onDone fires extremely quickly.
                pendingPromises[utteranceId] = Pair(promise, file)

                val params = Bundle().apply {
                    putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
                }

                val result = ttsEngine.synthesizeToFile(text, params, file, utteranceId)

                if (result != TextToSpeech.SUCCESS) {
                    // Job was not even queued — reject immediately and clean up
                    Log.e(TAG, "performSynthesis: synthesizeToFile() returned error code=$result")
                    pendingPromises.remove(utteranceId)
                    promise.reject("SYNTHESIS_ERROR", "Failed to queue synthesis job (result=$result)")
                } else {
                    Log.d(TAG, "performSynthesis: synthesis job queued successfully, waiting for onDone...")
                    // Promise will be resolved/rejected by UtteranceProgressListener.onDone/onError
                }
            } catch (e: Exception) {
                Log.e(TAG, "performSynthesis: exception: ${e.message}", e)
                promise.reject("SYNTHESIS_ERROR", e.message, e)
            }
        }

        if (isInitialized) {
            performSynthesis()
        } else {
            Log.d(TAG, "synthesizeToFile: TTS not yet initialized, queueing operation")
            pendingOperations.add {
                try {
                    performSynthesis()
                } catch (e: Exception) {
                    Log.e(TAG, "synthesizeToFile (queued): exception: ${e.message}", e)
                    promise.reject("SYNTHESIS_ERROR", "TTS initialization failed", e)
                }
            }
        }
    }

    @ReactMethod
    override fun getAvailableVoices(promise: Promise) {
        fun getVoices() {
            try {
                val ttsEngine = tts ?: throw Exception("TTS engine not initialized")
                val voices = ttsEngine.voices
                val voicesArray: WritableArray = Arguments.createArray()
                
                voices?.forEach { voice ->
                    val voiceMap: WritableMap = Arguments.createMap().apply {
                        putString("identifier", voice.name)
                        putString("name", voice.name)
                        putString("language", voice.locale.displayLanguage)
                        putInt("quality", voice.quality)
                    }
                    voicesArray.pushMap(voiceMap)
                }
                
                promise.resolve(voicesArray)
            } catch (e: Exception) {
                promise.reject("GET_VOICES_ERROR", e.message, e)
            }
        }
        
        if (isInitialized) {
            getVoices()
        } else {
            pendingOperations.add {
                try {
                    getVoices()
                } catch (e: Exception) {
                    promise.reject("GET_VOICES_ERROR", "TTS initialization failed", e)
                }
            }
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun isSpeaking(): Boolean {
        return tts?.isSpeaking ?: false
    }

    @ReactMethod
    override fun stop() {
        Log.d(TAG, "stop() called")
        tts?.stop()
        // Reject any promises still waiting — the synthesis was cancelled
        pendingPromises.forEach { (id, pair) ->
            Log.w(TAG, "stop(): rejecting pending promise for utteranceId=$id")
            pair.first.reject("SYNTHESIS_CANCELLED", "TTS synthesis cancelled by stop()")
        }
        pendingPromises.clear()
    }

    @ReactMethod
    override fun addListener(eventName: String) {
        // Required for EventEmitter, no-op
    }

    @ReactMethod
    override fun removeListeners(count: Double) {
        // Required for EventEmitter, no-op
    }

    private fun sendEventToReactNative(eventName: String, params: WritableMap?) {
        if (appContext.hasActiveCatalystInstance()) {
            appContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        }
    }

    override fun invalidate() {
        Log.d(TAG, "invalidate() called, shutting down TTS engine")
        tts?.stop()
        tts?.shutdown()
        tts = null
        isInitialized = false
        pendingOperations.clear()
        pendingPromises.forEach { (id, pair) ->
            Log.w(TAG, "invalidate(): rejecting pending promise for utteranceId=$id")
            pair.first.reject("SYNTHESIS_ERROR", "TTS engine invalidated")
        }
        pendingPromises.clear()
        super.invalidate()
    }
}
