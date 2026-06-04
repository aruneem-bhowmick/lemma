/**
 * Typed query functions for the `pages` manifest table.
 *
 * Every function uses the postgres.js tagged-template syntax for
 * parameterized queries — no SQL string concatenation for values.
 * All functions are fully typed against the ManifestEntry interface
 * from `src/types.ts`.
 *
 * Timestamp columns (`last_modified`, `processed_at`) are stored as
 * `timestamptz` in Postgres.  postgres.js returns these as JavaScript
 * Date objects by default; the `rowToManifestEntry` helper normalises
 * them to ISO 8601 strings so the rest of the pipeline can treat them
 * as opaque strings, matching the ManifestEntry type definition.
 */

import { db } from './client.js';
import type { ManifestEntry } from '../types.js';
import { isAbsolute, relative } from 'path';

/**
 * The subset of ManifestEntry fields supplied by the Graph API discovery
 * stage.  DB-owned fields (status, content_hash, markdown_path,
 * processed_at, error_message) are excluded — they are set by later
 * pipeline stages, not at discovery time.
 */
type SourcePageMeta = Pick<ManifestEntry, 'id' | 'title' | 'section' | 'last_modified'>;

/**
 * Raw row shape returned by postgres.js for `pages` SELECT queries.
 * Timestamps come back as Date objects (postgres.js default behaviour).
 */
type PageRow = {
  id: string;
  title: string;
  section: string;
  last_modified: Date | string;
  content_hash: string | null;
  markdown_path: string | null;
  status: ManifestEntry['status'];
  processed_at: Date | string | null;
  error_message: string | null;
};

/**
 * Converts a raw postgres.js row into a ManifestEntry, normalising any
 * Date values for timestamp columns to ISO 8601 strings.
 */
function rowToManifestEntry(row: PageRow): ManifestEntry {
  return {
    id: row.id,
    title: row.title,
    section: row.section,
    last_modified:
      row.last_modified instanceof Date
        ? row.last_modified.toISOString()
        : row.last_modified,
    content_hash: row.content_hash,
    markdown_path: row.markdown_path,
    status: row.status,
    processed_at:
      row.processed_at instanceof Date
        ? row.processed_at.toISOString()
        : (row.processed_at ?? null),
    error_message: row.error_message,
  };
}

/**
 * Inserts a new page or refreshes the Graph API metadata of an existing one.
 *
 * New rows are inserted with `status = 'pending'`.  For existing rows the
 * ON CONFLICT clause updates only `title`, `section`, and `last_modified` —
 * it deliberately leaves `status`, `content_hash`, `markdown_path`,
 * `processed_at`, and `error_message` untouched so that a re-run of the
 * discovery stage cannot accidentally reset the processing state of a page
 * that was already successfully converted.
 *
 * @param entry - Graph API page metadata (id, title, section, last_modified).
 */
export async function upsertPage(entry: SourcePageMeta): Promise<void> {
  await db`
    INSERT INTO pages (id, title, section, last_modified, status)
    VALUES (${entry.id}, ${entry.title}, ${entry.section}, ${entry.last_modified}, 'pending')
    ON CONFLICT (id) DO UPDATE SET
      title         = EXCLUDED.title,
      section       = EXCLUDED.section,
      last_modified = EXCLUDED.last_modified
  `;
}

/**
 * Retrieves a single manifest entry by OneNote page identifier.
 *
 * @param id - OneNote page identifier (primary key).
 * @returns The matching ManifestEntry row, or `null` if no row exists.
 */
export async function getPage(id: string): Promise<ManifestEntry | null> {
  const rows = await db`
    SELECT id, title, section, last_modified, content_hash,
           markdown_path, status, processed_at, error_message
    FROM   pages
    WHERE  id = ${id}
  `;
  if (rows.length === 0) return null;
  return rowToManifestEntry(rows[0] as PageRow);
}

/**
 * Retrieves all manifest entries whose status matches the given value.
 *
 * @param status - One of `'pending'`, `'processed'`, or `'failed'`.
 * @returns Array of matching ManifestEntry rows (may be empty).
 */
export async function getPagesByStatus(
  status: ManifestEntry['status'],
): Promise<ManifestEntry[]> {
  const rows = await db`
    SELECT id, title, section, last_modified, content_hash,
           markdown_path, status, processed_at, error_message
    FROM   pages
    WHERE  status = ${status}
  `;
  return (rows as unknown as PageRow[]).map(rowToManifestEntry);
}

/**
 * Marks a page as successfully processed, recording its output path and
 * content hash.
 *
 * Also clears any `error_message` left by a previous failed attempt so
 * that a successfully retried page does not show stale failure information.
 *
 * Absolute paths are converted to paths relative to `process.cwd()` before
 * storage so that the manifest remains valid across machines with different
 * root directories.
 *
 * @param id           - OneNote page identifier.
 * @param markdownPath - Path to the written Markdown file (absolute or relative).
 * @param contentHash  - SHA-256 hash of the rendered image, prefixed `'sha256:'`.
 */
export async function markProcessed(
  id: string,
  markdownPath: string,
  contentHash: string,
): Promise<void> {
  const storedPath = isAbsolute(markdownPath)
    ? relative(process.cwd(), markdownPath)
    : markdownPath;

  await db`
    UPDATE pages
    SET    status        = 'processed',
           markdown_path = ${storedPath},
           content_hash  = ${contentHash},
           processed_at  = NOW(),
           error_message = NULL
    WHERE  id = ${id}
  `;
}

/**
 * Marks a page as failed and stores a short diagnostic message.
 *
 * The error message is truncated to 2000 characters before storage to
 * keep the column bounded for runaway stack traces.
 *
 * @param id           - OneNote page identifier.
 * @param errorMessage - Human-readable description of the failure.
 */
export async function markFailed(id: string, errorMessage: string): Promise<void> {
  const truncated = errorMessage.slice(0, 2000);
  await db`
    UPDATE pages
    SET    status        = 'failed',
           error_message = ${truncated}
    WHERE  id = ${id}
  `;
}

/**
 * Returns the stored content hash for a page, or `null` if the page has
 * not yet been processed or does not exist in the manifest.
 *
 * @param id - OneNote page identifier.
 * @returns SHA-256 hash string prefixed with `'sha256:'`, or `null`.
 */
export async function getContentHash(id: string): Promise<string | null> {
  const rows = await db`
    SELECT content_hash
    FROM   pages
    WHERE  id = ${id}
  `;
  if (rows.length === 0) return null;
  return (rows[0] as { content_hash: string | null }).content_hash;
}

/**
 * Deletes manifest rows for pages that are no longer present in the Graph
 * API page list (i.e. pages that have been deleted from OneNote).
 *
 * Uses a CTE so that the count of deleted rows can be returned without a
 * separate SELECT.  Passing an empty `currentIds` array deletes every row
 * (full wipe), which should only happen when the notebook itself is empty.
 *
 * @param currentIds - All OneNote page identifiers returned by the current
 *                     Graph API listing.
 * @returns The number of rows deleted.
 */
export async function pruneDeletedPages(currentIds: string[]): Promise<number> {
  if (currentIds.length === 0) {
    const rows = await db`
      WITH deleted AS (DELETE FROM pages RETURNING id)
      SELECT count(*)::int AS count FROM deleted
    `;
    return (rows[0] as { count: number }).count;
  }

  // db.array() wraps the JavaScript string[] as a PostgreSQL text[] parameter,
  // which is the correct operand type for the = ANY() operator.
  const rows = await db`
    WITH deleted AS (
      DELETE FROM pages
      WHERE NOT (id = ANY(${db.array(currentIds)}))
      RETURNING id
    )
    SELECT count(*)::int AS count FROM deleted
  `;
  return (rows[0] as { count: number }).count;
}
