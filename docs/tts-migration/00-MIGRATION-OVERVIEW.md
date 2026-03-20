# TTS Refactoring: Migration to Foreground Service Architecture

**Migration Date:** March 2026  
**Status:** Planning Phase  
**Estimated Effort:** 2 weeks full-time (80-100 hours)  
**Target:** React Native 0.81.6 + Expo 54 + Android SDK 24-36

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Current vs New Architecture](#current-vs-new-architecture)
3. [Key Improvements](#key-improvements)
4. [Migration Strategy](#migration-strategy)
5. [Documentation Structure](#documentation-structure)
6. [Prerequisites](#prerequisites)
7. [Timeline](#timeline)

---

## Overview

This migration refactors LNReader's Text-to-Speech (TTS) system from a WebView-coordinated, on-demand synthesis model to a **hybrid foreground service architecture** with progressive preloading and offline batch downloads.

### Problems Solved

❌ **Current Issues:**
1. No true pause/resume - stops and restarts from element beginning
2. WebView freezes in background, breaking playback
3. Network switches (WiFi ↔ 5G) cause playback failures
4. Dead zones interrupt reading experience
5. No offline capability for travel/airplane mode
6. High API costs for Microsoft Speech ($15/1M chars)

✅ **Solutions:**
1. True mid-sentence pause/resume via expo-av
2. Android foreground service keeps app alive in background
3. Progressive preloading with retry logic and network resilience
4. Offline batch downloads via Azure Batch Synthesis API
5. Intelligent caching with LRU management
6. 66% cost reduction for batch downloads ($4/1M chars)

---

## Current vs New Architecture

### Current Architecture (March 2026)

```
WebView (core.js) 
  → Extracts text, manages state
  → Posts 'speak' events to React Native
    → React Native (WebViewReader.tsx)
      → Calls Speech.speak() OR MicrosoftSpeechService
        → Expo Speech (device TTS) OR Azure Speech (cloud TTS)
      → Shows notification via NativeTTSMediaControl
        → Android MediaSession + Notification
```

**Key Characteristics:**
- WebView is source of truth for playback state
- On-demand synthesis (per element)
- Queue-based fallback when backgrounded
- No true pause (stop/restart only)
- Network-dependent throughout playback

**Documentation:** [TTS_DOCUMENTATION.md](../TTS_DOCUMENTATION.md)

---

### New Architecture (Target)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Android Foreground Service                    │
│  • Keeps app alive 24/7 during TTS playback                     │
│  • Shows ongoing notification (required for Android 8+)          │
│  • Manages service lifecycle independently                       │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                     TTSPlaybackManager (NEW)                     │
│  • Singleton service managing all playback                       │
│  • expo-av Sound API for audio (true pause/resume)              │
│  • Queue management with position tracking                       │
│  • Progressive preloading (first 5 → background generation)      │
│  • Retry logic with exponential backoff                          │
│  • Cache management (LRU, 100MB default)                         │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                   Audio Generation Layer (NEW)                   │
│  ┌──────────────────────┐       ┌─────────────────────────────┐│
│  │  Expo Speech         │       │  Microsoft Speech           ││
│  │  → Native synthesis  │       │  ┌────────────────────────┐ ││
│  │  → synthesizeToFile()│       │  │ Real-time API          │ ││
│  │                      │       │  │ • On-demand generation │ ││
│  │                      │       │  │ • 200-500ms latency    │ ││
│  │                      │       │  │ • $15/1M chars         │ ││
│  │                      │       │  └────────────────────────┘ ││
│  │                      │       │  ┌────────────────────────┐ ││
│  │                      │       │  │ Batch Synthesis API    │ ││
│  │                      │       │  │ • Bulk pre-download    │ ││
│  │                      │       │  │ • Async processing     │ ││
│  │                      │       │  │ • $4/1M chars (66% ↓)  │ ││
│  │                      │       │  └────────────────────────┘ ││
│  └──────────────────────┘       └─────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    Existing Components (Modified)                │
│  • WebView (core.js) - Text extraction only                     │
│  • NativeTTSMediaControl - Notification coordination            │
│  • WebViewReader.tsx - Delegates to TTSPlaybackManager          │
└─────────────────────────────────────────────────────────────────┘
```

**Key Characteristics:**
- TTSPlaybackManager is source of truth
- Foreground service ensures background reliability
- Progressive + batch preloading strategies
- True pause/resume (expo-av)
- Network-resilient with offline capability

**Documentation:** See [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md)

---

## Key Improvements

### 1. True Pause/Resume
- **Before:** `Speech.stop()` → re-speak from beginning
- **After:** `sound.pauseAsync()` → resume from exact position
- **Benefit:** Better UX, no repeated words

### 2. Background Reliability
- **Before:** WebView freezes, queue-based fallback
- **After:** Foreground service keeps process alive
- **Benefit:** Guaranteed background playback

### 3. Network Resilience
- **Before:** Fails on network switch or dead zone
- **After:** Progressive preloading + retry logic + caching
- **Benefit:** Seamless playback through network transitions

### 4. Offline Capability
- **Before:** Requires network throughout
- **After:** Batch downloads for entire chapters/novels
- **Benefit:** Airplane mode, international travel

### 5. Cost Reduction
- **Before:** $15/1M chars (real-time API)
- **After:** $4/1M chars for offline downloads (batch API)
- **Benefit:** 66% savings for heavy users

---

## Migration Strategy

### Phase 1: Core Service + Progressive Preloading (Week 1)
**Focus:** Basic functionality with immediate value

- ✅ Foreground service implementation
- ✅ TTSPlaybackManager with expo-av
- ✅ Progressive preloading (fast startup + buffering)
- ✅ Retry logic and network error handling
- ✅ Cache management (LRU)
- ✅ Refactor WebViewReader integration

**Deliverable:** Working TTS with pause/resume, handles network switches

---

### Phase 2: Batch Downloads + Offline Support (Week 2)
**Focus:** Premium offline features

- ✅ Azure Batch Synthesis API integration
- ✅ Download manager with background jobs
- ✅ Offline storage management
- ✅ Download UI (chapter list, management screen)
- ✅ Auto-download next chapter
- ✅ State persistence and restoration

**Deliverable:** Full offline capability for travel

---

### Phase 3: Polish + Testing (Days 13-14)
**Focus:** Stability and UX refinement

- ✅ Comprehensive testing (all scenarios)
- ✅ Settings UI updates
- ✅ Performance optimization
- ✅ Documentation updates
- ✅ User guide

**Deliverable:** Production-ready, documented system

---

## Documentation Structure

This migration is documented across multiple files for clarity:

### Migration Docs (`docs/tts-migration/`)

1. **[00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md)** (this file)
   - High-level overview and strategy

2. **[01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md)**
   - Detailed architecture diagrams
   - Component responsibilities
   - Data flow and state management

3. **[02-IMPLEMENTATION-GUIDE.md](./02-IMPLEMENTATION-GUIDE.md)**
   - Step-by-step implementation instructions
   - Code examples for each component
   - File structure and organization

4. **[03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md)**
   - Batch Synthesis API integration guide
   - Azure Blob Storage setup
   - Alternative storage solutions
   - Cost analysis

5. **[04-TESTING-GUIDE.md](./04-TESTING-GUIDE.md)**
   - Test scenarios and cases
   - Manual testing procedures
   - Automated testing strategy

6. **[05-API-REFERENCE.md](./05-API-REFERENCE.md)**
   - New APIs and interfaces
   - Event schemas
   - Configuration options

### Existing Docs (Reference)

- **[../TTS_DOCUMENTATION.md](../TTS_DOCUMENTATION.md)**
  - Current TTS system documentation
  - Keep for reference during migration
  - Update after migration completes

---

## Prerequisites

### Development Environment

**Required:**
- Node.js >= 20
- Java SDK >= 17
- pnpm (package manager)
- Android SDK (minSdk: 24, targetSdk: 36)
- Expo CLI

**Recommended:**
- Android Studio (for native debugging)
- VS Code with React Native extensions
- Azure account (for Microsoft Speech testing)

### Dependencies to Add

```json
{
  "expo-av": "~14.0.0",  // Already present for Microsoft Speech
  "react-native-background-fetch": "^4.2.0"  // For background downloads
}
```

### Native Permissions (Android)

Add to `AndroidManifest.xml`:
```xml
<!-- Foreground service -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />

<!-- Background execution (Android 12+) -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

### Azure Requirements (Optional - for Microsoft Speech)

**Real-time API (already configured):**
- Speech Service resource
- Subscription key
- Region

**Batch Synthesis API (new):**
- Same Speech Service resource
- Azure Blob Storage account (for input hosting)
  - Or alternative temporary file hosting
- See [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md)

---

## Timeline

### Week 1: Foundation (40-44 hours)
- **Day 1-2:** Service implementation (8-10h)
- **Day 3-4:** TTSPlaybackManager + expo-av (8-10h)
- **Day 5:** Audio generation layer (6-8h)
- **Day 6:** Native TTS synthesizeToFile module (6-8h)
- **Day 7:** WebViewReader refactor + integration (6-8h)

**Milestone:** Basic TTS works with pause/resume

---

### Week 2: Advanced Features (40-44 hours)
- **Day 8:** Progressive preloading system (6-8h)
- **Day 9:** Cache management + retry logic (6-8h)
- **Day 10:** Batch Synthesis API integration (8-10h)
- **Day 11:** Download manager + background jobs (8-10h)
- **Day 12:** Download UI (chapter list, screens) (6-8h)
- **Day 13-14:** Testing, polish, documentation (6-8h)

**Milestone:** Full feature-complete system

---

## Success Criteria

The migration is successful when:

✅ **Functional Requirements:**
1. True pause/resume works mid-sentence
2. Playback continues seamlessly in background
3. Survives network switches (WiFi ↔ 5G)
4. Recovers from dead zones automatically
5. Offline downloads work for chapters
6. Both Expo and Microsoft Speech supported
7. Settings and voice changes apply correctly

✅ **Performance Requirements:**
1. Startup time < 2 seconds (progressive preload)
2. No audio gaps between elements
3. Retry logic recovers from transient errors
4. Cache management prevents disk overflow
5. Battery usage acceptable (<5% drain/hour)

✅ **Quality Requirements:**
1. All existing tests pass
2. No new lint errors
3. Documentation updated
4. User settings preserved during migration
5. Graceful degradation if features unavailable

---

## Risk Mitigation

### Risk 1: expo-speech doesn't support synthesizeToFile
**Mitigation:** Create native Turbo Module using Android's `TextToSpeech.synthesizeToFile()`

### Risk 2: Azure Blob Storage adds complexity
**Mitigation:** Support multiple strategies (blob, data URI, self-hosted) - see [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md)

### Risk 3: Foreground service killed by system
**Mitigation:** Proper notification, state persistence, auto-restart

### Risk 4: Breaking existing functionality
**Mitigation:** Feature flags, gradual rollout, fallback to old code path

---

## Migration Checklist

Before starting implementation:

- [ ] Read all migration documentation
- [ ] Review current TTS implementation ([TTS_DOCUMENTATION.md](../TTS_DOCUMENTATION.md))
- [ ] Set up Azure resources (if using Microsoft Speech)
- [ ] Configure blob storage (if using batch downloads)
- [ ] Create feature branch: `feature/tts-foreground-service`
- [ ] Back up current working state

During implementation:

- [ ] Follow implementation guide step-by-step
- [ ] Test each component in isolation
- [ ] Update tests as you go
- [ ] Document any deviations from plan
- [ ] Commit regularly with clear messages

After implementation:

- [ ] Complete all test scenarios
- [ ] Update main TTS_DOCUMENTATION.md
- [ ] Create user migration guide if needed
- [ ] Performance testing and optimization
- [ ] Code review and feedback

---

## Getting Started

1. **Read in order:**
   - This file (overview)
   - [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md) (architecture)
   - [02-IMPLEMENTATION-GUIDE.md](./02-IMPLEMENTATION-GUIDE.md) (implementation)

2. **Set up prerequisites:**
   - Verify development environment
   - Install dependencies
   - Configure Azure (if needed)

3. **Start Phase 1:**
   - Begin with Step 1 in implementation guide
   - Work through systematically
   - Test frequently

---

## Support & Questions

- **Architecture questions:** See [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md)
- **Implementation help:** See [02-IMPLEMENTATION-GUIDE.md](./02-IMPLEMENTATION-GUIDE.md)
- **Azure/Blob setup:** See [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md)
- **Testing procedures:** See [04-TESTING-GUIDE.md](./04-TESTING-GUIDE.md)
- **API details:** See [05-API-REFERENCE.md](./05-API-REFERENCE.md)

---

**Next:** Read [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md) for detailed architecture
