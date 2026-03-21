# Phase 2 TTS Migration - Implementation Status

**Date**: March 21, 2026  
**Current Status**: Infrastructure Complete, Integration Pending  
**Completion**: ~80% of core implementation done

---

## Overview

Phase 2 adds offline TTS audio download capability using Azure Batch Synthesis API. This enables users to pre-download entire chapters/novels for offline playback at 66% cost savings ($4/1M chars vs $15/1M).

---

## ✅ Completed Components

### 1. Azure Blob Storage Service (`src/services/tts/AzureBlobStorage.ts`)
**Purpose**: Upload SSML input files to Azure Blob Storage for Batch Synthesis API

**Features**:
- ✅ Upload SSML documents to blob storage
- ✅ Generate SAS URLs for time-limited access
- ✅ Delete temporary files after batch jobs complete
- ✅ Cleanup old blobs (7+ days)
- ✅ List and check file existence

**Configuration**:
- Requires: `azureBlobStorage` in `IntegrationSettings` (MMKV)
- Fields: `accountName`, `accountKey`, `containerName`, `enabled`

### 2. Azure Batch Synthesis Service (`src/services/tts/AzureBatchSynthesisService.ts`)
**Purpose**: Submit bulk TTS generation jobs to Azure Batch Synthesis API

**Features**:
- ✅ Create SSML batch documents with voice settings
- ✅ Submit batch synthesis jobs
- ✅ Poll job status until completion
- ✅ Download generated audio files
- ✅ Delete completed jobs
- ✅ List all jobs for management

**API Details**:
- Endpoint: `https://{region}.api.cognitive.microsoft.com/speechtotext/v3.1-preview1/batchsynthesis`
- Authentication: Same Azure Speech subscription key as real-time TTS
- Input: SSML file hosted on public URL (Azure Blob Storage)
- Output: MP3 audio files (one per text element)

### 3. TTSDownload Database Schema (`src/database/schema/ttsDownload.ts`)
**Purpose**: Track download status and metadata

**Table Structure**:
```typescript
{
  id: integer (primary key)
  chapterId: integer (unique)
  novelId: integer
  batchJobId: text // Azure job ID
  status: 'pending' | 'processing' | 'completed' | 'failed'
  totalElements: integer
  downloadedElements: integer
  storageDir: text // Local path where audio files stored
  audioFilesPaths: text // JSON array of file paths
  voiceName: text
  voiceRate: text
  voicePitch: text
  engine: text
  createdAt: text
  startedAt: text
  completedAt: text
  totalSizeMB: integer
  errorMessage: text
  retryCount: integer
  inputBlobFilename: text // For cleanup
}
```

**Indexes**:
- Unique on `chapterId`
- Index on `novelId`, `status`, and composite `(novelId, status)`

### 4. Download Queries (`src/database/queries/TTSDownloadQueries.ts`)
**Purpose**: Database operations for downloads

**Operations**:
- ✅ Create download entry
- ✅ Update batch job ID and status
- ✅ Update progress
- ✅ Mark completed/failed
- ✅ Retry failed downloads
- ✅ Delete downloads
- ✅ Query by chapter, novel, status
- ✅ Get statistics (pending, processing, completed counts)
- ✅ Get audio file paths for playback
- ✅ Check if chapter has completed download

### 5. TTSDownloadManager (`src/services/tts/TTSDownloadManager.ts`)
**Purpose**: Orchestrate download queue and coordinate all services

**Features**:
- ✅ Download queue management
- ✅ Concurrent download limiting (max 3)
- ✅ Batch job submission
- ✅ Job status polling (every 10 seconds)
- ✅ Audio file download to local storage
- ✅ Progress tracking and events
- ✅ Retry logic (max 3 attempts)
- ✅ Cleanup of Azure resources (blobs, jobs)
- ✅ Resume interrupted downloads on app restart

**Events Emitted**:
```typescript
- downloadStarted: { downloadId, chapterId }
- downloadProgress: { downloadId, progress, downloaded, total }
- downloadCompleted: { downloadId, chapterId }
- downloadFailed: { downloadId, chapterId, error }
- queueChanged: { pending, processing }
```

**Storage Location**: `${FileSystem.documentDirectory}tts-downloads/chapter_{chapterId}/`

### 6. Downloads UI Screen (`src/screens/more/TTSDownloadsScreen.tsx`)
**Purpose**: View and manage TTS downloads

**Features**:
- ✅ List all downloads (pending, processing, completed, failed)
- ✅ Show download status and progress
- ✅ Display statistics (total downloads, size)
- ✅ Delete completed downloads
- ✅ Cancel pending/processing downloads
- ✅ Real-time updates via event listeners

**TODO**:
- Display actual chapter names (currently shows Chapter ID)
- Add retry button for failed downloads
- Add bulk delete/cancel actions
- Navigate to chapter when tapping download

### 7. Integration Settings (`src/screens/settings/SettingsIntegrationsScreen.tsx`)
**Purpose**: Configure Azure credentials

**Settings Added**:
- ✅ Azure Blob Storage section
  - Account Name
  - Account Key (secure entry)
  - Container Name (default: tts-inputs)
  - Enable/disable toggle
  - Help modal with setup instructions

**Settings Schema** (`src/hooks/persisted/useSettings.ts`):
```typescript
interface IntegrationSettings {
  microsoftSpeech?: {
    subscriptionKey?: string;
    region?: string;
    enabled?: boolean;
  };
  azureBlobStorage?: {      // NEW
    accountName?: string;
    accountKey?: string;
    containerName?: string;
    enabled?: boolean;
  };
}
```

### 8. Integration Hooks in TTSPlaybackManager (`src/services/tts/TTSPlaybackManager.ts`)
- ✅ Import download queries
- ✅ TODO comments marking integration points
- ✅ Method stub for checking offline audio availability

**Integration Point**:
```typescript
// In play() method, before starting preloader:
// TODO: Phase 2 - Check for offline downloaded audio
// const hasOfflineAudio = await hasCompletedDownload(chapterId);
// if (hasOfflineAudio) {
//   const audioFiles = await getAudioFilePaths(chapterId);
//   if (audioFiles && audioFiles.length === textElements.length) {
//     return this.playFromOfflineFiles(audioFiles, startIndex);
//   }
// }
```

---

## ❌ Missing / TODO Components

### 1. Database Migration (REQUIRED)
**Status**: Schema created but migration not generated  
**Action Required**:
```bash
pnpm run generate:db-migration
```

This will create a migration file in `drizzle/` for the `TTSDownload` table.

### 2. Download Request Integration (HIGH PRIORITY)
**Missing**: Mechanism to request chapter downloads from UI

**Required Changes**:
- Add download button to chapter list/detail screens
- Implement text extraction from chapter HTML
- Pass text elements to `ttsDownloadManager.requestDownload()`

**Example Integration**:
```typescript
// In chapter screen
const handleDownloadChapter = async () => {
  // 1. Get chapter content
  const chapterText = await fetchChapterContent(chapter.path);
  
  // 2. Parse into text elements (same as WebView TTS does)
  const textElements = parseChapterIntoElements(chapterText);
  
  // 3. Get current voice settings
  const voiceSettings = {
    voice: ttsSettings.voice,
    rate: ttsSettings.rate,
    pitch: ttsSettings.pitch,
  };
  
  // 4. Request download
  const downloadId = await ttsDownloadManager.requestDownload({
    chapterId: chapter.id,
    novelId: novel.id,
    textElements,
    voiceSettings,
  });
  
  showToast('Download started');
};
```

### 3. Offline Playback Integration (HIGH PRIORITY)
**Missing**: Logic to play from downloaded files instead of generating on-demand

**Required Implementation**:
Create method in `TTSPlaybackManager.ts`:
```typescript
async playFromOfflineFiles(
  audioFilePaths: string[],
  startIndex: number
): Promise<void> {
  // 1. Skip preloader entirely
  // 2. Build queue from local file URIs
  // 3. Load and play audio from expo-av
  // 4. Handle next/previous between local files
  
  this.queue = audioFilePaths.map((path, index) => ({
    index,
    text: '', // Not needed for offline
    status: 'ready',
    uri: path, // Local file URI
  }));
  
  this.currentIndex = startIndex;
  await this.playCurrentElement(); // Modified to support local URIs
}
```

**Challenges**:
- Current architecture assumes all audio generated via preloader
- Need to handle local file URIs in `playCurrentElement()`
- Progress tracking differs (no generation time, just playback)
- Cache management (downloaded files vs LRU cache)

### 4. Chapter Text Extraction (REQUIRED)
**Missing**: Helper to convert chapter HTML to text elements array

**Current State**: WebView's `core.js` does this in JavaScript  
**Needed**: React Native equivalent to extract readable elements

**Approach**:
- Option A: Reuse WebView extraction (inject JS, get results)
- Option B: Port `core.js` logic to TypeScript
- Option C: Simple regex-based extraction (less accurate)

**Recommended**: Option A (reuse existing logic)
```typescript
// Utility function
async function extractChapterElements(
  chapterHtml: string,
  webViewRef: React.RefObject<WebView>
): Promise<string[]> {
  return new Promise((resolve) => {
    // Inject temporary script to extract elements
    webViewRef.current?.injectJavaScript(`
      (function() {
        const html = ${JSON.stringify(chapterHtml)};
        document.body.innerHTML = html;
        
        // Reuse existing TTS extraction logic
        const elements = tts.extractReadableElements();
        const texts = elements.map(el => el.innerText);
        
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'extracted-elements',
          elements: texts
        }));
      })();
    `);
    
    // Listen for result
    // ... resolve when received
  });
}
```

### 5. Navigation to Downloads Screen (LOW PRIORITY)
**Missing**: Add link to TTS Downloads screen in app navigation

**Required Changes**:
- Add to More screen menu (like existing Downloads)
- Update navigator types
- Add route in stack navigator

**Implementation**:
```typescript
// In MoreScreen.tsx
<List.Item
  title="TTS Downloads"
  description="Manage offline TTS audio"
  icon="download-circle-outline"
  onPress={() => navigation.navigate('TTSDownloads')}
  theme={theme}
/>
```

### 6. Auto-Download Next Chapter (NICE TO HAVE)
**Missing**: Intelligent prefetching during playback

**Desired Behavior**:
- When user is 80% through current chapter
- Check if next chapter exists
- If yes, auto-download in background
- Respect settings (WiFi-only, storage limits)

**Implementation Sketch**:
```typescript
// In TTSPlaybackManager or WebViewReader
const handleProgressUpdate = (current: number, total: number) => {
  const progress = current / total;
  
  if (progress > 0.8 && !hasStartedPrefetch) {
    hasStartedPrefetch = true;
    
    // Get next chapter
    const nextChapter = await getNextChapter(chapterId);
    if (nextChapter) {
      // Check settings
      const settings = getDownloadSettings();
      if (settings.autoDownloadNext && settings.allowCellular || isWifi) {
        // Start download
        await ttsDownloadManager.requestDownload({
          chapterId: nextChapter.id,
          novelId: novelId,
          textElements: await extractChapterElements(nextChapter),
          voiceSettings: currentVoiceSettings,
        });
      }
    }
  }
};
```

### 7. Download Settings (NICE TO HAVE)
**Missing**: User preferences for download behavior

**Desirable Settings**:
- Auto-download next chapter (on/off)
- WiFi-only downloads (on/off)
- Max storage quota (MB)
- Delete old downloads automatically (days)
- Concurrent download limit

### 8. Error Handling & Edge Cases
**Missing**: Robust error handling for various scenarios

**Cases to Handle**:
- Network interruption during download
- Insufficient storage space
- Azure quota limits exceeded
- Voice settings mismatch (different voice than downloaded)
- Chapter updated after download (content changed)
- App force-closed during download

### 9. Package Dependencies
**Required**: Add Azure SDK to package.json

**Installation**:
```bash
pnpm add @azure/storage-blob
```

**Current Status**: NOT INSTALLED YET

---

## 🧪 Testing Checklist

### Setup Testing
- [ ] Install @azure/storage-blob package
- [ ] Generate database migration
- [ ] Apply migration to database
- [ ] Create Azure Storage Account
- [ ] Create blob container ("tts-inputs")
- [ ] Configure credentials in Settings > Integrations
- [ ] Validate blob storage connection

### Download Flow Testing
- [ ] Request chapter download
- [ ] Verify batch job submitted to Azure
- [ ] Monitor job status polling
- [ ] Check audio files downloaded to local storage
- [ ] Verify database updated with completed status
- [ ] Confirm Azure resources cleaned up (blob, job)

### Offline Playback Testing
- [ ] Download chapter
- [ ] Enable airplane mode
- [ ] Play chapter from offline audio
- [ ] Verify all elements play correctly
- [ ] Test pause/resume
- [ ] Test seek/skip
- [ ] Test background playback

### UI Testing
- [ ] View TTS Downloads screen
- [ ] See pending/processing/completed downloads
- [ ] Cancel a download
- [ ] Delete a download
- [ ] Retry a failed download
- [ ] Navigate to chapter from download

### Edge Cases
- [ ] Download fails - verify retry logic
- [ ] Download fails after max retries - verify error state
- [ ] App closed during download - verify resume on restart
- [ ] Network switches during download
- [ ] Insufficient storage space
- [ ] Voice settings changed after download

---

## 📋 Implementation Priority

### Critical Path (Must Do Before Testing):
1. **Install dependencies**: `pnpm add @azure/storage-blob`
2. **Generate migration**: `pnpm run generate:db-migration`
3. **Azure setup**: Create Storage Account and container
4. **Text extraction**: Implement chapter element extraction
5. **Download button**: Add UI to trigger downloads
6. **Offline playback**: Implement `playFromOfflineFiles()` method

### High Priority (Core Features):
7. Update Downloads screen with chapter names
8. Add navigation link to Downloads screen
9. Handle download errors gracefully
10. Test end-to-end flow

### Medium Priority (Polish):
11. Auto-download next chapter
12. Download settings/preferences
13. Bulk operations (delete all, cancel all)
14. Storage quota management

### Low Priority (Nice to Have):
15. Download progress notifications
16. Download history/statistics
17. Voice change detection (redownload if changed)
18. Batch download entire novel

---

## 💾 Storage Estimates

**Per Chapter** (assuming 10,000 words, ~50 elements):
- Azure Blob Storage (temporary): ~50KB SSML file (~2 hours retention) = negligible
- Local Storage: ~50 MP3 files × ~100KB each = ~5MB per chapter
- Database: ~1KB metadata per chapter

**For 100 Chapters**:
- Azure Blob: < $0.01/month (temporary files deleted)
- Local Storage: ~500MB
- Database: ~100KB

**Batch Synthesis Cost**:
- 100 chapters @ 10,000 words = ~1M characters
- Real-time API: $15
- Batch API: $4
- **Savings: $11 (73%)**

---

## 🔄 Migration from Phase 1

**Phase 1 (Current - Real-time TTS)**:
- Works: ✅
- Preserved: ✅
- Default behavior: Generate on-demand

**Phase 2 (With Downloads)**:
- Checks for offline audio first
- Falls back to Phase 1 if no download
- User can mix:
  - Some chapters downloaded (offline)
  - Some chapters on-demand (Phase 1)
- Seamless transition between modes

**No Breaking Changes**: Phase 1 functionality remains intact.

---

## 📚 Documentation Reference

- **Architecture**: `docs/tts-migration/01-NEW-ARCHITECTURE.md`
- **Implementation Guide**: `docs/tts-migration/02-IMPLEMENTATION-GUIDE.md`
- **Azure Batch API**: `docs/tts-migration/03-AZURE-BATCH-SYNTHESIS.md`
- **Blob Storage Setup**: `docs/tts-migration/03-BLOB-STORAGE-SETUP.md`
- **Phase 1 Findings**: `/memories/repo/tts-migration-findings.md`

---

## 🎯 Next Steps

**Immediate**:
1. Install `@azure/storage-blob` package
2. Generate and apply database migration
3. Set up Azure Storage Account
4. Test Blob Storage service (upload/download)
5. Test Batch Synthesis service (submit job, poll, download)

**Short Term**:
6. Implement chapter text extraction
7. Add download button to UI
8. Implement offline playback method
9. End-to-end testing

**Future**:
10. Auto-download feature
11. Download management features
12. Performance optimization
13. User documentation

**Questions/Blockers**:
- None currently identified
- All required infrastructure is in place
- Main work is integration and testing

---

**Status Summary**: Phase 2 infrastructure is 80% complete. Core services, database, and UI built. Missing: Download trigger, text extraction, offline playback integration, and testing. Estimated remaining effort: 8-12 hours.
