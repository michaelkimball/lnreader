/**
 * Azure Batch Synthesis Service
 * 
 * Handles bulk TTS audio generation using Azure's Batch Synthesis API.
 * This enables offline downloads of entire chapters/novels at 66% cost savings.
 * 
 * API Documentation: https://learn.microsoft.com/en-us/rest/api/speechtotext/batch-synthesis
 * 
 * Requirements:
 * - Azure Speech Service subscription (same as real-time TTS)
 * - Azure Blob Storage for input file hosting (AzureBlobStorage service)
 */

import { getMMKVObject } from '@utils/mmkv/mmkv';
import { INTEGRATION_SETTINGS, IntegrationSettings } from '@hooks/persisted/useSettings';
import { File, Directory, Paths } from 'expo-file-system';
import { unzip } from 'react-native-zip-archive';
import { ttsLog } from '@utils/logger';

const API_VERSION = '2024-04-01';

export interface BatchSynthesisInput {
  text: string;
  id?: string; // Optional identifier for tracking
}

export interface VoiceSettings {
  voice: string; // e.g., "en-US-JennyNeural"
  rate?: number; // 0.5 - 2.0
  pitch?: number; // 0.5 - 2.0
}

export interface BatchJobRequest {
  inputs: BatchSynthesisInput[];
  voiceSettings: VoiceSettings;
  outputFormat?: 'audio-24khz-48kbitrate-mono-mp3' | 'audio-24khz-96kbitrate-mono-mp3';
}

export interface BatchJobStatus {
  id: string;
  status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed';
  createdDateTime: string;
  lastActionDateTime: string;
  outputs?: {
    result?: string; // URL to download results
  };
  properties?: {
    error?: {
      code: string;
      message: string;
    };
    [key: string]: unknown;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface BatchJobResult {
  url: string; // Download URL for generated audio
  filename: string;
  duration?: number; // Audio duration in seconds
}

// Azure batch synthesis *.bookmark.json entries — schema confirmed from real output.
// AudioOffset is in milliseconds (unlike the real-time SDK which uses 100-ns ticks).
export interface BookmarkEntry {
  Text: string;        // The mark= attribute value from the <bookmark> tag
  AudioOffset: number; // ms from the start of the audio file
}

export interface DownloadResults {
  audioFiles: string[];
  elementOffsets: number[]; // ms absolute start time of each element in the concatenated audio
}

class AzureBatchSynthesisService {
  private subscriptionKey: string = '';
  private region: string = '';
  private baseEndpoint: string = '';

  /**
   * Initialize the service with Azure Speech credentials
   */
  initialize(): void {
    try {
      const settings = getMMKVObject<IntegrationSettings>(INTEGRATION_SETTINGS);
      if (!settings) {
        throw new Error('Integration settings not found');
      }

      if (!settings.microsoftSpeech?.enabled) {
        throw new Error('Microsoft Speech not enabled');
      }

      const { subscriptionKey, region } = settings.microsoftSpeech;

      if (!subscriptionKey || !region) {
        throw new Error('Azure Speech credentials missing');
      }

      this.subscriptionKey = subscriptionKey;
      this.region = region;
      this.baseEndpoint = `https://${region}.api.cognitive.microsoft.com/texttospeech/batchsyntheses`;

      ttsLog.debug('[AzureBatchSynthesis] Initialized:', { region, baseEndpoint: this.baseEndpoint });
    } catch (error) {
      ttsLog.error('[AzureBatchSynthesis] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return !!this.subscriptionKey && !!this.region && !!this.baseEndpoint;
  }

  // Duration (ms) injected into the chapter audio for decorative/unreadable elements.
  private readonly DECORATIVE_BREAK_MS = 500;

  /**
   * Returns true when text contains no readable characters (letters or digits in any script).
   * Decorative elements (e.g. "* * *", "——", "…") are replaced with a silence break in the
   * SSML rather than being spoken literally, preventing garbled audio.
   */
  private isDecorativeText(text: string): boolean {
    return !/[\p{L}\p{N}]/u.test(text);
  }

  /**
   * Build a single SSML document for the entire chapter.
   * A <bookmark mark="element_{i}"/> tag is placed before each element's content so
   * Azure returns a *.bookmark.json file mapping each mark name to its AudioOffset (ms).
   * This provides exact per-element timestamps without any estimation.
   *
   * Decorative elements (e.g. "* * *", "——") are replaced with a <break> silence so they
   * don't get spoken literally, while still occupying their correct time slot.
   */
  private createSSMLDocument(texts: string[], voiceSettings: VoiceSettings): string {
    const { voice, rate = 1.0, pitch = 1.0 } = voiceSettings;
    const rateValue = `${rate}`;
    const pitchValue = `${(pitch - 1) * 50}%`;

    const entries = texts.map((text, i) => {
      const content = this.isDecorativeText(text)
        ? `<break time="${this.DECORATIVE_BREAK_MS}ms"/>`
        : `<prosody rate="${rateValue}" pitch="${pitchValue}">
        <mstts:express-as style="general">
          ${text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')}
        </mstts:express-as>
      </prosody>`;
      return `    <bookmark mark="element_${i}"/>
    ${content}`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US">
  <voice name="${voice}">
${entries}
  </voice>
</speak>`;
  }

  /**
   * Submit a batch synthesis job
   * 
   * @param request - Batch job configuration
   * @param chapterId - Chapter ID for tracking
   * @returns Job ID for polling
   */
  async submitJob(request: BatchJobRequest, chapterId: number): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Azure Batch Synthesis not initialized');
    }

    try {
      // One SSML document with <bookmark mark="element_{i}"/> before each element.
      // Single input → one output audio file (0001.mp3) + one offset file (0001.bookmark.json).
      const texts = request.inputs.map((input) => input.text);
      const ssml = this.createSSMLDocument(texts, request.voiceSettings);

      // Generate a unique job ID (UUID v4)
      const jobId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });

      const jobPayload = {
        description: `Batch synthesis for chapter ${chapterId}`,
        inputKind: 'SSML',
        inputs: [{ content: ssml }],
        properties: {
          outputFormat: request.outputFormat || 'audio-24khz-96kbitrate-mono-mp3',
          wordBoundaryEnabled: false,
          sentenceBoundaryEnabled: false,
          concatenateResult: false,
          decompressOutputFiles: false,
        },
      };

      const response = await fetch(`${this.baseEndpoint}/${jobId}?api-version=${API_VERSION}`, {
        method: 'PUT',
        headers: {
          'Ocp-Apim-Subscription-Key': this.subscriptionKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(jobPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Batch submission failed: ${response.status} - ${errorText}`);
      }

      ttsLog.debug('[AzureBatchSynthesis] Job submitted:', { jobId, chapterId, elementCount: texts.length });

      return jobId;
    } catch (error) {
      ttsLog.error('[AzureBatchSynthesis] Job submission failed:', error);
      throw error;
    }
  }

  /**
   * Get batch job status
   * Poll this until status is 'Succeeded' or 'Failed'
   * 
   * @param jobId - Job ID from submitJob()
   * @returns Job status with output URLs if complete
   */
  async getJobStatus(jobId: string): Promise<BatchJobStatus> {
    if (!this.isReady()) {
      throw new Error('Azure Batch Synthesis not initialized');
    }

    try {
      const url = `${this.baseEndpoint}/${jobId}?api-version=${API_VERSION}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': this.subscriptionKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get job status: ${response.status}`);
      }

      const status: BatchJobStatus = await response.json();
      return status;
    } catch (error) {
      ttsLog.error('[AzureBatchSynthesis] Failed to get job status:', error);
      throw error;
    }
  }

  /**
   * Poll job status until completion
   * 
   * @param jobId - Job ID
   * @param onProgress - Callback for status updates
   * @param maxWaitMinutes - Maximum wait time (default: 30)
   * @returns Final job status
   */
  async pollJobUntilComplete(
    jobId: string,
    onProgress?: (status: BatchJobStatus) => void,
    maxWaitMinutes: number = 30
  ): Promise<BatchJobStatus> {
    const startTime = Date.now();
    const maxWaitMs = maxWaitMinutes * 60 * 1000;
    const pollIntervalMs = 5000; // Poll every 5 seconds

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getJobStatus(jobId);

      if (onProgress) {
        onProgress(status);
      }

      if (status.status === 'Succeeded' || status.status === 'Failed') {
        return status;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Job ${jobId} timed out after ${maxWaitMinutes} minutes`);
  }

  /**
   * Download batch synthesis results
   *
   * @param jobStatus - Completed job status
   * @param downloadDir - Local directory to save files
   * @returns Audio file paths and sentence boundaries
   */
  async downloadResults(jobStatus: BatchJobStatus, downloadDir: string): Promise<DownloadResults> {
    if (jobStatus.status !== 'Succeeded') {
      throw new Error(`Cannot download results - job status is ${jobStatus.status}`);
    }

    if (!jobStatus.outputs?.result) {
      throw new Error('Job completed but no result URL available');
    }

    const tempZipFile = new File(Paths.cache, `batch_${jobStatus.id}.zip`);

    try {
      const response = await fetch(jobStatus.outputs.result);
      if (!response.ok) {
        throw new Error(`Failed to download results ZIP: ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      tempZipFile.write(bytes);

      const extractDir = downloadDir.replace(/\/$/, '');
      await unzip(tempZipFile.uri, extractDir);

      const chapterDirectory = new Directory(downloadDir);
      const entries = chapterDirectory.list();

      const audioFiles = (entries as File[])
        .filter(f => f.uri.endsWith('.mp3') || f.uri.endsWith('.wav'))
        .sort((a, b) => a.uri.localeCompare(b.uri))
        .map(f => f.uri);

      // Parse the bookmark file (0001.bookmark.json) to extract per-element audio offsets.
      // Each entry has { Text: "element_{i}", AudioOffset: ms } — a direct lookup, no estimation.
      const bookmarkFiles = (entries as File[])
        .filter(f => f.uri.endsWith('.bookmark.json'))
        .sort((a, b) => a.uri.localeCompare(b.uri));

      const elementOffsets: number[] = [];
      if (bookmarkFiles.length > 0) {
        try {
          const bookmarks: BookmarkEntry[] = JSON.parse(await bookmarkFiles[0].text());
          ttsLog.debug('[AzureBatchSynthesis] bookmark.json first entry:', JSON.stringify(bookmarks[0]));
          // Build a map from mark name → AudioOffset for O(1) lookup
          const offsetMap = new Map<string, number>(bookmarks.map(b => [b.Text, b.AudioOffset]));
          // Reconstruct ordered array: element_0, element_1, ...
          let idx = 0;
          while (offsetMap.has(`element_${idx}`)) {
            elementOffsets.push(offsetMap.get(`element_${idx}`)!);
            idx++;
          }
        } catch (e) {
          ttsLog.warn('[AzureBatchSynthesis] Failed to parse bookmark.json:', e);
        }
      }

      ttsLog.debug(`[AzureBatchSynthesis] Extracted ${audioFiles.length} audio files, ${elementOffsets.length} element offsets`);
      return { audioFiles, elementOffsets };
    } catch (error) {
      ttsLog.error('[AzureBatchSynthesis] Download failed:', error);
      throw error;
    } finally {
      if (tempZipFile.exists) {
        tempZipFile.delete();
      }
    }
  }

  /**
   * Delete a batch job (cleanup)
   * 
   * @param jobId - Job ID to delete
   */
  async deleteJob(jobId: string): Promise<void> {
    if (!this.isReady()) {
      return;
    }

    try {
      const url = `${this.baseEndpoint}/${jobId}?api-version=${API_VERSION}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Ocp-Apim-Subscription-Key': this.subscriptionKey,
        },
      });

      if (response.ok) {
        ttsLog.debug('[AzureBatchSynthesis] Deleted job:', jobId);
      } else {
        ttsLog.warn('[AzureBatchSynthesis] Failed to delete job:', jobId, response.status);
      }
    } catch (error) {
      ttsLog.error('[AzureBatchSynthesis] Delete job error:', error);
      // Don't throw - cleanup failure is not critical
    }
  }

  /**
   * List all batch synthesis jobs
   * Useful for debugging and management
   * 
   * @returns Array of job statuses
   */
  async listJobs(): Promise<BatchJobStatus[]> {
    if (!this.isReady()) {
      return [];
    }

    try {
      const response = await fetch(`${this.baseEndpoint}?api-version=${API_VERSION}`, {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': this.subscriptionKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to list jobs: ${response.status}`);
      }

      const result = await response.json();
      return result.value || [];
    } catch (error) {
      ttsLog.error('[AzureBatchSynthesis] List jobs failed:', error);
      return [];
    }
  }
}

// Singleton instance
export const azureBatchSynthesis = new AzureBatchSynthesisService();
