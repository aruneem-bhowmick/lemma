/**
 * Diagram asset extraction and file writing for the Lemma pipeline.
 *
 * Produces one PNG image file per diagram found in a ConvertedPage, writes
 * each to the configured assets directory, and updates the Markdown body so
 * that every `<asset-placeholder>` token is replaced with the actual relative
 * file path (`./assets/page-<pageId>-fig<N>.png`).
 *
 * v1 behaviour: the full-page JPEG buffer is stored as the asset image for
 * every diagram on the page.  Per-figure cropping (using bounding boxes
 * supplied by the vision model) is reserved for a future iteration.
 *
 * Asset naming convention
 * ──────────────────────
 *   Filename:     page-<pageId>-fig<N>.png   (N is 0-indexed diagram number)
 *   Relative path: ./assets/page-<pageId>-fig<N>.png
 *   Absolute path: path.resolve(<assetsDir>, filename)
 *
 * The relative path is a repository-root-relative convention understood by
 * downstream Markdown viewers and tooling.  It is always prefixed with
 * `./assets/` regardless of the actual assetsDir path on disk.
 *
 * Idempotency
 * ─────────────
 * Re-processing the same page overwrites existing asset files without error.
 * The assets directory is created with `{ recursive: true }` so it is safe to
 * call this function even when the directory does not yet exist.
 */

import { mkdirSync } from 'fs';
import { join, resolve } from 'path';
import type { ConvertedPage } from '../types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Metadata for a single diagram asset file written to disk during asset
 * extraction.
 */
export interface ExtractedAsset {
  /** Filename only (e.g. `page-0abc-fig1.png`). */
  filename: string;
  /** Repository-root-relative path used in Markdown image tags (e.g. `./assets/page-0abc-fig1.png`). */
  relativePath: string;
  /** Absolute filesystem path of the written file. */
  absolutePath: string;
  /** Zero-indexed position of this diagram within the page's diagram list. */
  diagramIndex: number;
}

// ---------------------------------------------------------------------------
// extractAndWriteAssets
// ---------------------------------------------------------------------------

/**
 * Saves diagram assets to disk and resolves `<asset-placeholder>` tokens in
 * the page's Markdown body.
 *
 * For each `DiagramData` entry in `page.diagrams`, this function:
 * 1. Derives a deterministic filename: `page-<pageId>-fig<N>.png`.
 * 2. Converts `imageBuffer` to PNG format via `sharp` and writes it to
 *    `<assetsDir>/<filename>` (overwriting any existing file — idempotent).
 * 3. Replaces the **first** remaining `<asset-placeholder>` in the Markdown
 *    string with the relative path `./assets/<filename>`.
 *
 * When `page.diagrams` is empty the function returns immediately without
 * touching the filesystem.
 *
 * @param page        - Fully converted page containing the diagram list and
 *                      the Markdown body to update.
 * @param imageBuffer - Full-page JPEG buffer from the render stage.  Written
 *                      as PNG for every diagram (v1: whole-page image;
 *                      v2 will crop individual bounding boxes).
 * @param assetsDir   - Directory to write asset files into.  Created
 *                      recursively if absent.
 * @returns An object with the array of written asset records and the updated
 *          Markdown string (with all `<asset-placeholder>` tokens resolved).
 */
export async function extractAndWriteAssets(
  page: ConvertedPage,
  imageBuffer: Buffer,
  assetsDir: string,
): Promise<{ assets: ExtractedAsset[]; markdown: string }> {
  if (page.diagrams.length === 0) {
    return { assets: [], markdown: page.markdown };
  }

  // Ensure the assets directory exists before attempting any file writes.
  mkdirSync(assetsDir, { recursive: true });

  const sharpModule = await import('sharp');
  const assets: ExtractedAsset[] = [];
  let markdown = page.markdown;

  for (let i = 0; i < page.diagrams.length; i++) {
    const filename = `page-${page.pageId}-fig${i}.png`;
    // absolutePath: true filesystem path for file I/O.
    const absolutePath = resolve(join(assetsDir, filename));
    // relativePath: repository-root-relative reference embedded in Markdown.
    // v2: crop individual figure bounding boxes using vision-provided coordinates.
    const relativePath = `./assets/${filename}`;

    await sharpModule.default(imageBuffer).png().toFile(absolutePath);

    // Replace only the first occurrence of the placeholder so that each loop
    // iteration resolves the diagram that corresponds to index i.
    markdown = markdown.replace('<asset-placeholder>', `page-${page.pageId}-fig${i}`);

    assets.push({ filename, relativePath, absolutePath, diagramIndex: i });
  }

  console.log(`[assets] wrote ${assets.length} assets for page ${page.pageId}`);

  return { assets, markdown };
}
