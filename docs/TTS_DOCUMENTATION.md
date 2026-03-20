# LNReader Text-to-Speech (TTS) System Documentation

**Last Updated:** March 20, 2026  
**Version:** React Native 0.81.6 with Expo 54  
**TTS Engines:** Expo Speech (device TTS) + Microsoft Azure Speech (cloud TTS)  
**Status:** **MIGRATION IN PROGRESS** - See [Migration Plan](./tts-migration/00-MIGRATION-OVERVIEW.md)

---

> **⚠️ IMPORTANT:** This document describes the **current TTS implementation**. A major refactoring to a foreground service architecture with progressive preloading and offline downloads is planned. See the [TTS Migration Documentation](./tts-migration/00-MIGRATION-OVERVIEW.md) for details on the new architecture.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Components & Layers](#components--layers)
4. [TTS Engines](#tts-engines)
5. [Core Features](#core-features)
6. [User Interface](#user-interface)
7. [Settings & Configuration](#settings--configuration)
8. [Technical Implementation Details](#technical-implementation-details)
9. [Media Controls Integration](#media-controls-integration)
10. [Event Flow & Communication](#event-flow--communication)
11. [Limitations & Known Issues](#limitations--known-issues)
12. [Future Enhancement Opportunities](#future-enhancement-opportunities)
13. **[Migration to New Architecture](./tts-migration/00-MIGRATION-OVERVIEW.md)** ✨

---

## Overview

LNReader implements a comprehensive Text-to-Speech system that allows users to listen to light novel chapters while reading. The system provides:

- **Dual-engine support**: Device TTS (Expo Speech) or Cloud TTS (Microsoft Azure Speech)
- **Continuous narration** with automatic chapter progression
- **Android media notification controls** for background playback
- **Customizable voice settings** (voice selection, pitch, rate)
- **Visual highlighting** of currently reading text
- **Draggable controller** for selecting reading start position
- **Integration with Android MediaSession** for lock screen controls
- **Azure neural voices** with higher quality and more languages
- **Automatic fallback** from cloud to device TTS on errors

The TTS system supports two engines:
1. **Expo Speech API** (default): React Native wrapper for Android's TextToSpeech engine
2. **Microsoft Azure Speech** (optional): Cloud-based neural TTS via REST API

Both engines integrate with custom WebView-based text parsing and a native Kotlin media notification system.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Interface Layer                      │
│  ┌──────────────────┐  ┌────────────────┐  ┌─────────────────┐ │
│  │  TTS Controller  │  │  Settings UI   │  │  Media Notif.   │ │
│  │   (WebView UI)   │  │ (TTSTab +      │  │  (Android)      │ │
│  │                  │  │  Integrations) │  │                 │ │
│  └──────────────────┘  └────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                     React Native Bridge Layer                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              WebViewReader (WebViewReader.tsx)              ││
│  │  • Event handling (speak, pause, stop)                     ││
│  │  • DUAL ENGINE ROUTING: Expo Speech OR Microsoft Speech    ││
│  │  • Notification management                                 ││
│  │  • Automatic fallback on errors                            ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │        MicrosoftSpeechService (MicrosoftSpeechService.ts)   ││
│  │  • Azure Speech REST API integration                       ││
│  │  • Token management                                        ││
│  │  • Audio download & playback (expo-av)                    ││
│  │  • Voice enumeration                                       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                      WebView JavaScript Layer                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                  TTS Engine (core.js)                       ││
│  │  • DOM traversal & text extraction                         ││
│  │  • Reading position tracking                               ││
│  │  • Element highlighting                                    ││
│  │  • Auto-scroll implementation                              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                   Native Android Layer (Kotlin)                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │        NativeTTSMediaControl (Turbo Module)                ││
│  │  • MediaSessionCompat integration                          ││
│  │  • Notification builder                                    ││
│  │  • Broadcast receiver for media actions                    ││
│  │  • Progress tracking (seek support)                        ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                      Android System APIs                         │
│     [TextToSpeech API]  [MediaSession]  [NotificationManager]   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components & Layers

### 1. WebView JavaScript Layer

**File:** `android/app/src/main/assets/js/core.js`

The core TTS engine runs inside the WebView and handles:

#### Key Responsibilities:
- **Text Extraction**: Identifies readable text elements in the chapter HTML
- **DOM Traversal**: Non-recursive array-based approach to prevent stack overflow
- **Element Highlighting**: Adds `.highlight` CSS class to currently reading element
- **Auto-Scrolling**: Scrolls to current element (top or center based on settings)
- **Queue Management**: Builds flat text queue for background playback fallback

#### Core Class: `window.tts`

**Properties:**
```javascript
{
  started: boolean,          // TTS session is active
  reading: boolean,          // Currently speaking
  elementsRead: number,      // Progress counter
  totalElements: number,     // Total readable elements
  currentElement: HTMLElement,   // Currently reading element
  prevElement: HTMLElement,      // Previously read element
  allReadableElements: Array,    // Cache of all readable elements
  textQueue: Array,              // Normalized text strings
  readableNodeNames: Array       // Whitelisted HTML tags
}
```

**Methods:**
```javascript
tts.start(element?)      // Start TTS from element (or chapter start)
tts.pause()              // Pause speaking
tts.resume()             // Resume speaking
tts.stop()               // Stop and reset TTS session
tts.next()               // Advance to next readable element
tts.rewind()             // Replay current element
tts.seekTo(index)        // Jump to specific element index
tts.speak()              // Post speak message to React Native
tts.readable(element)    // Check if element is readable
tts.normalizeText(text)  // Normalize whitespace & punctuation
tts.getAllReadableElements(element)  // Extract all readable elements
tts.scrollToElement(element)         // Auto-scroll to element
```

**Readable Element Detection:**
- Only elements with child nodes containing **text-level tags** are readable
- Whitelisted tags: `#text`, `B`, `I`, `SPAN`, `EM`, `BR`, `STRONG`, `A`
- Prevents reading structural elements (divs, headers, etc.)

**Text Normalization:**
```javascript
normalizeText: text => {
  return text
    .replace(/\s+/g, ' ')              // Collapse whitespace
    .replace(/\s*([.,!?;:])\s*/g, '$1 ')  // Fix punctuation spacing
    .trim();
}
```

#### Event Communication:
Posts messages to React Native via `reader.post()`:
- `speak`: Request speech synthesis with text + progress
- `pause-speak`: Request pause
- `stop-speak`: Request stop and cleanup
- `tts-state`: Update reading state (isReading: boolean)
- `tts-queue`: Send full text queue for background fallback
- `next`/`prev`: Chapter navigation with `autoStartTTS` flag

---

### 2. React Native Bridge Layer

**File:** `src/screens/reader/components/WebViewReader.tsx`

#### Key Responsibilities:
- **Expo Speech Integration**: Calls `Speech.speak()` with text from WebView
- **Event Dispatching**: Handles WebView post messages
- **Notification Management**: Shows/updates/dismisses TTS notification
- **Background Playback**: Manages TTS queue when app is backgrounded
- **Settings Sync**: Listens to MMKV settings changes and updates WebView

#### Key State Management:
```typescript
const autoStartTTSRef = useRef<boolean>(false);    // Auto-start after chapter nav
const isTTSReadingRef = useRef<boolean>(false);    // Currently reading state
const ttsQueueRef = useRef<string[]>([]);          // Full text queue
const ttsQueueIndexRef = useRef<number>(0);        // Current queue position
const readerSettingsRef = useRef<ChapterReaderSettings>();  // Voice/pitch/rate
```

#### Event Handlers:

**1. Media Control Events** (from notification):
```typescript
ttsMediaEmitter.addListener('TTSPlay', () => {
  webViewRef.current?.injectJavaScript(`
    if (window.tts && !tts.reading) { tts.resume(); }
  `);
});

ttsMediaEmitter.addListener('TTSPause', () => {
  webViewRef.current?.injectJavaScript(`
    if (window.tts && tts.reading) { tts.pause(); }
  `);
});

ttsMediaEmitter.addListener('TTSSeekTo', (event) => {
  webViewRef.current?.injectJavaScript(`
    if (window.tts && tts.started) { tts.seekTo(${event.position}); }
  `);
});
```

**2. WebView Post Events**:
```typescript
case 'speak':
  // Start TTS notification if first speak
  if (!isTTSReadingRef.current) {
    showTTSNotification({
      novelName: novel?.name || 'Unknown',
      chapterName: chapter.name,
      coverUri: novel?.cover || '',
      isPlaying: true,
    });
  }
  // Update progress
  updateTTSProgress(event.index, event.total);
  // Speak text via Expo Speech
  speakText(event.data);
  break;

case 'pause-speak':
  Speech.stop();
  break;

case 'stop-speak':
  Speech.stop();
  if (!autoStartTTSRef.current) {
    dismissTTSNotification();
    ttsQueueRef.current = [];
  }
  break;

case 'tts-queue':
  // Store full text queue for background playback
  ttsQueueRef.current = event.data.queue;
  ttsQueueIndexRef.current = event.data.startIndex;
  break;
```

#### Speech Synthesis:
```typescript
const speakText = (text: string) => {
  Speech.speak(text, {
    onDone() {
      const isBackground = appStateRef.current === 'background';
      
      if (isBackground && ttsQueueRef.current.length > 0) {
        // Background playback: use stored queue
        const nextIndex = ttsQueueIndexRef.current + 1;
        if (nextIndex < ttsQueueRef.current.length) {
          ttsQueueIndexRef.current = nextIndex;
          speakText(ttsQueueRef.current[nextIndex]);
          return;
        }
      }
      
      // Foreground: trigger WebView to find next element
      webViewRef.current?.injectJavaScript('tts.next?.()');
    },
    voice: readerSettingsRef.current.tts?.voice?.identifier,
    pitch: readerSettingsRef.current.tts?.pitch || 1,
    rate: readerSettingsRef.current.tts?.rate || 1,
  });
};
```

**Settings Update Handling:**
```typescript
useEffect(() => {
  const mmkvListener = MMKVStorage.addOnValueChangedListener(key => {
    if (key === CHAPTER_READER_SETTINGS) {
      const newSettings = getMMKVObject<ChapterReaderSettings>(key);
      setReaderSettings(newSettings);
      
      // Stop current speech to apply new settings
      Speech.stop();
      
      // Restart TTS with new settings if currently reading
      webViewRef.current?.injectJavaScript(`
        if (window.tts && tts.reading) {
          const currentElement = tts.currentElement;
          tts.stop();
          setTimeout(() => tts.start(currentElement), 100);
        }
      `);
    }
  });
  return () => mmkvListener.remove();
}, []);
```

---

### 3. Native Android Layer

**Files:**
- `android/app/src/main/java/com/rajarsheechatterjee/NativeTTSMediaControl/NativeTTSMediaControl.kt`
- `specs/NativeTTSMediaControl.ts`

#### Turbo Module Spec:
```typescript
export interface Spec extends TurboModule {
  showMediaNotification(
    title: string,        // Novel name
    subtitle: string,     // Chapter name
    coverUri: string,     // Cover image URI
    isPlaying: boolean
  ): void;
  updatePlaybackState(isPlaying: boolean): void;
  updateProgress(current: number, total: number): void;
  dismiss(): void;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
}
```

#### Key Components:

**1. MediaSessionCompat Integration:**
```kotlin
mediaSession = MediaSessionCompat(appContext, "LNReaderTTS").apply {
  setCallback(object : MediaSessionCompat.Callback() {
    override fun onPlay() { sendEvent("TTSPlay") }
    override fun onPause() { sendEvent("TTSPause") }
    override fun onStop() { sendEvent("TTSStop") }
    override fun onSkipToPrevious() { sendEvent("TTSPrev") }
    override fun onSkipToNext() { sendEvent("TTSNext") }
    override fun onSeekTo(pos: Long) {
      // pos is in ms (elementIndex * 1000)
      val elementIndex = pos / 1000L
      sendSeekEvent(elementIndex)
    }
  })
  isActive = true
}
```

**2. Notification Builder:**
- **Channel ID:** `"tts-media-controls"`
- **Notification ID:** `1001`
- **Importance:** `IMPORTANCE_LOW` (no sound/vibration)
- **Compact View Actions:** Rewind, Play/Pause, Next (indices 1, 2, 3)
- **All Actions:** Previous, Rewind, Play/Pause, Next
- **MediaStyle:** Integrates with MediaSession, shows on lock screen

**3. Broadcast Actions:**
```kotlin
ACTION_PLAY   = "com.lnreader.TTS_PLAY"
ACTION_PAUSE  = "com.lnreader.TTS_PAUSE"
ACTION_STOP   = "com.lnreader.TTS_STOP"
ACTION_PREV   = "com.lnreader.TTS_PREV"
ACTION_NEXT   = "com.lnreader.TTS_NEXT"
ACTION_REWIND = "com.lnreader.TTS_REWIND"
```

**4. Progress Tracking:**
```kotlin
override fun updateProgress(current: Double, total: Double) {
  currentPosition = current.toLong()   // Element index
  totalDuration = total.toLong()       // Total elements
  updateNotification()
}

// In updateNotification():
stateBuilder.setState(
  if (isPlaying) PlaybackStateCompat.STATE_PLAYING 
  else PlaybackStateCompat.STATE_PAUSED,
  currentPosition * 1000L,  // Scale to ms for MediaSession
  0f                        // Playback speed (0 = paused)
)

metadataBuilder.putLong(
  MediaMetadataCompat.METADATA_KEY_DURATION,
  totalDuration * 1000L     // Scale to ms
)
```

**5. Cover Image Loading:**
- Supports `file://` URIs and HTTP URLs
- Asynchronous network image loading (background thread)
- Caches bitmap in `coverBitmap` variable
- Updates notification when image loads

**6. Lifecycle Management:**
```kotlin
override fun dismiss() {
  mediaSession?.isActive = false
  mediaSession?.release()
  mediaSession = null
  
  notificationManager.cancel(NOTIFICATION_ID)
  
  try {
    appContext.unregisterReceiver(mediaReceiver)
  } catch (_: Exception) {}
  
  coverBitmap = null
  currentCoverUri = null
  currentPosition = 0L
  totalDuration = 0L
}
```

---

### 4. User Interface Layer

#### WebView TTS Controller

**File:** `android/app/src/main/assets/js/index.js` → `TTSController()`

**Features:**
- **Draggable Button**: Long-press to drag, drops on text element to start reading
- **Visual Feedback**: Highlights elements during drag
- **Button States**:
  - Volume icon (stopped)
  - Pause icon (playing)
  - Resume icon (paused)
- **Smart Positioning**: Restricts to readable viewport area
- **Auto-hide**: Fades when TTS is disabled

**CSS Styling** (`android/app/src/main/assets/css/tts.css`):
```css
#TTS-Controller {
  position: fixed;
  top: 50%;
  left: 20px;
  opacity: 0.5;
  pointer-events: auto;  /* Disabled when TTSEnable is false */
}

#TTS-Controller.active {
  opacity: 1;            /* Full opacity during drag */
}

.highlight {
  background-color: /* Dynamic based on theme */;
  transition: background-color 0.3s;
}
```

**Interaction Flow:**
1. **Touch Start**: Activate (opacity 1)
2. **Touch Move**: 
   - Update button position
   - Check elements at touch point
   - Highlight first readable element
3. **Touch End**:
   - Deactivate (opacity 0.5)
   - Start TTS from highlighted element
   - Update button icon to pause

#### Settings UI

**File:** `src/screens/reader/components/ReaderBottomSheet/TTSTab.tsx`

**Settings Exposed:**

1. **Enable TTS** (boolean toggle)
   - Controls visibility of TTS controller
   - Watched by `van.derive()` to auto-stop when disabled

2. **Voice Picker** (modal with language filters)
   - Shows all available system voices via `getAvailableVoicesAsync()`
   - Filters by language (system language shown by default)
   - Displays voice name and language code
   - Includes "System" default voice

3. **Speed Slider** (0.1x - 5.0x, step 0.1)
   - Default: 1.0x
   - Applies to `Speech.speak()` rate parameter
   - Live updates on slide complete

4. **Pitch Slider** (0.1 - 5.0, step 0.1)
   - Default: 1.0
   - Applies to `Speech.speak()` pitch parameter
   - Live updates on slide complete

5. **Auto Page Advance** (boolean toggle)
   - Default: `false`
   - When enabled: automatically navigates to next chapter when current finishes
   - Triggers `reader.post({ type: 'next', autoStartTTS: true })`

6. **Scroll to Top** (boolean toggle)
   - Default: `true`
   - When true: scrolls current element to 80px from top (notch padding)
   - When false: scrolls element to center of viewport

---

## TTS Engines

LNReader supports two TTS engines with automatic engine selection and fallback:

### 1. Expo Speech (Device TTS) - Default

**Technology:** `expo-speech` package (wrapper for Android TextToSpeech API)

**Advantages:**
- ✅ Works offline (no internet required)
- ✅ No API costs
- ✅ Fast response time (local processing)
- ✅ No setup required
- ✅ Privacy-friendly (no data sent to cloud)

**Limitations:**
- ❌ Voice quality varies by device
- ❌ Limited voice selection (depends on installed voices)
- ❌ Language support depends on device TTS engine

**Voice Sources:**
- System default voices
- Google TTS voices (if installed)
- Third-party TTS engines (Samsung, etc.)

**API Usage:**
```typescript
import * as Speech from 'expo-speech';

// Speak text
Speech.speak(text, {
  voice: voiceIdentifier,
  pitch: 1.0,
  rate: 1.0,
  onDone: () => { /* next element */ }
});

// Get available voices
const voices = await Speech.getAvailableVoicesAsync();
```

### 2. Microsoft Azure Speech (Cloud TTS) - Optional

**Technology:** Azure Cognitive Services Speech REST API with expo-av for playback

**File:** `src/services/tts/MicrosoftSpeechService.ts`

**Advantages:**
- ✅ Premium neural voice quality
- ✅ 400+ voices in 140+ languages
- ✅ Consistent quality across devices
- ✅ Advanced prosody control
- ✅ Natural-sounding speech with emotions

**Limitations:**
- ❌ Requires internet connection
- ❌ Requires Azure subscription (with free tier)
- ❌ API costs (free tier: 500K characters/month)
- ❌ Latency from API calls
- ❌ Privacy consideration (text sent to cloud)

**Setup Requirements:**
1. Azure account with Speech Service resource
2. Subscription key and region
3. Configure in Settings → Integrations

**Architecture:**
```
speakText(text)
  ↓
Get access token from Azure
  ↓
Generate SSML with prosody settings
  ↓
POST to https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
  ↓
Download MP3 audio via fetch()
  ↓
Convert ArrayBuffer to base64
  ↓
Save to temporary file (expo-file-system)
  ↓
Play with expo-av (Audio.Sound)
  ↓
Delete temp file on completion
```

**Key Methods:**
```typescript
class MicrosoftSpeechService {
  initialize(config: { subscriptionKey, region, voice? }): boolean
  
  async speak(text: string, options: {
    voice?: string,
    pitch?: number,  // 0.5 - 2.0
    rate?: number,   // 0.5 - 2.0
    onStart?: () => void,
    onDone?: () => void,
    onError?: (error: string) => void
  }): Promise<void>
  
  async getVoices(locale?: string): Promise<MicrosoftVoice[]>
  
  async validateCredentials(key: string, region: string): Promise<boolean>
  
  async stop(): Promise<void>
  
  async dispose(): Promise<void>
}
```

**SSML Generation:**
```typescript
generateSSML(text: string, options: SpeakOptions): string {
  const voice = options.voice || 'en-US-JennyNeural';
  const pitch = `${(options.pitch - 1) * 50}%`;  // 0% = normal
  const rate = `${options.rate}`;  // 1.0 = normal
  
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
    <voice name="${voice}">
      <prosody pitch="${pitch}" rate="${rate}">
        ${escapeXml(text)}
      </prosody>
    </voice>
  </speak>`;
}
```

**Voice Enumeration:**
```typescript
// GET https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list
// Headers: Ocp-Apim-Subscription-Key: {subscriptionKey}

const voices = await microsoftSpeechService.getVoices('en');
// Returns: [
//   { name: "en-US-JennyNeural", displayName: "Jenny", locale: "en-US", ... },
//   { name: "en-US-GuyNeural", displayName: "Guy", locale: "en-US", ... },
//   ...
// ]
```

### Engine Selection & Fallback

**Engine Routing (WebViewReader.tsx):**
```typescript
const speakText = async (text: string) => {
  const engine = readerSettingsRef.current.tts?.engine || 'expo';
  const integrationSettings = getMMKVObject<IntegrationSettings>(INTEGRATION_SETTINGS);
  
  // Try Microsoft Speech if selected and configured
  if (engine === 'microsoft' && integrationSettings?.microsoftSpeech?.enabled) {
    try {
      await microsoftSpeechService.speak(text, {
        voice: readerSettingsRef.current.tts?.microsoftVoice?.shortName,
        pitch: readerSettingsRef.current.tts?.pitch || 1,
        rate: readerSettingsRef.current.tts?.rate || 1,
        onStart: () => { /* notify WebView */ },
        onDone: onDoneCallback,
        onError: (error) => {
          showToast('Microsoft Speech failed, using default voice');
          // Fallback to Expo Speech
          Speech.speak(text, { onDone: onDoneCallback, ... });
        }
      });
      return;
    } catch (error) {
      showToast('Falling back to Expo Speech');
      // Fall through to Expo Speech
    }
  }
  
  // Default to Expo Speech
  Speech.speak(text, { onDone: onDoneCallback, ... });
};
```

**Fallback Scenarios:**
1. **Network error**: Automatic fallback to Expo Speech
2. **Invalid credentials**: Toast + fallback
3. **API quota exceeded**: Error toast + fallback
4. **Unsupported voice**: Fallback to default voice
5. **Initialization failure**: Fallback to Expo Speech

**User Experience:**
- User selects engine in TTS Tab settings
- If Microsoft Speech fails, toast notification appears
- Playback continues seamlessly with Expo Speech
- No interruption to reading experience

---

## Core Features

### 1. Text Extraction & Parsing

**Algorithm:**
- Start from `reader.chapterElement` (chapter root)
- Recursively traverse DOM tree
- Only select elements that contain **only** readable child nodes
- Build `allReadableElements` array (cached at start)
- Extract normalized text for each element → `textQueue`

**Readable Criteria:**
```javascript
readable(element) {
  // Must be SPAN or have readable node name
  if (element.nodeName !== 'SPAN' && 
      !readableNodeNames.includes(element.nodeName)) {
    return false;
  }
  
  // Must have child nodes
  if (!element.hasChildNodes()) {
    return false;
  }
  
  // All children must be readable tags
  for (let child of element.childNodes) {
    if (!readableNodeNames.includes(child.nodeName)) {
      return false;
    }
  }
  
  return true;
}
```

### 2. Reading Position Tracking

**Array-Based Traversal:**
```javascript
// Old (recursive, caused stack overflow):
findNextTextNode(depth) { ... }

// New (array-based, no recursion):
next() {
  while (this.elementsRead < this.totalElements) {
    const nextElement = this.allReadableElements[this.elementsRead];
    const text = this.normalizeText(nextElement.innerText);
    
    if (text) {
      this.currentElement = nextElement;
      this.elementsRead++;
      this.speak();
      return;
    } else {
      this.elementsRead++;  // Skip empty elements
    }
  }
  
  // Reached end
  this.reading = false;
  if (autoPageAdvance && hasNextChapter) {
    reader.post({ type: 'next', autoStartTTS: true });
  } else {
    this.stop();
  }
}
```

**Progress Tracking:**
- `elementsRead`: Current position (1-indexed after speaking)
- `totalElements`: Total number of readable elements
- Sent to React Native on each speak event
- Displayed in notification as seekable progress

### 3. Auto-Chapter Progression

**Trigger Condition:**
```javascript
if (this.elementsRead >= this.totalElements) {
  const autoPageAdvance = reader.readerSettings.val.tts?.autoPageAdvance === true;
  const hasNextChapter = !!reader.nextChapter;
  
  if (autoPageAdvance && hasNextChapter) {
    reader.post({ type: 'next', autoStartTTS: true });
  }
}
```

**React Native Handling:**
```typescript
case 'next':
  if (event.autoStartTTS) {
    autoStartTTSRef.current = true;  // Flag for onLoadEnd
  }
  navigateChapter('NEXT');
  break;

// In onLoadEnd callback:
if (autoStartTTSRef.current) {
  autoStartTTSRef.current = false;
  setTimeout(() => {
    webViewRef.current?.injectJavaScript(`tts.start();`);
  }, 800);  // 300ms delay + 500ms internal delay
}
```

### 4. Element Highlighting

**CSS Class Toggle:**
```javascript
speak() {
  this.prevElement = this.currentElement;
  this.currentElement.classList.add('highlight');
  // ... post speak event
}

next() {
  this.currentElement?.classList?.remove('highlight');
  // ... find next element
}

stop() {
  this.currentElement?.classList?.remove('highlight');
  // ... reset state
}
```

**Highlight Styling** (dynamically injected):
```css
.highlight {
  background-color: rgba(theme.primary, 0.2);
  transition: background-color 0.3s ease;
}
```

### 5. Auto-Scrolling

**Smart Scroll Logic:**
```javascript
scrollToElement(element) {
  if (!element) return;
  
  const rect = element.getBoundingClientRect();
  const windowHeight = window.innerHeight;
  
  // Check if element is partially visible
  const isPartiallyVisible = 
    rect.top < windowHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0;
  
  // Only scroll if not visible or barely visible
  if (!isPartiallyVisible || rect.top < 0 || rect.bottom > windowHeight) {
    const scrollToTop = reader.readerSettings.val.tts?.scrollToTop !== false;
    
    if (scrollToTop) {
      // Scroll to 80px from top (notch/camera padding)
      const elementTop = element.getBoundingClientRect().top + window.pageYOffset;
      const offsetPosition = elementTop - 80;
      window.scrollTo({ top: offsetPosition, behavior: 'smooth' });
    } else {
      // Center scroll
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}
```

### 6. Seek Support

**Media Session Seek Handling:**
```kotlin
// Android: User drags notification progress bar
override fun onSeekTo(pos: Long) {
  val elementIndex = pos / 1000L  // Convert ms to element index
  currentPosition = elementIndex
  updateNotification()
  sendSeekEvent(elementIndex)
}
```

**React Native Event:**
```typescript
ttsMediaEmitter.addListener('TTSSeekTo', (event: { position: number }) => {
  webViewRef.current?.injectJavaScript(`
    if (window.tts && tts.started) { tts.seekTo(${event.position}); }
  `);
});
```

**WebView Implementation:**
```javascript
seekTo(index) {
  if (!this.started || !this.allReadableElements.length) return;
  
  const targetIndex = Math.max(0, Math.min(index, this.totalElements - 1));
  reader.post({ type: 'pause-speak' });  // Stop current speech
  
  this.currentElement?.classList?.remove('highlight');
  this.elementsRead = targetIndex;
  this.currentElement = this.allReadableElements[targetIndex];
  this.reading = true;
  this.elementsRead++;  // Increment for next() call
  this.speak();
}
```

### 7. Background Playback

**Queue-Based Fallback:**
When the app is backgrounded, the WebView may freeze. To handle this:

1. **Queue Population** (on TTS start):
```javascript
tts.start = () => {
  // ... setup
  this.textQueue = this.allReadableElements
    .map(el => this.normalizeText(el.innerText))
    .filter(text => !!text);
  
  reader.post({
    type: 'tts-queue',
    data: {
      queue: this.textQueue,
      startIndex: this.elementsRead,
    },
  });
};
```

2. **Background Playback** (React Native):
```typescript
const speakText = (text: string) => {
  Speech.speak(text, {
    onDone() {
      const isBackground = 
        appStateRef.current === 'background' || 
        appStateRef.current === 'inactive';
      
      if (isBackground && ttsQueueRef.current.length > 0) {
        // Use stored queue instead of WebView
        const nextIndex = ttsQueueIndexRef.current + 1;
        if (nextIndex < ttsQueueRef.current.length) {
          ttsQueueIndexRef.current = nextIndex;
          speakText(ttsQueueRef.current[nextIndex]);
          return;
        }
      }
      
      // Foreground: use WebView
      webViewRef.current?.injectJavaScript('tts.next?.()');
    },
    // ... voice settings
  });
};
```

3. **State Restoration** (on app resume):
```typescript
useEffect(() => {
  const subscription = AppState.addEventListener('change', nextState => {
    appStateRef.current = nextState;
    
    if (nextState === 'active' && isTTSReadingRef.current) {
      const index = ttsQueueIndexRef.current;
      webViewRef.current?.injectJavaScript(`
        if (window.tts && window.tts.allReadableElements) {
          tts.elementsRead = ${index};
          tts.currentElement = tts.allReadableElements[${index}];
          tts.started = true;
          tts.reading = true;
          tts.scrollToElement(tts.currentElement);
          tts.currentElement.classList.add('highlight');
        }
      `);
    }
  });
  return () => subscription.remove();
}, []);
```

---

## Settings & Configuration

### Settings Storage

**Technology:** MMKV (Memory-Mapped Key-Value store)

**Keys:**
- `CHAPTER_GENERAL_SETTINGS`: TTSEnable flag
- `CHAPTER_READER_SETTINGS`: Voice, pitch, rate, autoPageAdvance, scrollToTop, engine, microsoftVoice
- `INTEGRATION_SETTINGS`: Microsoft Speech API credentials and configuration

**TypeScript Interfaces:**
```typescript
interface ChapterGeneralSettings {
  TTSEnable: boolean;  // Default: true
  // ... other reader settings
}

interface ChapterReaderSettings {
  tts?: {
    engine?: TTSEngine;           // 'expo' | 'microsoft' (default: 'expo')
    voice?: Voice;                // Expo Voice object (for Expo Speech)
    microsoftVoice?: MicrosoftSpeechVoice; // Microsoft voice (for Microsoft Speech)
    rate?: number;                // 0.1 - 5.0 (default: 1.0)
    pitch?: number;               // 0.1 - 5.0 (default: 1.0)
    autoPageAdvance?: boolean;    // Default: false
    scrollToTop?: boolean;        // Default: true
  };
  // ... other theme settings
}

// Expo Speech Voice
interface Voice {
  identifier: string;   // System voice ID
  name: string;         // Display name (e.g., "Google US English")
  language: string;     // Language code (e.g., "en-US")
  quality?: number;     // Voice quality rating
}

// Microsoft Speech Voice
interface MicrosoftSpeechVoice {
  name: string;         // Full voice name (e.g., "en-US-JennyNeural")
  displayName: string;  // Human-readable name (e.g., "Jenny")
  locale: string;       // Locale code (e.g., "en-US")
  shortName?: string;   // Short name for API calls
  gender?: string;      // "Male" | "Female"
  localeName?: string;  // Language display name (e.g., "English (United States)")
}

// Integration Settings (API keys, etc.)
interface IntegrationSettings {
  microsoftSpeech?: {
    enabled: boolean;
    subscriptionKey: string;
    region: string;
    defaultVoice?: string;
  };
}

type TTSEngine = 'expo' | 'microsoft';
```

### Default Values

```typescript
export const initialChapterGeneralSettings: ChapterGeneralSettings = {
  TTSEnable: true,
  // ...
};

export const initialChapterReaderSettings: ChapterReaderSettings = {
  tts: {
    engine: 'expo',  // Default to Expo Speech
    rate: 1,
    pitch: 1,
    autoPageAdvance: false,
    scrollToTop: true,
  },
  // ...
};

// Integration settings default
export const INTEGRATION_SETTINGS = '@integration_settings';

// Initial integration settings (stored when user configures)
const defaultIntegrationSettings: IntegrationSettings = {
  microsoftSpeech: {
    enabled: false,
    subscriptionKey: '',
    region: '',
  },
};
```

### Settings Persistence & Reactivity

**MMKV Listener:**
```typescript
useEffect(() => {
  const mmkvListener = MMKVStorage.addOnValueChangedListener(key => {
    switch (key) {
      case CHAPTER_READER_SETTINGS:
        const newSettings = getMMKVObject<ChapterReaderSettings>(key);
        setReaderSettings(newSettings);
        Speech.stop();  // Apply new settings immediately
        
        webViewRef.current?.injectJavaScript(`
          reader.readerSettings.val = ${MMKVStorage.getString(key)};
          // Restart TTS with new settings
          if (window.tts && tts.reading) {
            const currentElement = tts.currentElement;
            tts.stop();
            setTimeout(() => tts.start(currentElement), 100);
          }
        `);
        break;
        
      case CHAPTER_GENERAL_SETTINGS:
        webViewRef.current?.injectJavaScript(`
          reader.generalSettings.val = ${MMKVStorage.getString(key)};
        `);
        break;
    }
  });
  return () => mmkvListener.remove();
}, []);
```

**WebView Reactive Stop:**
```javascript
// core.js
van.derive(() => {
  if (!reader.generalSettings.val.TTSEnable && window.tts) {
    if (tts.reading || tts.started) {
      tts.stop();
    }
  }
});
```

---

## Technical Implementation Details

### 1. Expo Speech API

**Package:** `expo-speech` (wrapper for Android TextToSpeech)

**Key Methods:**
```typescript
import * as Speech from 'expo-speech';

// Get available voices
const voices = await Speech.getAvailableVoicesAsync();
// Returns: Voice[] (name, identifier, language, quality)

// Speak text
Speech.speak(text: string, options?: {
  voice?: string,        // Voice identifier
  pitch?: number,        // 0.5 - 2.0 typical range
  rate?: number,         // 0.5 - 2.0 typical range
  onDone?: () => void,   // Callback when finished
  onStopped?: () => void,
  onError?: (error) => void,
});

// Control playback
Speech.stop();          // Stop current speech
Speech.pause();         // Pause (not used in LNReader)
Speech.resume();        // Resume (not used in LNReader)
Speech.isSpeakingAsync();  // Check if speaking
```

**LNReader Usage:**
```typescript
Speech.speak(text, {
  onDone() {
    // Triggered when text finishes speaking
    // LNReader uses this to call tts.next() or advance queue
  },
  voice: readerSettingsRef.current.tts?.voice?.identifier,
  pitch: readerSettingsRef.current.tts?.pitch || 1,
  rate: readerSettingsRef.current.tts?.rate || 1,
});
```

**Android System Integration:**
- Uses Android `android.speech.tts.TextToSpeech` API
- Requires TTS engine installed on device (Google TTS is default)
- Supports all voices installed on device
- Quality depends on device TTS engine

### 2. MediaSessionCompat

**Android Library:** `androidx.media:media:1.x`

**Purpose:**
- Integrates with Android media system
- Enables lock screen controls
- Supports Bluetooth/headset media buttons
- Handles notification callbacks

**LNReader Implementation:**
```kotlin
mediaSession = MediaSessionCompat(appContext, "LNReaderTTS").apply {
  setCallback(object : MediaSessionCompat.Callback() {
    override fun onPlay() {
      isPlaying = true
      sendEvent("TTSPlay")
      updateNotification()
    }
    
    override fun onPause() {
      isPlaying = false
      sendEvent("TTSPause")
      updateNotification()
    }
    
    override fun onSeekTo(pos: Long) {
      val elementIndex = pos / 1000L
      currentPosition = elementIndex
      updateNotification()
      sendSeekEvent(elementIndex)
    }
    
    // ... other callbacks
  })
  
  isActive = true  // Required for callbacks to work
}
```

**Metadata Setting:**
```kotlin
val metadataBuilder = MediaMetadataCompat.Builder()
  .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentSubtitle)  // Chapter
  .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentTitle)    // Novel
  .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, totalDuration * 1000L)
  .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, coverBitmap)

mediaSession.setMetadata(metadataBuilder.build())
```

**Playback State:**
```kotlin
val stateBuilder = PlaybackStateCompat.Builder()
  .setActions(
    PlaybackStateCompat.ACTION_PLAY_PAUSE or
    PlaybackStateCompat.ACTION_STOP or
    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
    PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
    PlaybackStateCompat.ACTION_SEEK_TO
  )
  .setState(
    if (isPlaying) PlaybackStateCompat.STATE_PLAYING 
    else PlaybackStateCompat.STATE_PAUSED,
    currentPosition * 1000L,  // Position in ms
    0f                        // Playback speed
  )

mediaSession.setPlaybackState(stateBuilder.build())
```

### 3. React Native Turbo Modules

**Technology:** New Architecture (JSI-based)

**Registration:**
```typescript
// specs/NativeTTSMediaControl.ts
import { TurboModule, TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  showMediaNotification(
    title: string,
    subtitle: string,
    coverUri: string,
    isPlaying: boolean
  ): void;
  // ... other methods
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeTTSMediaControl');
```

**Package Registration:**
```kotlin
// NativeTTSMediaControlPackage.kt
class NativeTTSMediaControlPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext) =
    if (name == NativeTTSMediaControlSpec.NAME) {
      NativeTTSMediaControl(reactContext)
    } else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      NativeTTSMediaControlSpec.NAME to ReactModuleInfo(
        /* ... */
        isTurboModule = true
      )
    )
  }
}
```

**Event Emission:**
```kotlin
private fun sendEvent(eventName: String) {
  if (listenerCount > 0) {
    appContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(eventName, null)
  }
}
```

**React Native Listener:**
```typescript
import { NativeEventEmitter } from 'react-native';
import NativeTTSMediaControl from '@specs/NativeTTSMediaControl';

export const ttsMediaEmitter = new NativeEventEmitter(NativeTTSMediaControl);

const playListener = ttsMediaEmitter.addListener('TTSPlay', () => {
  // Handle play event
});
```

### 4. WebView Communication

**React Native → WebView:**
```typescript
webViewRef.current?.injectJavaScript(`
  if (window.tts && tts.started) {
    tts.seekTo(${position});
  }
`);
```

**WebView → React Native:**
```javascript
// WebView (core.js)
reader.post({
  type: 'speak',
  data: text,
  index: 42,
  total: 100,
});

// React Native (WebViewReader.tsx)
<WebView
  onMessage={(ev) => {
    const event = JSON.parse(ev.nativeEvent.data);
    switch (event.type) {
      case 'speak':
        speakText(event.data);
        break;
      // ...
    }
  }}
/>
```

**Post Function Implementation:**
```javascript
// Defined in WebView HTML
reader.post = (obj) => {
  window.ReactNativeWebView.postMessage(JSON.stringify(obj));
};
```

### 5. Microsoft Speech REST API

**File:** `src/services/tts/MicrosoftSpeechService.ts`

**Dependencies:**
```typescript
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
```

**Key Implementation Steps:**

#### Step 1: Token Acquisition
```typescript
private async getAccessToken(): Promise<string> {
  const tokenUrl = `https://${this.region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': this.subscriptionKey,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Token fetch failed: ${response.status}`);
  }
  
  return await response.text();  // Returns JWT token
}
```

**Token Details:**
- Valid for 10 minutes
- No caching implemented (fetch on every request)
- Future enhancement: cache token with refresh logic

#### Step 2: SSML Generation
```typescript
private generateSSML(text: string, options: SpeakOptions): string {
  const voice = options.voice || this.voice || 'en-US-JennyNeural';
  const pitch = `${(options.pitch - 1) * 50}%`;  // Convert 0.5-2.0 → -50% to +50%
  const rate = `${options.rate || 1.0}`;         // Direct mapping (0.5-2.0)
  
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
    <voice name="${voice}">
      <prosody pitch="${pitch}" rate="${rate}">
        ${this.escapeXml(text)}
      </prosody>
    </voice>
  </speak>`;
}

private escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
```

**SSML Prosody Mapping:**
- **Pitch**: 0.5 → -50%, 1.0 → 0%, 2.0 → +50%
- **Rate**: Direct passthrough (Azure supports 0.5-3.0)

#### Step 3: TTS API Call & Audio Download
```typescript
async speak(text: string, options: SpeakOptions): Promise<void> {
  const token = await this.getAccessToken();
  const ssml = this.generateSSML(text, options);
  
  const ttsUrl = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  
  const response = await fetch(ttsUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
    },
    body: ssml,
  });
  
  if (!response.ok) {
    throw new Error(`TTS synthesis failed: ${response.status}`);
  }
  
  // Download audio as ArrayBuffer
  const audioData = await response.arrayBuffer();
  
  // Convert ArrayBuffer to base64
  const uint8Array = new Uint8Array(audioData);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  const base64Audio = btoa(binary);
  
  // Save to temporary file
  const timestamp = Date.now();
  const tempFilePath = `${FileSystem.documentDirectory}tts_${timestamp}.mp3`;
  
  await FileSystem.writeAsStringAsync(tempFilePath, base64Audio, {
    encoding: FileSystem.EncodingType.Base64,
  });
  
  // Play with expo-av
  await this.playAudio(tempFilePath, options);
}
```

**Why Not Use FileSystem.downloadAsync()?**
- `downloadAsync()` doesn't send POST request bodies properly
- Deprecated in newer expo-file-system versions
- fetch() → ArrayBuffer → base64 → writeAsStringAsync() is more reliable

#### Step 4: Audio Playback with expo-av
```typescript
private async playAudio(filePath: string, options: SpeakOptions): Promise<void> {
  // Unload previous sound if exists
  if (this.sound) {
    await this.sound.unloadAsync();
    this.sound = null;
  }
  
  // Create new sound instance
  const { sound } = await Audio.Sound.createAsync(
    { uri: filePath },
    { shouldPlay: true },
    this.onPlaybackStatusUpdate.bind(this, filePath, options)
  );
  
  this.sound = sound;
  
  // Notify start
  options.onStart?.();
}

private async onPlaybackStatusUpdate(
  filePath: string,
  options: SpeakOptions,
  status: AVPlaybackStatus
) {
  if (status.isLoaded && status.didJustFinish) {
    // Playback finished
    try {
      await this.sound?.unloadAsync();
      this.sound = null;
      
      // Delete temp file
      await FileSystem.deleteAsync(filePath, { idempotent: true });
      
      // Notify completion
      options.onDone?.();
    } catch (error) {
      options.onError?.(error.message);
    }
  }
}
```

**Audio Configuration:**
- Format: MP3 (24kHz, 48kbps, mono)
- Auto-play on load
- Auto-cleanup on finish
- Supports stop via `sound.unloadAsync()`

#### Step 5: Voice Enumeration
```typescript
async getVoices(locale?: string): Promise<MicrosoftVoice[]> {
  const voicesUrl = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
  
  const response = await fetch(voicesUrl, {
    headers: {
      'Ocp-Apim-Subscription-Key': this.subscriptionKey,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch voices: ${response.status}`);
  }
  
  const voices = await response.json();
  
  // Filter by locale if provided
  if (locale) {
    return voices.filter((voice: MicrosoftVoice) => 
      voice.locale.toLowerCase().startsWith(locale.toLowerCase())
    );
  }
  
  return voices;
}
```

**Voice Object Schema:**
```typescript
interface MicrosoftVoice {
  name: string;              // "en-US-JennyNeural"
  displayName: string;       // "Jenny"
  localName: string;         // "Jenny"
  shortName: string;         // "en-US-JennyNeural"
  gender: string;            // "Female"
  locale: string;            // "en-US"
  localeName: string;        // "English (United States)"
  sampleRateHertz: string;   // "24000"
  voiceType: string;         // "Neural"
  status: string;            // "GA" (Generally Available)
}
```

**Usage in Voice Picker:**
```typescript
const voices = await microsoftSpeechService.getVoices('en');
// Returns all English voices (en-US, en-GB, en-AU, etc.)

// Group by locale
const groupedVoices = voices.reduce((acc, voice) => {
  if (!acc[voice.locale]) acc[voice.locale] = [];
  acc[voice.locale].push(voice);
  return acc;
}, {});
```

#### Step 6: Credential Validation
```typescript
async validateCredentials(subscriptionKey: string, region: string): Promise<boolean> {
  try {
    // Temporarily set credentials
    const originalKey = this.subscriptionKey;
    const originalRegion = this.region;
    
    this.subscriptionKey = subscriptionKey;
    this.region = region;
    
    // Test by fetching voices
    await this.getVoices();
    
    // Restore original credentials
    this.subscriptionKey = originalKey;
    this.region = originalRegion;
    
    return true;
  } catch (error) {
    return false;
  }
}
```

**Validation Flow:**
1. User enters subscription key and region in Settings → Integrations
2. Taps "Validate Credentials" button
3. Calls `validateCredentials()` which attempts voice fetch
4. Shows "✓ Credentials are valid" toast on success
5. Enables Microsoft Speech engine in TTS Tab

**Error Handling:**
- 401: Invalid subscription key
- 403: Region mismatch (key from westus but region set to eastus)
- Network errors: Show "Failed to validate" toast

---

## Media Controls Integration

### Android Notification

**Notification Structure:

---

## Media Controls Integration

### Android Notification

**Notification Structure:**
```
┌─────────────────────────────────────────┐
│  [Cover]  Chapter Name                  │
│           Novel Name                    │
│                                         │
│  [<]  [<<]  [||]  [>>]                  │
│                                         │
│  Progress Bar: ████░░░░░░ 42/100        │
└─────────────────────────────────────────┘
```

**Compact View (notification collapsed):**
- Shows 3 actions: Rewind, Play/Pause, Next
- `setShowActionsInCompactView(1, 2, 3)`

**Expanded View:**
- Shows 4 actions: Previous, Rewind, Play/Pause, Next

**Notification Behavior:**
- **Ongoing when playing** (`setOngoing(isPlaying)`)
- **Dismissible when paused**
- **Swipe to dismiss triggers stop action** (`setDeleteIntent()`)

### Lock Screen Integration

**Enabled by MediaSession:**
- Shows full media controls on lock screen
- Displays cover art
- Shows chapter/novel info
- Seekable progress bar

**Headset/Bluetooth Support:**
- Play/Pause button works
- Next/Previous track buttons work
- Volume buttons do **not** control TTS (Android limitation)

### Progress Bar Behavior

**Display:**
- Shows current element index / total elements
- Scaled by 1000 for MediaSession (ms scale)
- Updates on each speak event

**Seek Interaction:**
1. User drags progress bar in notification
2. Android calls `mediaSession.onSeekTo(positionMs)`
3. Kotlin converts to element index: `positionMs / 1000`
4. Emits `TTSSeekTo` event with index
5. React Native injects JavaScript to call `tts.seekTo(index)`
6. WebView jumps to element and starts speaking

---

## Event Flow & Communication

### TTS Start Flow

```
User taps TTS controller in WebView
  ↓
TTSController.onclick() → tts.start()
  ↓
core.js: getAllReadableElements() → build textQueue
  ↓
Post 'tts-queue' message to React Native
  ↓
WebViewReader stores queue in ttsQueueRef
  ↓
core.js: tts.speak() → post 'speak' message
  ↓
WebViewReader.onMessage receives 'speak' event
  ↓
showTTSNotification() → calls NativeTTSMediaControl.showMediaNotification()
  ↓
NativeTTSMediaControl.kt creates MediaSession & Notification
  ↓
Speech.speak(text, { onDone: () => tts.next() })
  ↓
Android TTS engine speaks text
  ↓
onDone callback triggers → inject 'tts.next()'
  ↓
Repeat speak → onDone loop until chapter ends
```

### Media Control Flow (Play from Notification)

```
User taps Play in notification
  ↓
Android MediaSession.onPlay() callback
  ↓
NativeTTSMediaControl.kt sendEvent("TTSPlay")
  ↓
DeviceEventManagerModule emits event to React Native
  ↓
ttsMediaEmitter.addListener('TTSPlay') receives event
  ↓
webViewRef.injectJavaScript('tts.resume()')
  ↓
core.js: tts.resume() → tts.speak()
  ↓
Post 'speak' message to React Native
  ↓
Speech.speak() resumes playback
  ↓
updateNotification() updates button to Pause icon
```

### Settings Change Flow

```
User changes TTS pitch in Settings UI
  ↓
TTSTab.tsx: setChapterReaderSettings({ tts: { pitch: 1.5 } })
  ↓
MMKV.setObject(CHAPTER_READER_SETTINGS, newSettings)
  ↓
MMKVStorage.addOnValueChangedListener triggers
  ↓
WebViewReader.useEffect receives change event
  ↓
Speech.stop() to interrupt current speech
  ↓
webViewRef.injectJavaScript updates reader.readerSettings.val
  ↓
If TTS is reading: stop and restart from currentElement
  ↓
Next Speech.speak() uses new pitch value
```

### Background Playback Flow

```
User backgrounds app while TTS is playing
  ↓
AppState changes to 'background'
  ↓
AppState listener updates appStateRef.current
  ↓
Speech.speak() onDone callback checks appStateRef
  ↓
If background: use ttsQueueRef instead of WebView
  ↓
speakText(ttsQueueRef.current[nextIndex])
  ↓
Queue continues playing without WebView
  ↓
User returns to app → AppState 'active'
  ↓
AppState listener injects JavaScript to restore TTS state
  ↓
Syncs elementsRead, currentElement, highlight
  ↓
Foreground playback resumes
```

---

## Limitations & Known Issues

### 1. WebView Freeze in Background

**Issue:**
- WebView JavaScript execution pauses when app is backgrounded
- `tts.next()` cannot be called from background

**Current Solution:**
- Build complete text queue on TTS start
- Store queue in React Native (`ttsQueueRef`)
- Use queue-based playback in background
- Restore state when app resumes

**Limitation:**
- Cannot dynamically update highlight in background
- Cannot auto-advance to next chapter in background

### 2. Seek Bar Granularity

**Issue:**
- Progress is element-based, not time-based
- Seeking jumps to specific element, not specific word/sentence

**Impact:**
- Coarse seeking in chapters with long paragraphs
- Fine-tuned seeking in chapters with short sentences

**Potential Improvement:**
- Split long elements into sentences
- Track sentence index separately

### 3. Voice Quality Variance

**Issue:**
- Voice quality depends on device TTS engine
- Some devices have low-quality default voices
- Downloaded language packs vary in quality

**Mitigation:**
- Voice picker allows selecting best available voice
- Users can download higher-quality voices from system settings

### 4. No Pause/Resume in Expo Speech

**Issue:**
- Expo Speech only supports `speak()` and `stop()`
- No native pause/resume functionality

**Current Implementation:**
- "Pause" actually stops speech
- "Resume" re-speaks the current element from the start

**Impact:**
- User may hear repeated words when resuming

### 5. Microsoft Speech Network Dependency

**Issue:**
- Requires active internet connection for API calls
- No offline mode available

**Impact:**
- Cannot use Microsoft Speech on airplane mode or poor connectivity
- Automatic fallback to Expo Speech on network errors

**Mitigation:**
- Fallback to Expo Speech on API failure
- Toast notification informing user of fallback

### 6. Microsoft Speech API Costs

**Issue:**
- Azure Speech Service has usage-based pricing
- Free tier: 500K characters/month
- Paid tier: $15 per 1M characters (Standard voices)

**Impact:**
- Users need to monitor usage to avoid unexpected charges
- Heavy readers may exceed free tier

**Mitigation:**
- Document costs in help modal
- Recommend free tier for most users (500K chars ≈ 5-10 novels/month)

**Future Enhancement:**
- Add usage tracking in app
- Show monthly character counter
- Warning when approaching free tier limit

### 7. Microsoft Speech Latency

**Issue:**
- Cloud API calls add 100-500ms latency per request
- Token acquisition adds extra delay on first request

**Impact:**
- Slight delay before each element starts speaking
- More noticeable on slower connections

**Optimization:**
- Could implement token caching (10-minute expiry)
- Could pre-fetch audio for next element (future enhancement)

### 8. Microsoft Speech Credential Security

**Issue:**
- Subscription key stored in MMKV (plaintext)
- Exposed to root access on rooted devices

**Impact:**
- Low risk for most users (key only grants TTS API access)
- Potential for key theft on compromised devices

**Mitigation:**
- Subscription keys have limited scope (not account-wide credentials)
- Users should rotate keys if device is compromised
- Future: Consider using keychain/keystore for secure storage
- No seamless pause mid-sentence

### 5. RTL Language Support

**Status:**
- RTL detected via `plugin?.lang === 'Arabic' || plugin?.lang === 'Hebrew'`
- WebView dir attribute set to `rtl`
- TTS traversal is LTR-based (may not match reading order)

**Potential Issue:**
- Reading order may not match visual order in complex RTL layouts

### 6. Image-Heavy Chapters

**Issue:**
- Readable element detection may skip image captions
- Images themselves cannot be described

**Impact:**
- User may miss context provided by images
- No alt-text narration

### 7. Custom CSS/JS Conflicts

**Issue:**
- User custom CSS may hide readable elements
- Custom JS may interfere with TTS controller

**Impact:**
- TTS may skip hidden but readable content
- Controller may become non-functional

### 8. No Offline Voice Download

**Issue:**
- App cannot trigger voice downloads programmatically
- Users must manually download voices via system settings

**Mitigation:**
- Voice picker shows all available voices
- Instructions could be added to guide users

### 9. No Speech Feedback

**Issue:**
- No visual/audio cue when speech errors occur
- Silent failures if TTS engine crashes

**Current Handling:**
```javascript
try {
  this.next();
} catch (e) {
  this.stop();
  alert('TTS Error: ' + e.message);
}
```

**Limitation:**
- User may not notice if TTS stops unexpectedly

### 10. Progress Bar in Page Reader Mode

**Issue:**
- TTS progress is element-based, but page reader shows page numbers
- Progress bar may show `42/100` elements while footer shows `5/10` pages

**Impact:**
- Inconsistent progress display between notification and footer

---

## Future Enhancement Opportunities

### 1. Sentence-Level Splitting

**Current:**
- Readable elements are spoken in full (entire paragraph)

**Enhancement:**
- Split long paragraphs into sentences
- Track sentence index for finer seek granularity
- Improve progress accuracy

**Implementation:**
```javascript
this.splitIntoSentences = text => {
  // Split on sentence boundaries
  return text.match(/[^.!?]+[.!?]+/g) || [text];
};

// In speak():
const sentences = this.splitIntoSentences(element.innerText);
sentences.forEach((sentence, i) => {
  // Speak each sentence with index
  reader.post({
    type: 'speak',
    data: sentence,
    index: this.sentenceIndex++,
    total: this.totalSentences,
  });
});
```

### 2. Word-Level Highlighting

**Current:**
- Entire element is highlighted during speech

**Enhancement:**
- Highlight current word being spoken
- Requires word-level timing from TTS engine

**Complexity:**
- Expo Speech doesn't expose word boundaries
- Would require native TTS API access or workarounds

### 3. Background Service

**Current:**
- Background playback uses queue-based workaround

**Enhancement:**
- Implement Android Foreground Service for TTS
- Allows persistent background execution
- Better integration with media controls

**Benefits:**
- Proper pause/resume mid-sentence
- Auto-chapter advance in background
- More reliable playback

### 4. Sleep Timer

**Feature:**
- Allow user to set a timer (e.g., 15 minutes)
- Auto-stop TTS when timer expires
- Common in audiobook/podcast apps

**Implementation:**
```typescript
useEffect(() => {
  if (sleepTimerMinutes > 0 && isTTSReadingRef.current) {
    const timer = setTimeout(() => {
      webViewRef.current?.injectJavaScript('tts.stop()');
    }, sleepTimerMinutes * 60 * 1000);
    
    return () => clearTimeout(timer);
  }
}, [sleepTimerMinutes, isTTSReadingRef.current]);
```

### 5. Reading Speed Estimation

**Feature:**
- Calculate estimated time remaining
- Display in notification (e.g., "15 minutes left")

**Implementation:**
```javascript
const estimateTimeRemaining = () => {
  const wordsLeft = this.allReadableElements
    .slice(this.elementsRead)
    .reduce((total, el) => total + el.innerText.split(/\s+/).length, 0);
  
  const wordsPerMinute = 150 * this.rate;  // Adjusted by rate
  const minutesLeft = wordsLeft / wordsPerMinute;
  
  return minutesLeft;
};
```

### 6. Bookmarks for TTS

**Feature:**
- Allow users to save TTS position
- Resume from saved position across sessions

**Implementation:**
```typescript
const saveTTSBookmark = () => {
  MMKVStorage.setObject(`tts_bookmark_${chapter.id}`, {
    elementIndex: tts.elementsRead,
    timestamp: Date.now(),
  });
};

const loadTTSBookmark = () => {
  const bookmark = getMMKVObject(`tts_bookmark_${chapter.id}`);
  if (bookmark) {
    webViewRef.current?.injectJavaScript(`
      tts.start();
      tts.seekTo(${bookmark.elementIndex});
    `);
  }
};
```

### 7. Multi-Voice Support

**Feature:**
- Assign different voices to different character dialogues
- Detect speaker from text patterns

**Complexity:**
- Requires dialogue detection heuristics
- Voice switching mid-chapter
- May be inconsistent across novels

### 8. Pronunciation Dictionary

**Feature:**
- Allow users to define custom pronunciations
- Common for LN-specific terms (character names, fantasy words)

**Implementation:**
```typescript
const pronunciationMap = getMMKVObject('tts_pronunciation') || {};

const applyPronunciations = (text: string) => {
  let result = text;
  Object.entries(pronunciationMap).forEach(([original, replacement]) => {
    result = result.replace(new RegExp(original, 'gi'), replacement);
  });
  return result;
};

// In speakText:
const processedText = applyPronunciations(text);
Speech.speak(processedText, { ... });
```

### 9. TTS Analytics

**Feature:**
- Track TTS usage statistics
- Most-read novels, total listening time, etc.

**Privacy Consideration:**
- Should be opt-in and local-only

### 10. Offline TTS Fallback

**Feature:**
- Detect when TTS engine is unavailable
- Show clear error message with troubleshooting steps

**Implementation:**
```typescript
useEffect(() => {
  Speech.isSpeakingAsync().catch((error) => {
    // TTS engine not available
    Alert.alert(
      'TTS Unavailable',
      'Text-to-Speech engine is not available. Please install Google TTS from Play Store.',
      [{ text: 'Open Play Store', onPress: () => Linking.openURL('market://...') }]
    );
  });
}, []);
```

### 11. Microsoft Speech Token Caching

**Current:**
- New token requested for every TTS request

**Enhancement:**
- Cache access token for its 10-minute lifespan
- Reduce API calls and latency

**Implementation:**
```typescript
class MicrosoftSpeechService {
  private cachedToken?: { token: string; expiry: number };
  
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    
    // Return cached token if still valid
    if (this.cachedToken && this.cachedToken.expiry > now) {
      return this.cachedToken.token;
    }
    
    // Fetch new token
    const token = await this.fetchNewToken();
    this.cachedToken = {
      token,
      expiry: now + (9 * 60 * 1000), // 9 minutes (conservative)
    };
    
    return token;
  }
}
```

**Benefits:**
- Faster response time (no token fetch delay)
- Reduced API calls
- Lower latency between elements

### 12. Microsoft Speech Audio Pre-fetching

**Current:**
- Fetches audio for each element sequentially
- User waits for API call before each element

**Enhancement:**
- Pre-fetch next 2-3 elements while current is playing
- Queue audio files for seamless playback

**Implementation:**
```typescript
class MicrosoftSpeechService {
  private audioCache: Map<number, string> = new Map();
  
  async prefetchAudio(textArray: string[], startIndex: number) {
    const prefetchCount = 3;
    const promises = [];
    
    for (let i = startIndex; i < Math.min(startIndex + prefetchCount, textArray.length); i++) {
      if (!this.audioCache.has(i)) {
        promises.push(this.fetchAndCacheAudio(textArray[i], i));
      }
    }
    
    await Promise.all(promises);
  }
  
  async speak(text: string, index: number) {
    // Use cached audio if available
    const cachedFile = this.audioCache.get(index);
    if (cachedFile) {
      await this.playAudio(cachedFile);
      this.audioCache.delete(index); // Cleanup
      return;
    }
    
    // Fallback to normal fetch
    await this.fetchAndSpeak(text);
  }
}
```

**Benefits:**
- Near-instant playback between elements
- Better user experience for cloud TTS
- Reduced perceived latency

### 13. Microsoft Speech Usage Tracking & Limits

**Feature:**
- Track monthly character usage for Microsoft Speech
- Show usage meter in Settings
- Warn user when approaching free tier limit (500K chars)

**Implementation:**
```typescript
interface MicrosoftSpeechUsage {
  month: string;           // "2026-03"
  charactersUsed: number;  // 245680
  requestCount: number;    // 842
}

const MICROSOFT_SPEECH_USAGE = '@microsoft_speech_usage';

const trackUsage = (textLength: number) => {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const usage = getMMKVObject<MicrosoftSpeechUsage>(MICROSOFT_SPEECH_USAGE) || {
    month: currentMonth,
    charactersUsed: 0,
    requestCount: 0,
  };
  
  // Reset if new month
  if (usage.month !== currentMonth) {
    usage.month = currentMonth;
    usage.charactersUsed = 0;
    usage.requestCount = 0;
  }
  
  usage.charactersUsed += textLength;
  usage.requestCount += 1;
  
  setMMKVObject(MICROSOFT_SPEECH_USAGE, usage);
  
  // Warn at 90% of free tier
  if (usage.charactersUsed > 450000) {
    showToast('Warning: Approaching Microsoft Speech free tier limit (450K/500K chars used)');
  }
};
```

**UI Addition:**
```typescript
// In Settings → Integrations
<Text>
  Monthly Usage: {usage.charactersUsed.toLocaleString()} / 500,000 characters
</Text>
<ProgressBar value={usage.charactersUsed / 500000} />
<Text style={{ fontSize: 12, color: 'gray' }}>
  Resets on {getNextMonthDate()}
</Text>
```

### 14. Microsoft Speech Emotion & Style Selection

**Feature:**
- Some Microsoft voices support speaking styles (cheerful, sad, newscast, etc.)
- Allow users to select style in voice picker

**Current Limitation:**
- Current implementation uses basic SSML with only pitch/rate

**Enhancement:**
```typescript
generateSSML(text: string, options: SpeakOptions): string {
  const voice = options.voice || 'en-US-JennyNeural';
  const pitch = `${(options.pitch - 1) * 50}%`;
  const rate = `${options.rate}`;
  const style = options.style || 'default';  // NEW
  const styleDegree = options.styleDegree || '1.0';  // NEW
  
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" 
                 xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">
    <voice name="${voice}">
      <mstts:express-as style="${style}" styledegree="${styleDegree}">
        <prosody pitch="${pitch}" rate="${rate}">
          ${this.escapeXml(text)}
        </prosody>
      </mstts:express-as>
    </voice>
  </speak>`;
}
```

**Available Styles (voice-dependent):**
- Jenny: cheerful, sad, angry, excited, friendly, hopeful, shouting, terrified, unfriendly, whispering
- Davis: angry, cheerful, excited, friendly, hopeful, sad, shouting, terrified, unfriendly, whispering

**UI:**
- Add style picker in TTS Tab when Microsoft voice selected
- Show available styles based on voice capabilities

### 15. Multi-Engine Hybrid Mode

**Feature:**
- Use Microsoft Speech for dialogue (premium quality)
- Use Expo Speech for narration (faster, offline)
- Auto-detect dialogue vs narration

**Implementation:**
```typescript
const detectDialogue = (text: string): boolean => {
  // Simple heuristic: text in quotes
  return /[""].*[""]/.test(text) || /「.*」/.test(text);
};

const speakText = async (text: string) => {
  const useDialogueEngine = detectDialogue(text);
  const engine = useDialogueEngine ? 'microsoft' : 'expo';
  
  if (engine === 'microsoft' && integrationSettings?.microsoftSpeech?.enabled) {
    await microsoftSpeechService.speak(text, ...);
  } else {
    Speech.speak(text, ...);
  }
};
```

**Benefits:**
- Cost reduction (less Microsoft API usage)
- Quality where it matters (character voices)
- Faster narration (offline Expo Speech)

### 16. Microsoft Speech Secure Credential Storage

**Current:**
- Subscription key stored in MMKV (plaintext)

**Enhancement:**
- Use React Native Keychain for secure storage
- Encrypt subscription key at rest

**Implementation:**
```typescript
import * as Keychain from 'react-native-keychain';

const saveCredentials = async (key: string, region: string) => {
  await Keychain.setGenericPassword(region, key, {
    service: 'microsoft-speech-credentials',
  });
};

const loadCredentials = async (): Promise<{ key: string; region: string } | null> => {
  const credentials = await Keychain.getGenericPassword({
    service: 'microsoft-speech-credentials',
  });
  
  if (credentials) {
    return { key: credentials.password, region: credentials.username };
  }
  return null;
};
```

**Benefits:**
- Protection against key theft on rooted devices
- Encrypted storage using Android Keystore
- Better security posture

---

## Summary

### What Works Well

✅ **Robust Text Parsing**
- Array-based traversal prevents stack overflow
- Handles complex HTML structures
- Normalizes text for better speech quality

✅ **Seamless Media Integration**
- Lock screen controls work perfectly
- Notification UI is clean and functional
- Seek support with element-level granularity

✅ **Background Playback**
- Queue-based fallback maintains playback when app is backgrounded
- State restoration on app resume

✅ **User Control**
- Draggable controller for flexible start position
- Comprehensive settings (voice, pitch, rate, auto-advance, scroll)
- Real-time settings updates without restart

✅ **Auto-Chapter Progression**
- Optional seamless transition to next chapter
- Maintains TTS state across navigation

✅ **Dual-Engine Support** (NEW)
- Expo Speech (device TTS) for offline, cost-free playback
- Microsoft Speech (cloud TTS) for premium neural voices
- Automatic fallback on errors
- 400+ voices in 140+ languages via Azure

### Areas for Improvement

⚠️ **Pause/Resume Limitations**
- No mid-sentence pause (Expo Speech API limitation)
- Resume re-speaks entire element

⚠️ **Background Execution**
- WebView freeze requires workarounds
- No highlight updates in background

⚠️ **Seek Granularity**
- Element-based, not time-based
- Coarse for chapters with long paragraphs

⚠️ **Voice Quality (Expo Speech)**
- Device-dependent
- No in-app voice downloads

⚠️ **Microsoft Speech Latency**
- Cloud API calls add 100-500ms delay
- Token acquisition adds extra delay

⚠️ **Microsoft Speech Costs**
- Free tier: 500K chars/month
- No usage tracking implemented yet

### Recommended Next Steps

**High Priority:**
1. **Microsoft Speech Token Caching** (low complexity, reduces latency)
2. **Implement Sleep Timer** (low complexity, high user value)
3. **Microsoft Speech Usage Tracking** (medium complexity, prevents bill shock)

**Medium Priority:**
4. **Add Reading Time Estimation** (medium complexity, high UX value)
5. **Sentence-Level Splitting** (medium complexity, improves seek accuracy)
6. **TTS Bookmarks** (low complexity, user convenience)

**Low Priority (Advanced):**
7. **Microsoft Speech Audio Pre-fetching** (high complexity, requires queue refactor)
8. **Background Service** (high complexity, solves pause/resume issue)
9. **Multi-Engine Hybrid Mode** (high complexity, dialogue detection)

---

## Migration to New Architecture

> **🚀 The TTS system is being migrated to a new architecture that addresses the limitations above.**

### What's Changing?

The current TTS system is being refactored from a WebView-coordinated, on-demand synthesis model to a **hybrid foreground service architecture** with progressive preloading and offline batch downloads.

**Key Improvements:**
- ✅ **True pause/resume** - Mid-sentence pause via expo-av (no more stop/restart)
- ✅ **Background reliability** - Android foreground service prevents process termination
- ✅ **Network resilience** - Progressive preloading with retry logic and intelligent caching
- ✅ **Offline capability** - Batch download chapters for airplane mode, travel
- ✅ **66% cost reduction** - Azure Batch Synthesis API ($4/1M vs $15/1M chars)
- ✅ **Better UX** - Faster startup, smoother playback, no gaps between elements

### Migration Documentation

**Comprehensive migration plan available:**

1. **[00-MIGRATION-OVERVIEW.md](./tts-migration/00-MIGRATION-OVERVIEW.md)**
   - High-level strategy and timeline
   - Current vs new architecture comparison
   - Success criteria and risk mitigation

2. **[01-NEW-ARCHITECTURE.md](./tts-migration/01-NEW-ARCHITECTURE.md)**
   - Detailed component design
   - Data flow diagrams
   - State management strategy

3. **[02-IMPLEMENTATION-GUIDE.md](./tts-migration/02-IMPLEMENTATION-GUIDE.md)**
   - Step-by-step implementation instructions
   - Complete code examples
   - Testing procedures

4. **[03-AZURE-BATCH-SYNTHESIS.md](./tts-migration/03-AZURE-BATCH-SYNTHESIS.md)**
   - Batch Synthesis API integration
   - Azure Blob Storage setup (optional)
   - Cost analysis and alternatives

5. **[03-BLOB-STORAGE-SETUP.md](./tts-migration/03-BLOB-STORAGE-SETUP.md)**
   - Quick reference for Azure Blob Storage setup
   - Alternative storage solutions
   - Troubleshooting guide

### Timeline

- **Phase 1 (Week 1):** Core service + progressive preloading
- **Phase 2 (Week 2):** Batch downloads + offline support
- **Phase 3 (Days 13-14):** Testing and polish

**Estimated effort:** 80-100 hours (2 weeks full-time or 4 weeks part-time)

### For Developers

If you're implementing TTS features or fixing bugs:
1. Read the [migration plan](./tts-migration/00-MIGRATION-OVERVIEW.md) first
2. Consider whether your change should wait for the migration
3. Ensure compatibility with both architectures if implementing now

### For AI Agents

The migration documentation is designed to be comprehensive enough for an AI agent to implement the refactoring from scratch. Start with [00-MIGRATION-OVERVIEW.md](./tts-migration/00-MIGRATION-OVERVIEW.md) and follow the documentation sequentially.

---

**End of Documentation**

For questions or contributions, see:
- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [Architecture Decisions](https://github.com/LNReader/lnreader/discussions)
- **[TTS Migration Plan](./tts-migration/00-MIGRATION-OVERVIEW.md)** ✨
