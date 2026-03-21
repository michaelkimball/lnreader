/**
 * Azure Blob Storage Service for TTS Batch Synthesis
 * 
 * Handles uploading SSML input files to Azure Blob Storage
 * and generating publicly accessible URLs for the Batch Synthesis API.
 * 
 * Requirements:
 * - Azure Storage account with blob container
 * - Container must have public blob access OR generate SAS tokens
 * - pnpm add @azure/storage-blob
 */

import {
  BlobServiceClient,
  ContainerClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { getMMKVString } from '@utils/mmkv/mmkv';
import { INTEGRATION_SETTINGS } from '@utils/constants/storage.constants';
import { IntegrationSettings } from '@type/integrations';

interface BlobUploadResult {
  url: string;
  filename: string;
  size: number;
}

class AzureBlobStorageService {
  private containerClient: ContainerClient | null = null;
  private credential: StorageSharedKeyCredential | null = null;
  private accountName: string = '';
  private containerName: string = 'tts-inputs';

  /**
   * Initialize the blob storage client
   * Reads configuration from MMKV integration settings
   */
  initialize(): void {
    try {
      const settingsJson = getMMKVString(INTEGRATION_SETTINGS);
      if (!settingsJson) {
        throw new Error('Integration settings not found');
      }

      const settings: IntegrationSettings = JSON.parse(settingsJson);
      
      if (!settings.azureBlobStorage?.enabled) {
        throw new Error('Azure Blob Storage not enabled in settings');
      }

      const { accountName, accountKey, containerName } = settings.azureBlobStorage;

      if (!accountName || !accountKey) {
        throw new Error('Azure Blob Storage credentials missing');
      }

      this.accountName = accountName;
      this.containerName = containerName || 'tts-inputs';

      // Create credential from account name and key
      this.credential = new StorageSharedKeyCredential(accountName, accountKey);

      // Create blob service client
      const blobServiceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        this.credential
      );

      // Get container client
      this.containerClient = blobServiceClient.getContainerClient(this.containerName);

      console.log('[AzureBlobStorage] Initialized successfully:', { accountName, containerName: this.containerName });
    } catch (error) {
      console.error('[AzureBlobStorage] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Check if the service is initialized and ready
   */
  isReady(): boolean {
    return this.containerClient !== null && this.credential !== null;
  }

  /**
   * Upload SSML content to blob storage and return public URL
   * 
   * @param ssml - SSML content to upload
   * @param filename - Unique filename (e.g., "chapter_123_1234567890.ssml")
   * @param usePublicAccess - If true, return direct blob URL. If false, generate SAS token
   * @returns Upload result with URL and metadata
   */
  async uploadSSML(
    ssml: string,
    filename: string,
    usePublicAccess: boolean = false
  ): Promise<BlobUploadResult> {
    if (!this.isReady()) {
      throw new Error('Azure Blob Storage not initialized. Call initialize() first.');
    }

    try {
      const blockBlobClient = this.containerClient!.getBlockBlobClient(filename);

      // Upload content
      const uploadResponse = await blockBlobClient.upload(ssml, Buffer.byteLength(ssml, 'utf-8'), {
        blobHTTPHeaders: {
          blobContentType: 'application/xml; charset=utf-8',
          blobCacheControl: 'no-cache',
        },
      });

      console.log('[AzureBlobStorage] Uploaded SSML file:', {
        filename,
        size: Buffer.byteLength(ssml, 'utf-8'),
        requestId: uploadResponse.requestId,
      });

      // Generate URL based on access method
      const url = usePublicAccess
        ? blockBlobClient.url
        : await this.generateSasUrl(filename, 120); // 2 hour expiry for batch jobs

      return {
        url,
        filename,
        size: Buffer.byteLength(ssml, 'utf-8'),
      };
    } catch (error) {
      console.error('[AzureBlobStorage] Upload failed:', error);
      throw error;
    }
  }

  /**
   * Generate SAS URL with time-limited read access
   * Use this for private containers to avoid making blobs publicly accessible
   * 
   * @param filename - Blob filename
   * @param expiryMinutes - Minutes until the SAS token expires (default: 60)
   * @returns Full URL with SAS token
   */
  async generateSasUrl(filename: string, expiryMinutes: number = 60): Promise<string> {
    if (!this.isReady() || !this.credential) {
      throw new Error('Azure Blob Storage not initialized');
    }

    try {
      const blockBlobClient = this.containerClient!.getBlockBlobClient(filename);

      // Generate SAS token with read permission
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName: this.containerName,
          blobName: filename,
          permissions: BlobSASPermissions.parse('r'), // Read only
          startsOn: new Date(),
          expiresOn: new Date(Date.now() + expiryMinutes * 60 * 1000),
        },
        this.credential
      ).toString();

      return `${blockBlobClient.url}?${sasToken}`;
    } catch (error) {
      console.error('[AzureBlobStorage] SAS generation failed:', error);
      throw error;
    }
  }

  /**
   * Delete blob file after batch job completes
   * Clean up temporary input files to save storage costs
   * 
   * @param filename - Blob filename to delete
   */
  async deleteFile(filename: string): Promise<void> {
    if (!this.isReady()) {
      console.warn('[AzureBlobStorage] Cannot delete file - not initialized');
      return;
    }

    try {
      const blockBlobClient = this.containerClient!.getBlockBlobClient(filename);
      const deleteResponse = await blockBlobClient.deleteIfExists();

      if (deleteResponse.succeeded) {
        console.log('[AzureBlobStorage] Deleted file:', filename);
      } else {
        console.log('[AzureBlobStorage] File does not exist or already deleted:', filename);
      }
    } catch (error) {
      console.error('[AzureBlobStorage] Delete failed:', error);
      // Don't throw - deletion failure is not critical
    }
  }

  /**
   * Delete multiple files in batch
   * 
   * @param filenames - Array of filenames to delete
   */
  async deleteFiles(filenames: string[]): Promise<void> {
    const deletePromises = filenames.map((filename) => this.deleteFile(filename));
    await Promise.allSettled(deletePromises);
  }

  /**
   * Check if a blob exists
   * 
   * @param filename - Blob filename
   * @returns True if blob exists
   */
  async fileExists(filename: string): Promise<boolean> {
    if (!this.isReady()) {
      return false;
    }

    try {
      const blockBlobClient = this.containerClient!.getBlockBlobClient(filename);
      return await blockBlobClient.exists();
    } catch (error) {
      console.error('[AzureBlobStorage] Exists check failed:', error);
      return false;
    }
  }

  /**
   * List all blobs in the container (for debugging/management)
   * 
   * @param prefix - Optional prefix to filter blobs
   * @returns Array of blob names
   */
  async listFiles(prefix?: string): Promise<string[]> {
    if (!this.isReady()) {
      return [];
    }

    try {
      const blobs: string[] = [];
      const iterator = this.containerClient!.listBlobsFlat({ prefix });

      for await (const blob of iterator) {
        blobs.push(blob.name);
      }

      return blobs;
    } catch (error) {
      console.error('[AzureBlobStorage] List failed:', error);
      return [];
    }
  }

  /**
   * Clean up old blobs (older than specified days)
   * Helps prevent accumulating orphaned files from failed jobs
   * 
   * @param olderThanDays - Delete blobs older than this many days
   */
  async cleanupOldFiles(olderThanDays: number = 7): Promise<number> {
    if (!this.isReady()) {
      return 0;
    }

    try {
      const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
      let deletedCount = 0;

      const iterator = this.containerClient!.listBlobsFlat({ includeMetadata: true });

      for await (const blob of iterator) {
        if (blob.properties.lastModified && blob.properties.lastModified < cutoffDate) {
          await this.deleteFile(blob.name);
          deletedCount++;
        }
      }

      console.log(`[AzureBlobStorage] Cleaned up ${deletedCount} old files`);
      return deletedCount;
    } catch (error) {
      console.error('[AzureBlobStorage] Cleanup failed:', error);
      return 0;
    }
  }
}

// Singleton instance
export const azureBlobStorage = new AzureBlobStorageService();
