# TTS Playback Engine

**File:** `src/services/tts/TTSPlaybackManager.ts`
**Last Updated:** March 30, 2026

---

## Overview

`TTSPlaybackManager` is a singleton that orchestrates all audio playback. It owns the expo-av `Audio.Sound` instance, drives the `TTSAudioPreloader`, and emits events consumed by `WebViewReader`.

There is intentionally **one** instance application-wide — created lazily via `TTSPlaybackManager.getInstance()`.

---

## State Machine

```
         play()                 audio finishes / next()
  idle ──────────► loading ──────────────────────────► queueEnd emitted
    ▲                │                                        │
    │                ▼                                        │
    │            playing ◄────────────── resume()            │
    │                │                       ▲               │
    │           pause()│                     │               │
    │                ▼                       │               │
    │            paused ─────────────────────┘               │
    │                                                         │
    └─────────────────── stop() ─────────────────────────────┘
```

**States:**

| State | Meaning |
|---|---|
| `idle` | No audio. Initial state or after stop completes (100ms delay). |
| `loading` | Audio is being generated / fetched by preloader. |
| `playing` | Audio is actively playing via expo-av. |
| `paused` | Audio paused mid-file (true pause — position preserved). |
| `stopped` | Stop in progress (transitional — clears to `idle` after 100ms). |

---

## Key Properties

```typescript
private state: PlaybackState         // Current state
private currentIndex: number         // Element index in chapter (0-based)
private queue: TTSQueueItem[]        // Current single-element queue
private chapterId: number
private novelId: number
private currentSound: Audio.Sound | null
private voiceSettings: VoiceSettings | null
private preloader: TTSAudioPreloader
private isStopping: boolean          // Re-entrance guard
private idleTimer: NodeJS.Timeout | null
private isOfflineMode: boolean       // Playing from batch-downloaded file
private elementOffsets: number[]     // ms start times for offline mode
private lastEmittedElementIndex: number  // Prevents duplicate elementChange events
```

---

## Public API

### `play(texts, startIndex, total, chapterId, novelId?, voiceSettings?)`

Starts playback from `startIndex`. Rejects if `state === 'loading' || state === 'playing'` (state guard).

1. Calls `stop(true)` (fromPlay flag — no idle timer, no queueEnd emission)
2. Checks DB for completed offline download → switches to offline mode if available
3. Enqueues text(s) to preloader
4. State → `loading`

### `pause()`

Calls `currentSound.pauseAsync()`. State → `paused`.

### `resume()`

Calls `currentSound.playAsync()`. State → `playing`.

### `stop(fromPlay?: boolean)`

Re-entrance protected by `isStopping` flag.

- Unloads current sound
- Clears preloader queue
- If `fromPlay=true`: clears `isStopping` immediately (no idle timer, no queueEnd)
- If `fromPlay=false`: emits `queueEnd { reason: 'stopped' }`, sets 100ms timer to → `idle`

### `next()`

Manually advances to next element. Does NOT call `stop()` internally — cleans up manually to avoid re-entrant `isStopping` conflicts.

### `seek(index)`

For offline mode: calls `currentSound.setPositionAsync(elementOffsets[index] * 1000)`.
For online mode: re-enqueues text at `index` via `play()`.

### `playOffline(audioPath, elementOffsets, chapterId)`

Loads entire chapter MP3 into expo-av. Sets `isOfflineMode = true`. Uses `elementOffsets` array for seeking to specific elements.

---

## Events Emitted

All events follow the `PlaybackEvent` interface:

```typescript
interface PlaybackEvent {
  type: 'stateChange' | 'progress' | 'elementChange' | 'queueEnd' | 'error' | 'audioLoading' | 'audioReady';
  state?: PlaybackState;
  index?: number;
  current?: number;
  total?: number;
  text?: string;
  reason?: 'completed' | 'stopped';
  message?: string;
  code?: string;
  uri?: string;
}
```

| Event Type | When Emitted | Key Fields |
|---|---|---|
| `stateChange` | On every state transition | `state` |
| `elementChange` | When element index advances | `index`, `text` |
| `progress` | Periodically during playback | `current`, `total` |
| `audioLoading` | Generation started | `index` |
| `audioReady` | Audio file ready to play | `uri`, `index` |
| `queueEnd` | Playback finished or stopped | `reason: 'completed' | 'stopped'` |
| `error` | Generation or playback error | `message`, `code` |

**WebViewReader listens to:** `queueEnd` (to inject `tts.next()`), `stateChange` (to update UI), `elementChange` (for progress tracking).

---

## TTSAudioPreloader

**File:** `src/services/tts/TTSAudioPreloader.ts`

The preloader manages look-ahead audio generation so the next element is ready before the current one finishes.

### How It Works

1. `TTSPlaybackManager` calls `preloader.enqueue(item)` for the current element (and optionally N ahead)
2. Preloader calls `TTSAudioGenerator.generateAudio()` asynchronously
3. On success → emits `'ready'` event with `{ uri, index, item }`
4. On failure → retries up to configured limit, then emits `'error'`

### TTSQueueItem Interface

```typescript
interface TTSQueueItem {
  text: string;
  index: number;
  voiceSettings: VoiceSettings;
}
```

### Retry Logic

Failed generation is retried with exponential backoff. After max retries, the `'error'` event fires and `TTSPlaybackManager` skips to the next element.

---

## Foreground Service Integration

**Spec:** `specs/NativeTTSForegroundService.ts`
**Implementation:** `android/app/src/main/java/.../TTSForegroundService.kt`

### Lifecycle

```typescript
// Start service (must call before first playback notification appears)
NativeTTSForegroundService.startService(novelName, chapterName, coverUri, isPlaying);

// Update while playing
NativeTTSForegroundService.updatePlaybackState(true); // playing
NativeTTSForegroundService.updateMetadata(title, subtitle, cover);

// Stop when TTS session ends
NativeTTSForegroundService.stopService();
```

### Events from Service

The service emits these events via `NativeEventEmitter`, consumed in `WebViewReader.tsx`:

| Event | Triggers |
|---|---|
| `TTSPlay` | Notification play button / headset |
| `TTSPause` | Notification pause button / headset |
| `TTSStop` | Notification close button |
| `TTSNext` | Notification next button |
| `TTSPrev` | Notification previous button |
| `TTSSeekTo` | Seek slider on notification |

### MediaSession (Android)

Progress is tracked in `ms` (element index × 1000):
- `STATE_PLAYING` or `STATE_PAUSED`
- `currentPosition = elementIndex * 1000L`
- `duration = totalElements * 1000L`
- Seek slider maps back: `elementIndex = seekPositionMs / 1000`

Compact notification shows: Previous · Play/Pause · Next (3 actions).

---

## Position Resumption

TTS position is saved to MMKV after every element completes, so the app can resume from the exact element even if it crashes.

**Key:** `tts_state_{chapterId}`

```typescript
interface TTSState {
  chapterId: number;
  elementIndex: number;
  isPlaying: boolean;
  timestamp: number;
}
```

**Save:** Called in `WebViewReader` inside the `'speak'` event handler, before `play()`.

**Load:** On chapter open (TTS button press). Uses **dual-condition check**:

```typescript
const savedState = loadTTSState(chapter.id);
const isServiceRunning = NativeTTSForegroundService.isServiceRunning();

if (isServiceRunning && savedState) {
  // Service exists AND we have a saved position → resume
  webViewRef.current?.injectJavaScript(`tts.start(${savedState.elementIndex})`);
} else {
  // Start fresh
  webViewRef.current?.injectJavaScript(`ttsButton.click()`);
}
```

> See [known-bugs-and-patterns.md](./known-bugs-and-patterns.md#8-mmkv-state-persistence--resume-not-working) for why a single condition is insufficient.

**Clear:** When chapter completes, WebViewReader injects `clear-tts-position` message which deletes the MMKV key.

---

## Audio Mode Configuration

Set once at startup via `initializeAudio()`:

```typescript
await Audio.setAudioModeAsync({
  allowsRecordingIOS: false,
  staysActiveInBackground: true,   // Critical for background playback
  playsInSilentModeIOS: true,
  shouldDuckAndroid: true,         // Lower other audio
  playThroughEarpieceAndroid: false,
});
```
