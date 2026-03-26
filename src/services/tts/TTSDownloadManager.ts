/**
 * TTS Download Manager
 * 
 * Orchestrates offline TTS audio downloads using Azure Batch Synthesis API.
 * Manages download queue, polls job status, and coordinates storage.
 * 
 * Architecture:
 * 1. User requests chapter download
 * 2. Manager creates DB entry (pending)
 * 3. Submits SSML to Azure Blob Storage
 * 4. Submits batch job to Azure Batch Synthesis API
 * 5. Polls job status until completion
 * 6. Downloads audio files to local storage
 * 7. Updates DB with completed status
 * 8. Cleans up temporary Azure resources
 */

import { EventEmitter } from './EventEmitter';
import { azureBlobStorage } from './AzureBlobStorage';
import { azureBatchSynthesis, BatchJobStatus, VoiceSettings } from './AzureBatchSynthesisService';
import {
  createTTSDownload,
  updateBatchJobId,
  updateDownloadProgress,
  markDownloadCompleted,
  markDownloadFailed,
  markDownloadProcessing,
  retryDownload,
  getPendingDownloads,
  getProcessingDownloads,
  resetDownloadToPending,
  getTTSDownloadById,
  deleteTTSDownload,
  getTTSDownload,
} from '@database/queries/TTSDownloadQueries';
import { File, Directory, Paths } from 'expo-file-system';
import { TTSDownloadRow } from '@database/schema';

// Event types
export type DownloadEvent = 
  | { type: 'downloadStarted'; downloadId: number; chapterId: number }
  | { type: 'downloadProgress'; downloadId: number; progress: number; downloaded: number; total: number }
  | { type: 'downloadCompleted'; downloadId: number; chapterId: number }
  | { type: 'downloadFailed'; downloadId: number; chapterId: number; error: string }
  | { type: 'queueChanged'; pending: number; processing: number };

interface DownloadRequest {
  chapterId: number;
  novelId: number;
  textElements: string[];
  voiceSettings: VoiceSettings;
}

class TTSDownloadManager extends EventEmitter {
  private isProcessing: boolean = false;
  private pollingIntervals: Map<number, NodeJS.Timeout> = new Map();
  private readonly MAX_CONCURRENT_DOWNLOADS = 3; // Limit concurrent batch jobs
  private readonly POLL_INTERVAL_MS = 10000; // Poll every 10 seconds


  private storageDir(): Directory {
    return new Directory(Paths.document, 'tts-downloads');
  }

  private tempFile(downloadId: number): File {
    return new File(Paths.document, 'tts-downloads', `temp_${downloadId}.json`);
  }

  private chapterDir(chapterId: number): Directory {
    return new Directory(Paths.document, 'tts-downloads', `chapter_${chapterId}`);
  }

  constructor() {
    super();
  }

  /**
   * Initialize the download manager
   * Sets up storage directories and initializes Azure services
   */
  async initialize(): Promise<void> {
    try {
      // Ensure storage directory exists
      const dir = this.storageDir();
      if (!dir.exists) {
        dir.create();
        console.log('[TTSDownloadManager] Created storage directory');
      }

      // Initialize Azure services
      azureBatchSynthesis.initialize();

      // Resume any stuck processing downloads
      await this.resumeProcessingDownloads();

      console.log('[TTSDownloadManager] Initialized successfully');
    } catch (error) {
      console.error('[TTSDownloadManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Request download for a chapter
   * Creates DB entry and starts processing queue
   * 
   * @param request Download request with chapter info and voice settings
   * @returns Download ID
   */
  async requestDownload(request: DownloadRequest): Promise<number> {
    const { chapterId, novelId, textElements, voiceSettings } = request;

    console.log('[TTSDownloadManager] Requesting download:', { chapterId, elements: textElements.length });

    // Initialize Azure Batch Synthesis (reads current config from MMKV)
    azureBatchSynthesis.initialize();

    // Reset any stale processing rows so they don't block the queue
    await this.resetStaleProcessingDownloads();

    // Create database entry
    const downloadId = await createTTSDownload(
      novelId,
      chapterId,
      textElements.length,
      voiceSettings.voice,
      voiceSettings.rate?.toString() || '1.0',
      voiceSettings.pitch?.toString() || '1.0',
      'microsoft'
    );

    // Ensure storage directory exists and write temp file.
    // If this fails, clean up the DB entry so it doesn't become a stale pending row.
    try {
      const dir = this.storageDir();
      if (!dir.exists) {
        dir.create();
      }
      const tempFile = this.tempFile(downloadId);
      tempFile.write(JSON.stringify({ textElements, voiceSettings }));
    } catch (error) {
      await deleteTTSDownload(chapterId);
      throw error;
    }

    console.log('[TTSDownloadManager] Stored text elements for download:', downloadId);

    // Emit queue changed event
    this.emitQueueChanged();

    // Start processing queue (no-ops if already running)
    this.processQueue();

    return downloadId;
  }

  /**
   * Process the download queue
   * Picks up pending downloads and submits batch jobs
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (true) {
        // Get pending downloads
        const pending = await getPendingDownloads();
        
        if (pending.length === 0) {
          break;
        }

        // Check how many are currently processing
        const processing = await getProcessingDownloads();
        
        if (processing.length >= this.MAX_CONCURRENT_DOWNLOADS) {
          console.log('[TTSDownloadManager] Max concurrent downloads reached, waiting...');
          break;
        }

        // Process next pending download
        const download = pending[0];
        
        try {
          await this.processSingleDownload(download);
        } catch (error) {
          console.error('[TTSDownloadManager] Failed to process download, continuing with queue:', error);
          // Error already handled in processSingleDownload, just continue
        }

        // Small delay before next
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error('[TTSDownloadManager] Queue processing error:', error);
    } finally {
      this.isProcessing = false;
      this.emitQueueChanged();
    }
  }

  /**
   * Process a single download
   * Submits batch job and starts polling
   */
  private async processSingleDownload(download: TTSDownloadRow): Promise<void> {
    try {
      console.log('[TTSDownloadManager] Processing download:', download.id);

      // Mark as processing immediately to prevent stuck pending state
      await markDownloadProcessing(download.id);

      // Get text elements from temp file
      const tempFile = this.tempFile(download.id);

      if (!tempFile.exists) {
        throw new Error(`Temp file not found for download ${download.id}`);
      }

      const tempData = await tempFile.text();
      const { textElements, voiceSettings } = JSON.parse(tempData) as {
        textElements: string[];
        voiceSettings: VoiceSettings;
      };

      console.log('[TTSDownloadManager] Retrieved text elements:', textElements.length);

      // Submit batch job
      const jobId = await azureBatchSynthesis.submitJob(
        {
          inputs: textElements.map((text, index) => ({ text, id: `element_${index}` })),
          voiceSettings,
        },
        download.chapterId
      );

      // Update download with job ID
      await updateBatchJobId(download.id, jobId);

      console.log('[TTSDownloadManager] Submitted batch job:', jobId);

      // Start polling for this job
      this.startPolling(download.id, jobId);
      // Temp file is kept until job succeeds or retries are exhausted
      
    } catch (error) {
      console.error('[TTSDownloadManager] Failed to process download:', error);
      await markDownloadFailed(download.id, error instanceof Error ? error.message : 'Unknown error');
      
      // Clean up temp file on error
      const cleanupFile = this.tempFile(download.id);
      if (cleanupFile.exists) {
        cleanupFile.delete();
      }
      
      this.emit('downloadFailed', {
        type: 'downloadFailed',
        downloadId: download.id,
        chapterId: download.chapterId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Create SSML for batch synthesis
   */
  private createSSML(textElements: string[], voiceSettings: VoiceSettings): string {
    const { voice, rate = 1.0, pitch = 1.0 } = voiceSettings;
    
    // Convert rate/pitch to SSML format
    const ratePercent = `${Math.round(rate * 100)}%`;
    const pitchValue = pitch > 1 
      ? `+${Math.round((pitch - 1) * 50)}%` 
      : `-${Math.round((1 - pitch) * 50)}%`;

    // Build SSML with each element as a separate sentence
    const sentences = textElements
      .map(text => `<s>${this.escapeXml(text)}</s>`)
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <voice name="${voice}">
    <prosody rate="${ratePercent}" pitch="${pitchValue}">
      ${sentences}
    </prosody>
  </voice>
</speak>`;
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Submit batch job for download
   * Internal method called by processSingleDownload
   */
  private async submitBatchJob(
    downloadId: number,
    chapterId: number,
    textElements: string[],
    voiceSettings: VoiceSettings
  ): Promise<string> {
    // Submit to Azure Batch Synthesis
    const jobId = await azureBatchSynthesis.submitJob(
      {
        inputs: textElements.map((text, index) => ({ text, id: `element_${index}` })),
        voiceSettings,
      },
      chapterId
    );

    // Update database with job ID
    // Get the input filename from the batch service (we need to track this)
    const inputFilename = `chapter_${chapterId}_${Date.now()}.ssml`;
    await updateBatchJobId(downloadId, jobId, inputFilename);

    console.log('[TTSDownloadManager] Batch job submitted:', { downloadId, jobId });

    // Start polling
    this.startPolling(downloadId, jobId);

    // Emit started event
    this.emit('downloadStarted', {
      type: 'downloadStarted',
      downloadId,
      chapterId,
    });

    return jobId;
  }

  /**
   * Start polling a batch job status
   */
  private startPolling(downloadId: number, jobId: string): void {
    // Clear any existing polling for this download
    this.stopPolling(downloadId);

    const interval = setInterval(async () => {
      try {
        await this.pollJobStatus(downloadId, jobId);
      } catch (error) {
        console.error('[TTSDownloadManager] Polling error:', error);
        this.stopPolling(downloadId);
      }
    }, this.POLL_INTERVAL_MS);

    this.pollingIntervals.set(downloadId, interval);
  }

  /**
   * Stop polling a download
   */
  private stopPolling(downloadId: number): void {
    const interval = this.pollingIntervals.get(downloadId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(downloadId);
    }
  }

  /**
   * Poll job status and handle completion
   */
  private async pollJobStatus(downloadId: number, jobId: string): Promise<void> {
    const status = await azureBatchSynthesis.getJobStatus(jobId);

    console.log('[TTSDownloadManager] Job status:', JSON.stringify({ downloadId, jobId, status }));

    if (status.status === 'Succeeded') {
      this.stopPolling(downloadId);
      await this.handleJobSuccess(downloadId, status);
    } else if (status.status === 'Failed') {
      this.stopPolling(downloadId);
      await this.handleJobFailure(downloadId, status);
    }
    // If Running or NotStarted, keep polling
  }

  /**
   * Handle successful job completion
   */
  private async handleJobSuccess(downloadId: number, status: BatchJobStatus): Promise<void> {
    try {
      const download = await getTTSDownloadById(downloadId);
      if (!download) {
        throw new Error('Download not found');
      }

      // Create storage directory for this chapter
      const chapterDirectory = this.chapterDir(download.chapterId);
      chapterDirectory.create({ idempotent: true });
      const chapterDir = chapterDirectory.uri;

      // Download audio files
      const audioFiles = await azureBatchSynthesis.downloadResults(status, chapterDir);

      // Calculate total size
      let totalSizeMB = 0;
      for (const filePath of audioFiles) {
        const file = new File(filePath);
        if (file.exists) {
          totalSizeMB += file.size / (1024 * 1024);
        }
      }

      // Update database
      await markDownloadCompleted(downloadId, chapterDir, audioFiles, Math.round(totalSizeMB * 100) / 100);

      // Cleanup temp file and Azure resources
      const tempFile = this.tempFile(downloadId);
      if (tempFile.exists) {
        tempFile.delete();
      }
      if (download.inputBlobFilename) {
        await azureBlobStorage.deleteFile(download.inputBlobFilename);
      }
      await azureBatchSynthesis.deleteJob(status.id);

      console.log('[TTSDownloadManager] Download completed:', { downloadId, files: audioFiles.length, sizeMB: totalSizeMB });

      // Emit completed event
      this.emit('downloadCompleted', {
        type: 'downloadCompleted',
        downloadId,
        chapterId: download.chapterId,
      });

      // Continue processing queue
      this.emitQueueChanged();
      this.processQueue();

    } catch (error) {
      console.error('[TTSDownloadManager] Failed to handle job success:', error);
      await markDownloadFailed(downloadId, error instanceof Error ? error.message : 'Download failed');
      
      this.emit('downloadFailed', {
        type: 'downloadFailed',
        downloadId,
        chapterId: 0, // We'd need to get this from the download
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Handle job failure
   */
  private async handleJobFailure(downloadId: number, status: BatchJobStatus): Promise<void> {
    const download = await getTTSDownloadById(downloadId);
    if (!download) {
      return;
    }

    const errorMessage = status.properties?.error?.message || status.error?.message || 'Batch job failed';

    console.error('[TTSDownloadManager] Download failed:', { downloadId, error: errorMessage });
    await markDownloadFailed(downloadId, errorMessage);

    // Cleanup temp file and Azure resources
    const tempFile = this.tempFile(downloadId);
    if (tempFile.exists) {
      tempFile.delete();
    }
    await azureBatchSynthesis.deleteJob(status.id);

    this.emit('downloadFailed', {
      type: 'downloadFailed',
      downloadId,
      chapterId: download.chapterId,
      error: errorMessage,
    });

    this.emitQueueChanged();
    this.processQueue();
  }

  /**
   * Resume processing downloads that were interrupted
   * Called during initialization
   */
  private async resumeProcessingDownloads(): Promise<void> {
    await resetStaleProcessingDownloads();
    this.processQueue();
  }

  /**
   * Reset stale processing downloads, checking temp file existence.
   * Downloads with temp files are reset to pending (can retry).
   * Downloads without temp files are marked failed (data is gone).
   */
  private async resetStaleProcessingDownloads(): Promise<void> {
    const processing = await getProcessingDownloads();
    for (const download of processing) {
      const tempFile = this.tempFile(download.id);
      if (tempFile.exists) {
        await resetDownloadToPending(download.id);
      } else {
        await markDownloadFailed(download.id, 'Download data lost - please re-download');
      }
    }
  }

  /**
   * Cancel a download
   */
  async cancelDownload(chapterId: number): Promise<void> {
    const download = await getTTSDownload(chapterId);
    if (!download) {
      return;
    }

    // Stop polling
    this.stopPolling(download.id);

    // Cleanup Azure resources
    if (download.batchJobId) {
      await azureBatchSynthesis.deleteJob(download.batchJobId);
    }
    if (download.inputBlobFilename) {
      await azureBlobStorage.deleteFile(download.inputBlobFilename);
    }

    // Delete from database
    await deleteTTSDownload(chapterId);

    // Delete local files if they exist
    if (download.storageDir) {
      const dir = new Directory(download.storageDir);
      if (dir.exists) {
        dir.delete();
      }
    }

    console.log('[TTSDownloadManager] Download cancelled:', chapterId);
    this.emitQueueChanged();
  }

  /**
   * Delete a completed download
   */
  async deleteDownload(chapterId: number): Promise<void> {
    const download = await getTTSDownload(chapterId);
    if (!download) {
      return;
    }

    // Delete local files
    if (download.storageDir) {
      const dir = new Directory(download.storageDir);
      if (dir.exists) {
        dir.delete();
      }
    }

    // Delete from database
    await deleteTTSDownload(chapterId);

    console.log('[TTSDownloadManager] Download deleted:', chapterId);
    this.emitQueueChanged();
  }

  /**
   * Emit queue changed event
   */
  private async emitQueueChanged(): Promise<void> {
    const pending = await getPendingDownloads();
    const processing = await getProcessingDownloads();

    this.emit('queueChanged', {
      type: 'queueChanged',
      pending: pending.length,
      processing: processing.length,
    });
  }

  /**
   * Retry a failed download
   */
  async retryDownload(chapterId: number): Promise<void> {
    await retryDownload(chapterId);
    this.emitQueueChanged();
    await this.processQueue();
  }

  /**
   * Get download status
   */
  async getDownloadStatus(chapterId: number): Promise<TTSDownloadRow | null> {
    return getTTSDownload(chapterId);
  }

  /**
   * Cleanup old temporary files from Azure Blob Storage
   */
  async cleanupOldBlobs(olderThanDays: number = 7): Promise<void> {
    await azureBlobStorage.cleanupOldFiles(olderThanDays);
  }

  /**
   * Stop all polling and cleanup
   */
  shutdown(): void {
    // Stop all polling
    for (const [downloadId, interval] of this.pollingIntervals.entries()) {
      clearInterval(interval);
    }
    this.pollingIntervals.clear();
    
    this.isProcessing = false;
    console.log('[TTSDownloadManager] Shutdown complete');
  }
}

// Singleton instance
export const ttsDownloadManager = new TTSDownloadManager();
