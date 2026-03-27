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
import { INTEGRATION_SETTINGS } from '@hooks/persisted/useSettings';
import { IntegrationSettings } from '@hooks/persisted/useSettings';
import { File, Directory, Paths } from 'expo-file-system';
import { unzip } from 'react-native-zip-archive';

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

// Azure batch synthesis JSON can emit boundaries in two shapes:
// Flat:   { AudioOffset, BoundaryType: "SentenceBoundary", Text }
// Nested: { AudioOffset, Duration, text: { BoundaryType: "SentenceBoundary", Text } }
export interface SentenceBoundary {
  AudioOffset: number; // 100-nanosecond ticks
  Duration?: number;
  BoundaryType?: string;          // flat format
  Text?: string;                  // flat format
  text?: {                        // nested format
    BoundaryType: string;
    Text?: string;
  };
}

export interface DownloadResults {
  audioFiles: string[];
  sentenceBoundaries: SentenceBoundary[];
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

      console.log('[AzureBatchSynthesis] Initialized:', { region, baseEndpoint: this.baseEndpoint });
    } catch (error) {
      console.error('[AzureBatchSynthesis] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return !!this.subscriptionKey && !!this.region && !!this.baseEndpoint;
  }

  /**
   * Create SSML document for batch synthesis.
   * All text elements are combined into one document → one output audio file.
   */
  private createSSMLDocument(texts: string[], voiceSettings: VoiceSettings): string {
    const { voice, rate = 1.0, pitch = 1.0 } = voiceSettings;

    const rateValue = `${Math.round(rate * 100)}%`;
    const pitchValue = pitch >= 1.0 ? `+${Math.round((pitch - 1) * 50)}%` : `-${Math.round((1 - pitch) * 50)}%`;

    const ssmlEntries = texts.map((text) => {
      const sanitizedText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

      return `    <voice name="${voice}">
      <prosody rate="${rateValue}" pitch="${pitchValue}">
        <mstts:express-as style="general">
          ${sanitizedText}
        </mstts:express-as>
      </prosody>
    </voice>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US">
${ssmlEntries}
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
      // All text elements are combined into one SSML → one output audio file.
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
          sentenceBoundaryEnabled: true,
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

      console.log('[AzureBatchSynthesis] Job submitted:', { jobId, chapterId, elementCount: texts.length });

      return jobId;
    } catch (error) {
      console.error('[AzureBatchSynthesis] Job submission failed:', error);
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
      console.error('[AzureBatchSynthesis] Failed to get job status:', error);
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

      // Parse sentence boundary JSON (same base name as audio, .json extension)
      let sentenceBoundaries: SentenceBoundary[] = [];
      const jsonFiles = (entries as File[])
        .filter(f => f.uri.endsWith('.json'))
        .sort((a, b) => a.uri.localeCompare(b.uri));

      // Azure names sentence boundary files "*.sentence.json"
      const sentenceJsonFiles = (entries as File[])
        .filter(f => f.uri.endsWith('.sentence.json'))
        .sort((a, b) => a.uri.localeCompare(b.uri));

      if (sentenceJsonFiles.length > 0) {
        try {
          const jsonText = await sentenceJsonFiles[0].text();
          const parsed = JSON.parse(jsonText);
          console.log('[AzureBatchSynthesis] sentence.json first entry:', JSON.stringify(Array.isArray(parsed) ? parsed[0] : parsed).slice(0, 300));
          if (Array.isArray(parsed)) {
            sentenceBoundaries = parsed as SentenceBoundary[];
          }
        } catch (e) {
          console.warn('[AzureBatchSynthesis] Failed to parse timing JSON:', e);
        }
      }

      console.log(`[AzureBatchSynthesis] Extracted ${audioFiles.length} audio files, ${sentenceBoundaries.length} sentence boundaries`);
      return { audioFiles, sentenceBoundaries };
    } catch (error) {
      console.error('[AzureBatchSynthesis] Download failed:', error);
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
        console.log('[AzureBatchSynthesis] Deleted job:', jobId);
      } else {
        console.warn('[AzureBatchSynthesis] Failed to delete job:', jobId, response.status);
      }
    } catch (error) {
      console.error('[AzureBatchSynthesis] Delete job error:', error);
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
      return result.values || [];
    } catch (error) {
      console.error('[AzureBatchSynthesis] List jobs failed:', error);
      return [];
    }
  }
}

// Singleton instance
export const azureBatchSynthesis = new AzureBatchSynthesisService();
