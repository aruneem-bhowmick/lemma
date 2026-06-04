/**
 * Stage 3 of the Lemma pipeline: page rendering.
 *
 * Accepts a PageMeta and an authenticated GraphClient, attempts rendering
 * via a configurable strategy chain, normalises the result to JPEG, and
 * returns a RenderResult with the image buffer, content hash, strategy name,
 * and elapsed duration.
 *
 * Strategy chain
 * ──────────────
 * The primary strategy is selected by the RENDER_STRATEGY environment
 * variable (default: 'pdf-export'). If the primary strategy throws, the
 * orchestrator logs a warning and attempts the next strategy in the fixed
 * fallback order:
 *
 *   pdf-export  →  semi-auto  →  inkml-raster
 *
 * The primary strategy is moved to the head of this chain; the remaining
 * strategies follow in fixed order. RenderError is thrown only when every
 * strategy is exhausted.
 *
 * Quality gates
 * ─────────────
 * After a successful render:
 *   - The raw buffer is normalised to JPEG quality 92 via sharp.
 *   - If the image is narrower than 1668 px a warning is logged (but the
 *     image is still used — the vision model may still produce acceptable
 *     output).
 *   - If the JPEG buffer is smaller than 50 KB a separate warning is logged
 *     to alert the operator that the image is suspiciously small.
 */

import type { PageMeta } from '../types.js';
import type { GraphClient } from '../graph/client.js';
import { hashBuffer } from './hash.js';
import { pdfExportStrategy } from './render-strategies/pdf-export.js';
import { semiAutoStrategy } from './render-strategies/semi-auto.js';
import { inkmlRasterStrategy } from './render-strategies/inkml-raster.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum JPEG buffer size below which a quality warning is emitted (bytes). */
const MIN_IMAGE_BYTES = 50_000;

/** Minimum image width in pixels below which a resolution warning is emitted. */
const MIN_WIDTH_PX = 1_668;

// ---------------------------------------------------------------------------
// RenderError
// ---------------------------------------------------------------------------

/**
 * Thrown when every strategy in the fallback chain has been attempted without
 * success for a given page.
 *
 * The `pageId` field allows the pipeline orchestrator to record a targeted
 * per-page failure in the manifest rather than aborting the entire run.
 */
export class RenderError extends Error {
  /** OneNote page identifier that could not be rendered. */
  readonly pageId: string;

  /**
   * @param message - Combined failure message listing each strategy's error.
   * @param pageId  - OneNote page identifier for the page that failed.
   */
  constructor(message: string, pageId: string) {
    super(message);
    this.name = 'RenderError';
    this.pageId = pageId;
  }
}

// ---------------------------------------------------------------------------
// RenderResult
// ---------------------------------------------------------------------------

/** Output of the render stage for a single page. */
export interface RenderResult {
  /** OneNote page identifier. */
  pageId: string;
  /** JPEG image bytes at minimum 150 DPI equivalent resolution. */
  imageBuffer: Buffer;
  /** SHA-256 content hash of the image buffer, prefixed with 'sha256:'. */
  contentHash: string;
  /** Rendering strategy that ultimately succeeded. */
  renderStrategy: 'pdf-export' | 'inkml-raster' | 'semi-auto';
  /** Wall-clock time from start to completion in milliseconds. */
  renderDurationMs: number;
}

// ---------------------------------------------------------------------------
// Strategy chain helpers
// ---------------------------------------------------------------------------

/** Names of all supported rendering strategies, in their fixed fallback order. */
type RenderStrategy = 'pdf-export' | 'semi-auto' | 'inkml-raster';

/** Canonical fallback order when the primary strategy is pdf-export. */
const STRATEGY_ORDER: RenderStrategy[] = ['pdf-export', 'semi-auto', 'inkml-raster'];

/**
 * Builds the ordered strategy chain for this run.
 *
 * Reads RENDER_STRATEGY from the environment (defaulting to `'pdf-export'`),
 * validates it, and places it at the head of the chain. The remaining
 * strategies follow in {@link STRATEGY_ORDER}.
 *
 * An unrecognised value triggers a stderr warning and falls back to the
 * default chain so a misconfigured environment does not silently fail.
 *
 * @returns Array of strategy names in the order they should be attempted.
 */
function buildStrategyChain(): RenderStrategy[] {
  const envValue = process.env.RENDER_STRATEGY ?? 'pdf-export';
  const primary = envValue as RenderStrategy;

  if (!STRATEGY_ORDER.includes(primary)) {
    process.stderr.write(
      `[render] WARNING: unrecognised RENDER_STRATEGY '${envValue}', ` +
        `falling back to default chain.\n`,
    );
    return [...STRATEGY_ORDER];
  }

  return [primary, ...STRATEGY_ORDER.filter((s) => s !== primary)];
}

/**
 * Dispatches to the appropriate strategy function by name.
 *
 * @param strategy    - Strategy name to execute.
 * @param page        - Page metadata supplied to the strategy.
 * @param graphClient - Authenticated Graph API client (used by pdf-export).
 * @returns Raw buffer from the strategy (may be JPEG or PDF; normalised after).
 */
async function runStrategy(
  strategy: RenderStrategy,
  page: PageMeta,
  graphClient: GraphClient,
): Promise<Buffer> {
  switch (strategy) {
    case 'pdf-export':
      return pdfExportStrategy(page, graphClient);
    case 'semi-auto':
      return semiAutoStrategy(page);
    case 'inkml-raster':
      return inkmlRasterStrategy(page);
  }
}

// ---------------------------------------------------------------------------
// JPEG normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a raw image buffer to JPEG quality 92 and checks minimum dimensions.
 *
 * If the image is narrower than {@link MIN_WIDTH_PX} a warning is logged but
 * the image is still returned — low resolution degrades vision accuracy rather
 * than causing a hard failure.
 *
 * @param rawBuffer - Buffer from a rendering strategy (any sharp-readable format).
 * @param pageId    - Page identifier used in warning messages.
 * @returns JPEG buffer at quality 92.
 * @throws Error if sharp cannot decode or re-encode the buffer.
 */
async function normalizeToJpeg(rawBuffer: Buffer, pageId: string): Promise<Buffer> {
  const sharpModule = await import('sharp');
  const image = sharpModule.default(rawBuffer);
  const metadata = await image.metadata();

  const width = metadata.width ?? 0;
  if (width > 0 && width < MIN_WIDTH_PX) {
    console.warn(
      `[render] WARNING: image for page ${pageId} is only ${width}px wide ` +
        `(minimum recommended: ${MIN_WIDTH_PX}px) — vision accuracy may be degraded.`,
    );
  }

  return image.jpeg({ quality: 92 }).toBuffer();
}

// ---------------------------------------------------------------------------
// renderPage
// ---------------------------------------------------------------------------

/**
 * Renders a OneNote page to a JPEG buffer via the configured strategy chain.
 *
 * Attempts each strategy in turn. When a strategy fails a warning is logged
 * and the next strategy is tried. If all strategies are exhausted, a
 * {@link RenderError} is thrown with a combined failure message.
 *
 * After a successful render the raw buffer is normalised to JPEG and two
 * quality checks are applied: a width check (warns if below {@link MIN_WIDTH_PX})
 * and a size check (warns if the JPEG is below {@link MIN_IMAGE_BYTES}).
 *
 * Emits `[render] page <id> rendered via <strategy> in <ms>ms (<bytes> bytes)`
 * to stdout on success.
 *
 * @param page        - Page metadata including the Graph content URL.
 * @param graphClient - Authenticated Graph API client.
 * @returns RenderResult with image buffer, hash, strategy name, and duration.
 * @throws {@link RenderError} when every strategy in the chain has failed.
 */
export async function renderPage(page: PageMeta, graphClient: GraphClient): Promise<RenderResult> {
  const start = Date.now();
  const chain = buildStrategyChain();
  const failures: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const strategy = chain[i];

    try {
      const rawBuffer = await runStrategy(strategy, page, graphClient);
      const imageBuffer = await normalizeToJpeg(rawBuffer, page.id);
      const renderDurationMs = Date.now() - start;
      const contentHash = hashBuffer(imageBuffer);

      if (imageBuffer.length < MIN_IMAGE_BYTES) {
        console.warn(
          `[render] WARNING: rendered image for page ${page.id} is suspiciously small ` +
            `(${imageBuffer.length} bytes) — vision accuracy may be degraded.`,
        );
      }

      console.log(
        `[render] page ${page.id} rendered via ${strategy} in ${renderDurationMs}ms ` +
          `(${imageBuffer.length} bytes)`,
      );

      return {
        pageId: page.id,
        imageBuffer,
        contentHash,
        renderStrategy: strategy,
        renderDurationMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${strategy}: ${message}`);

      if (i < chain.length - 1) {
        console.warn(
          `[render] ${strategy} failed, falling back to ${chain[i + 1]}: ${message}`,
        );
      }
    }
  }

  throw new RenderError(
    `All rendering strategies exhausted for page ${page.id}:\n` +
      failures.map((f) => `  - ${f}`).join('\n'),
    page.id,
  );
}
