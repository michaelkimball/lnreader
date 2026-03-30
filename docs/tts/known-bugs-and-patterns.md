# TTS Known Bugs & Patterns

**Last Updated:** March 30, 2026

All bugs listed here have been **resolved**. This document preserves the root-cause analysis and solutions as a reference for future debugging and to prevent regression.

---

## Resolved Bugs

### 9. Expo Engine Produces Unplayable Audio (Wrong Format + Malformed Path)

**Symptom:** TTS with the Expo engine either produces silence or expo-av reports a load error. Manifests on first install and after clearing the cache.

**Root Cause (three compounding bugs):**

1. **Wrong file extension:** `getTempFilePath('expo')` was generating `.mp3` paths. Android's `TextToSpeech.synthesizeToFile()` always writes WAV audio regardless of the filename extension. expo-av rejected the WAV-data-in-an-mp3-file as an unsupported codec.

2. **Malformed path passed to Kotlin:** `FileSystem.cacheDirectory` (legacy API) returns a `file:///data/...` URI. This was passed directly as `outputPath` to the Kotlin module, which passed it to `java.io.File(outputPath)`. `java.io.File` treats `file:///path` as a literal filename starting with `file:`, so it tried to create the file in the process working directory — failing silently.

3. **Promise resolved before synthesis completes:** `synthesizeToFile()` on Android is asynchronous. `ERROR_SUCCESS` from the API means the job was queued, not that the file has been written. The original code slept 100ms and resolved the promise, causing expo-av to try to load an empty or partial WAV file for longer texts.

**Solution:**

- `ENGINE_CONFIGS` record maps each engine to its actual output extension (`'wav'` for expo, `'mp3'` for microsoft). `getTempFilePath` derives the extension from this record — no hard-coded strings.
- All file path construction migrated from string concatenation to `new File(Paths.cache, filename).uri` (new expo-file-system API), which always produces well-formed `file://` URIs.
- `MicrosoftSpeechService` migrated from `expo-file-system/legacy` import to `expo-file-system` main export. Audio written as raw bytes via `file.write(new Uint8Array(arrayBuffer))` — no base64 encoding round-trip.
- Kotlin `NativeExpoSpeechModule`: `outputPath` parsed via `java.net.URI(outputPath).path` to extract the real filesystem path. `Thread.sleep(100) + promise.resolve()` replaced with storing the promise in a `ConcurrentHashMap<utteranceId, Pair<Promise, File>>` and resolving inside `UtteranceProgressListener.onDone()`. Both `onError` overloads reject the pending promise.

**Key Rule:** Android TTS always writes WAV. Never name the output file `.mp3`. Always pass a plain filesystem path (not a `file://` URI) to `java.io.File`.

---

### 10. Overlapping Voices on Second Play Session (Cache-Warm Race)

**Symptom:** On the second play session (after navigate away/back), two or more overlapping voices play the first element simultaneously. After the overlapping stops, playback appears to jump to the middle of the chapter.

**Root Cause:** On the second session all audio is already cached. Cache hits are effectively instant (~10ms), so all 5 priority preload elements emit `'ready'` events within ~100ms — all while `state === 'loading'`. The auto-start condition in `setupPreloaderListeners` checked `state === 'loading'` but had no guard against firing more than once. `playCurrentElement()` was called 5+ times in rapid succession, creating 5 `Audio.Sound` instances all playing element 0.

The apparent mid-chapter "skip" was a perceptual artifact: 5 overlapping audio tracks finishing at different times collapsed the perceived timeline, making sequential playback sound like a jump.

**Solution:** Added `private hasAutoStarted: boolean = false` to `TTSPlaybackManager`. The auto-start condition now also checks `!this.hasAutoStarted` and immediately sets it to `true` before calling `playCurrentElement()`. `stop()` resets it to `false` so the next session starts clean.

```typescript
if (this.state === 'loading' && !this.hasAutoStarted && (event.index === this.currentIndex || currentIndexReady)) {
  this.hasAutoStarted = true;
  this.playCurrentElement();
}
```

**Key Rule:** Any condition that should fire exactly once must be guarded by a boolean flag, not just a state check. State transitions are not atomic when multiple events arrive within one JS task queue turn.

---

### 11. `FileAlreadyExistsException` When Caching Audio on Second Session

**Symptom:** Error toast appears on the first play after hot reload or on second session. Logs show `TTSCacheManager set() failed: FileAlreadyExistsException`.

**Root Cause (two parts):**

1. **Initialization race:** `TTSCacheManager` constructor called `initialize()` as a fire-and-forget async call. If playback started before `loadMetadata()` completed, the in-memory map was empty. `get()` missed, TTS regenerated audio, and `set()` tried to copy the new file onto one that already existed from the previous session. `File.copy()` in the new expo-file-system API throws if the destination exists (no overwrite option).

2. **URI scheme mismatch:** Kotlin's `file.toURI().toString()` returns `file:/path` (one slash). expo-file-system uses `file:///path` (three slashes). The `uri.startsWith(this.cacheDir)` check in `set()` always returned `false` for Kotlin-sourced URIs, so the copy path was always taken even for files legitimately in the cache directory under a different URI form.

**Solution:**

- Constructor now assigns `this.ready = this.initialize()` (captured, not discarded). Every public method (`get`, `set`, `has`, `delete`, `clear`) begins with `await this.ready`, blocking until metadata is loaded. Subsequent calls resolve immediately since the promise is already settled.
- Before calling `sourceFile.copy(cachedFile)`, `set()` checks `cachedFile.exists`. If the destination already exists, the copy is skipped and the existing file is reused silently. This makes `set()` idempotent regardless of the URI scheme mismatch.

---

### 12. Position Not Saved When Navigating Away While Paused

**Symptom:** TTS plays a few elements, user navigates away (while TTS is paused or mid-element), returns to the chapter, presses play — playback restarts from the last persisted position (often position 1 from a previous session) rather than where it was.

**Root Cause:** `stopTTS()` gated the MMKV position save on `isTTSReadingRef.current`. `handleStateChange` sets `isTTSReadingRef.current = isPlaying || isLoading` — which evaluates to `false` when paused. Navigating away while paused therefore skipped the save silently.

**Solution:** Changed the save condition from `isTTSReadingRef.current && queue.length > 0` to `queue.length > 0 && currentIndex > 0`.

- `ttsQueueRef` is cleared only by the WebView's `stop-speak` event (explicit user stop) and chapter completion — not by pause. So a non-empty queue correctly signals "TTS was active in this session".
- `currentIndex > 0` avoids writing a useless position-0 save (the default start is always 0, so there is nothing to restore).
- `isTTSReadingRef` removed from the condition entirely — it is too volatile (paused = false) to use as a gate for persistence.

---

### 1. Stop() Cascade

**Symptom:** `stop()` called 50+ times in rapid succession, creating hundreds of timers. App becomes unresponsive. "reactInstance is null. Dropping work" errors in logcat.

**Root Cause:** Bidirectional event feedback loop:
1. `stop()` emits `queueEnd`
2. `handleQueueEnd` injects `tts.stop()` into WebView
3. WebView posts `stop-speak` back to React Native
4. React Native calls `stopTTS()` → `ttsPlaybackManager.stop()`
5. Back to step 1 — infinite loop

**Solution:**
- Added `isStopping: boolean` re-entrance guard to `stop()`
- Added `fromPlay: boolean` parameter: when `true`, skip emitting `queueEnd`
- `handleQueueEnd` for `reason: 'completed'` only injects `tts.next()`, never `tts.stop()`
- `pause-speak` and `stop-speak` events from WebView call `ttsPlaybackManager.stop(true)` (not `stopTTS()`)

**Key Rule:** Never emit `queueEnd` when stopping as part of `play()` cleanup.

---

### 2. Race Condition — Idle Timer Fires Before Audio Ready

**Symptom:** Button changes to pause icon but no audio ever plays. State becomes `idle` immediately.

**Root Cause:**
1. `play()` calls `stop(false)` for cleanup → `stop()` sets a 100ms timer to transition to `idle`
2. Audio generation takes ~900ms
3. Timer fires, state → `idle`
4. `setupPreloaderListeners()` checks `if (state === 'loading')` → condition false → audio silently discarded

**Solution:**
- `stop(fromPlay: boolean)` parameter
- When `fromPlay=true`: clear `isStopping` immediately, skip idle timer
- Audio generation can now complete and transition state correctly

---

### 3. WebView Queue Getting Reset Mid-Playback

**Symptom:** Plays one element then stops. WebView logs show `totalElements: 0` after first element.

**Root Cause:** Feedback loop between React Native and WebView during startup:
1. WebView's `tts.start()` calls `tts.stop()` internally for cleanup
2. `tts.stop()` posts `stop-speak` to React Native
3. React Native calls `stopTTS()` → emits `queueEnd { reason: 'stopped' }`
4. `handleQueueEnd` injects `tts.stop()` back into WebView
5. This second `tts.stop()` destroys the queue that `tts.start()` just built

**Solution:**
- When React Native receives `stop-speak` or `pause-speak`, the WebView has **already** stopped itself
- Call `ttsPlaybackManager.stop(true)` (not `stopTTS()`) to avoid re-emitting `queueEnd`
- WebView queue now survives the startup sequence

**Key Rule:** `stop-speak` and `pause-speak` events from WebView must use `fromPlay=true` to avoid feedback loops.

---

### 4. Rapid 'Speak' Events Causing Audio to Play < 1 Second

**Symptom:** Audio starts and immediately skips to next element.

**Root Cause:** WebView sends `speak` events approximately every 400ms. `play()` was being called multiple times for the same element before the first one finished.

**Solution:** State guard at the top of `play()`:
```typescript
async play(...) {
  if (this.state === 'loading' || this.state === 'playing') {
    return;
  }
  // ...
}
```

---

### 5. Every-Other-Element Skipping

**Symptom:** Only plays elements at indices 0, 2, 4, 6... (skips all odd ones).

**Root Cause:** `next()` was calling `stop()` internally. `stop()` sets `isStopping = true`. The next `speak` event arrives and `play()` calls `stop(true)`, which is blocked by `isStopping`. A second `speak` event arrives, `isStopping` has cleared, and that second element plays — skipping index N+1.

**Solution:** `next()` no longer calls `stop()`. It manually unloads the audio and emits `queueEnd` without going through the `stop()` path, so `isStopping` is never set.

---

### 6. Duplicate `tts.next()` Calls After Each Element

**Symptom:** Still skipping every other element even after fixing issue #5.

**Root Cause:** Two code paths were both calling `tts.next()` for each completed element:
- `handleQueueEnd` injected `tts.next()` when audio finished ✅ (correct)
- `handleElementChange` also injected `tts.next()` when new audio started ❌ (incorrect)

**Solution:** `handleElementChange` is for UI updates only. Removed `tts.next()` injection from it. Only `handleQueueEnd` advances the WebView queue.

---

### 7. Position Not Resuming After Chapter Exit

**Symptom:** Position key is present in MMKV but TTS starts from the beginning when returning to the chapter.

**Root Cause (multiple):**

1. Initially tried saving position from the WebView via injected JS on unmount. WebView is destroyed before the async JS injection completes.
2. Component unmount was calling `ttsPlaybackManager.stop()` directly instead of `stopTTS()`. This bypassed position save logic.

**Solution:**
- Track position in React Native refs (`ttsQueueIndexRef.current`) — refs persist through unmount
- Save to MMKV from `stopTTS()`, not from the WebView
- On WebView `onLoadEnd`, inject `window.tts.savedPosition = N` before WebView runs any TTS logic
- WebView's `tts.start()` checks `this.savedPosition` and resumes from there

**Key Rule:** Never rely on WebView context during component unmount. Always track critical state in React refs.

---

### 8. MMKV State Persistence — Resume Not Working

**Symptom:** App tracks reading progress but doesn't resume from saved position.

**Root Cause (three iterations):**

**Attempt 1:** Added MMKV save but no load logic → position saves but never used.

**Attempt 2:** Added load logic gated on `isServiceRunning()`. Service running means the check returned early with no playback at all.

**Attempt 3 (root cause):** Must distinguish three cases:
- Service running, NO saved state → don't interfere
- Service running, saved state for THIS chapter → resume
- Service not running → start fresh

**Final Solution — Dual-Condition Check:**
```typescript
const savedState = loadTTSState(chapter.id);
const isServiceRunning = NativeTTSForegroundService.isServiceRunning();

if (isServiceRunning && savedState) {
  // Both: service alive AND we have position for this chapter → safe to resume
  webViewRef.current?.injectJavaScript(`tts.start(${savedState.elementIndex})`);
} else {
  // Either failed: start fresh
  webViewRef.current?.injectJavaScript(`ttsButton.click()`);
}
```

**Why single-condition fails:**
```typescript
// ❌ Only service check — blocks all starts
if (isServiceRunning) { return; }

// ❌ Only state check — may conflict with running service for different chapter
if (savedState) { tts.start(savedState.elementIndex); }

// ✅ Both required
if (isServiceRunning && savedState) { /* resume */ }
```

**Per-chapter MMKV keys** (`tts_state_{chapterId}`) prevent state from one chapter contaminating another.

---

## State Management Patterns

### `isStopping` Flag Pattern

Prevents re-entrant calls to `stop()` which can cause cascading timers and multiple `queueEnd` emissions:

```typescript
async stop(fromPlay: boolean = false): Promise<void> {
  if (this.isStopping) return;
  this.isStopping = true;

  try {
    await this.currentSound?.unloadAsync();
    this.currentSound = null;
    this.preloader.clear();

    if (!fromPlay) {
      this.emit('queueEnd', { reason: 'stopped' });
      this.idleTimer = setTimeout(() => {
        this.setState('idle');
        this.isStopping = false;
      }, 100);
    } else {
      this.isStopping = false; // Clear immediately
    }
  } catch {
    this.isStopping = false;
  }
}
```

### State Guards

Prevent overlapping `play()` calls while loading or playing:

```typescript
async play(...) {
  if (this.state === 'loading' || this.state === 'playing') {
    return;
  }
  // proceed...
}
```

### Event-Driven State Sync

Components should not poll state. Subscribe to events instead:

```typescript
// Subscribe
ttsPlaybackManager.on('stateChange', (event: PlaybackEvent) => {
  setIsPlaying(event.state === 'playing');
});

// Unsubscribe on cleanup
return () => ttsPlaybackManager.off('stateChange', handler);
```

### React Native Ref Management for Unmount Safety

State that must be read during component unmount should live in refs, not React state:

```typescript
const ttsQueueIndexRef = useRef<number>(0);
const isTTSReadingRef = useRef<boolean>(false);

// In event handler
ttsQueueIndexRef.current = event.index;

// In cleanup (unmount) — refs still accessible
const stopTTS = async () => {
  if (isTTSReadingRef.current) {
    saveTTSState(chapter.id, ttsQueueIndexRef.current, false);
  }
  await ttsPlaybackManager.stop();
};
```

### WebView Communication Safety

When injecting JavaScript, always use optional chaining and existence checks:

```typescript
// Safe injection
webViewRef.current?.injectJavaScript(`
  if (typeof tts !== 'undefined' && tts.started) {
    tts.next?.();
  }
`);
```

---

## Build & Development Gotchas

### TypeScript Changes May Require Full Rebuild

Metro bundler sometimes does not pick up TS changes during hot reload:

```bash
cd android && ./gradlew assembleDebug
adb push app/build/outputs/apk/debug/app-debug.apk /data/local/tmp/
adb shell pm install -r /data/local/tmp/app-debug.apk
```

### WSL: `pnpm run dev:android` Hangs on Deployment

`react-native run-android` cannot deploy to a device from WSL. Use manual APK push via ADB (see above).

### Port Forwarding Required in WSL

```bash
adb reverse tcp:8081 tcp:8081
```

### Metro Must Be Running Before ADB Push

```bash
pnpm run dev:start
# If port 8081 occupied:
lsof -ti:8081 | xargs kill -9 && pnpm run dev:start
```

### React Native Bridge Overflow

**Symptom:** "reactInstance is null. Dropping work" in logcat. App becomes unresponsive.
**Cause:** Stop() cascade or other event loop flooding the bridge.
**Fix:** Full app restart (close and relaunch from device). Resolve the underlying feedback loop.

### Node.js `events` Module Not Available in React Native

```
Error: Cannot find module 'events'
```

`TTSPlaybackManager` uses a custom `EventEmitter` implementation (`src/services/tts/EventEmitter.ts`) instead of Node.js's built-in module, which is not available in the React Native JavaScript environment.

### MMKV vs FileSystem for Cache Storage

- **MMKV**: Use for small JSON state objects (settings, positions, metadata)
- **FileSystem (`expo-file-system`)**: Use for audio files and large binary data — MMKV is not suitable for binary file storage

The `TTSCacheManager` correctly uses FileSystem, not MMKV.
