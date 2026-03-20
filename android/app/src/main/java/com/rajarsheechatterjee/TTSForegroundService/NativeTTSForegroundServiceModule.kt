package com.rajarsheechatterjee.TTSForegroundService

import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.lnreader.spec.NativeTTSForegroundServiceSpec

class NativeTTSForegroundServiceModule(private val appContext: ReactApplicationContext) :
    NativeTTSForegroundServiceSpec(appContext) {

    init {
        // Store context in service for event emission
        TTSForegroundService.reactContext = appContext
    }

    override fun getName(): String = "NativeTTSForegroundService"

    @ReactMethod
    override fun startService(
        title: String,
        subtitle: String,
        coverUri: String,
        isPlaying: Boolean
    ) {
        val intent = Intent(appContext, TTSForegroundService::class.java).apply {
            putExtra(TTSForegroundService.EXTRA_TITLE, title)
            putExtra(TTSForegroundService.EXTRA_SUBTITLE, subtitle)
            putExtra(TTSForegroundService.EXTRA_COVER_URI, coverUri)
            putExtra(TTSForegroundService.EXTRA_IS_PLAYING, isPlaying)
        }
        appContext.startService(intent)
    }

    @ReactMethod
    override fun stopService() {
        val intent = Intent(appContext, TTSForegroundService::class.java)
        appContext.stopService(intent)
    }

    @ReactMethod
    override fun updateMetadata(title: String, subtitle: String, coverUri: String) {
       // Not implemented - would require service binding
       // For now, metadata updates via startService()
    }

    @ReactMethod
    override fun updatePlaybackState(isPlaying: Boolean) {
        // Not implemented - would require service binding
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun isServiceRunning(): Boolean {
        return TTSForegroundService.isServiceRunning
    }

    @ReactMethod
    override fun addListener(eventName: String) {
        // Required for EventEmitter, no-op
    }

    @ReactMethod
    override fun removeListeners(count: Double) {
        // Required for EventEmitter, no-op
    }
}
