/**
 * Azure Blob Storage Service for TTS Batch Synthesis
 *
 * Uses the Azure Blob Storage REST API directly with Shared Key authentication
 * via crypto.subtle (Web Crypto API, available in Hermes/React Native).
 * The @azure/storage-blob SDK intentionally stubs out SharedKeyCredential
 * signing in its React Native build, so we bypass it entirely.
 */

import forge from 'node-forge';
import { getMMKVObject } from '@utils/mmkv/mmkv';
import { INTEGRATION_SETTINGS } from '@hooks/persisted/useSettings';
import { IntegrationSettings } from '@type/integrations';
import { ttsLog } from '@utils/logger';

/** HMAC-SHA256 using node-forge (pure JS, works in Hermes/React Native).
 *  key is base64-encoded. Returns base64 signature. */
function hmacSHA256(base64Key: string, message: string): string {
  const keyBytes = forge.util.decode64(base64Key);
  const hmac = forge.hmac.create();
  hmac.start('sha256', keyBytes);
  hmac.update(message);
  return forge.util.encode64(hmac.digest().getBytes());
}

/** Format a Date as ISO-8601 without milliseconds (Azure SAS requirement). */
function isoDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

class AzureBlobStorageService {
  private accountName = '';
  private accountKey = '';
  private containerName = 'tts-inputs';
  private initialized = false;

  initialize(): void {
    try {
      const settings = getMMKVObject<IntegrationSettings>(INTEGRATION_SETTINGS);
      if (!settings?.azureBlobStorage?.enabled) {
        throw new Error('Azure Blob Storage not enabled in settings');
      }
      const { accountName, accountKey, containerName } = settings.azureBlobStorage;
      if (!accountName || !accountKey) {
        throw new Error('Azure Blob Storage credentials missing');
      }
      this.accountName = accountName;
      this.accountKey = accountKey;
      this.containerName = containerName || 'tts-inputs';
      this.initialized = true;
      ttsLog.debug('[AzureBlobStorage] Initialized:', {
        accountName,
        containerName: this.containerName,
      });
    } catch (error) {
      ttsLog.error('[AzureBlobStorage] Initialization failed:', error);
      throw error;
    }
  }

  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Build the Authorization header value for Azure Blob Storage Shared Key auth.
   * https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key
   */
  private sharedKeyHeader(
    method: string,
    blobName: string,
    xmsHeaders: Record<string, string>,
    contentLength = 0,
    contentType = '',
  ): Promise<string> {
    const canonicalizedHeaders = Object.entries(xmsHeaders)
      .map(([k, v]) => `${k.toLowerCase()}:${v}`)
      .sort()
      .join('\n');

    const stringToSign = [
      method,
      '',  // Content-Encoding
      '',  // Content-Language
      method === 'PUT' ? String(contentLength) : '',
      '',  // Content-MD5
      method === 'PUT' ? contentType : '',
      '',  // Date (empty — using x-ms-date instead)
      '',  // If-Modified-Since
      '',  // If-Match
      '',  // If-None-Match
      '',  // If-Unmodified-Since
      '',  // Range
      canonicalizedHeaders,
      `/${this.accountName}/${this.containerName}/${blobName}`,
    ].join('\n');

    const signature = hmacSHA256(this.accountKey, stringToSign);
    return `SharedKey ${this.accountName}:${signature}`;
  }

  /**
   * Upload SSML content to blob storage and return a time-limited SAS URL.
   */
  async uploadSSML(
    ssml: string,
    filename: string,
  ): Promise<{ url: string; filename: string; size: number }> {
    if (!this.isReady()) {
      throw new Error('Azure Blob Storage not initialized. Call initialize() first.');
    }

    const encoded = new TextEncoder().encode(ssml);
    const contentLength = encoded.byteLength;
    const contentType = 'application/xml; charset=utf-8';
    const version = '2020-08-04';
    const date = new Date().toUTCString();

    const xmsHeaders: Record<string, string> = {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-date': date,
      'x-ms-version': version,
    };

    const auth = this.sharedKeyHeader(
      'PUT',
      filename,
      xmsHeaders,
      contentLength,
      contentType,
    );

    const blobUrl = `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${filename}`;
    const response = await fetch(blobUrl, {
      method: 'PUT',
      headers: {
        ...xmsHeaders,
        Authorization: auth,
        'Content-Type': contentType,
        'Content-Length': String(contentLength),
      },
      body: ssml,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Blob upload failed (${response.status}): ${text}`);
    }

    const sasUrl = this.generateSasUrl(filename, 120);
    ttsLog.debug('[AzureBlobStorage] Uploaded:', { filename, size: contentLength });
    return { url: sasUrl, filename, size: contentLength };
  }

  /**
   * Generate a time-limited read-only SAS URL for a blob.
   * https://learn.microsoft.com/en-us/rest/api/storageservices/create-service-sas
   */
  generateSasUrl(filename: string, expiryMinutes = 60): string {
    const version = '2020-08-04';
    const now = new Date();
    const expiry = new Date(now.getTime() + expiryMinutes * 60 * 1000);
    const signedStart = isoDate(now);
    const signedExpiry = isoDate(expiry);

    const stringToSign = [
      'r',                    // signedPermissions
      signedStart,
      signedExpiry,
      `/blob/${this.accountName}/${this.containerName}/${filename}`,
      '',                     // signedIdentifier
      '',                     // signedIP
      'https',                // signedProtocol
      version,
      'b',                    // signedResource (blob)
      '',                     // signedSnapshotTime
      '',                     // signedEncryptionScope
      '', '', '', '', '',     // rscc, rscd, rsce, rscl, rsct
    ].join('\n');

    const signature = hmacSHA256(this.accountKey, stringToSign);
    const params = new URLSearchParams({
      sv: version,
      st: signedStart,
      se: signedExpiry,
      sr: 'b',
      sp: 'r',
      spr: 'https',
      sig: signature,
    });
    return `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${filename}?${params}`;
  }

  /**
   * Delete a blob. Silently ignores 404.
   */
  async deleteFile(filename: string): Promise<void> {
    if (!this.isReady()) return;

    const version = '2020-08-04';
    const date = new Date().toUTCString();
    const xmsHeaders: Record<string, string> = {
      'x-ms-date': date,
      'x-ms-version': version,
    };
    const auth = this.sharedKeyHeader('DELETE', filename, xmsHeaders);
    const blobUrl = `https://${this.accountName}.blob.core.windows.net/${this.containerName}/${filename}`;

    try {
      const response = await fetch(blobUrl, {
        method: 'DELETE',
        headers: { ...xmsHeaders, Authorization: auth },
      });
      if (!response.ok && response.status !== 404) {
        ttsLog.warn('[AzureBlobStorage] Delete failed:', response.status);
      }
    } catch (error) {
      ttsLog.error('[AzureBlobStorage] Delete error:', error);
    }
  }

  async cleanupOldFiles(_olderThanDays = 7): Promise<number> {
    // Listing blobs to find old ones requires additional auth plumbing;
    // not critical for the download flow.
    return 0;
  }
}

export const azureBlobStorage = new AzureBlobStorageService();
