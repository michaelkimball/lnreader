# TTS Migration Documentation

**Migrating LNReader TTS to Foreground Service Architecture**

---

## Quick Links

📖 **Start Here:** [00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md)

---

## Documentation Files

| File | Purpose | Audience |
|------|---------|----------|
| [00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md) | High-level strategy, timeline, prerequisites | Everyone |
| [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md) | Detailed component design, data flow, state management | Developers, AI agents |
| [02-IMPLEMENTATION-GUIDE.md](./02-IMPLEMENTATION-GUIDE.md) | Step-by-step code implementation with examples | Implementers |
| [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md) | Batch Synthesis API integration, cost analysis | Developers using Microsoft Speech |
| [03-BLOB-STORAGE-SETUP.md](./03-BLOB-STORAGE-SETUP.md) | Quick setup guide for Azure Blob Storage | Setup/deployment |

---

## What We're Building

### Current TTS System (March 2026)

❌ **Problems:**
- No true pause/resume (stops and restarts)
- WebView freezes in background
- Network switches break playback
- No offline capability
- High API costs

### New TTS System (Target)

✅ **Solutions:**
- True mid-sentence pause/resume via expo-av
- Android foreground service for background reliability
- Progressive preloading with retry logic
- Offline batch downloads via Azure Batch Synthesis API
- 66% cost reduction for offline downloads
- Network resilience with intelligent caching

---

## Reading Order

### For Understanding the Plan (30 minutes)

1. [00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md) - Read sections:
   - Overview
   - Current vs New Architecture
   - Key Improvements
   - Migration Strategy

2. [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md) - Skim:
   - System Architecture diagram
   - Component Responsibilities (scan headers)
   - Data Flow (understand main flows)

### For Implementation (40+ hours)

1. [00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md) - Read completely
2. [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md) - Read completely
3. [02-IMPLEMENTATION-GUIDE.md](./02-IMPLEMENTATION-GUIDE.md) - Follow step by step
4. [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md) - If using Microsoft Speech
5. [03-BLOB-STORAGE-SETUP.md](./03-BLOB-STORAGE-SETUP.md) - For blob storage setup

### For AI Agents

Start with [00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md) and read all docs sequentially. The documentation is designed to be comprehensive enough to implement the refactoring from scratch.

---

## Implementation Timeline

### Phase 1: Core Service + Progressive Preloading (Week 1)
- ✅ Android foreground service
- ✅ TTSPlaybackManager with expo-av
- ✅ Progressive preloading (fast startup + buffering)
- ✅ Retry logic and network error handling
- ✅ Cache management (LRU)
- ✅ WebViewReader integration

**Deliverable:** Working TTS with pause/resume, handles network switches

---

### Phase 2: Batch Downloads + Offline Support (Week 2)
- ✅ Azure Batch Synthesis API integration
- ✅ Download manager with background jobs
- ✅ Offline storage management
- ✅ Download UI (chapter list, management screen)
- ✅ Auto-download next chapter
- ✅ State persistence and restoration

**Deliverable:** Full offline capability for travel

---

### Phase 3: Polish + Testing (Days 13-14)
- ✅ Comprehensive testing (all scenarios)
- ✅ Settings UI updates
- ✅ Performance optimization
- ✅ Documentation updates
- ✅ User guide

**Deliverable:** Production-ready, documented system

---

## Prerequisites

### Development Environment
- Node.js >= 20
- Java SDK >= 17
- pnpm (package manager)
- Android SDK (minSdk: 24, targetSdk: 36)
- Expo CLI

### Dependencies to Add
```bash
pnpm add @azure/storage-blob  # For blob storage (optional)
# expo-av already present in project
```

### Azure Requirements (Optional - for Microsoft Speech)
- Speech Service resource
- Subscription key and region
- Azure Blob Storage (optional, for batch synthesis)
  - See [03-BLOB-STORAGE-SETUP.md](./03-BLOB-STORAGE-SETUP.md)

---

## Key Features

### 1. True Pause/Resume
- **Before:** `Speech.stop()` → re-speak from beginning
- **After:** `sound.pauseAsync()` → resume from exact position

### 2. Progressive Preloading
- Generate first 5 elements immediately (priority)
- Start playback as soon as first ready (~1-2 seconds)
- Background: Generate remaining elements
- During playback: Maintain 3-5 element buffer ahead

### 3. Network Resilience
- Retry logic with exponential backoff
- Automatic fallback from Microsoft Speech to Expo Speech
- LRU cache survives network switches
- Handles dead zones gracefully

### 4. Offline Batch Downloads
- Download entire chapters in advance
- Azure Batch Synthesis API (66% cost savings)
- Perfect for airplane mode, travel
- Auto-download next chapter while reading

### 5. Background Playback
- Android foreground service keeps app alive
- Continues playback when app is backgrounded
- Auto-sync WebView highlight on app resume

---

## Success Criteria

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

---

## Questions?

- **Architecture:** See [01-NEW-ARCHITECTURE.md](./01-NEW-ARCHITECTURE.md)
- **Implementation:** See [02-IMPLEMENTATION-GUIDE.md](./02-IMPLEMENTATION-GUIDE.md)
- **Azure/Blob:** See [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md)
- **Current system:** See [../TTS_DOCUMENTATION.md](../TTS_DOCUMENTATION.md)

---

## Status

**Current:** Planning Phase  
**Effort:** 80-100 hours (2 weeks full-time)  
**Target:** Production-ready TTS with all features

---

**Start:** Read [00-MIGRATION-OVERVIEW.md](./00-MIGRATION-OVERVIEW.md) →
