/**
 * TTSAudioGenerator - Unified Audio Generation Layer
 * 
 * Factory for generating TTS audio files from both Expo Speech and Microsoft Speech engines.
 * Handles caching, engine routing, and error fallback.
 */

import { File, Paths } from 'expo-file-system';
import NativeExpoSpeech from '@specs/NativeExpoSpeech';
import { microsoftSpeechService } from './MicrosoftSpeechService';
import { ttsCacheManager } from './TTSCacheManager';

export type TTSEngine = 'expo' | 'microsoft';

export interface EngineConfig {
  /** Human-readable display name */
  name: string;
  /** File extension produced by this engine's output */
  ext: string;
}

/**
 * Metadata for each TTS engine. Add a new entry here when integrating a new engine.
 * - `ext` must match what the engine actually writes to disk, not what it's capable of.
 *   Android TextToSpeech.synthesizeToFile always writes WAV regardless of filename.
 *   Microsoft Speech is requested as audio-16khz-128kbitrate-mono-mp3.
 */
export const ENGINE_CONFIGS: Record<TTSEngine, EngineConfig> = {
  expo: { name: 'Expo (Android TTS)', ext: 'wav' },
  microsoft: { name: 'Microsoft Azure Speech', ext: 'mp3' },
};

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
    const textPreview = text.substring(0, 60).replace(/\n/g, ' ');
    console.log(`[TTSAudioGenerator] generateAudio start: engine=${settings.engine}, voice=${settings.voice}, text="${textPreview}"`);

    try {
      // 1. Check cache first (unless force regenerate)
      if (!options.forceRegenerate) {
        const cacheKey = ttsCacheManager.generateKey(text, settings);
        const cachedUri = await ttsCacheManager.get(cacheKey);
        
        if (cachedUri) {
          console.log(`[TTSAudioGenerator] Cache hit: key=${cacheKey}, uri=${cachedUri}, duration=${Date.now() - startTime}ms`);
          return {
            uri: cachedUri,
            cached: true,
            engine: settings.engine,
            duration: Date.now() - startTime,
          };
        }
        console.log(`[TTSAudioGenerator] Cache miss: key=${cacheKey}`);
      } else {
        console.log('[TTSAudioGenerator] Cache skipped (forceRegenerate=true)');
      }

      // 2. Generate new audio
      let uri: string;
      let usedEngine = settings.engine;

      try {
        if (settings.engine === 'microsoft') {
          console.log('[TTSAudioGenerator] Routing to Microsoft Speech engine');
          uri = await this.generateWithMicrosoft(text, settings, options.timeout);
        } else {
          console.log('[TTSAudioGenerator] Routing to Expo Speech engine');
          uri = await this.generateWithExpo(text, settings, options.timeout);
        }
      } catch (error) {
        console.warn(`[TTSAudioGenerator] Engine "${settings.engine}" failed: ${error instanceof Error ? error.message : String(error)}`);
        // Fallback to Expo if Microsoft fails and fallback is enabled
        if (settings.engine === 'microsoft' && options.fallbackToExpo !== false) {
          console.log('[TTSAudioGenerator] Falling back to Expo Speech engine');
          uri = await this.generateWithExpo(text, {
            ...settings,
            engine: 'expo',
          }, options.timeout);
          usedEngine = 'expo';
          console.log(`[TTSAudioGenerator] Fallback Expo generation succeeded: uri=${uri}`);
        } else {
          throw error;
        }
      }

      // 3. Cache the result
      const cacheKey = ttsCacheManager.generateKey(text, { ...settings, engine: usedEngine });
      console.log(`[TTSAudioGenerator] Caching result: key=${cacheKey}, engine=${usedEngine}, uri=${uri}`);
      await ttsCacheManager.set(cacheKey, uri, { ...settings, engine: usedEngine }, text);

      const duration = Date.now() - startTime;
      console.log(`[TTSAudioGenerator] generateAudio complete: engine=${usedEngine}, cached=false, duration=${duration}ms, uri=${uri}`);
      return {
        uri,
        cached: false,
        engine: usedEngine,
        duration,
      };
    } catch (error) {
      console.error(`[TTSAudioGenerator] generateAudio failed: ${error instanceof Error ? error.message : String(error)}`);
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
    const outputPath = this.getTempFilePath('expo');
    console.log(`[TTSAudioGenerator] generateWithExpo: voice=${settings.voice || 'system'}, pitch=${settings.pitch || 1.0}, rate=${settings.rate || 1.0}, outputPath=${outputPath}`);

    try {
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

      console.log(`[TTSAudioGenerator] generateWithExpo: native synthesizeToFile returned uri=${uri}`);
      return uri;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[TTSAudioGenerator] generateWithExpo failed: ${msg}`);
      throw new Error(`Expo Speech generation failed: ${msg}`);
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
    console.log(`[TTSAudioGenerator] generateWithMicrosoft: voice=${settings.voice}, pitch=${settings.pitch}, rate=${settings.rate}`);

    try {
      const promise = microsoftSpeechService.generateAudio(text, {
        voice: settings.voice,
        pitch: settings.pitch,
        rate: settings.rate,
      });

      // Apply timeout if specified
      const uri = timeout
        ? await this.withTimeout(promise, timeout, 'Microsoft Speech synthesis timeout')
        : await promise;

      console.log(`[TTSAudioGenerator] generateWithMicrosoft: returned uri=${uri}`);
      return uri;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[TTSAudioGenerator] generateWithMicrosoft failed: ${msg}`);
      throw new Error(`Microsoft Speech generation failed: ${msg}`);
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
        return microsoftSpeechService.isReady();
      }
    } catch {
      return false;
    }
  }

  /**
   * Get the default output extension for an engine.
   * For capability enumeration (all supported formats), use ENGINE_CONFIGS directly.
   */
  static getOutputExtension(engine: TTSEngine): string {
    return ENGINE_CONFIGS[engine].ext;
  }

  /**
   * Generate a temporary file path for audio
   */
  /**
   * Generate a temporary file URI for a new audio file.
   *
   * IMPORTANT: Android TextToSpeech.synthesizeToFile always writes WAV audio.
   * Microsoft Speech returns MP3 data. Using the wrong extension causes expo-av
   * to fail loading the file (wrong codec).
   *
   * Uses the new expo-file-system File/Paths API so the URI is always well-formed
   * (avoids manual `file://` + string concatenation which can produce malformed paths).
   */
  private static getTempFilePath(engine: TTSEngine): string {
    this.tempFileCounter++;
    const timestamp = Date.now();
    const counter = this.tempFileCounter;
    const { ext } = ENGINE_CONFIGS[engine];
    const filename = `tts_${engine}_${timestamp}_${counter}.${ext}`;
    const uri = new File(Paths.cache, filename).uri;
    console.log(`[TTSAudioGenerator] getTempFilePath: engine=${engine}, filename=${filename}, uri=${uri}`);
    return uri;
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
