/**
 * Stage 2 of the Lemma pipeline: change detection.
 *
 * Compares each discovered page against its manifest entry and returns
 * only the subset that needs processing: new pages, pages whose
 * lastModifiedDateTime has changed, pending pages from interrupted runs,
 * and failed pages queued for retry.
 */

import type { PageMeta } from '../types.js';

/**
 * Returns the subset of pages that need processing this run.
 *
 * A page needs processing if it is new, pending, failed, or its
 * lastModifiedDateTime has advanced since the last successful run.
 *
 * @param pages - Full list of pages returned by discoverPages.
 * @returns Array of PageMeta objects that require processing.
 */
export async function detectChanges(pages: PageMeta[]): Promise<PageMeta[]> {
  void pages;
  return [];
}
