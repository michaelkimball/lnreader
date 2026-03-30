# LNReader TTS Documentation

**Last Updated:** March 30, 2026

---

## Documentation Map

This directory contains all documentation for LNReader's Text-to-Speech system. Use this map to find the right document quickly.

| Document | Topics Covered | Key Files Referenced |
|---|---|---|
| [architecture.md](./architecture.md) | System overview, component diagram, data flow, engine routing, layer responsibilities | TTSPlaybackManager, WebViewReader, core.js, NativeTTSForegroundService |
| [playback-engine.md](./playback-engine.md) | TTSPlaybackManager state machine, expo-av integration, preloader pipeline, notification controls, position resumption | TTSPlaybackManager.ts, TTSAudioPreloader.ts, NativeTTSForegroundService.ts |
| [audio-generation.md](./audio-generation.md) | TTSAudioGenerator engine routing, MicrosoftSpeechService (Azure), NativeExpoSpeech, LRU cache | TTSAudioGenerator.ts, MicrosoftSpeechService.ts, TTSCacheManager.ts |
| [offline-downloads.md](./offline-downloads.md) | Azure Batch Synthesis, AzureBlobStorage, TTSDownloadManager, DB schema, Downloads UI | TTSDownloadManager.ts, AzureBatchSynthesisService.ts, AzureBlobStorage.ts, TTSDownloadsScreen.tsx |
| [webview-integration.md](./webview-integration.md) | WebView TTS engine (core.js), event protocol, WebViewReader bridge, position save/restore, UI controller | core.js, WebViewReader.tsx |
| [known-bugs-and-patterns.md](./known-bugs-and-patterns.md) | All resolved bugs, state management patterns, build gotchas, anti-patterns | TTSPlaybackManager.ts, WebViewReader.tsx |

---

## High-Level Architecture

```
User Action
  ↓
WebViewReader.tsx  (React Native bridge)
  ↓         ↑ events (speak/pause/stop)
core.js    (WebView TTS engine — DOM traversal, element queue)
  ↓
TTSPlaybackManager (singleton orchestrator)
  ├── TTSAudioPreloader (generates next N audio files ahead)
  │     └── TTSAudioGenerator (expo or microsoft engine)
  │           ├── NativeExpoSpeech (device TTS → audio file)
  │           ├── MicrosoftSpeechService (Azure REST API → MP3)
  │           └── TTSCacheManager (LRU 100MB FileSystem cache)
  └── expo-av Audio.Sound (plays audio files)
        ↕
NativeTTSForegroundService (Android foreground service + MediaSession)
  └── Notification controls → events back to TTSPlaybackManager
```

For offline downloaded chapters:
```
TTSDownloadManager
  ├── AzureBlobStorage (upload SSML input files)
  ├── AzureBatchSynthesisService (submit/poll batch job)
  └── Database: ttsDownload table (status, paths, element offsets)
        ↓ (on playback)
TTSPlaybackManager (offline mode — single MP3 + element offset seeking)
```

---

## Key Source Locations

### TypeScript / React Native
| File | Purpose |
|---|---|
| `src/services/tts/TTSPlaybackManager.ts` | Singleton playback orchestrator |
| `src/services/tts/TTSAudioPreloader.ts` | Progressive look-ahead audio generation |
| `src/services/tts/TTSAudioGenerator.ts` | Unified audio generation (expo + microsoft) |
| `src/services/tts/TTSCacheManager.ts` | LRU FileSystem cache |
| `src/services/tts/MicrosoftSpeechService.ts` | Azure Speech REST API |
| `src/services/tts/EventEmitter.ts` | Custom event emitter (Node.js unavailable in RN) |
| `src/services/tts/AzureBlobStorage.ts` | Azure Blob Storage for batch synthesis inputs |
| `src/services/tts/AzureBatchSynthesisService.ts` | Batch synthesis job management |
| `src/services/tts/TTSDownloadManager.ts` | Offline download orchestration |
| `src/screens/reader/components/WebViewReader.tsx` | React Native ↔ WebView bridge |
| `src/screens/more/TTSDownloadsScreen.tsx` | Download management UI |
| `src/database/schema/ttsDownload.ts` | Drizzle schema for download tracking |
| `src/database/queries/TTSDownloadQueries.ts` | DB queries for downloads |
| `src/hooks/persisted/useSettings.ts` | TTS and integration settings (MMKV) |
| `specs/NativeTTSForegroundService.ts` | Turbo Module spec |
| `specs/NativeExpoSpeech.ts` | Turbo Module spec |

### WebView JavaScript
| File | Purpose |
|---|---|
| `android/app/src/main/assets/js/core.js` | TTS engine: DOM traversal, element queue, events |
| `android/app/src/main/assets/css/tts.css` | TTS controller and highlight styles |

### Android Kotlin
| File | Purpose |
|---|---|
| `android/app/src/main/java/.../TTSForegroundService.kt` | Foreground service + MediaSession |
| `android/app/src/main/java/.../NativeTTSForegroundService.kt` | Turbo Module wrapper |
| `android/app/src/main/java/.../NativeExpoSpeech.kt` | Audio-file-generating TTS engine |

---

## Finding Information

**"How does playback work end-to-end?"** → [architecture.md](./architecture.md)

**"Why is audio skipping / stopping unexpectedly?"** → [known-bugs-and-patterns.md](./known-bugs-and-patterns.md)

**"How does the state machine work? What events are emitted?"** → [playback-engine.md](./playback-engine.md)

**"How do I add a new TTS engine?"** → [audio-generation.md](./audio-generation.md)

**"How does the WebView communicate with React Native?"** → [webview-integration.md](./webview-integration.md)

**"How does offline download work? What's the DB schema?"** → [offline-downloads.md](./offline-downloads.md)

**"Why do I need `isServiceRunning && savedState` (not just one check)?"** → [known-bugs-and-patterns.md](./known-bugs-and-patterns.md#8-mmkv-state-persistence--resume-not-working)
