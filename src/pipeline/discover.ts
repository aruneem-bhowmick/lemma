/**
 * Stage 1 of the Lemma pipeline: page discovery.
 *
 * Calls the Microsoft Graph API to list all pages in the target notebook
 * and upserts each page into the manifest. New pages are inserted with
 * status 'pending'; existing pages have only their title, section, and
 * last_modified fields refreshed, so processing state is preserved across
 * runs and re-discovery never resets a page that was already converted.
 */

import { GraphClient } from '../graph/client.js';
import { upsertPage, getPage } from '../db/queries.js';
import type { PageMeta } from '../types.js';
import type { GraphPage } from '../graph/types.js';

/** Page count above which a large-notebook advisory is emitted. */
const LARGE_NOTEBOOK_THRESHOLD = 500;

/**
 * Maximum number of concurrent database calls issued at once.
 *
 * The postgres.js pool has max:5 connections. Firing hundreds of
 * concurrent promises into it does not saturate the DB server (the
 * pool queues extras), but it creates a large number of pending JS
 * promises and makes memory usage unpredictable for very large
 * notebooks. Processing pages in chunks of this size keeps the
 * in-flight count bounded without sacrificing throughput.
 */
const DB_CONCURRENCY_LIMIT = 50;

/**
 * Runs `fn` over every item in `items`, processing at most
 * `chunkSize` items concurrently. Results are returned in input order.
 *
 * @param items - Array of inputs to process.
 * @param chunkSize - Maximum number of concurrent `fn` calls.
 * @param fn - Async function applied to each item.
 * @returns Resolved values in the same order as `items`.
 */
async function runInChunks<T, R>(
  items: T[],
  chunkSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

/**
 * Maps a raw Microsoft Graph API page object to the pipeline's PageMeta format.
 *
 * @param gp - Raw GraphPage as returned by the Graph API.
 * @returns PageMeta with camelCase field names matching the shared type.
 */
function toPageMeta(gp: GraphPage): PageMeta {
  return {
    id: gp.id,
    title: gp.title,
    section: gp.parentSection.displayName,
    lastModifiedDateTime: gp.lastModifiedDateTime,
  };
}

/**
 * Discovers all pages in the target OneNote notebook and seeds the manifest.
 *
 * Retrieves the complete page list from the Graph API, maps each entry to
 * a `PageMeta` object, and upserts every page into the `pages` manifest
 * table. The upsert SQL uses an `INSERT … ON CONFLICT (id) DO UPDATE`
 * clause that ensures:
 *
 *  - **New pages** are inserted with `status = 'pending'` so they are
 *    picked up by the change-detection stage on the same run.
 *  - **Existing pages** have only `title`, `section`, and `last_modified`
 *    refreshed — `status`, `content_hash`, `markdown_path`, and
 *    `processed_at` are never overwritten, so a page that was already
 *    successfully converted is not inadvertently reset to pending.
 *
 * All manifest reads (for the new-vs-existing count) are issued in parallel
 * via `Promise.all`. Upserts are similarly parallelised.
 *
 * If the notebook contains more than 500 pages a warning is logged advising
 * the operator to consider scoping the sync to individual sections.
 *
 * Errors thrown by `GraphClient.listPages` are propagated directly; the
 * pipeline orchestrator is responsible for deciding whether to abort.
 *
 * @param notebookId - Microsoft OneNote notebook identifier (GUID).  Defaults
 *                     to `process.env.ONENOTE_NOTEBOOK_ID` when called from
 *                     the orchestrator.
 * @returns Array of `PageMeta` for every page found in the notebook (both
 *          new and previously known pages).
 * @throws  GraphError if the Graph API call fails or returns a non-success
 *          status.
 */
export async function discoverPages(notebookId: string): Promise<PageMeta[]> {
  const client = new GraphClient();
  const graphPages = await client.listPages(notebookId);

  if (graphPages.length > LARGE_NOTEBOOK_THRESHOLD) {
    console.warn(
      `[discover] Large notebook detected (>500 pages); consider section-scoped sync.`,
    );
  }

  const pages: PageMeta[] = graphPages.map(toPageMeta);

  // Read existing manifest entries in bounded-concurrent chunks. Results are
  // used only to produce the new-vs-existing count for the log summary; the
  // upsert below is unconditional because the SQL ON CONFLICT clause is the
  // authoritative guard for status preservation.
  const existingEntries = await runInChunks(pages, DB_CONCURRENCY_LIMIT, (p) =>
    getPage(p.id),
  );

  // Upsert every page in bounded-concurrent chunks.
  // - New pages  → INSERT with status = 'pending' (baked into the SQL).
  // - Existing   → UPDATE title, section, last_modified only; status untouched.
  await runInChunks(pages, DB_CONCURRENCY_LIMIT, (page) =>
    upsertPage({
      id: page.id,
      title: page.title,
      section: page.section,
      last_modified: page.lastModifiedDateTime,
    }),
  );

  const newCount = existingEntries.filter((e) => e === null).length;
  const existingCount = existingEntries.filter((e) => e !== null).length;

  console.log(
    `[discover] Found ${pages.length} pages (${newCount} new, ${existingCount} existing)`,
  );

  return pages;
}
