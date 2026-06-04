/**
 * Typed query functions for the `pages` manifest table.
 *
 * Every function uses parameterized queries via the postgres.js tagged-
 * template syntax to prevent SQL injection. All functions are fully typed
 * against the ManifestEntry interface from src/types.ts.
 *
 * Implemented in full by Prompt 2.
 */

import type { ManifestEntry } from '../types.js';

/**
 * The subset of ManifestEntry fields supplied by the Graph API discover stage.
 *
 * DB-owned fields (status, content_hash, markdown_path, processed_at) are
 * intentionally excluded — they are set by later pipeline stages, not at
 * discovery time.
 */
type SourcePageMeta = Pick<ManifestEntry, 'id' | 'title' | 'section' | 'last_modified'>;

/**
 * Inserts a new page entry or updates an existing one's title, section, and
 * last_modified without touching status, content_hash, markdown_path, or processed_at.
 *
 * @param entry - Source metadata from the Graph API (id, title, section, last_modified only).
 */
export async function upsertPage(entry: SourcePageMeta): Promise<void> {
  void entry;
  throw new Error('upsertPage not yet implemented — see Prompt 2');
}

/**
 * Retrieves a single page manifest entry by its OneNote page identifier.
 *
 * @param id - OneNote page identifier.
 * @returns The ManifestEntry row, or null if no row exists for this id.
 */
export async function getPage(id: string): Promise<ManifestEntry | null> {
  throw new Error(`getPage not yet implemented — see Prompt 2 (id: ${id})`);
}

/**
 * Retrieves all pages whose status matches the given value.
 *
 * @param status - One of 'pending', 'processed', or 'failed'.
 * @returns Array of matching ManifestEntry rows (may be empty).
 */
export async function getPagesByStatus(
  status: ManifestEntry['status'],
): Promise<ManifestEntry[]> {
  throw new Error(`getPagesByStatus not yet implemented — see Prompt 2 (status: ${status})`);
}

/**
 * Marks a page as successfully processed, recording its output path and content hash.
 *
 * @param id           - OneNote page identifier.
 * @param markdownPath - Relative path to the written Markdown file (relative to the
 *                       corpus root, e.g. "graph-theory/abc123.md").  The
 *                       implementation must store a relative path so the manifest
 *                       is portable across machines; convert any absolute path
 *                       with path.relative before persisting.
 * @param contentHash  - SHA-256 hash of the rendered image, prefixed with 'sha256:'.
 */
export async function markProcessed(
  id: string,
  markdownPath: string,
  contentHash: string,
): Promise<void> {
  void id;
  void markdownPath;
  void contentHash;
  throw new Error('markProcessed not yet implemented — see Prompt 2');
}

/**
 * Marks a page as failed, storing a short error message for diagnostics.
 *
 * The error message is truncated to 2000 characters before storage.
 *
 * @param id           - OneNote page identifier.
 * @param errorMessage - Human-readable description of the failure.
 */
export async function markFailed(id: string, errorMessage: string): Promise<void> {
  void id;
  void errorMessage;
  throw new Error('markFailed not yet implemented — see Prompt 2');
}

/**
 * Returns the stored content hash for a page, or null if not yet processed.
 *
 * @param id - OneNote page identifier.
 * @returns SHA-256 hash string prefixed with 'sha256:', or null.
 */
export async function getContentHash(id: string): Promise<string | null> {
  throw new Error(`getContentHash not yet implemented — see Prompt 2 (id: ${id})`);
}

/**
 * Deletes manifest rows for pages no longer present in the Graph API page list.
 *
 * @param currentIds - Array of all OneNote page identifiers from the current Graph listing.
 * @returns The number of rows deleted.
 */
export async function pruneDeletedPages(currentIds: string[]): Promise<number> {
  throw new Error(
    `pruneDeletedPages not yet implemented — see Prompt 2 (${currentIds.length} current ids)`,
  );
}
