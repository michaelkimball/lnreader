package com.rajarsheechatterjee.TTSForegroundService

import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.lnreader.spec.NativeTTSForegroundServiceSpec

class NativeTTSForegroundServiceModule(private val appContext: ReactApplicationContext) :
    NativeTTSForegroundServiceSpec(appContext) {

    init {
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
        if (!TTSForegroundService.isServiceRunning) return
        val intent = Intent(appContext, TTSForegroundService::class.java).apply {
            putExtra(TTSForegroundService.EXTRA_TITLE, title)
            putExtra(TTSForegroundService.EXTRA_SUBTITLE, subtitle)
            putExtra(TTSForegroundService.EXTRA_COVER_URI, coverUri)
        }
        appContext.startService(intent)
    }

    @ReactMethod
    override fun updatePlaybackState(isPlaying: Boolean) {
        if (!TTSForegroundService.isServiceRunning) return
        val intent = Intent(appContext, TTSForegroundService::class.java).apply {
            putExtra(TTSForegroundService.EXTRA_IS_PLAYING, isPlaying)
        }
        appContext.startService(intent)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    override fun isServiceRunning(): Boolean {
        return TTSForegroundService.isServiceRunning
    }

    @ReactMethod
    override fun addListener(eventName: String) {}

    @ReactMethod
    override fun removeListeners(count: Double) {}
}
