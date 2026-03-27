/**
 * Extract TTS-readable text elements from raw HTML using cheerio.
 *
 * Mirrors the getAllReadableElements / normalizeText logic in core.js so that
 * the same set of text elements is produced whether extraction runs inside the
 * WebView (TTSTab) or directly from the downloaded HTML (downloadChapter).
 */

import * as cheerio from 'cheerio';
import type { Element, AnyNode } from 'domhandler';

// Inline element tag names that may appear as children of a readable container.
// Mirrors readableNodeNames in core.js (excluding '#text' which is a node type,
// not a tag name).
const INLINE_TAGS = new Set(['B', 'I', 'SPAN', 'EM', 'BR', 'STRONG', 'A']);

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*([.,!?;:])\s*/g, '$1 ')
    .trim();
}

/**
 * Return true if `el` is a "readable" element — a block-level container whose
 * entire content is plain text or allowed inline elements, with no images.
 */
function isReadable($: cheerio.CheerioAPI, el: Element): boolean {
  if (el.type !== 'tag') return false;
  const tagName = el.tagName.toUpperCase();

  // An inline element itself (except SPAN) is not a readable container.
  if (tagName !== 'SPAN' && INLINE_TAGS.has(tagName)) return false;

  // Must have at least one child node.
  if (!el.children || el.children.length === 0) return false;

  // No embedded images.
  if ($(el).find('img, picture, svg').length > 0) return false;

  // Every child node must be a text node or an allowed inline element.
  for (const child of el.children as AnyNode[]) {
    if (child.type === 'text') continue;
    if (child.type === 'tag') {
      const childTag = (child as Element).tagName.toUpperCase();
      if (INLINE_TAGS.has(childTag)) continue;
    }
    return false;
  }

  return true;
}

/**
 * Recursively collect all readable elements from the DOM subtree rooted at
 * `root`.  Mirrors the traverse() helper inside getAllReadableElements in
 * core.js: once a readable element is found we do NOT descend into its
 * children.
 */
function collectReadable($: cheerio.CheerioAPI, root: Element): Element[] {
  const results: Element[] = [];

  function traverse(el: Element) {
    if (!el || el.type !== 'tag') return;
    if (isReadable($, el)) {
      results.push(el);
      return;
    }
    // Use element children only for traversal (mirrors DOM .children property).
    $(el)
      .children()
      .each((_, child) => traverse(child as Element));
  }

  traverse(root);
  return results;
}

/**
 * Extract the ordered list of non-empty, normalised text strings from an HTML
 * string.  Returns the same array that TTSTab would obtain via the WebView
 * extraction path.
 */
export function extractTextElementsFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const body = $('body')[0] as Element | undefined;
  if (!body) return [];

  return collectReadable($, body)
    .map(el => normalizeText($(el).text()))
    .filter(text => text.length > 0);
}
