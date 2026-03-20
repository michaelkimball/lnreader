# TTS Migration - Step-by-Step Implementation Guide

**Last Updated:** March 2026  
**Prerequisites:** Read [00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md) and [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md)

---

## Implementation Steps - Phase 1

This guide provides detailed, copy-paste-ready code for each component. Follow steps sequentially.

---

## Step 1: Create TTSForegroundService (Kotlin)

### 1.1: Create Service File

**File:** `android/app/src/main/java/com/rajarsheechatterjee/TTSForegroundService/TTSForegroundService.kt`

```kotlin
package com.rajarsheechatterjee.TTSForegroundService

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.lnreader.R

class TTSForegroundService : Service() {

    companion object {
        private const val CHANNEL_ID = "tts-foreground-service"
        private const val NOTIFICATION_ID = 1002
        const val ACTION_PLAY = "com.lnreader.TTS_SERVICE_PLAY"
        const val ACTION_PAUSE = "com.lnreader.TTS_SERVICE_PAUSE"
        const val ACTION_STOP = "com.lnreader.TTS_SERVICE_STOP"
        
        const val EXTRA_TITLE = "title"
        const val EXTRA_SUBTITLE = "subtitle"
        const val EXTRA_COVER_URI = "coverUri"
        const val EXTRA_IS_PLAYING = "isPlaying"
        
        var isServiceRunning = false
        var reactContext: ReactApplicationContext? = null
    }

    private var currentTitle: String = "LNReader"
    private var currentSubtitle: String = "Text-to-Speech"
    private var currentCoverUri: String = ""
    private var isPlaying: Boolean = false
    private var receiverRegistered = false

    private val mediaReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PLAY -> {
                    isPlaying = true
                    updateNotification()
                    sendEventToReactNative("TTSServicePlay", null)
                }
                ACTION_PAUSE -> {
                    isPlaying = false
                    updateNotification()
                    sendEventToReactNative("TTSServicePause", null)
                }
                ACTION_STOP -> {
                    sendEventToReactNative("TTSServiceStop", null)
                    stopForeground(true)
                    stopSelf()
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        registerReceiver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        isServiceRunning = true
        
        // Extract metadata from intent
        intent?.let {
            currentTitle = it.getStringExtra(EXTRA_TITLE) ?: currentTitle
            currentSubtitle = it.getStringExtra(EXTRA_SUBTITLE) ?: currentSubtitle
            currentCoverUri = it.getStringExtra(EXTRA_COVER_URI) ?: currentCoverUri
            isPlaying = it.getBooleanExtra(EXTRA_IS_PLAYING, false)
        }
        
        // Start foreground service with notification
        val notification = createNotification()
        startForeground(NOTIFICATION_ID, notification)
        
        return START_STICKY  // Restart service if killed by system
    }

    override fun onDestroy() {
        isServiceRunning = false
        unregisterReceiver()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null  // Not binding to service
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "TTS Playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Text-to-speech playback controls"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        // Intent to open app when notification is tapped
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openAppPendingIntent = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        // Play/Pause action
        val playPauseIntent = Intent(if (isPlaying) ACTION_PAUSE else ACTION_PLAY)
        val playPausePendingIntent = PendingIntent.getBroadcast(
            this, 1, playPauseIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        // Stop action
        val stopIntent = Intent(ACTION_STOP)
        val stopPendingIntent = PendingIntent.getBroadcast(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)  // Ensure this icon exists
            .setContentTitle(currentTitle)
            .setContentText(currentSubtitle)
            .setContentIntent(openAppPendingIntent)
            .setOngoing(true)  // Cannot be dismissed while service is running
            .setOnlyAlertOnce(true)
            .addAction(
                if (isPlaying) R.drawable.ic_pause else R.drawable.ic_play,
                if (isPlaying) "Pause" else "Play",
                playPausePendingIntent
            )
            .addAction(R.drawable.ic_stop, "Stop", stopPendingIntent)
            .setStyle(androidx.media.app.NotificationCompat.MediaStyle()
                .setShowActionsInCompactView(0, 1))
            .build()
    }

    fun updateNotification() {
        val notification = createNotification()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun registerReceiver() {
        if (!receiverRegistered) {
            val filter = IntentFilter().apply {
                addAction(ACTION_PLAY)
                addAction(ACTION_PAUSE)
                addAction(ACTION_STOP)
            }
            registerReceiver(mediaReceiver, filter)
            receiverRegistered = true
        }
    }

    private fun unregisterReceiver() {
        if (receiverRegistered) {
            unregisterReceiver(mediaReceiver)
            receiverRegistered = false
        }
    }

    private fun sendEventToReactNative(eventName: String, params: WritableMap?) {
        reactContext?.let {
            if (it.hasActiveCatalystInstance()) {
                it.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(eventName, params)
            }
        }
    }
}
```

---

### 1.2: Add Notification Icons

Create drawable resources (or use existing ones):

**Files:**
- `android/app/src/main/res/drawable/ic_notification.xml`
- `android/app/src/main/res/drawable/ic_play.xml`
- `android/app/src/main/res/drawable/ic_pause.xml`
- `android/app/src/main/res/drawable/ic_stop.xml`

If these don't exist, you can use built-in Android icons temporarily:
```kotlin
// In createNotification(), replace custom icons:
.setSmallIcon(android.R.drawable.ic_media_play)
.addAction(android.R.drawable.ic_media_pause, "Pause", ...)
```

---

### 1.3: Register Service in AndroidManifest.xml

**File:** `android/app/src/main/AndroidManifest.xml`

Add inside `<application>` tag:

```xml
<service
    android:name=".TTSForegroundService.TTSForegroundService"
    android:enabled="true"
    android:exported="false"
    android:foregroundServiceType="mediaPlayback" />
```

Add permissions before `<application>` tag:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

---

## Step 2: Create React Native Bridge for TTSForegroundService

### 2.1: Create Turbo Module Spec

**File:** `specs/NativeTTSForegroundService.ts`

```typescript
import { TurboModule, TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  startService(
    title: string,
    subtitle: string,
    coverUri: string,
    isPlaying: boolean
  ): void;
  
  stopService(): void;
  
  updateMetadata(
    title: string,
    subtitle: string,
    coverUri: string
  ): void;
  
  updatePlaybackState(isPlaying: boolean): void;
  
  isServiceRunning(): boolean;
  
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeTTSForegroundService');
```

---

### 2.2: Create Native Module Implementation

**File:** `android/app/src/main/java/com/rajarsheechatterjee/TTSForegroundService/NativeTTSForegroundServiceModule.kt`

```kotlin
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
```

---

### 2.3: Create Package

**File:** `android/app/src/main/java/com/rajarsheechatterjee/TTSForegroundService/NativeTTSForegroundServicePackage.kt`

```kotlin
package com.rajarsheechatterjee.TTSForegroundService

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NativeTTSForegroundServicePackage : TurboReactPackage() {
    override fun getModule(name: String, context: ReactApplicationContext): NativeModule? {
        return if (name == "NativeTTSForegroundService") {
            NativeTTSForegroundServiceModule(context)
        } else {
            null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                "NativeTTSForegroundService" to ReactModuleInfo(
                    "NativeTTSForegroundService",
                    "NativeTTSForegroundServiceModule",
                    false, // canOverrideExistingModule
                    false, // needsEagerInit
                    true,  // isCxxModule
                    true   // isTurboModule
                )
            )
        }
    }
}
```

---

### 2.4: Register Package

**File:** `android/app/src/main/java/com/rajarsheechatterjee/MainApplication.kt`

Add to packages list:

```kotlin
import com.rajarsheechatterjee.TTSForegroundService.NativeTTSForegroundServicePackage

// In getPackages() method:
override fun getPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
        add(NativeTTSForegroundServicePackage())  // Add this line
    }
```

---

## Remaining Steps (To Be Implemented)

The following steps are outlined below as a roadmap. Detailed code examples will be added as implementation progresses:

### Steps 3-9: React Native Components (Phase 1)
- **Step 3:** Create NativeExpoSpeech Turbo Module (synthesizeToFile support)
- **Step 4:** Create TTSPlaybackManager.ts (singleton service)
- **Step 5:** Integrate expo-av for audio playback with pause/resume
- **Step 6:** Create TTSAudioGenerator.ts (unified audio generation)
- **Step 7:** Create TTSAudioPreloader.ts (progressive preloading)
- **Step 8:** Create TTSCacheManager.ts (LRU cache)
- **Step 9:** Refactor WebViewReader.tsx to use TTSPlaybackManager

### Steps 10-15: Batch Downloads & Testing (Phase 2)
- **Step 10:** Create BatchSynthesisService.ts
- **Step 11:** Create TTSDownloadManager.ts
- **Step 12:** Create download UI components
- **Step 13:** Implement state persistence
- **Step 14:** Add settings UI updates
- **Step 15:** Complete testing and deployment

**Status:** Steps 1-2 complete with full code examples above.  
**Next Steps:** Implement Step 3 (NativeExpoSpeech) to enable file-based synthesis.

---

## Step 3: Create NativeExpoSpeech Turbo Module (Outline)

**Purpose:** Expo-speech doesn't support `synthesizeToFile()`, so we need a native module.

**Files to Create:**
- `specs/NativeExpoSpeech.ts` - Turbo Module spec
- `android/.../NativeExpoSpeech/NativeExpoSpeechModule.kt` - Implementation
- `android/.../NativeExpoSpeech/NativeExpoSpeechPackage.kt` - Package

**Key Method:**
```typescript
synthesizeToFile(
  text: string,
  voiceId: string,
  pitch: number,
  rate: number,
  outputPath: string
): Promise<string>;  // Returns file URI
```

**Implementation uses:** `android.speech.tts.TextToSpeech.synthesizeToFile()`

_Detailed code to be added during implementation phase._

---

## Steps 4-15: Implementation Roadmap

Detailed implementation guides for the remaining steps will be added as:
1. Each component is implemented and tested
2. Best practices are discovered during development
3. Integration patterns are validated

**Reference:**
- Architecture details: [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md)
- Batch synthesis API: [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md)
- Overall strategy: [00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md)

---

**Current Status:** Foundation complete (Steps 1-2). Ready to begin Phase 1 implementation.
