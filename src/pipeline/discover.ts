/**
 * Stage 1 of the Lemma pipeline: page discovery.
 *
 * Calls the Microsoft Graph API to list all pages in the target notebook
 * and upserts each page into the manifest with status 'pending' for any
 * pages not previously seen, without overwriting existing processed/failed entries.
 *
 * Implemented in full by Prompt 4.
 */

import type { PageMeta } from '../types.js';

/**
 * Discovers all pages in the target OneNote notebook and seeds the manifest.
 *
 * @param notebookId - Microsoft OneNote notebook identifier.
 * @returns Array of PageMeta objects for all pages found.
 */
export async function discoverPages(notebookId: string): Promise<PageMeta[]> {
  void notebookId;
  return [];
}
