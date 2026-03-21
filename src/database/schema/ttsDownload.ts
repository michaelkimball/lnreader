import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * TTSDownload table - Tracks batch TTS audio downloads for offline playback
 * 
 * Each row represents a chapter that has been or is being downloaded via
 * Azure Batch Synthesis API for offline TTS playback.
 */
export const ttsDownload = sqliteTable(
  'TTSDownload',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chapterId: integer('chapterId').notNull(),
    novelId: integer('novelId').notNull(),
    
    // Batch job tracking
    batchJobId: text('batchJobId'), // Azure Batch Synthesis job ID
    status: text('status').notNull().default('pending'), // pending, processing, completed, failed
    
    // Progress tracking
    totalElements: integer('totalElements').default(0), // Total text elements in chapter
    downloadedElements: integer('downloadedElements').default(0), // Successfully downloaded audio files
    
    // File storage
    storageDir: text('storageDir'), // Local directory where audio files are stored
    audioFilesPaths: text('audioFilesPaths'), // JSON array of file paths
    
    // Voice settings used for generation
    voiceName: text('voiceName'), // e.g., "en-US-JennyNeural"
    voiceRate: text('voiceRate').default('1.0'),
    voicePitch: text('voicePitch').default('1.0'),
    engine: text('engine').default('microsoft'), // 'microsoft' or 'expo'
    
    // Timestamps
    createdAt: text('createdAt').notNull(), // When download was requested
    startedAt: text('startedAt'), // When batch job started processing
    completedAt: text('completedAt'), // When download finished
    
    // Size tracking
    totalSizeMB: integer('totalSizeMB').default(0), // Total size of downloaded audio files in MB
    
    // Error handling
    errorMessage: text('errorMessage'), // Error message if failed
    retryCount: integer('retryCount').default(0), // Number of retry attempts
    
    // Cleanup tracking
    inputBlobFilename: text('inputBlobFilename'), // Azure Blob file to clean up
  },
  table => [
    // Ensure one download per chapter
    uniqueIndex('tts_download_chapter_unique').on(table.chapterId),
    
    // Index for querying by novel
    index('ttsDownloadNovelIdIndex').on(table.novelId),
    
    // Index for querying by status
    index('ttsDownloadStatusIndex').on(table.status),
    
    // Composite index for efficient novel + status queries
    index('ttsDownloadNovelStatusIndex').on(table.novelId, table.status),
  ],
);

export type TTSDownloadRow = typeof ttsDownload.$inferSelect;
export type TTSDownloadInsert = typeof ttsDownload.$inferInsert;
