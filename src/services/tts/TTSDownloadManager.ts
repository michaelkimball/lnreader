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
  retryDownload,
  getPendingDownloads,
  getProcessingDownloads,
  getTTSDownloadById,
  deleteTTSDownload,
  getTTSDownload,
} from '@database/queries/TTSDownloadQueries';
import * as FileSystem from 'expo-file-system';
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
  private readonly MAX_RETRY_ATTEMPTS = 3;

  // Storage directory for downloaded audio files
  private readonly STORAGE_BASE_DIR = `${FileSystem.documentDirectory}tts-downloads/`;

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
      const dirInfo = await FileSystem.getInfoAsync(this.STORAGE_BASE_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(this.STORAGE_BASE_DIR, { intermediates: true });
        console.log('[TTSDownloadManager] Created storage directory:', this.STORAGE_BASE_DIR);
      }

      // Initialize Azure services
      azureBlobStorage.initialize();
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

    // Emit queue changed event
    this.emitQueueChanged();

    // Start processing queue if not already running
    if (!this.isProcessing) {
      this.processQueue();
    }

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
        await this.processSingleDownload(download);

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

      // Get chapter content (this will need to be passed from the caller or fetched)
      // For now, throw error if we don't have the content
      // TODO: Add mechanism to retrieve chapter text elements
      throw new Error('TODO: Implement chapter text retrieval');

      // The actual implementation would be:
      // 1. Get text elements from chapter
      // 2. Submit batch job
      // 3. Start polling
      
    } catch (error) {
      console.error('[TTSDownloadManager] Failed to process download:', error);
      await markDownloadFailed(download.id, error instanceof Error ? error.message : 'Unknown error');
      this.emit('downloadFailed', {
        type: 'downloadFailed',
        downloadId: download.id,
        chapterId: download.chapterId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
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

    console.log('[TTSDownloadManager] Job status:', { downloadId, jobId, status: status.status });

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
      const chapterDir = `${this.STORAGE_BASE_DIR}chapter_${download.chapterId}/`;
      await FileSystem.makeDirectoryAsync(chapterDir, { intermediates: true });

      // Download audio files
      const audioFiles = await azureBatchSynthesis.downloadResults(status, chapterDir);

      // Calculate total size
      let totalSizeMB = 0;
      for (const filePath of audioFiles) {
        const fileInfo = await FileSystem.getInfoAsync(filePath);
        if (fileInfo.exists && 'size' in fileInfo) {
          totalSizeMB += fileInfo.size / (1024 * 1024);
        }
      }

      // Update database
      await markDownloadCompleted(downloadId, chapterDir, audioFiles, Math.round(totalSizeMB * 100) / 100);

      // Cleanup Azure resources
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

    const errorMessage = status.error?.message || 'Batch job failed';
    
    // Check if we should retry
    if ((download.retryCount || 0) < this.MAX_RETRY_ATTEMPTS) {
      console.log('[TTSDownloadManager] Retrying download:', downloadId);
      await retryDownload(downloadId);
      
      // Cleanup failed job
      await azureBatchSynthesis.deleteJob(status.id);
      if (download.inputBlobFilename) {
        await azureBlobStorage.deleteFile(download.inputBlobFilename);
      }

      // Reprocess
      this.processQueue();
    } else {
      console.error('[TTSDownloadManager] Download failed after max retries:', downloadId);
      await markDownloadFailed(downloadId, `Max retries exceeded: ${errorMessage}`);
      
      this.emit('downloadFailed', {
        type: 'downloadFailed',
        downloadId,
        chapterId: download.chapterId,
        error: errorMessage,
      });

      // Cleanup
      await azureBatchSynthesis.deleteJob(status.id);
      if (download.inputBlobFilename) {
        await azureBlobStorage.deleteFile(download.inputBlobFilename);
      }

      this.emitQueueChanged();
      this.processQueue();
    }
  }

  /**
   * Resume processing downloads that were interrupted
   * Called during initialization
   */
  private async resumeProcessingDownloads(): Promise<void> {
    const processing = await getProcessingDownloads();
    
    for (const download of processing) {
      if (download.batchJobId) {
        console.log('[TTSDownloadManager] Resuming polling for download:', download.id);
        this.startPolling(download.id, download.batchJobId);
      }
    }

    // Also process any pending downloads
    if (processing.length < this.MAX_CONCURRENT_DOWNLOADS) {
      this.processQueue();
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
      await FileSystem.deleteAsync(download.storageDir, { idempotent: true });
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
      await FileSystem.deleteAsync(download.storageDir, { idempotent: true });
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
