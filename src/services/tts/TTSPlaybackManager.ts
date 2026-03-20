/**
 * TTSPlaybackManager - Main TTS Playback Orchestrator
 * 
 * Singleton service that manages all TTS playback:
 * - Controls expo-av Sound for true pause/resume
 * - Manages playback queue and position
 * - Coordinates with preloader for audio generation
 * - Emits events for UI synchronization
 * - Handles playback controls (play, pause, resume, stop, seek, next, prev)
 */

import { EventEmitter } from 'events';
import { Audio, AVPlaybackStatus } from 'expo-av';
import TTSAudioPreloader, { TTSQueueItem } from './TTSAudioPreloader';
import { VoiceSettings } from './TTSAudioGenerator';
import NativeTTSForegroundService from '@specs/NativeTTSForegroundService';

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';

export interface PlaybackEvent {
  type: 'stateChange' | 'progress' | 'elementChange' | 'queueEnd' | 'error' | 'audioLoading' | 'audioReady';
  state?: PlaybackState;
  index?: number;
  current?: number;
  total?: number;
  text?: string;
  reason?: 'completed' | 'stopped';
  message?: string;
  code?: string;
  uri?: string;
}

class TTSPlaybackManager extends EventEmitter {
  private static instance: TTSPlaybackManager;
  
  private state: PlaybackState = 'idle';
  private currentIndex: number = -1;
  private queue: TTSQueueItem[] = [];
  private chapterId: number = -1;
  private novelId: number = -1;
  private currentSound: Audio.Sound | null = null;
  private voiceSettings: VoiceSettings | null = null;
  private preloader: TTSAudioPreloader;
  private isInitialized: boolean = false;

  private constructor() {
    super();
    this.preloader = new TTSAudioPreloader();
    this.setupPreloaderListeners();
    this.initializeAudio();
  }

  static getInstance(): TTSPlaybackManager {
    if (!TTSPlaybackManager.instance) {
      TTSPlaybackManager.instance = new TTSPlaybackManager();
    }
    return TTSPlaybackManager.instance;
  }

  /**
   * Initialize expo-av audio mode
   */
  private async initializeAudio(): Promise<void> {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        staysActiveInBackground: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      this.isInitialized = true;
      console.log('[TTSPlayback] Audio initialized');
    } catch (error) {
      console.error('[TTSPlayback] Audio initialization error:', error);
    }
  }

  /**
   * Setup preloader event listeners
   */
  private setupPreloaderListeners(): void {
    this.preloader.on('ready', (event) => {
      if (event.type === 'ready') {
        this.emit('audioReady', { type: 'audioReady', index: event.index, uri: event.uri });
        
        // Auto-start playback if we're loading first element
        if (this.state === 'loading' && event.index === this.currentIndex) {
          this.playCurrentElement();
        }
      }
    });

    this.preloader.on('progress', (event) => {
      if (event.type === 'progress') {
        console.log(`[TTSPlayback] Preload progress: ${event.progress.percentage}%`);
      }
    });

    this.preloader.on('error', (event) => {
      if (event.type === 'error') {
        console.error(`[TTSPlayback] Preload error at index ${event.index}:`, event.error);
        
        // If it's the current element and won't retry, skip to next
        if (event.index === this.currentIndex && !event.willRetry) {
          this.next();
        }
      }
    });
  }

  /**
   * Start TTS playback from a queue
   */
  async play(
    textElements: string[],
    startIndex: number = 0,
    chapterId: number,
    novelId: number,
    settings: VoiceSettings
  ): Promise<void> {
    try {
      console.log(`[TTSPlayback] Starting playback from index ${startIndex}`);
      
      // Stop any existing playback
      await this.stop();

      // Set state
      this.setState('loading');
      this.currentIndex = startIndex;
      this.chapterId = chapterId;
      this.novelId = novelId;
      this.voiceSettings = settings;

      // Start foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        'Loading...',
        '',
        false
      );

      // Start preloading
      this.preloader.preloadChapter(textElements, settings);
      
      // Build queue
      this.queue = textElements.map((text, index) => ({
        index,
        text,
        status: 'pending',
      }));

      // Emit progress
      this.emitProgress();

      // Wait for first element to be ready, then play
      // The preloader will emit 'ready' event which triggers playback
    } catch (error) {
      console.error('[TTSPlayback] Play error:', error);
      this.emitError('Failed to start playback', 'PLAY_ERROR');
      this.setState('idle');
    }
  }

  /**
   * Pause playback (true pause, can resume from exact position)
   */
  async pause(): Promise<void> {
    try {
      if (this.state !== 'playing') return;

      await this.currentSound?.pauseAsync();
      this.setState('paused');
      
      // Update foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        this.queue[this.currentIndex]?.text.substring(0, 50) + '...' || 'Paused',
        '',
        false
      );

      console.log('[TTSPlayback] Paused');
    } catch (error) {
      console.error('[TTSPlayback] Pause error:', error);
      this.emitError('Failed to pause', 'PAUSE_ERROR');
    }
  }

  /**
   * Resume playback from paused state
   */
  async resume(): Promise<void> {
    try {
      if (this.state !== 'paused') return;

      await this.currentSound?.playAsync();
      this.setState('playing');
      
      // Update foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        this.queue[this.currentIndex]?.text.substring(0, 50) + '...' || 'Playing',
        '',
        true
      );

      console.log('[TTSPlayback] Resumed');
    } catch (error) {
      console.error('[TTSPlayback] Resume error:', error);
      this.emitError('Failed to resume', 'RESUME_ERROR');
    }
  }

  /**
   * Stop playback and cleanup
   */
  async stop(): Promise<void> {
    try {
      console.log('[TTSPlayback] Stopping playback');

      // Stop current sound
      if (this.currentSound) {
        await this.currentSound.unloadAsync();
        this.currentSound = null;
      }

      // Cancel preloading
      await this.preloader.cancelPreloading();

      // Stop foreground service
      NativeTTSForegroundService.stopService();

      // Reset state
      this.setState('stopped');
      this.currentIndex = -1;
      this.queue = [];
      
      this.emit('queueEnd', { type: 'queueEnd', reason: 'stopped' });

      // Return to idle
      setTimeout(() => this.setState('idle'), 100);
    } catch (error) {
      console.error('[TTSPlayback] Stop error:', error);
    }
  }

  /**
   * Seek to specific element index
   */
  async seek(index: number): Promise<void> {
    try {
      if (index < 0 || index >= this.queue.length) {
        console.warn(`[TTSPlayback] Invalid seek index: ${index}`);
        return;
      }

      console.log(`[TTSPlayback] Seeking to index ${index}`);

      // Unload current sound
      if (this.currentSound) {
        await this.currentSound.unloadAsync();
        this.currentSound = null;
      }

      // Update index
      this.currentIndex = index;
      
      // Ensure buffer ahead
      await this.preloader.ensureBufferAhead(index);

      // Play new element
      if (this.state === 'playing' || this.state === 'paused') {
        await this.playCurrentElement();
      }

      this.emitProgress();
    } catch (error) {
      console.error('[TTSPlayback] Seek error:', error);
      this.emitError('Failed to seek', 'SEEK_ERROR');
    }
  }

  /**
   * Play next element
   */
  async next(): Promise<void> {
    if (this.currentIndex >= this.queue.length - 1) {
      // End of queue
      this.emit('queueEnd', { type: 'queueEnd', reason: 'completed' });
      await this.stop();
      return;
    }

    await this.seek(this.currentIndex + 1);
  }

  /**
   * Play previous element
   */
  async previous(): Promise<void> {
    if (this.currentIndex <= 0) {
      console.warn('[TTSPlayback] Already at first element');
      return;
    }

    await this.seek(this.currentIndex - 1);
  }

  /**
   * Rewind - replay current element from beginning
   */
  async rewind(): Promise<void> {
    if (this.currentSound) {
      await this.currentSound.setPositionAsync(0);
    } else {
      await this.seek(this.currentIndex);
    }
  }

  /**
   * Play current element (internal method)
   */
  private async playCurrentElement(): Promise<void> {
    try {
      const item = this.queue[this.currentIndex];
      if (!item) {
        console.error('[TTSPlayback] No item at current index');
        return;
      }

      // Check if audio is ready
      if (!this.preloader.isAudioReady(this.currentIndex)) {
        console.log(`[TTSPlayback] Waiting for audio at index ${this.currentIndex}`);
        this.emit('audioLoading', { type: 'audioLoading', index: this.currentIndex });
        // Audio will auto-play when preloader emits 'ready' event
        return;
      }

      const uri = this.preloader.getAudioUri(this.currentIndex);
      if (!uri) {
        console.error('[TTSPlayback] No URI for current element');
        await this.next();
        return;
      }

      // Unload previous sound
      if (this.currentSound) {
        await this.currentSound.unloadAsync();
        this.currentSound = null;
      }

      // Load and play new sound
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        this.onPlaybackStatusUpdate.bind(this)
      );

      this.currentSound = sound;
      this.setState('playing');

      // Update UI
      this.emit('elementChange', {
        type: 'elementChange',
        index: this.currentIndex,
        text: item.text,
      });
      this.emitProgress();

      // Update foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        item.text.substring(0, 50) + '...',
        '',
        true
      );

      // Ensure buffer ahead during playback
      await this.preloader.ensureBufferAhead(this.currentIndex);

      console.log(`[TTSPlayback] Playing index ${this.currentIndex}`);
    } catch (error) {
      console.error('[TTSPlayback] Play element error:', error);
      this.emitError('Failed to play element', 'PLAY_ELEMENT_ERROR');
      // Try to skip to next
      await this.next();
    }
  }

  /**
   * Handle playback status updates from expo-av
   */
  private onPlaybackStatusUpdate(status: AVPlaybackStatus): void {
    if (!status.isLoaded) return;

    if (status.didJustFinish) {
      console.log(`[TTSPlayback] Element ${this.currentIndex} finished`);
      // Auto-advance to next
      this.next();
    }
  }

  /**
   * Set voice settings (can be changed during playback)
   */
  setVoiceSettings(settings: VoiceSettings): void {
    this.voiceSettings = settings;
    // Note: Changes will apply to next generated audio files
  }

  /**
   * Get current state
   */
  getState(): PlaybackState {
    return this.state;
  }

  /**
   * Get current index
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Check if playing
   */
  isPlaying(): boolean {
    return this.state === 'playing';
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.state === 'paused';
  }

  /**
   * Set state and emit event
   */
  private setState(newState: PlaybackState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', {
        type: 'stateChange',
        state: newState,
        index: this.currentIndex,
      });
      console.log(`[TTSPlayback] State: ${newState}`);
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(): void {
    this.emit('progress', {
      type: 'progress',
      current: this.currentIndex + 1,
      total: this.queue.length,
    });
  }

  /**
   * Emit error event
   */
  private emitError(message: string, code: string): void {
    this.emit('error', {
      type: 'error',
      message,
      code,
    });
  }
}

// Export singleton instance
export const ttsPlaybackManager = TTSPlaybackManager.getInstance();
export default TTSPlaybackManager;
