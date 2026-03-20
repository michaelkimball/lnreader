# New TTS Architecture - Detailed Design

**Last Updated:** March 2026  
**Status:** Design Phase

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Component Responsibilities](#component-responsibilities)
3. [Data Flow](#data-flow)
4. [State Management](#state-management)
5. [Playback Strategies](#playback-strategies)
6. [Error Handling](#error-handling)

---

## System Architecture

### Layer Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         UI Layer                                 │
│  • TTSTab (settings, controls)                                   │
│  • WebViewReader (chapter reading)                               │
│  • DownloadsScreen (offline management)                          │
│  • ChapterList (download buttons)                                │
└─────────────────────────────────────────────────────────────────┘
                              ↕ Events & Commands
┌─────────────────────────────────────────────────────────────────┐
│                    Business Logic Layer                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │         TTSPlaybackManager (Singleton)                      ││
│  │  • Orchestrates all playback                                ││
│  │  • Manages audio queue and position                         ││
│  │  • Controls expo-av Sound instances                         ││
│  │  • Emits events for UI updates                              ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │         TTSAudioPreloader                                   ││
│  │  • Progressive preloading (first 5 → background)            ││
│  │  • Batch generation with concurrency limits                 ││
│  │  • Retry logic with exponential backoff                     ││
│  │  • Buffer management (ensure N elements ahead)              ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │         TTSCacheManager                                     ││
│  │  • LRU cache implementation                                 ││
│  │  • Storage management (max size limits)                     ││
│  │  • File persistence and cleanup                             ││
│  │  • Cache hit/miss tracking                                  ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │         TTSDownloadManager                                  ││
│  │  • Batch synthesis job management                           ││
│  │  • Background download polling                              ││
│  │  • Offline chapter storage                                  ││
│  │  • Download queue and prioritization                        ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                     Audio Generation Layer                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │         TTSAudioGenerator (Factory)                         ││
│  │  • Unified interface for both engines                       ││
│  │  • Routes to appropriate engine                             ││
│  │  • Returns file URIs for playback                           ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌──────────────────────┐       ┌─────────────────────────────┐│
│  │  ExpoSpeechService   │       │  MicrosoftSpeechService     ││
│  │  • Native synthesis  │       │  • Real-time API            ││
│  │  • synthesizeToFile()│       │  • Batch Synthesis API      ││
│  │  • Voice enumeration │       │  • Token management         ││
│  │                      │       │  • Audio download & cache   ││
│  └──────────────────────┘       └─────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                      Native Android Layer                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │         TTSForegroundService (Kotlin)                       ││
│  │  • Android Service with foreground notification             ││
│  │  • Prevents system from killing app                         ││
│  │  • Lifecycle management                                     ││
│  │  • Broadcast receiver for notification actions              ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │         NativeExpoSpeech (Turbo Module - NEW)               ││
│  │  • Wraps Android TextToSpeech.synthesizeToFile()            ││
│  │  • Returns file URI after synthesis                         ││
│  │  • Voice enumeration                                        ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │         NativeTTSMediaControl (Modified)                    ││
│  │  • MediaSession integration                                 ││
│  │  • Lock screen media controls                               ││
│  │  • Coordinates with foreground service                      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    Android System APIs                           │
│  • TextToSpeech (native synthesis)                              │
│  • MediaSession (media controls)                                │
│  • NotificationManager (foreground notification)                │
│  • expo-av (audio playback with pause/resume)                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### 1. TTSPlaybackManager

**File:** `src/services/tts/TTSPlaybackManager.ts`

**Type:** Singleton service (EventEmitter)

**Responsibilities:**
- Owns playback state (idle → loading → playing → paused → stopped)
- Manages audio queue (TTSQueueItem[])
- Tracks current position (index within queue)
- Controls expo-av Sound instances
- Coordinates with preloader for audio generation
- Emits events for UI synchronization
- Handles playback controls (play, pause, resume, stop, seek, next, prev)

**Key Methods:**
```typescript
class TTSPlaybackManager extends EventEmitter {
  // Lifecycle
  async play(queue: TTSQueueItem[], startIndex: number, chapterId: number): Promise<void>
  async pause(): Promise<void>
  async resume(): Promise<void>
  async stop(): Promise<void>
  
  // Navigation
  async seek(index: number): Promise<void>
  async next(): Promise<void>
  async previous(): Promise<void>
  async rewind(): Promise<void>  // Replay current element
  
  // State queries
  getState(): PlaybackState
  getCurrentIndex(): number
  getQueueLength(): number
  isPlaying(): boolean
  isPaused(): boolean
  
  // Configuration
  setVoiceSettings(settings: VoiceSettings): void
  setEngine(engine: TTSEngine): void
}
```

**Events Emitted:**
```typescript
'stateChange': { state: PlaybackState, index: number }
'progress': { current: number, total: number }
'elementChange': { index: number, text: string }
'queueEnd': { reason: 'completed' | 'stopped' }
'error': { message: string, code: string }
'audioLoading': { index: number }
'audioReady': { index: number, uri: string }
```

**State Machine:**
```
idle → loading → playing ⇄ paused → stopped → idle
                   ↓
                 error → idle
```

---

### 2. TTSAudioPreloader

**File:** `src/services/tts/TTSAudioPreloader.ts`

**Type:** Service class (EventEmitter)

**Responsibilities:**
- Progressive preloading strategy (first 5 priority → background batch)
- Batch audio generation with concurrency limits
- Retry logic with exponential backoff and fallback
- Buffer management (ensure N elements ahead of playback)
- Cache coordination (check cache before generating)

**Key Methods:**
```typescript
class TTSAudioPreloader extends EventEmitter {
  // Preloading
  async preloadChapter(
    queue: TTSQueueItem[], 
    options: PreloadOptions
  ): Promise<void>
  
  async ensureBufferAhead(
    currentIndex: number, 
    bufferSize: number
  ): Promise<void>
  
  // Status queries
  isAudioReady(index: number): boolean
  getAudioUri(index: number): string | undefined
  getProgress(): { completed: number, total: number }
  
  // Cache integration
  checkCache(item: TTSQueueItem): Promise<string | null>
  
  // Cleanup
  async cancelPreloading(): Promise<void>
}
```

**Events Emitted:**
```typescript
'ready': { index: number, uri: string }  // First element ready
'progress': { completed: number, total: number, percentage: number }
'complete': { totalGenerated: number, cached: number }
'error': { index: number, error: string, willRetry: boolean }
'retrying': { index: number, attempt: number, maxAttempts: number }
```

**Preload Strategy:**
```
1. Receive queue of N elements
2. Check cache for all elements
3. Generate first 5 uncached (parallel: 2)
4. Emit 'ready' when first element available
5. Background: Generate remaining (parallel: 10)
6. During playback: Maintain 3-5 buffer ahead
```

---

### 3. TTSCacheManager

**File:** `src/services/tts/TTSCacheManager.ts`

**Type:** Singleton service

**Responsibilities:**
- LRU (Least Recently Used) cache implementation
- Storage limit enforcement (default 100MB)
- File persistence and retrieval
- Cache key generation (hash of text + voice settings)
- Cleanup of expired/old files
- Storage metrics and reporting

**Key Methods:**
```typescript
class TTSCacheManager {
  // Cache operations
  async get(key: string): Promise<string | null>
  async set(key: string, uri: string, metadata: CacheMetadata): Promise<void>
  async has(key: string): Promise<boolean>
  async delete(key: string): Promise<void>
  
  // Bulk operations
  async clear(): Promise<void>
  async prune(): Promise<number>  // Remove LRU items to free space
  
  // Metrics
  async getSize(): Promise<number>  // Bytes
  async getItemCount(): Promise<number>
  getHitRate(): number  // percentage
  
  // Key generation
  generateKey(text: string, settings: VoiceSettings): string
}
```

**Cache Structure:**
```
FileSystem.cacheDirectory/tts/
  ├── cache/                 # Progressive preload cache (LRU)
  │   ├── abc123def.mp3     # Hash-based filenames
  │   ├── xyz789ghi.mp3
  │   └── metadata.json     # Cache index with LRU info
  └── offline/              # Batch download storage (persistent)
      ├── novel_123/
      │   ├── chapter_45/
      │   │   ├── element_0.mp3
      │   │   ├── element_1.mp3
      │   │   └── metadata.json
      │   └── chapter_46/
      └── novel_456/
```

**Metadata Schema:**
```typescript
interface CacheMetadata {
  key: string;
  uri: string;
  size: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  voice: string;
  engine: TTSEngine;
}
```

---

### 4. TTSDownloadManager

**File:** `src/services/tts/TTSDownloadManager.ts`

**Type:** Singleton service (EventEmitter)

**Responsibilities:**
- Batch synthesis job submission and tracking
- Background polling of job status
- Download orchestration when jobs complete
- Offline chapter metadata management
- Download queue prioritization
- Auto-download next chapter logic
- Storage management for offline files

**Key Methods:**
```typescript
class TTSDownloadManager extends EventEmitter {
  // Download operations
  async downloadChapter(
    chapterId: number, 
    textElements: string[]
  ): Promise<void>
  
  async cancelDownload(chapterId: number): Promise<void>
  async deleteOfflineChapter(chapterId: number): Promise<void>
  
  // Status queries
  isChapterDownloaded(chapterId: number): Promise<boolean>
  getDownloadStatus(chapterId: number): DownloadStatus | null
  getOfflineChapters(): Promise<number[]>
  
  // Playback support
  async getOfflineChapterAudio(chapterId: number): Promise<string[] | null>
  
  // Storage management
  async getStorageUsage(): Promise<number>
  async clearAllDownloads(): Promise<void>
  
  // Auto-download
  enableAutoDownload(enabled: boolean): void
  shouldAutoDownload(currentChapter: number): boolean
}
```

**Events Emitted:**
```typescript
'downloadStart': { chapterId: number, jobId: string }
'downloadProgress': { chapterId: number, progress: number }  // 0-100
'downloadComplete': { chapterId: number, fileCount: number }
'downloadFailed': { chapterId: number, error: string }
'storageWarning': { used: number, max: number }  // Approaching limit
```

**Download Workflow:**
```
1. User taps download button
2. Extract text from chapter HTML
3. Submit batch synthesis job to Azure
4. Store job ID and metadata
5. Poll job status every 10s (background task)
6. When succeeded: Download all output files
7. Save to offline storage with metadata
8. Emit completion event
9. Cleanup remote job
```

---

### 5. TTSAudioGenerator

**File:** `src/services/tts/TTSAudioGenerator.ts`

**Type:** Factory class

**Responsibilities:**
- Unified interface for audio generation
- Engine routing (Expo vs Microsoft)
- Error handling and fallback logic
- Returns file URIs for playback

**Key Methods:**
```typescript
class TTSAudioGenerator {
  static async generateAudio(
    text: string,
    engine: TTSEngine,
    settings: VoiceSettings,
    options?: { timeout?: number, forceRegenerate?: boolean }
  ): Promise<string>
  
  static async testEngine(engine: TTSEngine): Promise<boolean>
  
  static getSupportedFormats(engine: TTSEngine): string[]
}
```

**Generation Flow:**
```typescript
async generateAudio(text, engine, settings) {
  // 1. Check cache first
  const cacheKey = cacheManager.generateKey(text, settings);
  const cached = await cacheManager.get(cacheKey);
  if (cached && !options.forceRegenerate) {
    return cached;
  }
  
  // 2. Route to engine
  let uri: string;
  if (engine === 'microsoft') {
    uri = await microsoftSpeechService.generateAudio(text, settings);
  } else {
    uri = await expoSpeechService.synthesizeToFile(text, settings);
  }
  
  // 3. Cache result
  await cacheManager.set(cacheKey, uri, { ... });
  
  return uri;
}
```

---

### 6. TTSForegroundService (Native)

**File:** `android/app/src/main/java/.../TTSForegroundService/TTSForegroundService.kt`

**Type:** Android Service (extends Service)

**Responsibilities:**
- Run as foreground service (prevents system kill)
- Show ongoing notification (required for foreground)
- Manage service lifecycle (start, stop, restart)
- Broadcast receiver for notification actions
- Event communication with React Native

**Key Components:**
```kotlin
class TTSForegroundService : Service() {
  companion object {
    const val CHANNEL_ID = "tts-foreground-service"
    const val NOTIFICATION_ID = 1002
    const val ACTION_PLAY = "com.lnreader.TTS_SERVICE_PLAY"
    const val ACTION_PAUSE = "com.lnreader.TTS_SERVICE_PAUSE"
    const val ACTION_STOP = "com.lnreader.TTS_SERVICE_STOP"
  }
  
  override fun onCreate()
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int
  override fun onDestroy()
  override fun onBind(intent: Intent?): IBinder?
  
  private fun createNotification(): Notification
  private fun updateNotification(metadata: PlaybackMetadata)
  private fun sendEventToReactNative(eventName: String, data: WritableMap?)
}
```

**Notification Design:**
```
┌─────────────────────────────────────┐
│ 🔊 LNReader - Text-to-Speech        │ [X]
├─────────────────────────────────────┤
│ [Cover]  Novel Name                 │
│          Chapter 42: Title          │
│          Element 23/150             │
├─────────────────────────────────────┤
│    [⏮] [⏸/▶] [⏭]      [⏹]         │
└─────────────────────────────────────┘
```

**Lifecycle:**
```
React Native calls startService()
  → Service.onCreate()
  → startForeground(notification)
  → Service keeps process alive
  → User or app calls stopService()
  → Service.onDestroy()
```

---

### 7. NativeExpoSpeech (Native Turbo Module)

**File:** `android/app/src/main/java/.../NativeExpoSpeech/NativeExpoSpeech.kt`  
**Spec:** `specs/NativeExpoSpeech.ts`

**Type:** React Native Turbo Module

**Responsibilities:**
- Wrapper for Android TextToSpeech API
- Implements synthesizeToFile() (missing from expo-speech)
- Voice enumeration
- Synthesis progress callbacks

**Turbo Module Spec:**
```typescript
export interface Spec extends TurboModule {
  synthesizeToFile(
    text: string,
    voiceId: string,
    pitch: number,
    rate: number,
    outputPath: string
  ): Promise<string>;  // Returns file URI
  
  getAvailableVoices(): Promise<Voice[]>;
  
  isSpeaking(): boolean;
  
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
}
```

**Implementation:**
```kotlin
class NativeExpoSpeech(context: ReactApplicationContext) : NativeExpoSpeechSpec(context) {
  private var tts: TextToSpeech? = null
  
  override fun synthesizeToFile(
    text: String,
    voiceId: String,
    pitch: Double,
    rate: Double,
    outputPath: String,
    promise: Promise
  ) {
    val file = File(outputPath)
    val params = Bundle().apply {
      putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, "utterance_id")
    }
    
    tts?.setPitch(pitch.toFloat())
    tts?.setSpeechRate(rate.toFloat())
    
    val result = tts?.synthesizeToFile(text, params, file, "utterance_id")
    
    if (result == TextToSpeech.SUCCESS) {
      promise.resolve(file.toURI().toString())
    } else {
      promise.reject("SYNTHESIS_ERROR", "Failed to synthesize to file")
    }
  }
}
```

---

## Data Flow

### Startup Flow (User Taps Play)

```
1. User taps play button in WebViewReader
   ↓
2. WebView posts 'speak' event with queue data
   ↓
3. WebViewReader extracts:
   - textElements: string[]
   - startIndex: number
   - chapterId: number
   - novelId: number
   ↓
4. Check if chapter downloaded offline
   ├─ YES → Load offline audio files → Skip to step 9
   └─ NO → Continue to step 5
   ↓
5. Build TTSQueueItem[] from text elements
   ↓
6. Start foreground service
   TTSForegroundService.startService()
   ↓
7. Initialize TTSPlaybackManager
   playbackManager.play(queue, startIndex, chapterId)
   ↓
8. TTSAudioPreloader starts progressive preload
   ├─ Generate first 5 elements (priority)
   ├─ Check cache for each
   ├─ Generate missing elements
   └─ Emit 'ready' when first available
   ↓
9. TTSPlaybackManager receives first audio URI
   ↓
10. Load audio with expo-av
    const { sound } = await Audio.Sound.createAsync({ uri })
    ↓
11. Start playback
    await sound.playAsync()
    ↓
12. Update UI
    - WebView highlight (injectJavaScript)
    - Notification metadata
    - Progress display
    ↓
13. Background: Preloader continues generating remaining elements
    ↓
14. On element completion (sound.onPlaybackStatusUpdate):
    ├─ Update progress
    ├─ Check buffer ahead
    ├─ Load next element
    └─ Repeat from step 10
```

---

### Pause/Resume Flow

```
Pause:
1. User taps pause (notification or WebView)
   ↓
2. Event → TTSPlaybackManager.pause()
   ↓
3. await currentSound.pauseAsync()
   ↓
4. Update state: 'paused'
   ↓
5. Update notification: show play button
   ↓
6. Update WebView: show play icon

Resume:
1. User taps play
   ↓
2. Event → TTSPlaybackManager.resume()
   ↓
3. await currentSound.playAsync()
   ↓
4. Update state: 'playing'
   ↓
5. Update notification: show pause button
   ↓
6. Continue playback from exact position
```

---

### Background Playback Flow

```
1. User backgrounds app (home button)
   ↓
2. AppState changes to 'background'
   ↓
3. Foreground service keeps process alive
   ↓
4. expo-av continues playback (no interruption)
   ↓
5. WebView freezes (can't update highlight)
   ├─ Disable WebView updates
   └─ Continue audio playback
   ↓
6. User returns to foreground
   ↓
7. AppState changes to 'active'
   ↓
8. Sync WebView with current position
   webViewRef.injectJavaScript(`tts.seekTo(${currentIndex})`)
   ↓
9. Resume WebView highlight updates
```

---

### Offline Download Flow

```
1. User taps download icon on chapter
   ↓
2. Extract chapter text elements
   ↓
3. TTSDownloadManager.downloadChapter(chapterId, elements)
   ↓
4. BatchSynthesisService.submitChapterBatch()
   ├─ Create SSML document
   ├─ Upload to blob storage (or use data URI)
   └─ Submit batch job to Azure API
   ↓
5. Receive job ID, store metadata
   ↓
6. Start background polling (every 10s)
   ↓
7. Poll Azure for job status
   ├─ NotStarted → Keep polling
   ├─ Running → Update progress UI
   ├─ Failed → Emit error, cleanup
   └─ Succeeded → Continue to step 8
   ↓
8. Download output files from Azure
   ├─ Create chapter directory
   ├─ Download each audio file
   └─ Save metadata
   ↓
9. Cleanup Azure job (delete)
   ↓
10. Emit 'downloadComplete' event
    ↓
11. Update UI: Show checkmark icon
```

---

## State Management

### Global State (TTSPlaybackManager)

```typescript
{
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped',
  currentIndex: number,
  queue: TTSQueueItem[],
  chapterId: number,
  novelId: number,
  currentSound: Audio.Sound | null,
  voiceSettings: VoiceSettings,
  engine: TTSEngine
}
```

### Persisted State (MMKV)

```typescript
// Key: '@tts_playback_state'
{
  isActive: boolean,
  chapterId: number,
  novelId: number,
  elementIndex: number,
  playbackPosition: number,  // ms within current audio
  timestamp: number,
  engine: TTSEngine,
  voiceSettings: VoiceSettings
}
```

### Download State (MMKV)

```typescript
// Key: '@tts_downloads'
{
  [chapterId: number]: {
    status: 'queued' | 'processing' | 'downloading' | 'completed' | 'failed',
    batchJobId: string,
    progress: number,
    fileCount: number,
    createdAt: number,
    completedAt?: number
  }
}
```

---

## Playback Strategies

### Strategy 1: Progressive Preloading (Default)

**When:** User starts TTS normally  
**How:**
1. Generate first 5 elements immediately
2. Start playback as soon as first ready
3. Background: Generate remaining elements
4. During playback: Maintain 3-5 buffer ahead

**Pros:**
- Fast startup (1-2 seconds)
- Handles network switches (cached elements)
- Good UX balance

**Storage:** Temporary cache (100MB default, LRU)

---

### Strategy 2: Offline Playback

**When:** Chapter pre-downloaded OR no network  
**How:**
1. Check for offline files first
2. Load pre-generated audio
3. Instant playback (0 latency)

**Pros:**
- Zero network dependency
- Instant startup
- Perfect for travel/airplane

**Storage:** Persistent (user-managed, separate from cache)

---

### Strategy 3: On-Demand Fallback

**When:** Progressive preload fails OR minimal mode  
**How:**
1. Generate only current element
2. Wait for completion
3. Generate next element

**Pros:**
- Minimal storage
- Low bandwidth

**Cons:**
- Slower
- Gaps between elements

---

## Error Handling

### Network Errors

```typescript
try {
  const uri = await generateAudio(text, settings);
} catch (error) {
  if (error.code === 'NETWORK_ERROR') {
    // Retry with exponential backoff
    await retry(() => generateAudio(text, settings), {
      maxAttempts: 3,
      backoff: [1000, 2000, 4000]
    });
  }
}
```

### Engine Fallback

```typescript
try {
  // Try Microsoft Speech
  uri = await microsoftSpeechService.generateAudio(text);
} catch (error) {
  showToast('Microsoft Speech failed, using device voice');
  // Fallback to Expo Speech
  uri = await expoSpeechService.synthesizeToFile(text);
}
```

### Service Recovery

```kotlin
override fun onTaskRemoved(rootIntent: Intent?) {
  // Service killed by system
  // Save state to SharedPreferences
  savePlaybackState()
  
  // Schedule restart if playback was active
  if (isPlaying) {
    val restartIntent = Intent(this, TTSForegroundService::class.java)
    val pendingIntent = PendingIntent.getService(...)
    alarmManager.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 1000, pendingIntent)
  }
  
  super.onTaskRemoved(rootIntent)
}
```

---

**Next:** Read [02-IMPLEMENTATION-GUIDE.md](./02-IMPLEMENTATION-GUIDE.md) for step-by-step implementation
