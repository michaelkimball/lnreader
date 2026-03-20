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
import com.rajarsheechatterjee.LNReader.R

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
            .setSmallIcon(android.R.drawable.ic_media_play)  // Using built-in icon for now
            .setContentTitle(currentTitle)
            .setContentText(currentSubtitle)
            .setContentIntent(openAppPendingIntent)
            .setOngoing(true)  // Cannot be dismissed while service is running
            .setOnlyAlertOnce(true)
            .addAction(
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (isPlaying) "Pause" else "Play",
                playPausePendingIntent
            )
            .addAction(android.R.drawable.ic_delete, "Stop", stopPendingIntent)
            .setStyle(androidx.media.app.NotificationCompat.MediaStyle()
                .setShowActionsInCompactView(0, 1))
            .build()
    }

    private fun updateNotification() {
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(mediaReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(mediaReceiver, filter)
            }
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
