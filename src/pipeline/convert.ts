/**
 * Stage 4 of the Lemma pipeline: vision conversion.
 *
 * Accepts the rendered page image from the render stage, sends it to the
 * vision LLM via VisionClient, parses the structured Markdown response,
 * validates and repairs the callout structure, extracts diagram assets,
 * and returns a fully populated ConvertedPage ready for the write stage.
 *
 * Responsibility boundaries
 * ─────────────────────────
 * This stage encodes the buffer, calls the model, parses the output,
 * validates the Markdown convention, and writes diagram asset images.
 * After asset extraction, `ConvertedPage.markdown` contains resolved
 * `./assets/page-<id>-fig<N>.png` references in place of the raw
 * `<asset-placeholder>` tokens emitted by the vision model.
 * The `frontmatter` field is pre-populated here as a plain object;
 * generateFrontmatter (from frontmatter.ts) serialises it to a YAML
 * string when the file is written.
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
import { validateAndRepair } from './validate.js';
import { extractAndWriteAssets } from './assets.js';

/**
 * Converts a rendered page image to a structured ConvertedPage via the
 * vision LLM.
 *
 * Steps:
 * 1. Base64-encodes `renderResult.imageBuffer`.
 * 2. Calls VisionClient.convert() with the encoded image and page metadata.
 * 3. Calls parseVisionResponse() on the raw response string.
 * 4. Validates and repairs the Markdown body via validateAndRepair().
 * 5. Calls extractAndWriteAssets() to persist diagram images and resolve
 *    `<asset-placeholder>` tokens in the Markdown.
 * 6. Constructs and returns a ConvertedPage with assetPaths populated.
 *
 * Logs a one-line summary to stdout on success. Logs an additional warning
 * when the parsed response contains [ILLEGIBLE] markers.
 *
 * @param renderResult - Output of the render stage (image buffer + hash).
 * @param page         - Page metadata for prompt context and field population.
 * @param client       - Shared VisionClient instance; defaults to a new instance
 *                       when not provided. Callers that process multiple pages
 *                       should create one VisionClient and pass it here so the
 *                       Anthropic SDK connection is reused across pages.
 * @param assetsDir    - Directory to write diagram asset images into.  Defaults
 *                       to `process.env.ASSETS_DIR ?? './assets'`.
 * @returns Fully populated ConvertedPage with resolved asset paths.
 * @throws VisionError when the API call fails after retries.
 */
export async function convertPage(
  renderResult: RenderResult,
  page: PageMeta,
  client: VisionClient = new VisionClient(),
  assetsDir: string = process.env.ASSETS_DIR ?? './assets',
): Promise<ConvertedPage> {
  const imageBase64 = renderResult.imageBuffer.toString('base64');

  const rawResponse = await client.convert(imageBase64, page.title, page.section);

  const parsed = parseVisionResponse(rawResponse);

  // Validate and auto-repair the Markdown body before storing it.
  const validated = validateAndRepair(parsed.markdown, page.id);
  if (validated.repaired) {
    console.log(`[convert] page ${page.id}: markdown auto-repaired`);
  }
  for (const issue of validated.issues) {
    console.warn(issue);
  }

  console.log(
    `[convert] page ${page.id} — confidence: ${parsed.confidence}, ` +
      `${parsed.concepts.length} concepts, ${parsed.diagrams.length} diagrams`,
  );

  if (parsed.hasIllegible) {
    console.warn(`[convert] WARNING: page ${page.id} contains illegible regions`);
  }

  // Build the initial ConvertedPage so that extractAndWriteAssets can read
  // the diagrams array and the current markdown string.
  const partialPage: ConvertedPage = {
    pageId: page.id,
    title: page.title,
    section: page.section,
    lastModified: page.lastModifiedDateTime,
    contentHash: renderResult.contentHash,
    markdown: validated.markdown,
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

  // Extract diagram assets: writes PNGs to assetsDir and resolves placeholders.
  const { assets, markdown: resolvedMarkdown } = await extractAndWriteAssets(
    partialPage,
    renderResult.imageBuffer,
    assetsDir,
  );

  return {
    ...partialPage,
    markdown: resolvedMarkdown,
    assetPaths: assets.map((a) => a.absolutePath),
  };
}
