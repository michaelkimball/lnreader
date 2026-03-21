/**
 * Utility to extract readable text elements from a WebView chapter
 * Reuses the TTS extraction logic already in core.js
 */

import { RefObject } from 'react';
import WebView from 'react-native-webview';

export interface TextExtractionResult {
  success: boolean;
  elements: string[];
  error?: string;
}

// Global callback storage for extraction results
// This allows the WebView's message handler to route results back to the pending extraction
const pendingExtractions = new Map<string, (result: TextExtractionResult) => void>();

/**
 * Process extraction result message from WebView
 * This should be called by the WebView's onMessage handler when it receives
 * a message with type 'extract-chapter-text-result'
 * 
 * @param data - Parsed message data from WebView
 */
export function handleExtractionResult(data: {
  type: string;
  requestId: string;
  success: boolean;
  elements?: string[];
  error?: string;
}): boolean {
  if (data.type !== 'extract-chapter-text-result') {
    return false;
  }

  const callback = pendingExtractions.get(data.requestId);
  if (callback) {
    pendingExtractions.delete(data.requestId);
    
    if (data.success) {
      callback({
        success: true,
        elements: data.elements || [],
      });
    } else {
      callback({
        success: false,
        elements: [],
        error: data.error || 'Unknown error',
      });
    }
    return true;
  }
  
  return false;
}

/**
 * Extract readable text elements from the currently loaded chapter in a WebView
 * 
 * This function injects JavaScript that reuses the existing TTS extraction logic
 * (getAllReadableElements method from core.js) to get the same text elements
 * that would be read during TTS playback.
 * 
 * **IMPORTANT**: The WebView's onMessage handler must call `handleExtractionResult()`
 * to process extraction results. Add this to WebViewReader's message handler:
 * 
 * ```typescript
 * const dataPayload = JSON.parse(payload.nativeEvent.data);
 * if (handleExtractionResult(dataPayload)) {
 *   return; // Message was an extraction result, handled
 * }
 * ```
 * 
 * @param webViewRef - Reference to the WebView component with loaded chapter
 * @param timeoutMs - Maximum time to wait for extraction (default: 5000ms)
 * @returns Promise<TextExtractionResult> - Array of text strings or error
 * 
 * @example
 * const result = await extractChapterTextElements(webViewRef);
 * if (result.success) {
 *   console.log(`Extracted ${result.elements.length} elements`);
 *   await ttsDownloadManager.requestDownload({
 *     chapterId: chapter.id,
 *     novelId: novel.id,
 *     textElements: result.elements,
 *     voiceSettings,
 *   });
 * } else {
 *   console.error('Extraction failed:', result.error);
 * }
 */
export async function extractChapterTextElements(
  webViewRef: RefObject<WebView>,
  timeoutMs: number = 5000,
): Promise<TextExtractionResult> {
  return new Promise((resolve) => {
    if (!webViewRef.current) {
      resolve({
        success: false,
        elements: [],
        error: 'WebView reference is null',
      });
      return;
    }

    // Generate unique request ID
    const requestId = `extract_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Set up timeout
    const timeoutId = setTimeout(() => {
      pendingExtractions.delete(requestId);
      resolve({
        success: false,
        elements: [],
        error: `Extraction timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    // Register callback
    pendingExtractions.set(requestId, (result) => {
      clearTimeout(timeoutId);
      resolve(result);
    });

    // Inject extraction script
    const extractionScript = `
      (function() {
        const requestId = ${JSON.stringify(requestId)};
        try {
          // Check if tts object exists (from core.js)
          if (typeof tts === 'undefined' || !reader || !reader.chapterElement) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'extract-chapter-text-result',
              requestId: requestId,
              success: false,
              error: 'TTS system not initialized',
            }));
            return;
          }

          // Use the existing getAllReadableElements method from core.js
          const readableElements = tts.getAllReadableElements(reader.chapterElement);
          
          // Extract inner text from each element and normalize
          const textElements = readableElements.map(el => {
            const text = el.innerText || el.textContent || '';
            // Normalize whitespace (same as tts.normalizeText)
            return text.replace(/\\s+/g, ' ').replace(/\\s*([.,!?;:])\\s*/g, '$1 ').trim();
          }).filter(text => text.length > 0); // Remove empty strings

          // Send results back
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'extract-chapter-text-result',
            requestId: requestId,
            success: true,
            elements: textElements,
            totalElements: textElements.length,
          }));
        } catch (error) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'extract-chapter-text-result',
            requestId: requestId,
            success: false,
            error: error.message || 'Unknown extraction error',
          }));
        }
      })();
      true; // Prevent "Evaluated JavaScript did not return a value"
    `;

    // Inject the extraction script
    webViewRef.current.injectJavaScript(extractionScript);
  });
}

/**
 * Estimate the total size of audio files that would be generated for given text elements
 * Average TTS audio: ~100KB per element (varies by text length and voice)
 * 
 * @param textElements - Array of text strings
 * @returns Estimated size in MB
 */
export function estimateAudioSize(textElements: string[]): number {
  if (!textElements || textElements.length === 0) {
    return 0;
  }

  // Rough estimation based on character count
  // Azure TTS MP3: approximately 1KB per 10 characters (highly variable)
  const totalCharacters = textElements.reduce((sum, text) => sum + text.length, 0);
  const estimatedBytes = totalCharacters * 100; // Conservative estimate
  const estimatedMB = estimatedBytes / (1024 * 1024);
  
  return parseFloat(estimatedMB.toFixed(2));
}

/**
 * Validate that text elements are suitable for TTS download
 * 
 * @param textElements - Array of text strings to validate
 * @returns Validation result with error message if invalid
 */
export function validateTextElements(textElements: string[]): {
  valid: boolean;
  error?: string;
  warnings?: string[];
} {
  if (!textElements || !Array.isArray(textElements)) {
    return { valid: false, error: 'Text elements must be an array' };
  }

  if (textElements.length === 0) {
    return { valid: false, error: 'No text elements found in chapter' };
  }

  const warnings: string[] = [];

  // Check for very large chapters (>500 elements = ~50MB+ download)
  if (textElements.length > 500) {
    warnings.push(`Large chapter detected (${textElements.length} elements). Download may take several minutes.`);
  }

  // Check for very small chapters
  if (textElements.length < 10) {
    warnings.push(`Small chapter detected (${textElements.length} elements).`);
  }

  // Check for empty elements
  const emptyCount = textElements.filter(text => !text || text.trim().length === 0).length;
  if (emptyCount > 0) {
    warnings.push(`${emptyCount} empty text elements will be skipped.`);
  }

  return {
    valid: true,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
