/**
 * Stage 4 of the Lemma pipeline: vision conversion.
 *
 * Sends a rendered page image to the chosen vision LLM, parses the
 * structured response into a ConvertedPage object, and extracts all
 * diagram adjacency data and concept titles.
 *
 * Implemented in full by Prompts 7 and 8.
 */

import type { PageMeta, ConvertedPage } from '../types.js';
import type { RenderResult } from './render.js';

/**
 * Converts a rendered page image to structured Markdown via the vision LLM.
 *
 * @param renderResult - Output from the render stage (image buffer + metadata).
 * @param page - Page metadata for context injection into the prompt.
 * @returns ConvertedPage with validated Markdown, diagrams, frontmatter, and asset paths.
 * @throws VisionError when the API call fails after retries.
 */
export async function convertPage(
  renderResult: RenderResult,
  page: PageMeta,
): Promise<ConvertedPage> {
  void renderResult;
  void page;
  throw new Error('convertPage not yet implemented — see Prompts 7 and 8');
}
