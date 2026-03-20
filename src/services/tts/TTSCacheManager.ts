/**
 * TTSCacheManager - LRU Cache for TTS Audio Files
 * 
 * Manages a Least Recently Used (LRU) cache for generated TTS audio files
 * to avoid redundant synthesis and improve performance.
 */

import * as FileSystem from 'expo-file-system';
import { MMKVLoader } from 'react-native-mmkv-storage';

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
  private cacheDir: string;
  private metadataFile: string;
  private metadata: Map<string, CacheMetadata> = new Map();
  private storage: MMKVLoader;
  private maxCacheSize: number = 100 * 1024 * 1024; // 100MB default
  private currentCacheSize: number = 0;
  private hits: number = 0;
  private misses: number = 0;

  private constructor() {
    this.cacheDir = `${FileSystem.cacheDirectory}tts/cache/`;
    this.metadataFile = `${this.cacheDir}metadata.json`;
    this.storage = new MMKVLoader().initialize();
    this.initialize();
  }

  static getInstance(): TTSCacheManager {
    if (!TTSCacheManager.instance) {
      TTSCacheManager.instance = new TTSCacheManager();
    }
    return TTSCacheManager.instance;
  }

  private async initialize(): Promise<void> {
    try {
      // Ensure cache directory exists
      const dirInfo = await FileSystem.getInfoAsync(this.cacheDir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(this.cacheDir, { intermediates: true });
      }

      // Load metadata
      await this.loadMetadata();
      
      // Calculate current cache size
      await this.calculateCacheSize();
      
      console.log(`[TTSCache] Initialized with ${this.metadata.size} items, ${this.formatBytes(this.currentCacheSize)}`);
    } catch (error) {
      console.error('[TTSCache] Initialization error:', error);
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
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return `${Math.abs(hash).toString(36)}`;
  }

  /**
   * Get cached audio URI if exists
   */
  async get(key: string): Promise<string | null> {
    try {
      const meta = this.metadata.get(key);
      if (!meta) {
        this.misses++;
        return null;
      }

      // Check if file still exists
      const fileInfo = await FileSystem.getInfoAsync(meta.uri);
      if (!fileInfo.exists) {
        console.warn(`[TTSCache] Cached file missing for key ${key}, removing from metadata`);
        this.metadata.delete(key);
        await this.saveMetadata();
        this.misses++;
        return null;
      }

      // Update access metadata (LRU)
      meta.lastAccessedAt = Date.now();
      meta.accessCount++;
      this.metadata.set(key, meta);
      await this.saveMetadata();

      this.hits++;
      console.log(`[TTSCache] Hit for key ${key} (${meta.text.substring(0, 50)}...)`);
      return meta.uri;
    } catch (error) {
      console.error('[TTSCache] Get error:', error);
      this.misses++;
      return null;
    }
  }

  /**
   * Store audio file in cache
   */
  async set(key: string, uri: string, settings: VoiceSettings, text: string): Promise<void> {
    try {
      // Get file size
      const fileInfo = await FileSystem.getInfoAsync(uri);
      if (!fileInfo.exists) {
        throw new Error('File does not exist');
      }

      const size = fileInfo.size || 0;

      // Check if we need to prune
      if (this.currentCacheSize + size > this.maxCacheSize) {
        await this.pruneToSize(this.maxCacheSize - size);
      }

      // Copy file to cache directory if not already there
      let cachedUri = uri;
      if (!uri.startsWith(this.cacheDir)) {
        cachedUri = `${this.cacheDir}${key}.mp3`;
        await FileSystem.copyAsync({
          from: uri,
          to: cachedUri,
        });
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
      await this.saveMetadata();

      console.log(`[TTSCache] Cached ${key} (${this.formatBytes(size)}), total: ${this.formatBytes(this.currentCacheSize)}`);
    } catch (error) {
      console.error('[TTSCache] Set error:', error);
    }
  }

  /**
   * Check if key exists in cache
   */
  async has(key: string): Promise<boolean> {
    const uri = await this.get(key);
    return uri !== null;
  }

  /**
   * Delete specific cache entry
   */
  async delete(key: string): Promise<void> {
    try {
      const meta = this.metadata.get(key);
      if (!meta) return;

      // Delete file
      await FileSystem.deleteAsync(meta.uri, { idempotent: true });

      // Update metadata
      this.currentCacheSize -= meta.size;
      this.metadata.delete(key);
      await this.saveMetadata();

      console.log(`[TTSCache] Deleted ${key}`);
    } catch (error) {
      console.error('[TTSCache] Delete error:', error);
    }
  }

  /**
   * Clear entire cache
   */
  async clear(): Promise<void> {
    try {
      // Delete all cached files
      await FileSystem.deleteAsync(this.cacheDir, { idempotent: true });
      await FileSystem.makeDirectoryAsync(this.cacheDir, { intermediates: true });

      // Reset metadata
      this.metadata.clear();
      this.currentCacheSize = 0;
      this.hits = 0;
      this.misses = 0;
      await this.saveMetadata();

      console.log('[TTSCache] Cache cleared');
    } catch (error) {
      console.error('[TTSCache] Clear error:', error);
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

    console.log(`[TTSCache] Pruned ${toRemove.length} items, freed ${this.formatBytes(freedSpace)}`);
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
      const fileInfo = await FileSystem.getInfoAsync(this.metadataFile);
      if (fileInfo.exists) {
        const content = await FileSystem.readAsStringAsync(this.metadataFile);
        const data = JSON.parse(content);
        
        this.metadata = new Map(
          Object.entries(data.entries || {}).map(([key, value]) => [key, value as CacheMetadata])
        );
        this.hits = data.hits || 0;
        this.misses = data.misses || 0;
      }
    } catch (error) {
      console.error('[TTSCache] Load metadata error:', error);
      this.metadata = new Map();
    }
  }

  /**
   * Save metadata to file
   */
  private async saveMetadata(): Promise<void> {
    try {
      const data = {
        entries: Object.fromEntries(this.metadata),
        hits: this.hits,
        misses: this.misses,
        lastUpdated: Date.now(),
      };
      await FileSystem.writeAsStringAsync(
        this.metadataFile,
        JSON.stringify(data, null, 2)
      );
    } catch (error) {
      console.error('[TTSCache] Save metadata error:', error);
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
    } catch (error) {
      console.error('[TTSCache] Calculate size error:', error);
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
