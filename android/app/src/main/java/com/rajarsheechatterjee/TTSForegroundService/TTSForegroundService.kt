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
import android.os.PowerManager
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
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

    private var mediaSession: MediaSessionCompat? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val mediaReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PLAY -> {
                    isPlaying = true
                    updatePlaybackState()
                    updateNotification()
                    sendEventToReactNative("TTSServicePlay", null)
                }
                ACTION_PAUSE -> {
                    isPlaying = false
                    updatePlaybackState()
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
        initMediaSession()
        acquireWakeLock()
        registerReceiver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        isServiceRunning = true

        intent?.let {
            currentTitle = it.getStringExtra(EXTRA_TITLE) ?: currentTitle
            currentSubtitle = it.getStringExtra(EXTRA_SUBTITLE) ?: currentSubtitle
            currentCoverUri = it.getStringExtra(EXTRA_COVER_URI) ?: currentCoverUri
            isPlaying = it.getBooleanExtra(EXTRA_IS_PLAYING, false)
        }

        updatePlaybackState()

        val notification = createNotification()
        startForeground(NOTIFICATION_ID, notification)

        return START_STICKY
    }

    override fun onDestroy() {
        isServiceRunning = false
        releaseWakeLock()
        mediaSession?.release()
        mediaSession = null
        unregisterReceiver()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun initMediaSession() {
        mediaSession = MediaSessionCompat(this, "TTSForegroundService").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() {
                    isPlaying = true
                    updatePlaybackState()
                    updateNotification()
                    sendEventToReactNative("TTSServicePlay", null)
                }
                override fun onPause() {
                    isPlaying = false
                    updatePlaybackState()
                    updateNotification()
                    sendEventToReactNative("TTSServicePause", null)
                }
                override fun onStop() {
                    sendEventToReactNative("TTSServiceStop", null)
                    stopForeground(true)
                    stopSelf()
                }
            })
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            )
            isActive = true
        }
        updatePlaybackState()
    }

    private fun updatePlaybackState() {
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        mediaSession?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                    PlaybackStateCompat.ACTION_PAUSE or
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_STOP
                )
                .build()
        )
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "LNReader:TTSWakeLock"
        ).apply {
            acquire(4 * 60 * 60 * 1000L) // 4 hours max
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
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
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openAppPendingIntent = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playPauseIntent = Intent(if (isPlaying) ACTION_PAUSE else ACTION_PLAY)
        val playPausePendingIntent = PendingIntent.getBroadcast(
            this, 1, playPauseIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(ACTION_STOP)
        val stopPendingIntent = PendingIntent.getBroadcast(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTitle)
            .setContentText(currentSubtitle)
            .setContentIntent(openAppPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (isPlaying) "Pause" else "Play",
                playPausePendingIntent
            )
            .addAction(android.R.drawable.ic_delete, "Stop", stopPendingIntent)
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken)  // MediaSessionCompat.Token
                    .setShowActionsInCompactView(0, 1)
            )
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
                @Suppress("UnspecifiedRegisterReceiverFlag")
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
