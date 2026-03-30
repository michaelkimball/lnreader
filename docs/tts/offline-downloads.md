# TTS Offline Downloads

**Files:** `src/services/tts/TTSDownloadManager.ts`, `src/services/tts/AzureBatchSynthesisService.ts`, `src/services/tts/AzureBlobStorage.ts`, `src/database/schema/ttsDownload.ts`, `src/screens/more/TTSDownloadsScreen.tsx`
**Last Updated:** March 30, 2026

---

## Overview

Offline downloads let users pre-generate TTS audio for entire chapters using Azure's Batch Synthesis API. Benefits:

- **66% cost savings**: $4/1M chars (batch) vs $15/1M chars (real-time)
- **Offline playback**: No internet required once downloaded
- **Single MP3 per chapter**: One file with sentence-boundary offsets for element seeking

---

## End-to-End Flow

```
User requests chapter download
  ↓
TTSDownloadManager.downloadChapter(chapterId, novelId)
  ↓
1. Extract text elements from chapter HTML
   (uses extractTextElementsFromHtml utility)
  ↓
2. Build SSML document with all elements + sentence-boundary requests
  ↓
3. AzureBlobStorage.uploadSSML(ssml, filename)
   → Returns public HTTPS URL to the SSML file
  ↓
4. AzureBatchSynthesisService.submitJob(ssmlUrl, voice, region)
   → Returns batchJobId
  ↓
5. DB: Insert ttsDownload row (status: 'pending' → 'processing')
  ↓
6. Poll Azure API every 10 seconds until status = 'Succeeded' or 'Failed'
   AzureBatchSynthesisService.getJobStatus(jobId)
  ↓
7. Download output MP3 + sentence boundaries JSON to local storage
   Storage: {FileSystem.documentDirectory}tts-downloads/chapter_{chapterId}/
  ↓
8. Parse sentence boundaries → build elementOffsets[] array
  ↓
9. DB: Update row (status: 'completed', audioFilesPaths, storageDir, element offsets)
  ↓
10. AzureBlobStorage.deleteBlob(filename)     // Cleanup SSML input
    AzureBatchSynthesisService.deleteJob(jobId) // Cleanup job
```

---

## Azure Batch Synthesis API

**File:** `src/services/tts/AzureBatchSynthesisService.ts`

### Endpoint

```
https://{region}.api.cognitive.microsoft.com/speechtotext/v3.1-preview1/batchsynthesis
```

Authentication: `Ocp-Apim-Subscription-Key` header (same key as real-time API).

### Job Lifecycle

```typescript
// Submit job
const jobId = await azureBatchSynthesis.submitJob({
  ssmlUrl: string,       // Public URL to SSML blob
  voice: string,         // e.g. 'en-US-JennyNeural'
  outputFormat: 'audio-16khz-128kbitrate-mono-mp3',
  region: string,
});

// Poll
const status: BatchJobStatus = await azureBatchSynthesis.getJobStatus(jobId);
// status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed'

// Download outputs (when Succeeded)
const outputs = await azureBatchSynthesis.downloadOutputs(jobId);
// outputs: { audioPath: string, sentenceBoundariesPath: string }

// Cleanup
await azureBatchSynthesis.deleteJob(jobId);
```

### VoiceSettings for Batch

```typescript
interface VoiceSettings {
  voice: string;
  pitch?: number;
  rate?: number;
}
```

### SentenceBoundary

```typescript
interface SentenceBoundary {
  audioOffset: number;   // Offset in 100-nanosecond units (divide by 10000 for ms)
  duration: number;
  text: string;
  wordLength: number;
}
```

`elementsOffsets[]` (stored in DB) is constructed by mapping each text element to its boundary's `audioOffset / 10000` (converted to ms).

---

## Azure Blob Storage

**File:** `src/services/tts/AzureBlobStorage.ts`

Required because the Batch Synthesis API needs a **publicly accessible HTTPS URL** for the input SSML file. Azure Blob Storage is used for this.

### Configuration (MMKV `INTEGRATION_SETTINGS`)

```typescript
azureBlobStorage: {
  enabled: boolean;
  accountName: string;      // e.g., 'lnreadertts'
  accountKey: string;       // Storage account access key
  containerName: string;    // e.g., 'tts-inputs'
}
```

### Key Methods

```typescript
// Upload SSML and get public URL
const url = await azureBlobStorage.uploadSSML(ssml: string, filename: string): Promise<string>

// Delete blob after job completes (cost/privacy)
await azureBlobStorage.deleteBlob(filename: string): Promise<void>

// Cleanup blobs older than 7 days
await azureBlobStorage.cleanupOldBlobs(): Promise<void>
```

### Cost

Azure Blob Storage costs ~$0.02/GB/month + $0.001/10k operations. For typical use (temporary SSML files deleted after batch jobs), this is well under $1/month.

---

## TTSDownloadManager

**File:** `src/services/tts/TTSDownloadManager.ts`
**Type:** Singleton exported as `ttsDownloadManager`

### Configuration

| Constant | Value |
|---|---|
| `MAX_CONCURRENT_DOWNLOADS` | 3 |
| `POLL_INTERVAL_MS` | 10,000 (10 seconds) |
| Max retry attempts | 3 |

### Storage Layout

```
{FileSystem.documentDirectory}/
  tts-downloads/
    chapter_{chapterId}/
      audio.mp3          ← Full chapter audio
      boundaries.json    ← Sentence boundary data
    temp_{downloadId}.json  ← Temporary polling state
```

### Events Emitted

```typescript
type DownloadEvent =
  | { type: 'downloadStarted';   downloadId: number; chapterId: number }
  | { type: 'downloadProgress';  downloadId: number; progress: number; downloaded: number; total: number }
  | { type: 'downloadCompleted'; downloadId: number; chapterId: number }
  | { type: 'downloadFailed';    downloadId: number; chapterId: number; error: string }
  | { type: 'queueChanged';      pending: number; processing: number };
```

### Resume on App Restart

On `TTSDownloadManager` initialization, it calls `resumeInterruptedDownloads()`:
- Fetches all rows with `status = 'processing'` from DB
- Re-starts polling for any active batch jobs

### Key Public Methods

```typescript
downloadChapter(chapterId: number, novelId: number): Promise<void>
cancelDownload(downloadId: number): Promise<void>
deleteDownload(downloadId: number): Promise<void>
getDownloadStatus(chapterId: number): Promise<TTSDownloadRow | null>
resumeInterruptedDownloads(): Promise<void>
```

---

## Database Schema

**File:** `src/database/schema/ttsDownload.ts`

```typescript
ttsDownload: {
  id: integer (auto PK)
  chapterId: integer (unique)
  novelId: integer
  batchJobId: text           // Azure job ID, null until submitted
  status: text               // 'pending' | 'processing' | 'completed' | 'failed'
  totalElements: integer
  downloadedElements: integer
  storageDir: text           // Local directory path
  audioFilesPaths: text      // JSON array of local file paths
  voiceName: text
  voiceRate: text
  voicePitch: text
  engine: text               // 'microsoft' (batch only supports Microsoft)
  createdAt: text
  startedAt: text
  completedAt: text
  totalSizeMB: integer
  errorMessage: text
  retryCount: integer
  inputBlobFilename: text    // For blob cleanup after job completes
}
```

**Indexes:** unique on `chapterId`; indexes on `novelId`, `status`, `(novelId, status)`.

### DB Queries

**File:** `src/database/queries/TTSDownloadQueries.ts`

Key query functions:

| Function | Purpose |
|---|---|
| `createTTSDownload(row)` | Insert new download entry |
| `updateBatchJobId(id, jobId)` | After job submission |
| `updateDownloadProgress(id, downloaded, total)` | During polling |
| `markDownloadCompleted(id, paths, offsets)` | Job succeeded |
| `markDownloadFailed(id, error)` | Job failed |
| `retryDownload(id)` | Increment retryCount, reset to pending |
| `getPendingDownloads()` | For queue processing |
| `getProcessingDownloads()` | For resume on restart |
| `hasCompletedDownload(chapterId)` | Check before playback |
| `getAudioFilePaths(chapterId)` | Get local paths for playback |
| `getElementOffsets(chapterId)` | Get ms offsets for seeking |
| `getTTSDownload(chapterId)` | Full row by chapterId |
| `deleteTTSDownload(id)` | Remove row + files |

---

## Downloads UI Screen

**File:** `src/screens/more/TTSDownloadsScreen.tsx`

Features:
- Lists all downloads grouped by status (pending, processing, completed, failed)
- Real-time updates via `ttsDownloadManager.on('downloadProgress', ...)` listener
- Statistics: total downloads, total size
- Actions: delete completed, cancel pending/processing
- Chapter ID is shown (chapter name display is a known TODO)

**Known TODOs:**
- Display actual chapter name (currently shows chapter ID)
- Add retry button for failed downloads
- Bulk delete/cancel actions
- Navigate to chapter on tap

---

## Offline Playback Integration

When `WebViewReader` starts TTS for a chapter, `TTSPlaybackManager.play()` checks:

```typescript
const hasDownload = await hasCompletedDownload(chapterId);
if (hasDownload) {
  const [audioPath] = await getAudioFilePaths(chapterId);
  const offsets = await getElementOffsets(chapterId);
  await this.playOffline(audioPath, offsets, chapterId);
} else {
  // Normal online per-element playback
}
```

In offline mode, `this.isOfflineMode = true` and seeking uses:
```typescript
const positionMs = this.elementOffsets[index];
await this.currentSound.setPositionAsync(positionMs);
```
