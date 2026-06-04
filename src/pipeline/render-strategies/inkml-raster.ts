/**
 * Rendering strategy B: InkML → SVG → PNG rasterisation (stub, not implemented).
 *
 * This strategy would fetch the raw InkML stroke data from the Graph API,
 * render each stroke to SVG paths, and convert the result to PNG. It would
 * enable fully automated processing of handwritten-ink pages without requiring
 * any manual export steps.
 *
 * Current status: stub only. The effort required to implement a faithful
 * ink renderer (stroke interpolation, pressure curves, correct z-ordering)
 * is disproportionate to the marginal benefit given that the semi-auto
 * strategy already covers the primary use case. This file reserves the
 * strategy name in the fallback chain and documents the intended approach
 * for future work.
 *
 * @see src/pipeline/render-strategies/semi-auto.ts — current primary for personal accounts.
 * @see src/pipeline/render-strategies/pdf-export.ts — primary for work/school accounts.
 * @see src/pipeline/render.ts — strategy fallback chain configuration.
 */

import type { PageMeta } from '../../types.js';

/**
 * Placeholder for the InkML → SVG → PNG rendering strategy.
 *
 * Always throws to signal that this strategy is not available, allowing the
 * render orchestrator's fallback chain to proceed to the next candidate.
 *
 * @param page - Page metadata (unused in the stub).
 * @throws Error unconditionally — strategy is not yet implemented.
 */
export async function inkmlRasterStrategy(page: PageMeta): Promise<Buffer> {
  void page;
  throw new Error('inkml-raster strategy not yet implemented');
}
