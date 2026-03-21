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

import { azureBlobStorage } from './AzureBlobStorage';
import { getMMKVString } from '@utils/mmkv/mmkv';
import { INTEGRATION_SETTINGS } from '@utils/constants/storage.constants';
import { IntegrationSettings } from '@hooks/persisted/useSettings';
import * as FileSystem from 'expo-file-system';

// Batch Synthesis API endpoint (v3.1-preview1)
const API_VERSION = 'v3.1-preview1';

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

class AzureBatchSynthesisService {
  private subscriptionKey: string = '';
  private region: string = '';
  private endpoint: string = '';

  /**
   * Initialize the service with Azure Speech credentials
   */
  initialize(): void {
    try {
      const settingsJson = getMMKVString(INTEGRATION_SETTINGS);
      if (!settingsJson) {
        throw new Error('Integration settings not found');
      }

      const settings: IntegrationSettings = JSON.parse(settingsJson);

      if (!settings.microsoftSpeech?.enabled) {
        throw new Error('Microsoft Speech not enabled');
      }

      const { subscriptionKey, region } = settings.microsoftSpeech;

      if (!subscriptionKey || !region) {
        throw new Error('Azure Speech credentials missing');
      }

      this.subscriptionKey = subscriptionKey;
      this.region = region;
      this.endpoint = `https://${region}.api.cognitive.microsoft.com/speechtotext/${API_VERSION}/batchsynthesis`;

      console.log('[AzureBatchSynthesis] Initialized:', { region, endpoint: this.endpoint });
    } catch (error) {
      console.error('[AzureBatchSynthesis] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return !!this.subscriptionKey && !!this.region && !!this.endpoint;
  }

  /**
   * Create SSML document for batch synthesis
   * Batch API requires SSML format with specific structure
   */
  private createSSMLDocument(texts: string[], voiceSettings: VoiceSettings): string {
    const { voice, rate = 1.0, pitch = 1.0 } = voiceSettings;

    // Prosody attributes for rate and pitch
    const rateValue = `${Math.round(rate * 100)}%`;
    const pitchValue = pitch >= 1.0 ? `+${Math.round((pitch - 1) * 50)}%` : `-${Math.round((1 - pitch) * 50)}%`;

    // Create SSML entries for each text
   const ssmlEntries = texts.map((text, index) => {
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

    // Complete SSML document
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

    if (!azureBlobStorage.isReady()) {
      throw new Error('Azure Blob Storage not initialized');
    }

    try {
      // 1. Create SSML document from inputs
      const texts = request.inputs.map((input) => input.text);
      const ssml = this.createSSMLDocument(texts, request.voiceSettings);

      // 2. Upload SSML to blob storage
      const filename = `chapter_${chapterId}_${Date.now()}.ssml`;
      const uploadResult = await azureBlobStorage.uploadSSML(ssml, filename, false);

      console.log('[AzureBatchSynthesis] Uploaded input file:', uploadResult);

      // 3. Submit batch job
      const jobPayload = {
        displayName: `LNReader_Chapter_${chapterId}`,
        description: `Batch synthesis for chapter ${chapterId}`,
        textType: 'SSML',
        inputs: [
          {
            url: uploadResult.url,
          },
        ],
        properties: {
          outputFormat: request.outputFormat || 'audio-24khz-96kbitrate-mono-mp3',
          wordBoundaryEnabled: false,
          sentenceBoundaryEnabled: false,
          concatenateResult: false, // Keep as separate files
          decompressOutputFiles: false,
        },
        customProperties: {
          chapterId: chapterId.toString(),
          inputFilename: filename,
          elementCount: texts.length.toString(),
        },
      };

      const response = await fetch(this.endpoint, {
        method: 'POST',
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

      const result = await response.json();
      const jobId = result.id;

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
      const url = `${this.endpoint}/${jobId}`;

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
   * @returns Array of downloaded file paths
   */
  async downloadResults(jobStatus: BatchJobStatus, downloadDir: string): Promise<string[]> {
    if (jobStatus.status !== 'Succeeded') {
      throw new Error(`Cannot download results - job status is ${jobStatus.status}`);
    }

    if (!jobStatus.outputs?.result) {
      throw new Error('Job completed but no result URL available');
    }

    try {
      // Download result manifest
      const manifestUrl = jobStatus.outputs.result;
      const manifestResponse = await fetch(manifestUrl);

      if (!manifestResponse.ok) {
        throw new Error(`Failed to download manifest: ${manifestResponse.status}`);
      }

      const manifest = await manifestResponse.json();

      // Manifest contains URLs for all generated audio files
      const audioFiles: string[] = [];

      if (manifest.values && Array.isArray(manifest.values)) {
        for (const item of manifest.values) {
          if (item.url && item.url.endsWith('.mp3')) {
            const filename = item.url.split('/').pop() || `audio_${Date.now()}.mp3`;
            const localPath = `${downloadDir}/${filename}`;

            // Download audio file
            const downloadResult = await FileSystem.downloadAsync(item.url, localPath);

            if (downloadResult.status === 200) {
              audioFiles.push(downloadResult.uri);
              console.log('[AzureBatchSynthesis] Downloaded:', filename);
            } else {
              console.warn('[AzureBatchSynthesis] Download failed:', filename, downloadResult.status);
            }
          }
        }
      }

      console.log(`[AzureBatchSynthesis] Downloaded ${audioFiles.length} audio files`);
      return audioFiles;
    } catch (error) {
      console.error('[AzureBatchSynthesis] Download failed:', error);
      throw error;
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
      const url = `${this.endpoint}/${jobId}`;

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
      const response = await fetch(this.endpoint, {
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
