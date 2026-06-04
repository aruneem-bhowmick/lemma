/**
 * Stage 4 of the Lemma pipeline: vision conversion.
 *
 * Accepts the rendered page image from the render stage, sends it to the
 * vision LLM via VisionClient, parses the structured Markdown response, and
 * returns a fully populated ConvertedPage ready for the write stage.
 *
 * Responsibility boundaries
 * ─────────────────────────
 * This stage is deliberately narrow: it encodes the buffer, calls the model,
 * and parses the output. Frontmatter serialisation (Prompt 8) and asset file
 * writing (Prompt 9) are downstream concerns handled by their own modules.
 * The `frontmatter` field is pre-populated here with all known values; the
 * serialisation layer in Prompt 8 will convert this object to a YAML string.
 *
 * Error handling
 * ──────────────
 * VisionError thrown by VisionClient propagates upward to the orchestrator,
 * which records a per-page failure in the manifest and continues with the
 * next page. This stage does not swallow or wrap VisionError.
 */

import type { PageMeta, ConvertedPage } from '../types.js';
import type { RenderResult } from './render.js';
import { VisionClient } from '../vision/client.js';
import { parseVisionResponse } from '../vision/parser.js';

/**
 * Converts a rendered page image to a structured ConvertedPage via the
 * vision LLM.
 *
 * Steps:
 * 1. Base64-encodes `renderResult.imageBuffer`.
 * 2. Calls VisionClient.convert() with the encoded image and page metadata.
 * 3. Calls parseVisionResponse() on the raw response string.
 * 4. Constructs and returns a ConvertedPage.
 *
 * Logs a one-line summary to stdout on success. Logs an additional warning
 * when the parsed response contains [ILLEGIBLE] markers.
 *
 * @param renderResult - Output of the render stage (image buffer + hash).
 * @param page         - Page metadata for prompt context and field population.
 * @returns Fully populated ConvertedPage.
 * @throws VisionError when the API call fails after retries.
 */
export async function convertPage(
  renderResult: RenderResult,
  page: PageMeta,
): Promise<ConvertedPage> {
  const imageBase64 = renderResult.imageBuffer.toString('base64');

  const client = new VisionClient();
  const rawResponse = await client.convert(imageBase64, page.title, page.section);

  const parsed = parseVisionResponse(rawResponse);

  console.log(
    `[convert] page ${page.id} — confidence: ${parsed.confidence}, ` +
      `${parsed.concepts.length} concepts, ${parsed.diagrams.length} diagrams`,
  );

  if (parsed.hasIllegible) {
    console.warn(`[convert] WARNING: page ${page.id} contains illegible regions`);
  }

  return {
    pageId: page.id,
    title: page.title,
    section: page.section,
    lastModified: page.lastModifiedDateTime,
    contentHash: renderResult.contentHash,
    markdown: parsed.markdown,
    frontmatter: {
      page_id: page.id,
      title: page.title,
      section: page.section,
      last_modified: page.lastModifiedDateTime,
      source_hash: renderResult.contentHash,
      concepts: parsed.concepts,
      has_diagrams: parsed.diagrams.length > 0,
      confidence: parsed.confidence,
    },
    diagrams: parsed.diagrams,
    assetPaths: [],
    confidence: parsed.confidence,
  };
}
