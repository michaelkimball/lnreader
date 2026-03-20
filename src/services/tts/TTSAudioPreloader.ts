/**
 * TTSAudioPreloader - Progressive Audio Preloading Service
 * 
 * Implements progressive preloading strategy:
 * 1. Generate first 5 elements with high priority (fast startup)
 * 2. Generate remaining elements in background
 * 3. During playback, maintain buffer of N elements ahead
 * 4. Retry failed generations with exponential backoff
 */

import { EventEmitter } from 'events';
import TTSAudioGenerator, { VoiceSettings, GenerationResult } from './TTSAudioGenerator';

export interface TTSQueueItem {
  index: number;
  text: string;
  uri?: string;
  cached?: boolean;
  status: 'pending' | 'generating' | 'ready' | 'error';
  error?: string;
  retryCount?: number;
}

export interface PreloadOptions {
  priorityCount?: number;  // Number of items to load with priority (default: 5)
  bufferSize?: number;     // Maintain N elements ahead during playback (default: 3)
  maxRetries?: number;     // Max retry attempts per item (default: 3)
  retryDelay?: number;     // Base retry delay in ms (default: 1000)
  concurrency?: number;    // Parallel generations (default: 2 for priority, 10 for background)
}

export interface PreloadProgress {
  completed: number;
  total: number;
  percentage: number;
  cached: number;
  generated: number;
  failed: number;
}

class TTSAudioPreloader extends EventEmitter {
  private queue: TTSQueueItem[] = [];
  private settings: VoiceSettings | null = null;
  private options: Required<PreloadOptions>;
  private isPreloading: boolean = false;
  private isCancelled: boolean = false;
  private stats = {
    completed: 0,
    cached: 0,
    generated: 0,
    failed: 0,
  };

  constructor() {
    super();
    this.options = {
      priorityCount: 5,
      bufferSize: 3,
      maxRetries: 3,
      retryDelay: 1000,
      concurrency: 2,
    };
  }

  /**
   * Start preloading a chapter's audio
   */
  async preloadChapter(
    textElements: string[],
    settings: VoiceSettings,
    options?: Partial<PreloadOptions>
  ): Promise<void> {
    // Merge options
    this.options = { ...this.options, ...options };
    this.settings = settings;
    this.queue = textElements.map((text, index) => ({
      index,
      text,
      status: 'pending',
      retryCount: 0,
    }));
    this.isPreloading = true;
    this.isCancelled = false;
    this.resetStats();

    try{
      // Phase 1: Priority elements (first N)
      await this.preloadPriority();

      if (this.isCancelled) return;

      // Phase 2: Remaining elements in background
      await this.preloadBackground();

      if (!this.isCancelled) {
        this.emit('complete', { type: 'complete', stats: this.getProgress() });
      }
    } catch (error) {
      throw error;
    } finally {
      this.isPreloading = false;
    }
  }

  /**
   * Ensure buffer is maintained ahead of current playback position
   */
  async ensureBufferAhead(currentIndex: number): Promise<void> {
    if (!this.settings || !this.isPreloading) return;

    const targetIndex = currentIndex + this.options.bufferSize;
    const pendingItems = this.queue.filter(
      item => item.index > currentIndex && item.index <= targetIndex && item.status === 'pending'
    );

    if (pendingItems.length > 0) {
      await this.generateBatch(pendingItems, 2);  // Higher priority, low concurrency
    }
  }

  /**
   * Check if audio is ready for an index
   */
  isAudioReady(index: number): boolean {
    const item = this.queue[index];
    return item?.status === 'ready' && !!item.uri;
  }

  /**
   * Get audio URI for an index
   */
  getAudioUri(index: number): string | undefined {
    const item = this.queue[index];
    return item?.status === 'ready' ? item.uri : undefined;
  }

  /**
   * Get preloading progress
   */
  getProgress(): PreloadProgress {
    const total = this.queue.length;
    const completed = this.stats.completed;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      completed,
      total,
      percentage,
      cached: this.stats.cached,
      generated: this.stats.generated,
      failed: this.stats.failed,
    };
  }

  /**
   * Cancel ongoing preloading
   */
  async cancelPreloading(): Promise<void> {
    this.isCancelled = true;
    this.isPreloading = false;
  }

  /**
   * Reset the queue and stats
   */
  reset(): void {
    this.queue = [];
    this.settings = null;
    this.isPreloading = false;
    this.isCancelled = false;
    this.resetStats();
  }

  /**
   * Preload priority elements (first N)
   */
  private async preloadPriority(): Promise<void> {
    const priorityItems = this.queue.slice(0, this.options.priorityCount);
    
    await this.generateBatch(priorityItems, 2);  // Low concurrency for priority
    
    // Emit 'ready' event after first element is ready
    const firstReady = this.queue.find(item => item.status === 'ready');
    if (firstReady) {
      this.emit('ready', { type: 'ready', index: firstReady.index, uri: firstReady.uri! });
    }
  }

  /**
   * Preload remaining elements in background
   */
  private async preloadBackground(): Promise<void> {
    const remainingItems = this.queue.filter(item => item.status === 'pending');
    if (remainingItems.length === 0) return;

    await this.generateBatch(remainingItems, 10);  // Higher concurrency for background
  }

  /**
   * Generate audio for a batch of items with controlled concurrency
   */
  private async generateBatch(items: TTSQueueItem[], concurrency: number): Promise<void> {
    const chunks: TTSQueueItem[][] = [];
    for (let i = 0; i < items.length; i += concurrency) {
      chunks.push(items.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      if (this.isCancelled) break;
      
      await Promise.all(
        chunk.map(item => this.generateWithRetry(item))
      );

      this.emitProgress();
    }
  }

  /**
   * Generate audio for a single item with retry logic
   */
  private async generateWithRetry(item: TTSQueueItem): Promise<void> {
    if (!this.settings) return;

    let attempt = 0;
    while (attempt <= this.options.maxRetries) {
      if (this.isCancelled) break;

      try {
        item.status = 'generating';
        
        const result: GenerationResult = await TTSAudioGenerator.generateAudio(
          item.text,
          this.settings,
          {
            timeout: 30000,  // 30 second timeout
            fallbackToExpo: true,  // Auto-fallback if Microsoft fails
          }
        );

        item.uri = result.uri;
        item.status = 'ready';
        item.cached = result.cached;

        this.stats.completed++;
        if (result.cached) {
          this.stats.cached++;
        } else {
          this.stats.generated++;
        }

        return;  // Success, exit retry loop
      } catch (error) {
        attempt++;
        item.retryCount = attempt;

        const willRetry = attempt <= this.options.maxRetries;
        this.emit('error', {
          type: 'error',
          index: item.index,
          error: error instanceof Error ? error.message : String(error),
          willRetry,
        });

        if (willRetry) {
          // Exponential backoff
          const delay = this.options.retryDelay * Math.pow(2, attempt - 1);
          this.emit('retrying', {
            type: 'retrying',
            index: item.index,
            attempt,
            maxAttempts: this.options.maxRetries,
          });
          
          await this.sleep(delay);
        } else {
          // Max retries exceeded
          item.status = 'error';
          item.error = error instanceof Error ? error.message : String(error);
          this.stats.failed++;
          this.stats.completed++;
          break;
        }
      }
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(): void {
    this.emit('progress', { type: 'progress', progress: this.getProgress() });
  }

  /**
   * Reset statistics
   */
  private resetStats(): void {
    this.stats = {
      completed: 0,
      cached: 0,
      generated: 0,
      failed: 0,
    };
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default TTSAudioPreloader;
