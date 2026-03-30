/**
 * Microsoft Cognitive Services Speech REST API integration for TTS
 * 
 * This service provides an abstraction layer over the Azure Speech REST API
 * to enable Azure TTS as an alternative to Expo Speech.
 * 
 * Uses REST API instead of SDK for React Native compatibility.
 */

import { Audio } from 'expo-av';
import { File, Paths } from 'expo-file-system';
import { ttsLog } from '@utils/logger';

export interface MicrosoftVoice {
  name: string;
  displayName: string;
  locale: string;
  localeName: string;
  gender: string;
  shortName: string;
}

export interface MicrosoftSpeechConfig {
  subscriptionKey: string;
  region: string;
  voice?: string; // Voice short name
}

export interface SpeakOptions {
  voice?: string;
  pitch?: number; // 0.5 - 2.0
  rate?: number;  // 0.5 - 2.0
  onStart?: () => void;
  onDone?: () => void;
  onError?: (error: string) => void;
}

class MicrosoftSpeechService {
  private config: MicrosoftSpeechConfig | null = null;
  private currentSound: Audio.Sound | null = null;
  private isInitialized = false;

  /**
   * Initialize the Microsoft Speech service with API credentials
   */
  initialize(config: MicrosoftSpeechConfig): boolean {
    try {
      if (!config.subscriptionKey || !config.region) {
        throw new Error('Subscription key and region are required');
      }

      this.config = config;
      this.isInitialized = true;
      ttsLog.debug(`[MicrosoftSpeechService] Initialized: region=${config.region}, voice=${config.voice || 'default'}`);
      return true;
    } catch (error) {
      ttsLog.error(`[MicrosoftSpeechService] initialize() failed: ${error instanceof Error ? error.message : String(error)}`);
      this.isInitialized = false;
      return false;
    }
  }

  /**
   * Check if the service is initialized and ready
   */
  isReady(): boolean {
    return this.isInitialized && this.config !== null;
  }

  /**
   * Get Azure Speech API endpoints for a region
   */
  private getEndpoints(region: string) {
    return {
      token: `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      tts: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      voices: `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    };
  }

  /**
   * Get access token from Azure
   */
  private async getAccessToken(): Promise<string> {
    if (!this.config) {
      throw new Error('Service not initialized');
    }

    const endpoints = this.getEndpoints(this.config.region);
    ttsLog.debug(`[MicrosoftSpeechService] Fetching access token from: ${endpoints.token}`);

    const response = await fetch(endpoints.token, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.status} ${response.statusText}`);
    }

    ttsLog.debug('[MicrosoftSpeechService] Access token acquired');
    return await response.text();
  }

  /**
   * Generate SSML with pitch and rate adjustments
   */
  private generateSSML(text: string, options: SpeakOptions): string {
    const voice = options.voice || 'en-US-JennyNeural';
    const pitch = options.pitch !== undefined ? `${(options.pitch - 1) * 50}%` : '0%';
    const rate = options.rate !== undefined ? `${options.rate}` : '1.0';

    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <voice name="${voice}">
    <prosody pitch="${pitch}" rate="${rate}">
      ${this.escapeXml(text)}
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
   * Generate audio file from text without playing (for new architecture)
   * Returns the file path for later playback with expo-av
   */
  async generateAudio(text: string, options: Omit<SpeakOptions, 'onStart' | 'onDone' | 'onError'> = {}): Promise<string> {
    if (!this.isReady()) {
      throw new Error('Microsoft Speech service not initialized');
    }

    const startTime = Date.now();
    const textPreview = text.substring(0, 60).replace(/\n/g, ' ');
    ttsLog.debug(`[MicrosoftSpeechService] generateAudio: voice=${options.voice || 'default'}, pitch=${options.pitch}, rate=${options.rate}, text="${textPreview}"`);

    try {
      // Get access token
      const token = await this.getAccessToken();

      // Generate SSML
      const ssml = this.generateSSML(text, options);
      ttsLog.debug(`[MicrosoftSpeechService] SSML built (${ssml.length} chars)`);

      // Make TTS request
      const endpoints = this.getEndpoints(this.config!.region);
      ttsLog.debug(`[MicrosoftSpeechService] POST ${endpoints.tts}`);

      const response = await fetch(endpoints.tts, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        },
        body: ssml,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`TTS request failed: ${response.status} - ${errorText}`);
      }

      // Get audio as ArrayBuffer and write as raw bytes (no base64 overhead)
      const arrayBuffer = await response.arrayBuffer();
      ttsLog.debug(`[MicrosoftSpeechService] Received ${arrayBuffer.byteLength} bytes of audio`);

      // Use the new File API to write bytes directly — avoids base64 encode/decode
      const tempFile = new File(Paths.cache, `tts_ms_${Date.now()}.mp3`);
      tempFile.write(new Uint8Array(arrayBuffer));

      const duration = Date.now() - startTime;
      ttsLog.debug(`[MicrosoftSpeechService] generateAudio complete: uri=${tempFile.uri}, duration=${duration}ms`);

      return tempFile.uri;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      ttsLog.error(`[MicrosoftSpeechService] generateAudio failed: ${errorMsg}`);
      throw new Error(`Microsoft Speech generation failed: ${errorMsg}`);
    }
  }

  /**
   * Speak text using Microsoft Speech REST API
   */
  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    if (!this.isReady()) {
      const error = 'Microsoft Speech service not initialized';
      options.onError?.(error);
      throw new Error(error);
    }

    try {
      // Stop any currently playing audio
      await this.stop();

      // Get access token
      const token = await this.getAccessToken();

      // Generate SSML
      const ssml = this.generateSSML(text, options);

      // Make TTS request
      const endpoints = this.getEndpoints(this.config!.region);
      
      const response = await fetch(endpoints.tts, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        },
        body: ssml,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`TTS request failed: ${response.status} - ${errorText}`);
      }

      // Get audio as raw bytes and write with new File API (no base64 overhead)
      const arrayBuffer = await response.arrayBuffer();
      ttsLog.debug(`[MicrosoftSpeechService] speak(): received ${arrayBuffer.byteLength} bytes of audio`);

      const tempFile = new File(Paths.cache, `tts_speak_${Date.now()}.mp3`);
      tempFile.write(new Uint8Array(arrayBuffer));
      const tempFilePath = tempFile.uri;
      ttsLog.debug(`[MicrosoftSpeechService] speak(): temp file written: ${tempFilePath}`);

      // Play audio using Expo AV
      const { sound } = await Audio.Sound.createAsync(
        { uri: tempFilePath },
        { shouldPlay: true },
        (status) => {
          if (status.isLoaded) {
            if (status.isPlaying && !status.didJustFinish) {
              // Notify that playback has started
              if (options.onStart && !this.currentSound) {
                options.onStart();
              }
            }
            if (status.didJustFinish) {
              options.onDone?.();
              // Clean up temp file using new File API
              try { new File(tempFilePath).delete(); } catch {}
            }
          }
        },
      );

      this.currentSound = sound;
      
      // Also call onStart immediately since audio will start playing
      options.onStart?.();

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      options.onError?.(errorMsg);
      throw error;
    }
  }

  /**
   * Stop current speech synthesis
   */
  async stop(): Promise<void> {
    if (this.currentSound) {
      try {
        await this.currentSound.stopAsync();
        await this.currentSound.unloadAsync();
      } catch {
        // Ignore errors during cleanup
      }
      this.currentSound = null;
    }
  }

  /**
   * Get list of available voices for a locale
   */
  async getVoices(locale?: string): Promise<MicrosoftVoice[]> {
    if (!this.isReady()) {
      throw new Error('Microsoft Speech service not initialized');
    }

    try {
      const endpoints = this.getEndpoints(this.config!.region);
      
      const response = await fetch(endpoints.voices, {
        headers: {
          'Ocp-Apim-Subscription-Key': this.config!.subscriptionKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch voices: ${response.status} ${response.statusText}`);
      }

      const voices = await response.json();

      // Filter by locale if specified
      let filteredVoices = voices;
      if (locale) {
        filteredVoices = voices.filter((v: any) => 
          v.Locale.toLowerCase().startsWith(locale.toLowerCase())
        );
      }

      // Map to our interface
      return filteredVoices.map((voice: any) => ({
        name: voice.Name,
        displayName: voice.DisplayName,
        locale: voice.Locale,
        localeName: voice.LocaleName,
        gender: voice.Gender,
        shortName: voice.ShortName,
      }));
    } catch (error) {
      throw error;
    }
  }

  /**
   * Validate API credentials
   */
  async validateCredentials(subscriptionKey: string, region: string): Promise<boolean> {
    try {
      const endpoints = this.getEndpoints(region);
      
      // Try to get voices list as a validation check
      const response = await fetch(endpoints.voices, {
        headers: {
          'Ocp-Apim-Subscription-Key': subscriptionKey,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    await this.stop();
    this.config = null;
    this.isInitialized = false;
  }
}

// Export singleton instance
export const microsoftSpeechService = new MicrosoftSpeechService();
