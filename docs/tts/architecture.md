# TTS System Architecture

**Last Updated:** March 30, 2026

---

## Overview

LNReader's TTS system uses a foreground service architecture with progressive preloading and offline batch download capability.

**Engines supported:**
- **Expo Speech** (default): Uses `NativeExpoSpeech` Turbo Module to produce audio files from the device TTS engine. Always available, no internet, no cost.
- **Microsoft Azure Speech** (optional): Cloud neural TTS via REST API. Requires an Azure subscription. Higher quality, 400+ voices.

---

## Layer Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        User Interaction                          │
│  WebView TTS Controller (drag to start)  •  Media notification   │
│  Settings: TTSTab (voice, pitch, rate, engine, auto-advance)     │
└────────────────────────────┬─────────────────────────────────────┘
                             │ 'speak' / 'pause-speak' / 'stop-speak'
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│              WebView JavaScript (core.js)                        │
│  • Traverses chapter DOM, builds allReadableElements[]           │
│  • Sends one element at a time via reader.post('speak', ...)     │
│  • Tracks elementsRead / totalElements                           │
│  • Highlights current element, auto-scrolls                      │
└────────────────────────────┬─────────────────────────────────────┘
                             │ WebView onMessage
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│              WebViewReader.tsx  (React Native bridge)            │
│  • Dispatches WebView events to TTSPlaybackManager               │
│  • Handles playback events back (queueEnd → inject tts.next())   │
│  • Saves/restores TTS position via MMKV                          │
│  • Manages foreground service lifecycle                          │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│              TTSPlaybackManager  (singleton)                     │
│  • State machine: idle → loading → playing → paused → stopped   │
│  • Controls expo-av Audio.Sound for true pause/resume            │
│  • Coordinates TTSAudioPreloader for look-ahead generation       │
│  • Emits events: stateChange, elementChange, queueEnd, error     │
│  • Supports offline mode (single MP3 + element offsets)          │
└──────────┬────────────────────────────────────────┬─────────────┘
           │                                        │
           ▼                                        ▼
┌──────────────────────┐              ┌─────────────────────────────┐
│  TTSAudioPreloader   │              │  expo-av Audio.Sound        │
│  • Look-ahead buffer │              │  • True pause/resume        │
│  • Retry on failure  │              │  • Seeks to offset (offline)│
│  • Emits 'ready'     │              └─────────────────────────────┘
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│              TTSAudioGenerator  (static factory)                 │
│  • Checks TTSCacheManager first                                  │
│  • Routes to correct engine                                      │
│  • Falls back to Expo if Microsoft fails                         │
│  ┌─────────────────────────┐   ┌──────────────────────────────┐  │
│  │  NativeExpoSpeech       │   │  MicrosoftSpeechService      │  │
│  │  Turbo Module           │   │  Azure REST API              │  │
│  │  device TTS → .wav file │   │  SSML → MP3 download         │  │
│  └─────────────────────────┘   └──────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  TTSCacheManager  (LRU, 100 MB, FileSystem-backed)           │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘

                             │ controls
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  NativeTTSForegroundService  (Kotlin Turbo Module)               │
│  • Android foreground service (keeps app alive in background)    │
│  • MediaSession + notification with controls                     │
│  • Emits TTSPlay / TTSPause / TTSStop / TTSNext / TTSPrev events │
└──────────────────────────────────────────────────────────────────┘
```

---

## Offline Download Path

When a chapter has a completed offline download, `TTSPlaybackManager` enters **offline mode**:

```
TTSDownloadManager
  │
  ├── AzureBlobStorage.ts        Upload SSML → Azure Blob (public URL)
  ├── AzureBatchSynthesisService  Submit job → poll until done
  │                               Download single MP3 + sentence boundaries JSON
  └── Database: ttsDownload       Store status, local paths, element offsets

              ↓ (on playback request)

TTSPlaybackManager (isOfflineMode = true)
  • Loads single MP3 file into expo-av
  • Uses elementOffsets[] to seekTo() correct ms position per element
  • No network calls required during playback
```

---

## Engine Routing

Routing happens in `TTSAudioGenerator.generateAudio()`:

```
VoiceSettings.engine === 'microsoft'
  AND MicrosoftSpeechService.isInitialized()
    → generateWithMicrosoft()
      on error  → generateWithExpo() (fallback)
    
VoiceSettings.engine === 'expo'
  → generateWithExpo()
```

Settings are read from MMKV key `CHAPTER_READER_SETTINGS`. The engine is configured in Settings → Reader → TTS tab. Azure credentials are in Settings → Integrations.

---

## Data Flow: Online Playback (Per Element)

1. User taps TTS button → WebView `tts.start()` builds `allReadableElements[]`
2. WebView calls `tts.next()` → posts `{type: 'speak', data: text, index: N, total: M}`
3. `WebViewReader` receives `onMessage` → calls `ttsPlaybackManager.play([text], N, M, chapterId)`
4. `TTSPlaybackManager.play()`:
   - State guard: returns if already `loading` or `playing`
   - Sets state to `loading`
   - Calls `preloader.enqueue(text, voiceSettings)`
5. `TTSAudioPreloader`:
   - Checks cache → otherwise generates audio via `TTSAudioGenerator`
   - Emits `'ready'` with `{ uri, index }`
6. `TTSPlaybackManager` receives `'ready'`:
   - Loads `Audio.Sound` from `uri`
   - Plays → state becomes `playing`
   - When audio finishes → emits `queueEnd { reason: 'completed' }`
7. `WebViewReader` handles `queueEnd`:
   - Saves position to MMKV
   - Injects `tts.next()` into WebView
8. Repeat from step 2 until all elements played

---

## Data Flow: Offline Playback

1. `WebViewReader` detects chapter has completed download (`hasCompletedDownload(chapterId)`)
2. Gets audio file path and element offsets from DB (`getAudioFilePaths`, `getElementOffsets`)
3. Calls `ttsPlaybackManager.playOffline(audioPath, offsets, chapterId)`
4. `TTSPlaybackManager` loads single MP3, uses `currentSound.setPositionAsync(offsets[index] * 1000)` for element navigation
5. Media controls (seek, next, prev) translate to offset-based seeking

---

## Key Settings (MMKV)

| MMKV Key | Type | Contents |
|---|---|---|
| `CHAPTER_READER_SETTINGS` | `ChapterReaderSettings` | TTS engine, voice, pitch, rate, autoPageAdvance, scrollToTop |
| `INTEGRATION_SETTINGS` | `IntegrationSettings` | Azure Speech key/region, Azure Blob accountName/accountKey/containerName |
| `tts_state_{chapterId}` | `TTSState` | elementIndex, isPlaying, timestamp — per chapter position |

---

## Component Responsibilities Summary

| Component | Source of Truth For | Must NOT |
|---|---|---|
| `core.js` (WebView) | `allReadableElements[]`, `elementsRead`, highlighting | Call `tts.stop()` between elements (resets queue) |
| `WebViewReader.tsx` | Service lifecycle, notification, MMKV position | Call `ttsPlaybackManager.stop()` directly on unmount (bypasses position save) |
| `TTSPlaybackManager` | Playback state machine, audio hardware | Emit `queueEnd` when stopping from `play()` cleanup (`fromPlay=true`) |
| `TTSAudioPreloader` | Look-ahead generation, retry | Do audio playback directly |
| `NativeTTSForegroundService` | Service alive-ness, notification UI | Be the source of truth for playback state |
