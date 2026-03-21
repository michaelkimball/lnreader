CREATE TABLE `TTSDownload` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chapterId` integer NOT NULL,
	`novelId` integer NOT NULL,
	`batchJobId` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`totalElements` integer DEFAULT 0,
	`downloadedElements` integer DEFAULT 0,
	`storageDir` text,
	`audioFilesPaths` text,
	`voiceName` text,
	`voiceRate` text DEFAULT '1.0',
	`voicePitch` text DEFAULT '1.0',
	`engine` text DEFAULT 'microsoft',
	`createdAt` text NOT NULL,
	`startedAt` text,
	`completedAt` text,
	`totalSizeMB` integer DEFAULT 0,
	`errorMessage` text,
	`retryCount` integer DEFAULT 0,
	`inputBlobFilename` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tts_download_chapter_unique` ON `TTSDownload` (`chapterId`);--> statement-breakpoint
CREATE INDEX `ttsDownloadNovelIdIndex` ON `TTSDownload` (`novelId`);--> statement-breakpoint
CREATE INDEX `ttsDownloadStatusIndex` ON `TTSDownload` (`status`);--> statement-breakpoint
CREATE INDEX `ttsDownloadNovelStatusIndex` ON `TTSDownload` (`novelId`,`status`);