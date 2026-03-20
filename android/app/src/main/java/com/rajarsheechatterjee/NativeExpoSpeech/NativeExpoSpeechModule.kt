package com.rajarsheechatterjee.NativeExpoSpeech

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.lnreader.spec.NativeExpoSpeechSpec
import java.io.File
import java.util.Locale

class NativeExpoSpeechModule(private val appContext: ReactApplicationContext) :
    NativeExpoSpeechSpec(appContext) {

    private var tts: TextToSpeech? = null
    private var isInitialized = false
    private val pendingOperations = mutableListOf<() -> Unit>()

    init {
        initializeTTS()
    }

    override fun getName(): String = "NativeExpoSpeech"

    private fun initializeTTS() {
        tts = TextToSpeech(appContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                isInitialized = true
                // Execute any pending operations
                pendingOperations.forEach { it.invoke() }
                pendingOperations.clear()
            } else {
                isInitialized = false
            }
        }
        
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                sendEventToReactNative("onSynthesisStart", Arguments.createMap().apply {
                    putString("utteranceId", utteranceId)
                })
            }

            override fun onDone(utteranceId: String?) {
                sendEventToReactNative("onSynthesisDone", Arguments.createMap().apply {
                    putString("utteranceId", utteranceId)
                })
            }

            override fun onError(utteranceId: String?) {
                sendEventToReactNative("onSynthesisError", Arguments.createMap().apply {
                    putString("utteranceId", utteranceId)
                    putString("error", "Synthesis failed")
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
        fun performSynthesis() {
            try {
                val ttsEngine = tts ?: throw Exception("TTS engine not initialized")
                
                // Set voice if not system default
                if (voiceId != "system") {
                    val voices = ttsEngine.voices
                    val voice = voices?.find { it.name == voiceId }
                    if (voice != null) {
                        ttsEngine.voice = voice
                    }
                }
                
                // Set pitch and rate
                ttsEngine.setPitch(pitch.toFloat())
                ttsEngine.setSpeechRate(rate.toFloat())
                
                // Prepare output file
                val file = File(outputPath)
                file.parentFile?.mkdirs()
                
                // Synthesize to file
                val utteranceId = "utterance_${System.currentTimeMillis()}"
                val params = Bundle().apply {
                    putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
                }
                
                val result = ttsEngine.synthesizeToFile(text, params, file, utteranceId)
                
                if (result == TextToSpeech.SUCCESS) {
                    // Wait a bit for file to be written (async operation)
                    Thread.sleep(100)
                    promise.resolve(file.toURI().toString())
                } else {
                    promise.reject("SYNTHESIS_ERROR", "Failed to synthesize to file")
                }
            } catch (e: Exception) {
                promise.reject("SYNTHESIS_ERROR", e.message, e)
            }
        }
        
        if (isInitialized) {
            performSynthesis()
        } else {
            // Queue operation until TTS is initialized
            pendingOperations.add { 
                try {
                    performSynthesis()
                } catch (e: Exception) {
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
        tts?.stop()
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
        tts?.shutdown()
        tts = null
        isInitialized = false
        pendingOperations.clear()
        super.invalidate()
    }
}
