/**
 * TTS Download Queries
 * 
 * Database operations for managing offline TTS audio downloads
 * using Azure Batch Synthesis API.
 */

import {
  eq,
  and,
  inArray,
  desc,
  count,
  sql,
  or,
} from 'drizzle-orm';
import { Directory } from 'expo-file-system';
import { dbManager } from '@database/db';
import { ttsDownloadSchema } from '@database/schema';
import type { TTSDownloadRow, TTSDownloadInsert } from '@database/schema';

// #region Types

export type DownloadStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface TTSDownloadWithProgress {
  id: number;
  chapterId: number;
  novelId: number;
  status: DownloadStatus;
  progress: number; // 0-100 percentage
  totalElements: number;
  downloadedElements: number;
  totalSizeMB: number;
  createdAt: string;
  completedAt?: string | null;
  errorMessage?: string | null;
}

// #endregion

// #region Mutations

/**
 * Update download status to processing
 */
export const markDownloadProcessing = async (downloadId: number): Promise<void> => {
  await dbManager.write(async tx => {
    tx.update(ttsDownloadSchema)
      .set({
        status: 'processing',
        startedAt: new Date().toISOString(),
      })
      .where(eq(ttsDownloadSchema.id, downloadId))
      .run();
  });
};

/**
 * Start a new download for a chapter
 */
export const createTTSDownload = async (
  novelId: number,
  chapterId: number,
  totalElements: number,
  voiceName: string,
  voiceRate: string = '1.0',
  voicePitch: string = '1.0',
  engine: string = 'microsoft'
): Promise<number> => {
  const result = await dbManager.write(async tx => {
    return tx
      .insert(ttsDownloadSchema)
      .values({
        novelId,
        chapterId,
        totalElements,
        voiceName,
        voiceRate,
        voicePitch,
        engine,
        status: 'pending',
        createdAt: new Date().toISOString(),
        retryCount: 0,
      })
      . onConflictDoUpdate({
        target: [ttsDownloadSchema.chapterId],
        set: {
          status: 'pending',
          totalElements,
          voiceName,
          voiceRate,
          voicePitch,
          engine,
          createdAt: new Date().toISOString(),
          errorMessage: null,
          retryCount: 0,
        },
      })
      .returning({ id: ttsDownloadSchema.id })
      .get();
  });

  return result.id;
};

/**
 * Update download with batch job ID and set status to processing
 */
export const updateBatchJobId = async (
  downloadId: number,
  batchJobId: string,
  inputBlobFilename: string
): Promise<void> => {
  await dbManager.write(async tx => {
    tx.update(ttsDownloadSchema)
      .set({
        batchJobId,
        inputBlobFilename,
        status: 'processing',
        startedAt: new Date().toISOString(),
      })
      .where(eq(ttsDownloadSchema.id, downloadId))
      .run();
  });
};

/**
 * Update download progress
 */
export const updateDownloadProgress = async (
  downloadId: number,
  downloadedElements: number
): Promise<void> => {
  await dbManager.write(async tx => {
    tx.update(ttsDownloadSchema)
      .set({ downloadedElements })
      .where(eq(ttsDownloadSchema.id, downloadId))
      .run();
  });
};

/**
 * Mark download as completed
 */
export const markDownloadCompleted = async (
  downloadId: number,
  storageDir: string,
  audioFilesPaths: string[],
  totalSizeMB: number,
  elementOffsets?: number[]
): Promise<void> => {
  await dbManager.write(async tx => {
    tx.update(ttsDownloadSchema)
      .set({
        status: 'completed',
        storageDir,
        audioFilesPaths: JSON.stringify(audioFilesPaths),
        downloadedElements: audioFilesPaths.length,
        totalSizeMB,
        completedAt: new Date().toISOString(),
        elementOffsets: elementOffsets ? JSON.stringify(elementOffsets) : null,
      })
      .where(eq(ttsDownloadSchema.id, downloadId))
      .run();
  });
};

/**
 * Mark download as failed
 */
export const markDownloadFailed = async (
  downloadId: number,
  errorMessage: string
): Promise<void> => {
  await dbManager.write(async tx => {
    const download = tx
      .select({ retryCount: ttsDownloadSchema.retryCount })
      .from(ttsDownloadSchema)
      .where(eq(ttsDownloadSchema.id, downloadId))
      .get();

    tx.update(ttsDownloadSchema)
      .set({
        status: 'failed',
        errorMessage,
        retryCount: (download?.retryCount || 0) + 1,
      })
      .where(eq(ttsDownloadSchema.id, downloadId))
      .run();
  });
};

/**
 * Retry a failed download
 */
export const retryDownload = async (downloadId: number): Promise<void> => {
  await dbManager.write(async tx => {
    const download = tx
      .select({ retryCount: ttsDownloadSchema.retryCount })
      .from(ttsDownloadSchema)
      .where(eq(ttsDownloadSchema.id, downloadId))
      .get();

    tx.update(ttsDownloadSchema)
      .set({
        status: 'pending',
        errorMessage: null,
        batchJobId: null,
        inputBlobFilename: null,
        retryCount: (download?.retryCount || 0) + 1,
      })
      .where(eq(ttsDownloadSchema.id, downloadId))
      .run();
  });
};

/**
 * Delete a download and its audio files
 */
export const deleteTTSDownload = async (chapterId: number): Promise<TTSDownloadRow | null> => {
  // First get the download to access file paths for cleanup
  const download = await dbManager
    .select()
    .from(ttsDownloadSchema)
    .where(eq(ttsDownloadSchema.chapterId, chapterId))
    .get();

  if (!download) {
    return null;
  }

  // Delete from database
  await dbManager.write(async tx => {
    tx.delete(ttsDownloadSchema)
      .where(eq(ttsDownloadSchema.chapterId, chapterId))
      .run();
  });

  return download;
};

/**
 * Delete multiple downloads by chapter IDs
 */
export const deleteTTSDownloads = async (chapterIds: number[]): Promise<TTSDownloadRow[]> => {
  // Get downloads for cleanup
  const downloads = await dbManager
    .select()
    .from(ttsDownloadSchema)
    .where(inArray(ttsDownloadSchema.chapterId, chapterIds))
    .all();

  // Delete from database
  await dbManager.write(async tx => {
    tx.delete(ttsDownloadSchema)
      .where(inArray(ttsDownloadSchema.chapterId, chapterIds))
      .run();
  });

  return downloads;
};

// #endregion

// #region Queries

/**
 * Get download by chapter ID
 */
export const getTTSDownload = async (chapterId: number): Promise<TTSDownloadRow | null> => {
  return dbManager
    .select()
    .from(ttsDownloadSchema)
    .where(eq(ttsDownloadSchema.chapterId, chapterId))
    .get();
};

/**
 * Get download by ID
 */
export const getTTSDownloadById = async (downloadId: number): Promise<TTSDownloadRow | null> => {
  return dbManager
    .select()
    .from(ttsDownloadSchema)
    .where(eq(ttsDownloadSchema.id, downloadId))
    .get();
};

/**
 * Get all downloads for a novel
 */
export const getTTSDownloadsByNovel = async (novelId: number): Promise<TTSDownloadRow[]> => {
  return dbManager
    .select()
    .from(ttsDownloadSchema)
    .where(eq(ttsDownloadSchema.novelId, novelId))
    .orderBy(desc(ttsDownloadSchema.createdAt))
    .all();
};

/**
 * Get downloads by status
 */
export const getTTSDownloadsByStatus = async (status: DownloadStatus): Promise<TTSDownloadRow[]> => {
  return dbManager
    .select()
    .from(ttsDownloadSchema)
    .where(eq(ttsDownloadSchema.status, status))
    .orderBy(desc(ttsDownloadSchema.createdAt))
    .all();
};

/**
 * Get all pending downloads (for queue processing)
 */
export const getPendingDownloads = async (): Promise<TTSDownloadRow[]> => {
  return getTTSDownloadsByStatus('pending');
};

/**
 * Get all processing downloads (for status polling)
 */
export const getProcessingDownloads = async (): Promise<TTSDownloadRow[]> => {
  return getTTSDownloadsByStatus('processing');
};

/**
 * Reset a single download back to pending (for stale processing recovery).
 */
export const resetDownloadToPending = async (downloadId: number): Promise<void> => {
  await dbManager.write(async tx => {
    tx.update(ttsDownloadSchema)
      .set({ status: 'pending', batchJobId: null })
      .where(eq(ttsDownloadSchema.id, downloadId))
      .run();
  });
};

/**
 * Get completed downloads for a novel (for playback)
 */
export const getCompletedDownloads = async (novelId: number): Promise<TTSDownloadRow[]> => {
  return dbManager
    .select()
    .from(ttsDownloadSchema)
    .where(
      and(
        eq(ttsDownloadSchema.novelId, novelId),
        eq(ttsDownloadSchema.status, 'completed')
      )
    )
    .all();
};

/**
 * Get download statistics for a novel
 */
export const getTTSDownloadStats = async (
  novelId: number
): Promise<{
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  totalSizeMB: number;
}> => {
  const stats = await dbManager
    .select({
      status: ttsDownloadSchema.status,
      count: count(),
      totalSize: sql<number>`SUM(${ttsDownloadSchema.totalSizeMB})`,
    })
    .from(ttsDownloadSchema)
    .where(eq(ttsDownloadSchema.novelId, novelId))
    .groupBy(ttsDownloadSchema.status)
    .all();

  const result = {
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    totalSizeMB: 0,
  };

  stats.forEach((stat) => {
    const statusCount = stat.count;
    result.total += statusCount;
    result.totalSizeMB += stat.totalSize || 0;

    switch (stat.status) {
      case 'pending':
        result.pending = statusCount;
        break;
      case 'processing':
        result.processing = statusCount;
        break;
      case 'completed':
        result.completed = statusCount;
        break;
      case 'failed':
        result.failed = statusCount;
        break;
    }
  });

  return result;
};

/**
 * Check if chapter has completed download
 */
export const hasCompletedDownload = async (chapterId: number): Promise<boolean> => {
  const download = await getTTSDownload(chapterId);
  return download?.status === 'completed';
};

/**
 * Get total storage used by downloads (in MB)
 */
export const getTotalDownloadStorage = async (): Promise<number> => {
  const result = await dbManager
    .select({
      totalSize: sql<number>`SUM(${ttsDownloadSchema.totalSizeMB})`,
    })
    .from(ttsDownloadSchema)
    .where(eq(ttsDownloadSchema.status, 'completed'))
    .get();

  return result?.totalSize || 0;
};

/**
 * Get audio file paths for a chapter (for playback)
 */
export const getAudioFilePaths = async (chapterId: number): Promise<string[] | null> => {
  const download = await getTTSDownload(chapterId);

  if (!download || download.status !== 'completed' || !download.audioFilesPaths) {
    return null;
  }

  try {
    return JSON.parse(download.audioFilesPaths);
  } catch (error) {
    console.error('[TTSDownloadQueries] Failed to parse audio file paths:', error);
    return null;
  }
};

/**
 * Get element timing offsets for a chapter (for offline position tracking)
 */
export const getElementOffsets = async (chapterId: number): Promise<number[] | null> => {
  const download = await getTTSDownload(chapterId);
  if (!download?.elementOffsets) return null;
  try {
    return JSON.parse(download.elementOffsets);
  } catch {
    return null;
  }
};

/**
 * Delete TTS downloads for the given chapter IDs, including local audio files.
 * Safe to call with IDs that have no TTS download — they are silently skipped.
 */
export const deleteTTSDownloadsWithFiles = async (chapterIds: number[]): Promise<void> => {
  if (!chapterIds.length) return;

  const rows = await dbManager
    .select()
    .from(ttsDownloadSchema)
    .where(inArray(ttsDownloadSchema.chapterId, chapterIds))
    .all();

  if (!rows.length) return;

  rows.forEach(row => {
    if (row.storageDir) {
      try {
        const dir = new Directory(row.storageDir);
        if (dir.exists) {
          dir.delete();
        }
      } catch {
        // Best-effort file cleanup — don't block DB deletion
      }
    }
  });

  await dbManager.write(async tx => {
    tx.delete(ttsDownloadSchema)
      .where(inArray(ttsDownloadSchema.chapterId, chapterIds))
      .run();
  });
};

// #endregion
