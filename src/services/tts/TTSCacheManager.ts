/**
 * TTSCacheManager - LRU Cache for TTS Audio Files
 * 
 * Manages a Least Recently Used (LRU) cache for generated TTS audio files
 * to avoid redundant synthesis and improve performance.
 */

import { File, Directory, Paths } from 'expo-file-system';

export interface CacheMetadata {
  key: string;
  uri: string;
  size: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  voice: string;
  engine: 'expo' | 'microsoft';
  text: string;  // Store first 100 chars for debugging
}

export interface CacheStats {
  size: number;  // Total size in bytes
  itemCount: number;
  hitRate: number;  // Percentage (0-100)
  hits: number;
  misses: number;
}

interface VoiceSettings {
  voice: string;
  pitch?: number;
  rate?: number;
  engine: 'expo' | 'microsoft';
}

class TTSCacheManager {
  private static instance: TTSCacheManager;
  private cacheDirectory: Directory;
  private metadataFileRef: File;
  // String version of cache directory URI for prefix comparisons
  private cacheDir: string;
  private metadata: Map<string, CacheMetadata> = new Map();
  private maxCacheSize: number = 100 * 1024 * 1024; // 100MB default
  private currentCacheSize: number = 0;
  private hits: number = 0;
  private misses: number = 0;
  // Promise that resolves once initialize() has finished loading metadata from disk.
  // All public methods await this before touching the metadata map, preventing cache
  // misses during the async initialization window (e.g. after JS hot reload).
  private readonly ready: Promise<void>;

  private constructor() {
    // Use new File/Directory API — avoids manual file:// URI string concatenation
    this.cacheDirectory = new Directory(Paths.cache, 'tts', 'cache');
    this.cacheDir = this.cacheDirectory.uri;
    this.metadataFileRef = new File(this.cacheDirectory, 'metadata.json');
    console.log(`[TTSCacheManager] Cache directory: ${this.cacheDir}`);
    this.ready = this.initialize();
  }

  static getInstance(): TTSCacheManager {
    if (!TTSCacheManager.instance) {
      TTSCacheManager.instance = new TTSCacheManager();
    }
    return TTSCacheManager.instance;
  }

  private async initialize(): Promise<void> {
    try {
      console.log(`[TTSCacheManager] Initializing cache at: ${this.cacheDir}`);

      // Directory.exists and .create() are synchronous in the new API
      if (!this.cacheDirectory.exists) {
        this.cacheDirectory.create({ intermediates: true });
        console.log('[TTSCacheManager] Cache directory created');
      } else {
        console.log('[TTSCacheManager] Cache directory already exists');
      }

      // Load metadata
      await this.loadMetadata();

      // Calculate current cache size
      await this.calculateCacheSize();

      console.log(`[TTSCacheManager] Initialized: ${this.metadata.size} items, ${this.formatBytes(this.currentCacheSize)} used (max ${this.formatBytes(this.maxCacheSize)})`);
    } catch (error) {
      console.error(`[TTSCacheManager] initialize() failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate a cache key from text and voice settings
   */
  generateKey(text: string, settings: VoiceSettings): string {
    const normalized = text.trim().toLowerCase();
    const voiceKey = `${settings.engine}_${settings.voice}_${settings.pitch || 1.0}_${settings.rate || 1.0}`;
    
    // Simple hash function
    let hash = 0;
    const combined = normalized + voiceKey;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      // eslint-disable-next-line no-bitwise
      hash = ((hash << 5) - hash) + char;
      // eslint-disable-next-line no-bitwise
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return `${Math.abs(hash).toString(36)}`;
  }

  /**
   * Get cached audio URI if exists
   */
  async get(key: string): Promise<string | null> {
    await this.ready;
    try {
      const meta = this.metadata.get(key);
      if (!meta) {
        this.misses++;
        return null;
      }

      // File.exists is a synchronous property in the new API
      const cachedFile = new File(meta.uri);
      if (!cachedFile.exists) {
        console.warn(`[TTSCacheManager] Cached file missing, evicting key=${key}, uri=${meta.uri}`);
        this.metadata.delete(key);
        this.saveMetadata();
        this.misses++;
        return null;
      }

      // Update access metadata (LRU)
      meta.lastAccessedAt = Date.now();
      meta.accessCount++;
      this.metadata.set(key, meta);
      this.saveMetadata();

      this.hits++;
      console.log(`[TTSCacheManager] Cache hit: key=${key}, uri=${meta.uri}, accessCount=${meta.accessCount}`);
      return meta.uri;
    } catch (error) {
      console.error(`[TTSCacheManager] get(${key}) failed: ${error instanceof Error ? error.message : String(error)}`);
      this.misses++;
      return null;
    }
  }

  /**
   * Store audio file in cache
   */
  async set(key: string, uri: string, settings: VoiceSettings, text: string): Promise<void> {
    await this.ready;
    try {
      console.log(`[TTSCacheManager] set: key=${key}, engine=${settings.engine}, uri=${uri}`);

      // File.exists and .info() are synchronous in the new API
      const sourceFile = new File(uri);
      if (!sourceFile.exists) {
        throw new Error(`Source audio file does not exist: ${uri}`);
      }

      const fileInfo = sourceFile.info();
      const size = fileInfo.size || 0;
      console.log(`[TTSCacheManager] set: source size=${this.formatBytes(size)}`);

      // Check if we need to prune
      if (this.currentCacheSize + size > this.maxCacheSize) {
        console.log(`[TTSCacheManager] Cache full (${this.formatBytes(this.currentCacheSize)} / ${this.formatBytes(this.maxCacheSize)}), pruning...`);
        await this.pruneToSize(this.maxCacheSize - size);
      }

      // Copy file to cache directory if not already there.
      // Preserve the original extension: WAV for expo engine, MP3 for microsoft.
      //
      // NOTE: Kotlin's file.toURI().toString() returns `file:/path` (one slash) while
      // expo-file-system uses `file:///path` (three slashes). The startsWith check can
      // therefore fail for legitimately cached files returned from the native module.
      // We therefore ALSO check whether the destination already exists before copying —
      // File.copy() throws FileAlreadyExistsException if the destination is present.
      let cachedUri = uri;
      if (!uri.startsWith(this.cacheDir)) {
        const ext = uri.split('.').pop() || 'wav';
        const cachedFile = new File(this.cacheDirectory, `${key}.${ext}`);
        if (cachedFile.exists) {
          // File already present in cache (e.g. metadata was reset by hot reload but
          // files survived, or race between two preloader calls for the same key).
          console.log(`[TTSCacheManager] Destination already exists, reusing: ${cachedFile.uri}`);
        } else {
          console.log(`[TTSCacheManager] Copying to cache: ${uri} → ${cachedFile.uri}`);
          sourceFile.copy(cachedFile);
        }
        cachedUri = cachedFile.uri;
      }

      // Create metadata
      const meta: CacheMetadata = {
        key,
        uri: cachedUri,
        size,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        voice: settings.voice,
        engine: settings.engine,
        text: text.substring(0, 100),  // Store first 100 chars
      };

      this.metadata.set(key, meta);
      this.currentCacheSize += size;
      this.saveMetadata();
      console.log(`[TTSCacheManager] set complete: key=${key}, cachedUri=${cachedUri}, totalCacheSize=${this.formatBytes(this.currentCacheSize)}`);

    } catch (error) {
      console.error(`[TTSCacheManager] set(${key}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if key exists in cache
   */
  async has(key: string): Promise<boolean> {
    await this.ready;
    const uri = await this.get(key);
    return uri !== null;
  }

  /**
   * Delete specific cache entry
   */
  async delete(key: string): Promise<void> {
    await this.ready;
    try {
      const meta = this.metadata.get(key);
      if (!meta) return;

      // File.exists and .delete() are synchronous in the new API
      const f = new File(meta.uri);
      if (f.exists) {
        f.delete();
        console.log(`[TTSCacheManager] Deleted cache file: key=${key}, uri=${meta.uri}`);
      } else {
        console.warn(`[TTSCacheManager] delete(${key}): file already gone: ${meta.uri}`);
      }

      // Update metadata
      this.currentCacheSize -= meta.size;
      this.metadata.delete(key);
      this.saveMetadata();

    } catch (error) {
      console.error(`[TTSCacheManager] delete(${key}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Clear entire cache
   */
  async clear(): Promise<void> {
    await this.ready;
    try {
      console.log('[TTSCacheManager] Clearing entire cache...');

      // Delete and recreate directory (synchronous in new API)
      if (this.cacheDirectory.exists) {
        this.cacheDirectory.delete();
      }
      this.cacheDirectory.create({ intermediates: true });

      // Reset state
      this.metadata.clear();
      this.currentCacheSize = 0;
      this.hits = 0;
      this.misses = 0;
      this.saveMetadata();

      console.log('[TTSCacheManager] Cache cleared successfully');
    } catch (error) {
      console.error(`[TTSCacheManager] clear() failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Prune cache to fit within size limit using LRU strategy
   */
  async prune(): Promise<number> {
    return this.pruneToSize(this.maxCacheSize);
  }

  /**
   * Prune cache until it's under the target size
   */
  private async pruneToSize(targetSize: number): Promise<number> {
    if (this.currentCacheSize <= targetSize) {
      return 0;
    }

    // Sort by last accessed (oldest first)
    const entries = Array.from(this.metadata.values()).sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt
    );

    let freedSpace = 0;
    const toRemove: string[] = [];

    for (const entry of entries) {
      if (this.currentCacheSize - freedSpace <= targetSize) {
        break;
      }
      toRemove.push(entry.key);
      freedSpace += entry.size;
    }

    // Delete files
    for (const key of toRemove) {
      await this.delete(key);
    }

    return toRemove.length;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? (this.hits / totalRequests) * 100 : 0;

    return {
      size: this.currentCacheSize,
      itemCount: this.metadata.size,
      hitRate: Math.round(hitRate * 100) / 100,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /**
   * Get current cache size in bytes
   */
  getSize(): number {
    return this.currentCacheSize;
  }

  /**
   * Get number of cached items
   */
  getItemCount(): number {
    return this.metadata.size;
  }

  /**
   * Set maximum cache size
   */
  setMaxSize(bytes: number): void {
    this.maxCacheSize = bytes;
    // Prune if necessary
    this.pruneToSize(bytes);
  }

  /**
   * Load metadata from file
   */
  private async loadMetadata(): Promise<void> {
    try {
      // File.exists is synchronous in the new API
      if (this.metadataFileRef.exists) {
        // text() is async
        const content = await this.metadataFileRef.text();
        const data = JSON.parse(content) as {
          entries?: Record<string, CacheMetadata>;
          hits?: number;
          misses?: number;
        };

        this.metadata = new Map(
          Object.entries(data.entries || {}).map(([k, v]) => [k, v])
        );
        this.hits = data.hits || 0;
        this.misses = data.misses || 0;
        console.log(`[TTSCacheManager] Loaded metadata: ${this.metadata.size} entries, hits=${this.hits}, misses=${this.misses}`);
      } else {
        console.log('[TTSCacheManager] No existing metadata file, starting fresh');
        this.metadata = new Map();
      }
    } catch (error) {
      console.error(`[TTSCacheManager] loadMetadata() failed: ${error instanceof Error ? error.message : String(error)}`);
      this.metadata = new Map();
    }
  }

  /**
   * Save metadata to file (synchronous write via new File API)
   */
  private saveMetadata(): void {
    try {
      const data = {
        entries: Object.fromEntries(this.metadata),
        hits: this.hits,
        misses: this.misses,
        lastUpdated: Date.now(),
      };
      // File.write() is synchronous in the new API
      this.metadataFileRef.write(JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`[TTSCacheManager] saveMetadata() failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Calculate total cache size by summing file sizes
   */
  private async calculateCacheSize(): Promise<void> {
    try {
      let total = 0;
      for (const meta of this.metadata.values()) {
        total += meta.size;
      }
      this.currentCacheSize = total;
      console.log(`[TTSCacheManager] Calculated cache size: ${this.formatBytes(this.currentCacheSize)}`);
    } catch (error) {
      console.error(`[TTSCacheManager] calculateCacheSize() failed: ${error instanceof Error ? error.message : String(error)}`);
      this.currentCacheSize = 0;
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }
}

// Export singleton instance
export const ttsCacheManager = TTSCacheManager.getInstance();
