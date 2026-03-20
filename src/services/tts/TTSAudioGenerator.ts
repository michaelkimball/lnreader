/**
 * TTSAudioGenerator - Unified Audio Generation Layer
 * 
 * Factory for generating TTS audio files from both Expo Speech and Microsoft Speech engines.
 * Handles caching, engine routing, and error fallback.
 */

import * as FileSystem from 'expo-file-system';
import NativeExpoSpeech from '@specs/NativeExpoSpeech';
import { microsoftSpeechService } from './MicrosoftSpeechService';
import { ttsCacheManager } from './TTSCacheManager';

export type TTSEngine = 'expo' | 'microsoft';

export interface VoiceSettings {
  voice: string;
  pitch?: number;
  rate?: number;
  engine: TTSEngine;
}

export interface GenerateOptions {
  timeout?: number;
  forceRegenerate?: boolean;
  fallbackToExpo?: boolean;  // Fallback to Expo if Microsoft fails
}

export interface GenerationResult {
  uri: string;
  cached: boolean;
  engine: TTSEngine;
  duration?: number;  // Generation time in ms
}

class TTSAudioGenerator {
  private static tempFileCounter = 0;

  /**
   * Generate audio file for text using specified engine
   * Checks cache first, generates if not found
   */
  static async generateAudio(
    text: string,
    settings: VoiceSettings,
    options: GenerateOptions = {}
  ): Promise<GenerationResult> {
    const startTime = Date.now();

    try {
      // 1. Check cache first (unless force regenerate)
      if (!options.forceRegenerate) {
        const cacheKey = ttsCacheManager.generateKey(text, settings);
        const cachedUri = await ttsCacheManager.get(cacheKey);
        
        if (cachedUri) {
          return {
            uri: cachedUri,
            cached: true,
            engine: settings.engine,
            duration: Date.now() - startTime,
          };
        }
      }

      // 2. Generate new audio
      let uri: string;
      let usedEngine = settings.engine;

      try {
        if (settings.engine === 'microsoft') {
          uri = await this.generateWithMicrosoft(text, settings, options.timeout);
        } else {
          uri = await this.generateWithExpo(text, settings, options.timeout);
        }
      } catch (error) {
        // Fallback to Expo if Microsoft fails and fallback is enabled
        if (settings.engine === 'microsoft' && options.fallbackToExpo !== false) {
          uri = await this.generateWithExpo(text, {
            ...settings,
            engine: 'expo',
          }, options.timeout);
          usedEngine = 'expo';
        } else {
          throw error;
        }
      }

      // 3. Cache the result
      const cacheKey = ttsCacheManager.generateKey(text, { ...settings, engine: usedEngine });
      await ttsCacheManager.set(cacheKey, uri, { ...settings, engine: usedEngine }, text);

      return {
        uri,
        cached: false,
        engine: usedEngine,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Generate audio using Expo Speech (native TTS)
   */
  private static async generateWithExpo(
    text: string,
    settings: VoiceSettings,
    timeout?: number
  ): Promise<string> {
    try {
      const outputPath = this.getTempFilePath('expo');
      
      const promise = NativeExpoSpeech.synthesizeToFile(
        text,
        settings.voice || 'system',
        settings.pitch || 1.0,
        settings.rate || 1.0,
        outputPath
      );

      // Apply timeout if specified
      const uri = timeout 
        ? await this.withTimeout(promise, timeout, 'Expo Speech synthesis timeout')
        : await promise;

      return uri;
    } catch (error) {
      throw new Error(`Expo Speech generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate audio using Microsoft Speech (cloud TTS)
   */
  private static async generateWithMicrosoft(
    text: string,
    settings: VoiceSettings,
    timeout?: number
  ): Promise<string> {
    try {
      // Microsoft Speech service already handles file generation
      // We need to wrap it in a Promise to get the file URI
      return new Promise((resolve, reject) => {
        let resolved = false;
        let tempFilePath: string;

        const timeoutId = timeout ? setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error('Microsoft Speech synthesis timeout'));
          }
        }, timeout) : null;

        microsoftSpeechService.speak(text, {
          voice: settings.voice,
          pitch: settings.pitch,
          rate: settings.rate,
          onStart: () => {
            // Audio generation started
          },
          onDone: () => {
            if (!resolved && tempFilePath) {
              resolved = true;
              if (timeoutId) clearTimeout(timeoutId);
              resolve(tempFilePath);
            }
          },
          onError: (error) => {
            if (!resolved) {
              resolved = true;
              if (timeoutId) clearTimeout(timeoutId);
              reject(new Error(`Microsoft Speech error: ${error}`));
            }
          },
        }).then((filePath) => {
          // MicrosoftSpeechService.speak returns the temp file path
          // We need to modify MicrosoftSpeechService to expose this
          // For now, we'll rely on onDone callback
          tempFilePath = filePath || '';
        }).catch((error) => {
          if (!resolved) {
            resolved = true;
            if (timeoutId) clearTimeout(timeoutId);
            reject(error);
          }
        });
      });
    } catch (error) {
      throw new Error(`Microsoft Speech generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Test if an engine is available and configured
   */
  static async testEngine(engine: TTSEngine): Promise<boolean> {
    try {
      if (engine === 'expo') {
        // Test Expo Speech by checking if voices are available
        const voices = await NativeExpoSpeech.getAvailableVoices();
        return voices.length > 0;
      } else {
        // Test Microsoft Speech by validating configuration
        return microsoftSpeechService.isInitialized();
      }
    } catch {
      return false;
    }
  }

  /**
   * Get supported audio formats for an engine
   */
  static getSupportedFormats(engine: TTSEngine): string[] {
    if (engine === 'microsoft') {
      return ['mp3', 'wav', 'ogg'];  // Microsoft supports multiple formats
    } else {
      return ['mp3'];  // Expo Speech typically outputs mp3
    }
  }

  /**
   * Generate a temporary file path for audio
   */
  private static getTempFilePath(engine: TTSEngine): string {
    this.tempFileCounter++;
    const timestamp = Date.now();
    const counter = this.tempFileCounter;
    return `${FileSystem.cacheDirectory}tts_${engine}_${timestamp}_${counter}.mp3`;
  }

  /**
   * Helper to add timeout to promises
   */
  private static withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    errorMessage: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(errorMessage)), ms)
      ),
    ]);
  }

  /**
   * Batch generate audio for multiple texts
   * Useful for preloading
   */
  static async batchGenerate(
    texts: string[],
    settings: VoiceSettings,
    options: GenerateOptions & { concurrency?: number } = {}
  ): Promise<GenerationResult[]> {
    const concurrency = options.concurrency || 2;  // Limit parallel generations
    const results: GenerationResult[] = [];
    
    // Process in batches
    for (let i = 0; i < texts.length; i += concurrency) {
      const batch = texts.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(text => this.generateAudio(text, settings, options))
      );
      results.push(...batchResults);
    }

    return results;
  }
}

export default TTSAudioGenerator;
