# Azure Batch Synthesis API Integration Guide

**Last Updated:** March 2026  
**Azure API Version:** v3.1-preview1  
**Cost:** $4 per 1M characters (66% savings vs real-time API)

---

## Table of Contents

1. [Overview](#overview)
2. [Batch API vs Real-time API](#batch-api-vs-real-time-api)
3. [Azure Blob Storage Requirements](#azure-blob-storage-requirements)
4. [Alternative Storage Solutions](#alternative-storage-solutions)
5. [Implementation Guide](#implementation-guide)
6. [Cost Analysis](#cost-analysis)
7. [Limitations & Workarounds](#limitations--workarounds)

---

## Overview

The **Azure Batch Synthesis API** allows asynchronous bulk generation of TTS audio files. Instead of making individual API calls for each text element, you submit a batch job that processes multiple inputs and returns downloadable audio files.

### Key Benefits

- **66% cost reduction:** $4/1M chars vs $15/1M chars (real-time)
- **No rate limits:** Submit entire novels at once
- **Higher quality:** Batch processing can use premium neural voices
- **Offline preparation:** Download chapters in advance for travel

### Documentation Links

**Official Microsoft Documentation:**
- Batch Synthesis Overview: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-synthesis
- API Reference: https://learn.microsoft.com/en-us/rest/api/speechtotext/batch-synthesis
- Pricing: https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/

---

## Batch API vs Real-time API

| Feature | Real-time API | Batch Synthesis API |
|---------|---------------|---------------------|
| **Endpoint** | `/cognitiveservices/v1` | `/api/texttospeech/v3.1-preview1/batchsynthesis` |
| **Latency** | 200-500ms per request | 1-5 minutes (async) |
| **Cost** | $15/1M chars (Standard) | $4/1M chars (Standard) |
| **Max input size** | ~10KB per request | ~10MB per batch (10,000 inputs) |
| **Rate limits** | 20 requests/sec | No limit (async queue) |
| **Use case** | Immediate playback | Bulk pre-generation |
| **Input format** | SSML or plain text | SSML (must be URL-accessible) |
| **Output** | Audio stream | URLs to download audio files |
| **Processing** | Synchronous | Asynchronous (polling required) |
| **Supported voices** | All neural voices | All neural voices |
| **Output formats** | MP3, WAV, OGG, etc. | Same formats |
| **Job tracking** | N/A | Job ID with status polling |
| **Retention** | Immediate (ephemeral) | Configurable (up to 30 days) |

---

## Azure Blob Storage Requirements

### Why Blob Storage is Needed

The Batch Synthesis API requires **publicly accessible HTTPS URLs** for input text/SSML files. Azure Blob Storage is the recommended solution because:

1. ✅ **Native integration** with Azure Speech Services
2. ✅ **Secure** with SAS tokens for time-limited access
3. ✅ **Reliable** and globally distributed
4. ✅ **Cost-effective** ($0.018/GB storage + $0.001/10k operations)

### Setting Up Azure Blob Storage

#### Step 1: Create Storage Account

**Via Azure Portal:**
```
1. Navigate to: https://portal.azure.com
2. Click "Create a resource" → "Storage account"
3. Fill in details:
   - Subscription: Your subscription
   - Resource group: Select/create resource group (same as Speech Service)
   - Storage account name: lnreadertts (must be globally unique)
   - Region: Same as Speech Service (e.g., eastus)
   - Performance: Standard
   - Redundancy: LRS (Locally-redundant storage) - cheapest option
4. Click "Review + Create" → "Create"
```

**Via Azure CLI:**
```bash
# Login to Azure
az login

# Create resource group (if not exists)
az group create --name lnreader-resources --location eastus

# Create storage account
az storage account create \
  --name lnreadertts \
  --resource-group lnreader-resources \
  --location eastus \
  --sku Standard_LRS
```

**Cost:** ~$0.02 per GB/month + $0.001 per 10,000 operations  
**Expected usage:** < 1 GB for temporary files = **< $1/month**

---

#### Step 2: Create Blob Container

**Via Azure Portal:**
```
1. Navigate to your storage account: lnreadertts
2. Click "Containers" in left menu
3. Click "+ Container"
4. Name: tts-inputs
5. Public access level: Blob (anonymous read access for blobs)
   - OR: Private (use SAS tokens - more secure)
6. Click "Create"
```

**Via Azure CLI:**
```bash
# Create container with blob-level public access
az storage container create \
  --account-name lnreadertts \
  --name tts-inputs \
  --public-access blob
```

---

#### Step 3: Get Connection String

**Via Azure Portal:**
```
1. Navigate to storage account
2. Click "Access keys" in left menu
3. Copy "Connection string" from key1 or key2
4. Save to your app's environment variables
```

**Example Connection String:**
```
DefaultEndpointsProtocol=https;
AccountName=lnreadertts;
AccountKey=abc123...xyz789==;
EndpointSuffix=core.windows.net
```

---

#### Step 4: Install Azure Storage SDK (React Native)

```bash
# Install Azure Storage Blob library
pnpm add @azure/storage-blob
```

---

### Using Blob Storage in Your App

**File:** `src/services/tts/AzureBlobStorage.ts`

```typescript
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import * as FileSystem from 'expo-file-system';

class AzureBlobStorage {
  private containerClient: ContainerClient;
  
  constructor(connectionString: string) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    this.containerClient = blobServiceClient.getContainerClient('tts-inputs');
  }
  
  /**
   * Upload SSML file and return public URL
   */
  async uploadSSML(ssml: string, filename: string): Promise<string> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(filename);
    
    // Upload content
    await blockBlobClient.upload(ssml, ssml.length, {
      blobHTTPHeaders: {
        blobContentType: 'application/xml'
      }
    });
    
    // Return public URL
    return blockBlobClient.url;
  }
  
  /**
   * Generate SAS URL (time-limited access) for private containers
   */
  async generateSasUrl(filename: string, expiryMinutes: number = 60): Promise<string> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(filename);
    
    // Generate SAS token (read permission, expires after 60 minutes)
    const sasToken = generateBlobSASQueryParameters({
      containerName: 'tts-inputs',
      blobName: filename,
      permissions: BlobSASPermissions.parse('r'),  // Read only
      startsOn: new Date(),
      expiresOn: new Date(Date.now() + expiryMinutes * 60 * 1000),
    }, blockBlobClient.credential).toString();
    
    return `${blockBlobClient.url}?${sasToken}`;
  }
  
  /**
   * Delete file after batch job completes
   */
  async deleteFile(filename: string): Promise<void> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(filename);
    await blockBlobClient.deleteIfExists();
  }
}
```

**Usage in BatchSynthesisService:**

```typescript
import { AzureBlobStorage } from './AzureBlobStorage';

class BatchSynthesisService {
  private blobStorage: AzureBlobStorage;
  
  async submitChapterBatch(chapterId: number, textElements: string[]) {
    // 1. Create SSML document
    const ssml = this.createSSMLBatch(textElements, voiceSettings);
    
    // 2. Upload to blob storage
    const filename = `chapter_${chapterId}_${Date.now()}.ssml`;
    const inputUrl = await this.blobStorage.uploadSSML(ssml, filename);
    
    // 3. Submit batch job with blob URL
    const jobId = await this.submitJob(inputUrl, voiceSettings);
    
    // 4. Store filename for cleanup later
    await this.saveJobMetadata(jobId, { inputFilename: filename });
    
    return jobId;
  }
  
  async cleanupBatchJob(jobId: string) {
    const metadata = await this.loadJobMetadata(jobId);
    
    // Delete input file from blob storage
    await this.blobStorage.deleteFile(metadata.inputFilename);
    
    // Delete batch job from Azure
    await this.deleteJob(jobId);
  }
}
```

---

## Alternative Storage Solutions

If you don't want to use Azure Blob Storage, here are alternatives:

### Option 1: Data URIs (Small Inputs Only)

**Pros:**
- ✅ No external storage needed
- ✅ No additional costs
- ✅ Simple implementation

**Cons:**
- ❌ URL length limits (~2MB in most browsers/systems)
- ❌ Not suitable for large chapters
- ❌ Base64 encoding adds 33% size overhead

**Implementation:**

```typescript
async uploadInputText(ssml: string): Promise<string> {
  // Only use for small inputs (< 1MB before encoding)
  if (ssml.length > 700000) {
    throw new Error('SSML too large for data URI, use blob storage');
  }
  
  const base64 = Buffer.from(ssml, 'utf-8').toString('base64');
  return `data:application/xml;base64,${base64}`;
}
```

**When to use:** Chapters with < 500 elements (typical novel chapter)

---

### Option 2: Your Own Server (Self-Hosted)

**Pros:**
- ✅ Full control over data
- ✅ No Azure Blob costs
- ✅ Can integrate with existing infrastructure

**Cons:**
- ❌ Requires maintaining a server
- ❌ Must be HTTPS with valid certificate
- ❌ Must be publicly accessible

**Implementation:**

```typescript
// Server-side (Node.js/Express example)
app.post('/api/tts/upload-ssml', async (req, res) => {
  const { ssml } = req.body;
  const filename = `${uuidv4()}.ssml`;
  const filepath = path.join(__dirname, 'temp', filename);
  
  await fs.promises.writeFile(filepath, ssml);
  
  // Return public URL
  const publicUrl = `https://your-domain.com/tts-temp/${filename}`;
  
  // Auto-delete after 2 hours
  setTimeout(() => {
    fs.promises.unlink(filepath).catch(console.error);
  }, 2 * 60 * 60 * 1000);
  
  res.json({ url: publicUrl });
});

// React Native app
async uploadInputText(ssml: string): Promise<string> {
  const response = await fetch('https://your-domain.com/api/tts/upload-ssml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ssml }),
  });
  
  const { url } = await response.json();
  return url;
}
```

**Cost:** Depends on hosting provider (could be free if using existing server)

---

### Option 3: AWS S3 (Alternative Cloud Storage)

**Pros:**
- ✅ Similar to Azure Blob Storage
- ✅ Well-documented SDKs
- ✅ Competitive pricing

**Cons:**
- ❌ Requires AWS account
- ❌ Cross-cloud integration (Azure + AWS)

**Implementation:**

```bash
pnpm add @aws-sdk/client-s3
```

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async uploadInputText(ssml: string, filename: string): Promise<string> {
  await s3Client.send(new PutObjectCommand({
    Bucket: 'lnreader-tts',
    Key: filename,
    Body: ssml,
    ContentType: 'application/xml',
    ACL: 'public-read',  // Make publicly accessible
  }));
  
  return `https://lnreader-tts.s3.amazonaws.com/${filename}`;
}
```

**Cost:** Similar to Azure Blob (~$0.02/GB/month)

---

### Option 4: Firebase Storage (Google Cloud)

**Pros:**
- ✅ Free tier (5GB storage, 1GB/day download)
- ✅ Easy integration with React Native
- ✅ Good for small-scale use

**Cons:**
- ❌ Requires Firebase setup
- ❌ May exceed free tier for heavy users

**Implementation:**

```bash
pnpm add @react-native-firebase/storage
```

```typescript
import storage from '@react-native-firebase/storage';

async uploadInputText(ssml: string, filename: string): Promise<string> {
  const reference = storage().ref(`tts-inputs/${filename}`);
  await reference.putString(ssml);
  
  const url = await reference.getDownloadURL();
  return url;
}
```

---

## Recommended Approach

### Strategy: Hybrid with Fallback

```typescript
class InputStorageStrategy {
  async uploadInput(ssml: string, chapterId: number): Promise<string> {
    // 1. Try data URI for small inputs (< 500KB)
    if (ssml.length < 500000) {
      return this.createDataUri(ssml);
    }
    
    // 2. Use Azure Blob Storage if configured
    if (this.config.azureBlobConnectionString) {
      return await this.azureBlob.uploadSSML(ssml, `chapter_${chapterId}.ssml`);
    }
    
    // 3. Fallback to real-time API (skip batch synthesis)
    throw new Error('Input too large for data URI and no blob storage configured');
  }
}
```

**Benefits:**
- Works out-of-the-box for typical chapters (data URI)
- Scales to large chapters if user configures blob storage
- Graceful degradation

---

## Implementation Guide

### Complete Batch Synthesis Flow

```typescript
import { AzureBlobStorage } from './AzureBlobStorage';

class BatchSynthesisService {
  private config: MicrosoftSpeechConfig;
  private blobStorage?: AzureBlobStorage;
  
  constructor(config: MicrosoftSpeechConfig) {
    this.config = config;
    
    // Optional: Initialize blob storage if configured
    if (config.blobStorageConnectionString) {
      this.blobStorage = new AzureBlobStorage(config.blobStorageConnectionString);
    }
  }
  
  /**
   * Submit batch synthesis job
   */
  async submitChapterBatch(
    chapterId: number,
    textElements: string[],
    voiceSettings: VoiceSettings
  ): Promise<string> {
    // Step 1: Create SSML batch document
    const ssml = this.createSSMLBatch(textElements, voiceSettings);
    
    // Step 2: Upload input to accessible location
    const inputUrl = await this.uploadInput(ssml, chapterId);
    
    // Step 3: Submit batch synthesis job
    const endpoint = `https://${this.config.region}.customvoice.api.speech.microsoft.com/api/texttospeech/v3.1-preview1/batchsynthesis`;
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        displayName: `LNReader Chapter ${chapterId}`,
        description: `Generated on ${new Date().toISOString()}`,
        textType: 'SSML',
        inputs: [
          {
            content: inputUrl,  // Blob storage URL or data URI
          }
        ],
        properties: {
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
          wordBoundaryEnabled: false,
          sentenceBoundaryEnabled: false,
          concatenateResult: false,  // Individual files per element
          timeToLive: 'P7D',  // Keep outputs for 7 days
        },
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Batch submission failed: ${response.status} - ${error}`);
    }
    
    const job = await response.json();
    return job.id;
  }
  
  /**
   * Upload SSML input with fallback strategy
   */
  private async uploadInput(ssml: string, chapterId: number): Promise<string> {
    // Try data URI for small inputs
    if (ssml.length < 500000 && !this.config.forceBlobStorage) {
      const base64 = Buffer.from(ssml, 'utf-8').toString('base64');
      return `data:application/xml;base64,${base64}`;
    }
    
    // Use blob storage if available
    if (this.blobStorage) {
      const filename = `chapter_${chapterId}_${Date.now()}.ssml`;
      return await this.blobStorage.uploadSSML(ssml, filename);
    }
    
    // No storage available for large input
    throw new Error('Chapter too large for data URI. Please configure Azure Blob Storage.');
  }
  
  /**
   * Poll job status until completion
   */
  async pollJobStatus(jobId: string): Promise<BatchJob> {
    const endpoint = `https://${this.config.region}.customvoice.api.speech.microsoft.com/api/texttospeech/v3.1-preview1/batchsynthesis/${jobId}`;
    
    const response = await fetch(endpoint, {
      headers: {
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to poll job: ${response.status}`);
    }
    
    return await response.json();
  }
  
  /**
   * Download batch outputs when job succeeds
   */
  async downloadBatchOutputs(jobId: string, chapterId: number): Promise<string[]> {
    const job = await this.pollJobStatus(jobId);
    
    if (job.status !== 'Succeeded') {
      throw new Error(`Job not ready: ${job.status}`);
    }
    
    // Get outputs metadata
    const outputsUrl = job.outputs.result;
    const response = await fetch(outputsUrl);
    const outputs = await response.json();
    
    // Download each audio file
    const files: string[] = [];
    const chapterDir = `${FileSystem.documentDirectory}tts/offline/${chapterId}/`;
    await FileSystem.makeDirectoryAsync(chapterDir, { intermediates: true });
    
    for (const output of outputs.values || [outputs]) {
      const audioUrl = output.contentUrl;
      const filename = output.name || `element_${files.length}.mp3`;
      const localPath = `${chapterDir}${filename}`;
      
      await FileSystem.downloadAsync(audioUrl, localPath);
      files.push(localPath);
    }
    
    return files;
  }
  
  /**
   * Delete remote batch job
   */
  async deleteJob(jobId: string): Promise<void> {
    const endpoint = `https://${this.config.region}.customvoice.api.speech.microsoft.com/api/texttospeech/v3.1-preview1/batchsynthesis/${jobId}`;
    
    await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
      },
    });
  }
}
```

---

## Cost Analysis

### Scenario: 100-Chapter Novel

**Assumptions:**
- 100 chapters × 100 elements × 200 chars = 2M characters total
- User downloads all chapters for offline reading

#### Option 1: Real-time API (Progressive Preload)
```
API cost: 2M chars × $15/1M = $30
Blob storage: $0 (no batch synthesis)
Total: $30
```

#### Option 2: Batch Synthesis API
```
API cost: 2M chars × $4/1M = $8
Blob storage: 
  - Upload 100 SSML files (~10KB each) = 1MB
  - Storage for 7 days = $0.02
  - Operations: 100 uploads + 100 deletes = $0.02
Total: $8.04

Savings: $21.96 (73% reduction)
```

#### Monthly Heavy User (10 novels = 1000 chapters)
```
Real-time API: 20M chars × $15/1M = $300
Batch API: 20M chars × $4/1M = $80
Blob storage: ~$1

Savings: $219/month (73% reduction)
```

---

## Limitations & Workarounds

### Limitation 1: Preview API Instability

**Issue:** Batch Synthesis is in preview (v3.1-preview1), may have breaking changes

**Workaround:**
- Pin API version in code
- Monitor Azure changelog for updates
- Have fallback to real-time API if batch fails

---

### Limitation 2: Async Processing Delay

**Issue:** Batch jobs take 1-5 minutes to process

**Workaround:**
- Use for pre-downloads only (not immediate playback)
- Show progress UI during download
- Allow downloading multiple chapters in queue

---

### Limitation 3: Regional Availability

**Issue:** Batch API not available in all Azure regions

**Supported Regions (as of March 2026):**
- eastus
- westeurope
- southeastasia

**Workaround:**
- Check region support before enabling feature
- Fallback to real-time API if region unsupported
- Allow user to select different region for batch

```typescript
const BATCH_SUPPORTED_REGIONS = ['eastus', 'westeurope', 'southeastasia'];

function isBatchAvailable(region: string): boolean {
  return BATCH_SUPPORTED_REGIONS.includes(region);
}
```

---

### Limitation 4: Blob Storage Public Access

**Security Concern:** Public blob containers allow anyone with URL to access files

**Workaround:**
- Use SAS tokens for time-limited access
- Set container to private, generate URLs with expiry
- Delete input files immediately after job submission

```typescript
// Use SAS URL with 1-hour expiry instead of public URL
const sasUrl = await blobStorage.generateSasUrl(filename, 60);
await submitJob(sasUrl);
```

---

## Configuration in App Settings

Add to integration settings UI:

```typescript
interface IntegrationSettings {
  microsoftSpeech?: {
    enabled: boolean;
    subscriptionKey: string;
    region: string;
    
    // NEW: Batch synthesis settings
    batchSynthesisEnabled?: boolean;
    blobStorageConnectionString?: string;
    preferBatchForDownloads?: boolean;  // Use batch for offline downloads
  };
}
```

**UI:**
```tsx
<SettingsSection title="Microsoft Speech - Batch Downloads">
  <SwitchSetting
    label="Enable offline batch downloads"
    value={settings.batchSynthesisEnabled}
    description="Use batch API for 66% cost savings on offline downloads"
  />
  
  <TextInput
    label="Azure Blob Storage Connection String"
    value={settings.blobStorageConnectionString}
    secureTextEntry
    placeholder="DefaultEndpointsProtocol=https;AccountName=..."
  />
  
  <InfoBox>
    Batch synthesis reduces Microsoft Speech costs from $15/1M to $4/1M characters.
    Requires Azure Blob Storage for large chapters. See setup guide.
  </InfoBox>
</SettingsSection>
```

---

## Summary

### Recommended Setup

**For Most Users:**
1. Use data URIs (no blob storage needed)
2. Limits you to typical chapter sizes (< 500 elements)
3. Zero additional cost

**For Power Users:**
1. Set up Azure Blob Storage (< $1/month)
2. Configure connection string in app
3. Enable batch downloads for 66% savings
4. Pre-download novels for travel

**Implementation Priority:**
1. **Phase 1:** Real-time API only (works for everyone)
2. **Phase 2:** Add data URI support for small batches
3. **Phase 3:** Add blob storage support for large batches

---

**Next:** Read [02-IMPLEMENTATION-GUIDE.md](./02-IMPLEMENTATION-GUIDE.md) for step-by-step code implementation
