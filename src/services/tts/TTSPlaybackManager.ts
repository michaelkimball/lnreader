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

import { EventEmitter } from './EventEmitter';
import { Audio, AVPlaybackStatus } from 'expo-av';
import TTSAudioPreloader, { TTSQueueItem } from './TTSAudioPreloader';
import { VoiceSettings } from './TTSAudioGenerator';
import NativeTTSForegroundService from '@specs/NativeTTSForegroundService';
import { getAudioFilePaths, hasCompletedDownload, getElementOffsets, getTTSDownload } from '@database/queries/TTSDownloadQueries';

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
  private idleTimer: NodeJS.Timeout | null = null;
  private isStopping: boolean = false;
  private isOfflineMode: boolean = false; // Track if playing from offline files
  private elementOffsets: number[] = []; // ms start time of each text element (offline mode)
  private lastEmittedElementIndex: number = -1;

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
    } catch {
      // Error handling
    }
  }

  /**
   * Setup preloader event listeners
   */
  private setupPreloaderListeners(): void {
    this.preloader.on('ready', (event) => {
      console.log('[TTSPlaybackManager] Received ready event:', event);
      console.log('[TTSPlaybackManager] Current state:', this.state, 'currentIndex:', this.currentIndex);
      
      if (event.type === 'ready') {
        this.emit('audioReady', { type: 'audioReady', index: event.index, uri: event.uri });
        
        // Auto-start playback if we're loading first element
        console.log('[TTSPlaybackManager] Checking condition: state=', this.state, 'event.index=', event.index, 'currentIndex=', this.currentIndex);
        
        const currentIndexReady = this.preloader.isAudioReady(this.currentIndex);
        if (this.state === 'loading' && (event.index === this.currentIndex || currentIndexReady)) {
          console.log('[TTSPlaybackManager] Auto-starting playback for index', this.currentIndex, '(triggered by ready event for index', event.index, ')');
          this.playCurrentElement();
        } else {
          console.log('[TTSPlaybackManager] NOT auto-starting. state=', this.state, 'event.index=', event.index, 'currentIndex=', this.currentIndex, 'currentIndexReady=', currentIndexReady);
        }
      }
    });

    this.preloader.on('progress', (event) => {
      if (event.type === 'progress') {
        // Progress update
      }
    });

    this.preloader.on('error', (event) => {
      if (event.type === 'error') {
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
    console.log('🔥🔥🔥 [TTSPlaybackManager] HOT RELOAD TEST - play() called with', textElements.length, 'elements, current state:', this.state);
    
    // Prevent re-entrant calls when already loading or playing
    // This stops the WebView from interrupting playback with rapid 'speak' events
    if (this.state === 'loading' || this.state === 'playing') {
      console.log('[TTSPlaybackManager] Already in state:', this.state, '- ignoring play() call');
      return;
    }
    
    try {
      // Stop any existing playback (pass true to skip idle timer)
      await this.stop(true);

      // Clear any pending idle timer from stop() - must do this AFTER stop()
      console.log('[TTSPlaybackManager] Checking for idle timer after stop()...');
      if (this.idleTimer) {
        console.log('[TTSPlaybackManager] Clearing idle timer!');
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      } else {
        console.log('[TTSPlaybackManager] No idle timer to clear');
      }

      // Set state
      console.log('[TTSPlaybackManager] Setting state to loading, index to', startIndex);
      this.setState('loading');
      this.currentIndex = startIndex;
      this.chapterId = chapterId;
      this.novelId = novelId;
      this.voiceSettings = settings;
      this.isOfflineMode = false;

      console.log('[TTSPlaybackManager] Starting foreground service...');
      // Start foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        'Loading...',
        '',
        false
      );

      // TODO: Phase 2 - Check for offline downloaded audio
      const hasOfflineAudio = await hasCompletedDownload(chapterId);
      if (hasOfflineAudio) {
        const audioFiles = await getAudioFilePaths(chapterId);
        if (audioFiles && audioFiles.length > 0) {
          console.log('[TTSPlaybackManager] Playing from offline files:', audioFiles.length, 'files');
          return this.playFromOfflineFiles(audioFiles, startIndex, chapterId, novelId, textElements);
        }
      }

      console.log('[TTSPlaybackManager] Starting preloader...');
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

      console.log('[TTSPlaybackManager] Waiting for preloader ready event...');
      // Wait for first element to be ready, then play
      // The preloader will emit 'ready' event which triggers playback
    } catch (error) {
      console.error('[TTSPlaybackManager] Error in play():', error);
      this.emitError('Failed to start playback', 'PLAY_ERROR');
      this.setState('idle');
    }
  }

  /**
   * Play from pre-downloaded offline audio files
   * Bypass preloader and play directly from local file URIs
   * 
   * @param audioFilePaths - Array of local file paths to MP3 files
   * @param startIndex - Index to start playback from
   * @param chapterId - Chapter ID for tracking
   * @param novelId - Novel ID for tracking
   * @param textElements - Optional text elements for display (can be empty for offline mode)
   */
  async playFromOfflineFiles(
    audioFilePaths: string[],
    startIndex: number = 0,
    chapterId: number,
    novelId: number,
    textElements: string[] = []
  ): Promise<void> {
    console.log('[TTSPlaybackManager] playFromOfflineFiles() called with', audioFilePaths.length, 'files');
    
    // Prevent re-entrant calls when already playing (loading is OK — play() sets it before calling us)
    if (this.state === 'playing') {
      console.log('[TTSPlaybackManager] Already playing - ignoring playFromOfflineFiles() call');
      return;
    }
    
    try {
      // Stop any existing playback
      await this.stop(true);

      // Clear any pending idle timer
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }

      // Set state and offline mode flag
      // currentIndex always refers to the audio file index (0 for single-file offline mode).
      // startIndex is the text element to begin at — used for seeking and offset initialisation.
      console.log('[TTSPlaybackManager] Setting state to loading for offline playback, startIndex:', startIndex);
      this.setState('loading');
      this.currentIndex = 0;
      this.chapterId = chapterId;
      this.novelId = novelId;
      this.isOfflineMode = true;

      // Load element timing offsets for position-based element tracking
      this.elementOffsets = [];
      this.lastEmittedElementIndex = startIndex - 1; // so the first emitted change is the right element
      try {
        const download = await getTTSDownload(chapterId);
        console.log('[TTSPlaybackManager] Offline download voice settings - rate:', download?.voiceRate, 'pitch:', download?.voicePitch, 'voice:', download?.voiceName);
        const offsets = await getElementOffsets(chapterId);
        if (offsets && offsets.length > 0) {
          this.elementOffsets = offsets;
          console.log('[TTSPlaybackManager] Loaded', offsets.length, 'element offsets for position tracking');
        }
      } catch (e) {
        console.warn('[TTSPlaybackManager] Failed to load element offsets:', e);
      }

      // Start foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        'Playing offline audio...',
        '',
        false
      );

      // Build queue from file paths (no need for preloader)
      this.queue = audioFilePaths.map((filePath, index) => ({
        index,
        text: textElements[index] || `Element ${index + 1}`, // Use text if available, otherwise placeholder
        status: 'ready', // All files are already available
        uri: filePath, // Store file path directly in queue item
      }));

      console.log('[TTSPlaybackManager] Offline queue built with', this.queue.length, 'items');

      // Emit progress
      this.emitProgress();

      // Start playing immediately (no need to wait for preloader)
      // Pass startIndex so we can seek into the audio if resuming mid-chapter
      await this.playCurrentElementOffline(startIndex);

    } catch (error) {
      console.error('[TTSPlaybackManager] Error in playFromOfflineFiles():', error);
      this.emitError('Failed to start offline playback', 'PLAY_OFFLINE_ERROR');
      this.setState('idle');
    }
  }

  /**
   * Play current element from offline files (internal method)
   * Similar to playCurrentElement() but uses URIs directly from queue
   */
  private async playCurrentElementOffline(startElementIndex: number = 0): Promise<void> {
    console.log('[TTSPlaybackManager] playCurrentElementOffline() called, currentIndex:', this.currentIndex, 'startElementIndex:', startElementIndex);
    try {
      const item = this.queue[this.currentIndex];
      if (!item || !item.uri) {
        console.warn('[TTSPlaybackManager] No item or URI at current index');
        await this.next();
        return;
      }

      const uri = item.uri;
      console.log('[TTSPlaybackManager] Playing offline URI:', uri);

      // Determine seek position from element offsets
      const seekPositionMs = startElementIndex > 0 && this.elementOffsets.length > startElementIndex
        ? this.elementOffsets[startElementIndex]
        : 0;

      // Unload previous sound
      if (this.currentSound) {
        await this.currentSound.unloadAsync();
        this.currentSound = null;
      }

      // Load and play from local file, seeking to start position if resuming
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, positionMillis: seekPositionMs },
        this.onPlaybackStatusUpdate.bind(this)
      );

      this.currentSound = sound;

      // If user pressed pause while we were loading/transitioning, honor it
      if (this.state === 'paused') {
        console.log('[TTSPlaybackManager] State changed to paused during offline load - pausing sound');
        await sound.pauseAsync();
        return;
      }

      console.log('[TTSPlaybackManager] Offline sound created and playing! seekMs:', seekPositionMs);
      this.setState('playing');

      // Update UI — emit the text element we're actually starting at
      const displayIndex = startElementIndex > 0 ? startElementIndex : this.currentIndex;
      this.emit('elementChange', {
        type: 'elementChange',
        index: displayIndex,
        text: item.text,
      });
      this.emitProgress();

      // Update foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        `${item.text.substring(0, 40)}... (offline)`,
        '',
        true
      );

    } catch (error) {
      console.error('[TTSPlaybackManager] Error in playCurrentElementOffline():', error);
      this.emitError('Failed to play offline element', 'PLAY_OFFLINE_ELEMENT_ERROR');
      // Try to skip to next
      await this.next();
    }
  }

  /**
   * Pause playback (true pause, can resume from exact position)
   */
  async pause(): Promise<void> {
    try {
      console.log('[TTSPlaybackManager] pause() called - currentState:', this.state);
      if (this.state !== 'playing') {
        console.log('[TTSPlaybackManager] pause() skipped - not in playing state');
        return;
      }

      await this.currentSound?.pauseAsync();
      this.setState('paused');
      console.log('[TTSPlaybackManager] pause() successful');
      
      // Update foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        this.queue[this.currentIndex]?.text.substring(0, 50) + '...' || 'Paused',
        '',
        false
      );

    } catch {
      this.emitError('Failed to pause', 'PAUSE_ERROR');
    }
  }

  /**
   * Resume playback from paused state
   */
  async resume(): Promise<void> {
    try {
      console.log('[TTSPlaybackManager] resume() called - currentState:', this.state);
      if (this.state !== 'paused') {
        console.log('[TTSPlaybackManager] resume() skipped - not in paused state');
        return;
      }

      if (!this.currentSound) {
        // State is paused but no sound loaded (race condition during element transition)
        // Re-trigger playback from current position; playCurrentElement will honor paused state
        console.log('[TTSPlaybackManager] resume() - no sound, re-loading current element');
        this.setState('loading');
        if (this.isOfflineMode) {
          await this.playCurrentElementOffline(this.currentIndex);
        } else {
          await this.playCurrentElement();
        }
        return;
      }

      await this.currentSound.playAsync();
      this.setState('playing');
      console.log('[TTSPlaybackManager] resume() successful');
      
      // Update foreground service
      NativeTTSForegroundService.startService(
        'LNReader',
        this.queue[this.currentIndex]?.text.substring(0, 50) + '...' || 'Playing',
        '',
        true
      );

    } catch {
      this.emitError('Failed to resume', 'RESUME_ERROR');
    }
  }

  /**
   * Stop playback and cleanup
   */
  async stop(fromPlay: boolean = false): Promise<void> {
    // Prevent recursive calls - ALWAYS block if already stopping
    if (this.isStopping) {
      console.log('[TTSPlaybackManager] stop() already in progress, skipping');
      return;
    }
    
    this.isStopping = true;
    console.log('[TTSPlaybackManager] stop() starting...', fromPlay ? '(from play())' : '');
    
    try {
      // Clear any existing idle timer first
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      
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
      this.isOfflineMode = false;
      this.elementOffsets = [];
      this.lastEmittedElementIndex = -1;
      
      // Only emit queueEnd if this is a real stop (not from play())
      // Otherwise it triggers WebView tts.stop() which resets the WebView's queue
      if (!fromPlay) {
        console.log('[TTSPlaybackManager] Emitting queueEnd with reason=stopped (fromPlay=false)');
        this.emit('queueEnd', { type: 'queueEnd', reason: 'stopped' });
      } else {
        console.log('[TTSPlaybackManager] Skipping queueEnd emission (fromPlay=true)');
      }

      // Only set idle timer if this is a real stop, not called from play()
      if (!fromPlay) {
        console.log('[TTSPlaybackManager] stop() setting idle timer...');
        this.idleTimer = setTimeout(() => {
          console.log('[TTSPlaybackManager] Idle timer fired! Setting state to idle');
          this.setState('idle');
          this.isStopping = false;
        }, 100);
      } else {
        console.log('[TTSPlaybackManager] Skipping idle timer (called from play())');
        this.isStopping = false;
      }
    } catch (error) {
      console.error('[TTSPlaybackManager] Error in stop():', error);
      this.isStopping = false;
    }
  }

  /**
   * Seek to specific element index
   */
  async seek(index: number): Promise<void> {
    console.log('🎯 [TTSPlaybackManager] seek() called with index:', index, 'queue.length:', this.queue.length, 'currentState:', this.state);
    try {
      if (index < 0 || index >= this.queue.length) {
        console.log('[TTSPlaybackManager] seek() index out of bounds, returning');
        return;
      }

      // Unload current sound
      if (this.currentSound) {
        await this.currentSound.unloadAsync();
        this.currentSound = null;
      }

      // Update index
      this.currentIndex = index;
      console.log('[TTSPlaybackManager] seek() - index updated to', index);
      
      // Ensure buffer ahead
      await this.preloader.ensureBufferAhead(index);
      console.log('[TTSPlaybackManager] seek() - buffer ensured');

      // Play new element (use appropriate method based on mode)
      if (this.state === 'playing' || this.state === 'paused') {
        console.log('[TTSPlaybackManager] seek() - state is', this.state, '- calling play method');
        if (this.isOfflineMode) {
          await this.playCurrentElementOffline();
        } else {
          await this.playCurrentElement();
        }
      } else {
        console.log('[TTSPlaybackManager] seek() - state is', this.state, '- NOT calling play method');
      }

      this.emitProgress();
      console.log('[TTSPlaybackManager] seek() completed');
    } catch (error) {
      console.error('[TTSPlaybackManager] seek() error:', error);
      this.emitError('Failed to seek', 'SEEK_ERROR');
    }
  }

  /**
   * Play next element
   */
  async next(): Promise<void> {
    if (this.currentIndex >= this.queue.length - 1) {
      // End of current queue - but don't clear it (needed for seek in background mode)
      // Clean up sound
      if (this.currentSound) {
        await this.currentSound.unloadAsync();
        this.currentSound = null;
      }
      this.setState('stopped');
      // Don't clear queue or reset currentIndex - keep them for potential seek() calls
      this.emit('queueEnd', { type: 'queueEnd', reason: 'completed' });
      return;
    }

    await this.seek(this.currentIndex + 1);
  }

  /**
   * Play previous element
   */
  async previous(): Promise<void> {
    if (this.currentIndex <= 0) {
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
    console.log('[TTSPlaybackManager] playCurrentElement() called, currentIndex:', this.currentIndex);
    try {
      const item = this.queue[this.currentIndex];
      if (!item) {
        console.warn('[TTSPlaybackManager] No item at current index');
        return;
      }

      // Check if audio is ready
      const isReady = this.preloader.isAudioReady(this.currentIndex);
      console.log('[TTSPlaybackManager] Audio ready?', isReady);
      
      if (!isReady) {
        this.emit('audioLoading', { type: 'audioLoading', index: this.currentIndex });
        console.log('[TTSPlaybackManager] Audio not ready, waiting...');
        // Audio will auto-play when preloader emits 'ready' event
        return;
      }

      const uri = this.preloader.getAudioUri(this.currentIndex);
      console.log('[TTSPlaybackManager] Got URI:', uri);
      
      if (!uri) {
        console.warn('[TTSPlaybackManager] No URI, skipping to next');
        await this.next();
        return;
      }

      // Unload previous sound
      if (this.currentSound) {
        await this.currentSound.unloadAsync();
        this.currentSound = null;
      }

      console.log('[TTSPlaybackManager] Creating sound from URI...');
      // Load and play new sound
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        this.onPlaybackStatusUpdate.bind(this)
      );

      this.currentSound = sound;

      // If user pressed pause while we were loading/transitioning, honor it
      if (this.state === 'paused') {
        console.log('[TTSPlaybackManager] State changed to paused during load - pausing sound');
        await sound.pauseAsync();
        return;
      }

      console.log('[TTSPlaybackManager] Sound created and playing!');
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

    } catch (error) {
      console.error('[TTSPlaybackManager] Error in playCurrentElement():', error);
      this.emitError('Failed to play element', 'PLAY_ELEMENT_ERROR');
      // Try to skip to next
      await this.next();
    }
  }

  /**
   * Handle playback status updates from expo-av
   */
  private onPlaybackStatusUpdate(status: AVPlaybackStatus): void {
    if (!status.isLoaded) {
      console.log('[TTSPlaybackManager] Status update: not loaded');
      return;
    }

    console.log('[TTSPlaybackManager] Status update:', {
      isPlaying: status.isPlaying,
      positionMillis: status.positionMillis,
      durationMillis: status.durationMillis,
      didJustFinish: status.didJustFinish,
    });

    // Drive element highlighting from audio position in offline single-file mode
    if (status.isLoaded && this.isOfflineMode && this.elementOffsets.length > 0) {
      const posMs = status.positionMillis ?? 0;
      let elementIndex = 0;
      for (let i = this.elementOffsets.length - 1; i >= 0; i--) {
        if (posMs >= this.elementOffsets[i]) {
          elementIndex = i;
          break;
        }
      }
      if (elementIndex !== this.lastEmittedElementIndex) {
        this.lastEmittedElementIndex = elementIndex;
        this.emit('elementChange', {
          type: 'elementChange',
          index: elementIndex,
          text: this.queue[0]?.text || '',
        });
      }
    }

    if (status.didJustFinish) {
      console.log('==================================================');
      console.log('[TTSPlaybackManager] ⚠️ AUDIO FINISHED - ADVANCING TO NEXT');
      console.log('==================================================');
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
