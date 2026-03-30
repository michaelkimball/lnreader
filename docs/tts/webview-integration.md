# TTS WebView Integration

**Files:** `android/app/src/main/assets/js/core.js`, `src/screens/reader/components/WebViewReader.tsx`
**Last Updated:** March 30, 2026

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
const ttsQueueIndexRef = useRef<number>(0);    // Current element index
const isTTSReadingRef = useRef<boolean>(false); // Is TTS active?
const autoStartTTSRef = useRef<boolean>(false); // Auto-start after chapter nav
const readerSettingsRef = useRef<ChapterReaderSettings>();
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
  if (isTTSReadingRef.current) {
    saveTTSState(chapter.id, ttsQueueIndexRef.current, false);
  }
  await ttsPlaybackManager.stop();
  NativeTTSForegroundService.stopService();
};
```

---

## Position Save/Restore Across Navigation

**Problem:** WebView is destroyed when navigating away from a chapter. Any state stored in WebView JS is lost.

**Solution:** React Native is the persistence layer.

### Save Flow

1. Every `speak` event → `saveTTSState(chapterId, elementIndex, true)` → MMKV key `tts_state_{chapterId}`
2. On unmount → `saveTTSState(chapterId, ttsQueueIndexRef.current, false)`

### Restore Flow

1. Chapter opens → read `loadTTSState(chapterId)` from MMKV
2. After WebView loads → inject `window.tts.savedPosition = ${savedState.elementIndex}`
3. `tts.start()` in WebView checks `this.savedPosition`:
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

### Clear Flow

When a chapter completes naturally, WebViewReader handles `queueEnd` with `reason: 'completed'` at the final element and deletes the MMKV key: `deleteTTSState(chapterId)`.
