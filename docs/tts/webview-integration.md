# TTS WebView Integration

**Files:** `android/app/src/main/assets/js/core.js`, `src/screens/reader/components/WebViewReader.tsx`
**Last Updated:** March 31, 2026

---

## Overview

The TTS system bridges two separate JavaScript contexts: WebView (`core.js`) and React Native (`WebViewReader.tsx`). The WebView is the source of truth for the chapter's readable element queue. React Native owns playback and persistence.

---

## WebView TTS Engine (`core.js`)

The `window.tts` object in the WebView manages the full chapter element queue and drives element advancement.

### Initialization

`tts` is initialized when the reader loads. It does NOT start playback automatically — it must be triggered by the user or by `tts.start()`.

### Key Properties

```javascript
window.tts = {
  started: boolean,              // Session is active
  reading: boolean,              // Currently speaking
  elementsRead: number,          // Current position (incremented after speak)
  totalElements: number,         // Total readable elements in this chapter
  currentElement: HTMLElement,   // Element currently being read
  prevElement: HTMLElement,      // Previously read element (for highlight removal)
  allReadableElements: Array,    // Flat array of all readable elements (built at start)
  textQueue: Array,              // Normalized text strings (parallel to allReadableElements)
  savedPosition: number | null,  // Set from React Native on load for resume
  readableNodeNames: Array,      // Whitelisted HTML tags
}
```

### Key Methods

```javascript
tts.start(startFromIndex?)
// Builds allReadableElements[], sets elementsRead = startFromIndex || 0, calls next()
// startFromIndex is injected by React Native for position resume

tts.next()
// Advances elementsRead, finds next non-empty element, calls speak()
// Called after each audio completes (via React Native injection)

tts.speak()
// Posts 'speak' message to React Native:
// reader.post({ type: 'speak', data: normalizedText, index: elementsRead, total: totalElements })

tts.pause()
// Posts 'pause-speak' to React Native

tts.stop()
// Resets queue, posts 'stop-speak' to React Native
// WARNING: Destroys allReadableElements[] — do not call between elements

tts.resume()
// Resumes reading if paused (re-calls speak for current element)

tts.seekTo(index)
// Sets elementsRead = index, calls speak() from that position

tts.rewind()
// Replays current element (decrements elementsRead by 1, calls speak())

tts.readable(element)
// Returns true if element should be read (see Readable Element Detection below)

tts.normalizeText(text)
// Collapses whitespace, fixes punctuation spacing

tts.getAllReadableElements(element)
// Non-recursive array-based DOM traversal to build allReadableElements[]

tts.scrollToElement(element)
// Auto-scrolls to reading position (top or center based on settings)
```

### Readable Element Detection

Only elements matching **all** of the following are included in the queue:

1. Node name is in `readableNodeNames` (whitelisted tags)
2. Element has child nodes
3. All child nodes also have readable node names

**Whitelisted tags:** `#text`, `B`, `I`, `SPAN`, `EM`, `BR`, `STRONG`, `A`, `P`

This prevents reading structural elements (divs, tables, headers, etc.).

### Text Normalization

```javascript
normalizeText: text =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\s*([.,!?;:])\s*/g, '$1 ')
    .trim()
```

### DOM Traversal (Array-Based, Not Recursive)

Stack-overflow safe approach using a flat array:

```javascript
getAllReadableElements(root) {
  const stack = [root];
  const result = [];
  while (stack.length) {
    const el = stack.pop();
    if (this.readable(el)) {
      result.push(el);
    } else {
      // Push children in reverse order (so left→right traversal)
      for (let i = el.children.length - 1; i >= 0; i--) {
        stack.push(el.children[i]);
      }
    }
  }
  return result;
}
```

### Auto Chapter Advance

When `elementsRead >= totalElements`:

```javascript
const autoPageAdvance = reader.readerSettings.val.tts?.autoPageAdvance === true;
const hasNextChapter = !!reader.nextChapter;

if (autoPageAdvance && hasNextChapter) {
  reader.post({ type: 'next', autoStartTTS: true });
} else {
  this.stop();
}
```

### TTS Controller UI

The draggable TTS button (`TTSController()` in `android/app/src/main/assets/js/index.js`) controls the `window.tts` object:

- **Tap**: Toggle play/pause
- **Long-press + drag**: Move button; highlights readable elements at touch position; releases to `tts.start(element)` from that element
- **Button icons**: Volume icon (stopped), Pause icon (playing), Play icon (paused)

CSS file: `android/app/src/main/assets/css/tts.css`

---

## React Native Bridge (`WebViewReader.tsx`)

`WebViewReader` handles `onMessage` from the WebView and injects JavaScript back.

### Event Protocol: WebView → React Native

All events are posted via `reader.post(payload)` in the WebView, received via `onMessage` in React Native.

| `type` | Direction | Payload | Meaning |
|---|---|---|---|
| `speak` | WV → RN | `{ data: string, index: number, total: number }` | Speak this element |
| `pause-speak` | WV → RN | — | Pause playback |
| `stop-speak` | WV → RN | — | Stop playback (WebView stopped itself) |
| `tts-state` | WV → RN | `{ isReading: boolean }` | Reading state change |
| `next` | WV → RN | `{ autoStartTTS: boolean }` | Navigate to next chapter |
| `prev` | WV → RN | `{ autoStartTTS: boolean }` | Navigate to previous chapter |

### Event Handling in WebViewReader

**`speak` event:**
```typescript
case 'speak':
  // Save position to MMKV before playing
  saveTTSState(chapter.id, event.index, true);
  // Start foreground service if first element
  if (!isTTSReadingRef.current) {
    NativeTTSForegroundService.startService(novelName, chapterName, cover, true);
    isTTSReadingRef.current = true;
  }
  // Update notification progress
  NativeTTSForegroundService.updatePlaybackState(true);
  await ttsPlaybackManager.play([event.data], event.index, event.total, chapter.id);
  break;
```

**`pause-speak` event:**
```typescript
case 'pause-speak':
  // WebView has already paused itself; stop RN playback WITHOUT emitting queueEnd
  ttsPlaybackManager.stop(true);  // fromPlay=true prevents feedback loop
  break;
```

**`stop-speak` event:**
```typescript
case 'stop-speak':
  // WebView has already stopped itself; same as pause-speak
  ttsPlaybackManager.stop(true);
  if (!autoStartTTSRef.current) {
    NativeTTSForegroundService.stopService();
    isTTSReadingRef.current = false;
  }
  break;
```

### Key React Refs (Survive Renders, Available on Unmount)

```typescript
const ttsQueueRef = useRef<string[]>([]);          // Active text queue
const ttsQueueIndexRef = useRef<number>(0);         // Current element index (allReadableElements)
const ttsElementIndexMapRef = useRef<number[]>([]); // textQueue idx → allReadableElements idx
const ttsFullQueueInitializedRef = useRef<boolean>(false); // Full offline queue loaded
const isTTSReadingRef = useRef<boolean>(false);     // TTS session active?
const autoStartTTSRef = useRef<boolean>(false);     // Auto-start after foreground chapter nav
const readerSettingsRef = useRef<ChapterReaderSettings>();
// Always tracks current chapter.id even when component doesn't remount
// (e.g., background auto-advance via setChapter()). The [] unmount cleanup
// closes over the initial chapter.id — this ref ensures the correct MMKV key
// is written even after context-driven chapter changes.
const chapterIdRef = useRef(chapter.id);           // Updated on every render
// Set when background auto-advance lands on a non-downloaded chapter.
// Consumed by the AppState 'active' handler to trigger online TTS after unlock.
const pendingForegroundAutoStartRef = useRef(false);
```

> Refs are used instead of state for values needed during component unmount (when WebView is already destroyed).

### Event Injection: React Native → WebView

React Native sends commands back to the WebView via `webViewRef.current?.injectJavaScript(...)`:

| When | Injected JS |
|---|---|
| Audio element completes (`queueEnd: 'completed'`) | `tts.next?.()` |
| TTSPlay notification event | `if (tts && !tts.reading) { tts.resume(); }` |
| TTSPause notification event | `if (tts && tts.reading) { tts.pause(); }` |
| TTSNext notification event | `if (tts && tts.started) { tts.next(); }` |
| TTSPrev notification event | `if (tts && tts.started) { tts.rewind(); }` |
| TTSSeekTo notification event | `if (tts && tts.started) { tts.seekTo(${index}); }` |
| Position resume on chapter open | `tts.start(${savedState.elementIndex})` |
| Chapter complete (clear position) | `clear-tts-position` event → delete MMKV key |

### `handleQueueEnd` (Critical Integration Point)

```typescript
const handleQueueEnd = (event: PlaybackEvent) => {
  if (event.reason === 'completed') {
    // Audio finished naturally → advance WebView queue
    saveTTSState(chapter.id, ttsQueueIndexRef.current, true);
    webViewRef.current?.injectJavaScript('tts.next?.()');
  } else if (event.reason === 'stopped') {
    // Explicitly stopped (e.g., user tapped stop)
    deleteTTSState(chapter.id);
    NativeTTSForegroundService.stopService();
    isTTSReadingRef.current = false;
  }
};
```

> Do NOT inject `tts.stop()` from `handleQueueEnd` — this resets the WebView queue and causes the double-stop feedback loop. See [known-bugs-and-patterns.md](./known-bugs-and-patterns.md#1-stop-cascade).

---

## Background Auto-Advance

When `autoPageAdvance` is enabled, `handleQueueEnd` (with `reason: 'completed'`) navigates to the next chapter while the app is in the background (phone locked / screen off). WebView does not execute JS in the background, so the standard `tts.next()` injection path cannot be used.

### Downloaded Chapter → Downloaded Chapter

1. `handleQueueEnd` sets `TTS_AUTOSTART_KEY` in MMKV and calls `navigateChapter('NEXT')`.
2. The `chapter.id` `useEffect` fires on the new chapter. `hasCompletedDownload()` returns true.
3. Sets a sentinel queue (`ttsQueueRef.current = ['']`, length 1) so background queue-end logic can detect session boundaries.
4. Calls `ttsPlaybackManager.play([''], 0, chapter.id, ...)` which loads and plays the offline MP3.
5. `elementChange` events update `ttsQueueIndexRef` as the audio progresses.
6. On foreground restore (unlock): `AppState 'active'` handler syncs the WebView highlight and button icon via `injectJavaScript`.

### Downloaded Chapter → Non-Downloaded Chapter

1. `handleQueueEnd` sets `TTS_AUTOSTART_KEY` and calls `navigateChapter('NEXT')`.
2. The `chapter.id` `useEffect` fires. `hasCompletedDownload()` returns false.
3. Clears `TTS_AUTOSTART_KEY` and `backgroundHandoffInFlight`.
4. Resets all queue refs to empty/false/0 (stale state from the finished chapter).
5. Clears the new chapter's MMKV position (prevents stale position from a previous session poisoning `onLoadEnd`'s `savedPosition` injection).
6. Sets `pendingForegroundAutoStartRef.current = true`.
7. `onLoadEnd` runs in background — DOM is fully built, but `tts.start()` is NOT called (audio can't play without the foreground).
8. On foreground restore (unlock): `AppState 'active'` handler sees `pendingForegroundAutoStartRef`, clears it, and after 200ms injects:
   ```javascript
   tts.savedPosition = null;  // Belt-and-suspenders: clear any onLoadEnd injection
   tts.start();               // Begins online TTS from element 0
   ```

### `backgroundHandoffInFlight` Guard

`backgroundHandoffInFlight` is a module-level boolean (not a ref) that prevents the *previous* chapter's `stopTTS()` cleanup from calling `ttsPlaybackManager.stop()` while the *new* chapter's `play()` is still resolving `createAsync()`. This avoids a native crash from destroying the sound object mid-creation.

```
[Old chapter cleanup] stopTTS() ──► backgroundHandoffInFlight? yes → skip stop()
                                                     ↕
[New chapter play()]  play() ──► createAsync() resolves → backgroundHandoffInFlight = false
```

### Component Cleanup on Unmount

```typescript
useEffect(() => {
  return () => {
    // MUST call stopTTS() not ttsPlaybackManager.stop() directly
    // stopTTS() saves position before WebView is destroyed
    stopTTS();
  };
}, []);

const stopTTS = async () => {
  const currentIndex = ttsQueueIndexRef.current;
  const totalElements = ttsQueueRef.current.length;
  // Gate on queue presence, NOT isTTSReadingRef (false when paused).
  // Use chapterIdRef.current (not chapter.id) — the [] closure captures the
  // initial chapter.id; chapterIdRef always reflects the latest value.
  if (totalElements > 0 && currentIndex > 0) {
    const positionKey = `tts_position_${chapterIdRef.current}`;
    setMMKVObject(positionKey, { position: currentIndex, total: totalElements });
  }
  await ttsPlaybackManager.stop();
  NativeTTSForegroundService.stopService();
};
```

---

## Position Save/Restore Across Navigation

**Problem:** WebView is destroyed when navigating away from a chapter. Any state stored in WebView JS is lost.

**Solution:** React Native is the persistence layer. MMKV key: `tts_position_{chapterId}`. Data shape: `{ position: number, total: number }`.

### Save Flow

Positions are saved from two sources:

1. **While reading:** The WebView posts a `save-tts-position` event (e.g., from `tts.speak()`) — React Native writes `{ position: event.position, total: event.total }` to MMKV.
2. **On navigate-away (unmount):** `stopTTS()` reads `ttsQueueIndexRef.current` and `ttsQueueRef.current.length` and writes to MMKV, gated on `totalElements > 0 && currentIndex > 0`.
   - Uses `chapterIdRef.current` (not the closure-captured `chapter.id`) to handle background auto-advance without remount. See [bug #15](./known-bugs-and-patterns.md#15-wrong-chapter-position-saved-after-background-auto-advance-stale-closure).

### Restore Flow

1. Chapter opens → WebView's `onLoadEnd` fires → read `tts_position_{chapterId}` from MMKV.
2. If position exists: inject `window.tts.savedPosition = ${savedPosition.position}` into WebView.
3. When user starts TTS, `tts.start()` checks `this.savedPosition`:
   ```javascript
   this.start = function(startFromIndex) {
     const from = typeof startFromIndex === 'number'
       ? startFromIndex
       : (this.savedPosition || 0);
     this.elementsRead = from;
     this.savedPosition = null; // Clear after use
     this.next();
   };
   ```

**Important:** For background auto-advance to a non-downloaded chapter, `onLoadEnd` runs while the phone is locked and injects any stale `savedPosition`. The foreground restore path explicitly sets `tts.savedPosition = null` before calling `tts.start()` to prevent resuming from a stale session. See [bug #17](./known-bugs-and-patterns.md#17-wrong-start-position-on-foreground-restore-of-non-downloaded-chapter).

### Clear Flow

When a chapter completes naturally, `handleQueueEnd` receives `reason: 'completed'`, clears the MMKV key (`setMMKVObject(key, null)`), and navigates to the next chapter if auto-advance is enabled.
