# Azure Blob Storage Setup - Quick Reference

**For:** [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md)  
**Purpose:** Store SSML inputs for Batch Synthesis API

---

## Why Do You Need This?

The Azure Batch Synthesis API requires **publicly accessible HTTPS URLs** to your input SSML files. Azure Blob Storage is the recommended (but not required) solution.

---

##Options Summary

| Solution | Setup Time | Cost/Month | Pros | Cons |
|----------|-----------|------------|------|------|
| **Data URI** | 0 min | $0 | No setup, works immediately | Max ~500KB input size |
| **Azure Blob** | 15 min | <$1 | Native integration, secure | Requires Azure account |
| **Self-hosted** | 30+ min | Varies | Full control | Server maintenance |
| **AWS S3** | 15 min | <$1 | Alternative to Azure | Cross-cloud complexity |
| **Firebase** | 10 min | $0 (free tier) | Easy setup | Usage limits |

---

## Recommended: Start with Data URI

**For 90% of users, you don't need blob storage.**

```typescript
// This works for typical chapters (< 500 elements):
const inputUrl = `data:application/xml;base64,${btoa(ssml)}`;
await submitBatchJob(inputUrl);
```

**When you need Blob Storage:**
- Chapters with > 500 text elements
- Very long paragraphs (epic novels)
- Error: "Request Entity Too Large"

---

## Quick Setup: Azure Blob Storage (15 minutes)

### Step 1: Create Storage Account

**Azure Portal Method:**
```
1. Go to: https://portal.azure.com
2. Click "Create a resource"
3. Search "Storage account" → Create
4. Fill in:
   - Name: lnreadertts (must be unique globally)
   - Region: Same as your Speech Service (e.g., eastus)
   - Performance: Standard
   - Redundancy: LRS (cheapest)
5. Create (takes ~30 seconds)
```

**Azure CLI Method:**
```bash
az login
az storage account create \
  --name lnreadertts \
  --resource-group YOUR_RESOURCE_GROUP \
  --location eastus \
  --sku Standard_LRS
```

**Cost:** ~$0.02/GB/month (expect < $1/month total)

---

### Step 2: Create Container

```
1. Navigate to your storage account
2. Left menu → "Containers"
3. "+ Container"
4. Name: tts-inputs
5. Public access: Blob (or Private if using SAS tokens)
6. Create
```

---

### Step 3: Get Connection String

```
1. Storage account → "Access keys" (left menu)
2. Copy "Connection string" from key1
3. Paste into your app's settings
```

**Example:**
```
DefaultEndpointsProtocol=https;AccountName=lnreadertts;AccountKey=abc...xyz==;EndpointSuffix=core.windows.net
```

---

### Step 4: Test Upload

```bash
# Install Azure CLI (if not already)
# Windows: winget install Microsoft.AzureCLI
# macOS: brew install azure-cli
# Linux: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Upload test file
az storage blob upload \
  --account-name lnreadertts \
  --container-name tts-inputs \
  --name test.txt \
  --file ./test.txt \
  --connection-string "YOUR_CONNECTION_STRING"

# Get public URL
az storage blob url \
  --account-name lnreadertts \
  --container-name tts-inputs \
  --name test.txt
```

---

## Alternative: Firebase Storage (Free Tier)

**Pros:**
- Free tier: 5GB storage, 1GB/day downloads
- Easy React Native integration

**Setup:**

```bash
# 1. Create Firebase project: https://console.firebase.google.com
# 2. Enable Storage in Firebase console
# 3. Install SDK
pnpm add @react-native-firebase/app @react-native-firebase/storage

# 4. Configure Firebase (follow React Native Firebase docs)
```

**Usage:**
```typescript
import storage from '@react-native-firebase/storage';

const ref = storage().ref(`tts-inputs/${filename}`);
await ref.putString(ssml);
const url = await ref.getDownloadURL();
```

---

## Self-Hosted Option (Advanced)

**Pros:**
- No cloud costs
- Full control

**Cons:**
- Requires maintaining server
- Must be HTTPS with valid certificate
- Must be publicly accessible

**Example (Express.js):**

```javascript
// server.js
const express = require('express');
const fs = require('fs');
const app = express();

app.post('/api/upload-ssml', (req, res) => {
  const filename = `${Date.now()}.ssml`;
  fs.writeFileSync(`./temp/${filename}`, req.body.ssml);
  
  res.json({ url: `https://your-domain.com/temp/${filename}` });
  
  // Auto-delete after 2 hours
  setTimeout(() => fs.unlinkSync(`./temp/${filename}`), 2 * 60 * 60 * 1000);
});

app.listen(3000);
```

---

## Security Best Practices

### Option 1: Private Container + SAS Tokens (Recommended)

```typescript
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';

// Upload to private container
await blockBlobClient.upload(ssml, ssml.length);

// Generate time-limited URL (1 hour expiry)
const sasToken = generateBlobSASQueryParameters({
  containerName: 'tts-inputs',
  blobName: filename,
  permissions: BlobSASPermissions.parse('r'),  // Read only
  expiresOn: new Date(Date.now() + 60 * 60 * 1000),
}, credential);

const secureUrl = `${blockBlobClient.url}?${sasToken}`;
```

**Benefits:**
- URLs expire automatically
- Can't be accessed without token
- Can revoke access anytime

---

### Option 2: Lifecycle Management (Auto-Cleanup)

```
1. Azure Portal → Storage account → Containers → tts-inputs
2. "Management" → "Lifecycle management"
3. Add rule:
   - Name: "delete-old-inputs"
   - Delete blobs older than 7 days
4. Save
```

**Benefits:**
- Automatic cleanup
- No manual file management
- Prevents storage bloat

---

## Troubleshooting

### Error: "Storage account name already taken"

**Solution:** Choose a different name (must be globally unique)

```bash
# Try: lnreader-tts-{random}
# Example: lnreader-tts-abc123
```

---

### Error: "Public access not allowed"

**Azure changed defaults in 2024 - public access disabled by default**

**Solution:**
```
1. Storage account → Configuration
2. "Allow Blob public access" → Enabled
3. Save
4. Recreate container with public access
```

Or use SAS tokens with private container (more secure).

---

### Error: "Connection string invalid"

**Check format:**
```
Must include:
- DefaultEndpointsProtocol=https
- AccountName=YOUR_ACCOUNT
- AccountKey=YOUR_KEY
- EndpointSuffix=core.windows.net
```

**Get fresh connection string:**
```
Storage account → Access keys → Show → Copy connection string
```

---

## Cost Monitoring

### Azure Cost Management

```
1. Azure Portal → Cost Management
2. Add filter: Service = "Storage"
3. Group by: Resource
4. View monthly costs
```

**Expected costs:**
- Storage: < $0.10/month (< 5GB)
- Operations: < $0.05/month (< 50,000 ops)
- **Total: < $1/month**

---

## Documentation Links

- **Azure Blob Storage Quickstart:**  
  https://learn.microsoft.com/en-us/azure/storage/blobs/storage-quickstart-blobs-portal

- **Batch Synthesis API:**  
  https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-synthesis

- **Azure Storage Pricing:**  
  https://azure.microsoft.com/en-us/pricing/details/storage/blobs/

- **SAS Token Security:**  
  https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview

---

## Summary

**For most users:**
1. Start without blob storage (use data URIs)
2. If you hit size limits, set up Azure Blob (15 min, < $1/month)
3. Use SAS tokens for security
4. Enable lifecycle management for auto-cleanup

**For large-scale deployments:**
1. Set up Azure Blob Storage with private containers
2. Use SAS tokens with short expiry (1 hour)
3. Enable lifecycle management (auto-delete after 7 days)
4. Monitor costs monthly (should be < $5/month even for heavy users)

---

**Back to:** [03-AZURE-BATCH-SYNTHESIS.md](./03-AZURE-BATCH-SYNTHESIS.md)
