/**
 * Stage 2 of the Lemma pipeline: change detection.
 *
 * Compares each discovered page against its manifest entry and returns
 * only the subset that needs processing: new pages, pages whose
 * `lastModifiedDateTime` has changed, pending pages from interrupted runs,
 * and failed pages queued for unconditional retry.
 *
 * Design note — no image fetching here:
 * Fetching and hashing the rendered image is expensive (a full Graph API
 * round-trip + PDF rasterization per page).  The `lastModifiedDateTime`
 * timestamp is a reliable and cheap pre-filter: if the Graph API says the
 * page is unchanged, there is no reason to re-render it.  The content hash
 * stored in the manifest acts as a belt-and-suspenders check inside the
 * render stage: if `lastModifiedDateTime` is somehow identical yet the
 * rendered bytes differ (e.g. due to a rendering bug that was fixed), the
 * render stage will detect the mismatch via hash comparison and force a
 * re-conversion.  Change detection therefore intentionally never fetches
 * images.
 */

import type { PageMeta, ManifestEntry } from '../types.js';
import { getPage } from '../db/queries.js';

/**
 * Classification of why a page was included in or excluded from the
 * processing set.  Used internally to produce an accurate log summary.
 */
type ChangeReason = 'new' | 'modified' | 'retrying' | 'skipped';

/**
 * Determines the change reason for a single page given its manifest entry.
 *
 * The four conditions checked in priority order:
 *
 *  (a) No manifest entry at all — the page has never been seen; insert as new.
 *  (b) Status is `'pending'` — a previous run started but did not finish.
 *  (c) Status is `'failed'` — unconditionally retry every failed page on
 *      every run so that transient errors (network blips, API timeouts) do
 *      not permanently strand a page.
 *  (d) `lastModifiedDateTime` differs from the stored `last_modified` —
 *      the page content has changed since the last successful conversion.
 *
 * Any page that does not match a condition is `'skipped'` (processed and
 * unchanged).
 *
 * @param page  - PageMeta from the Graph API for this run.
 * @param entry - Manifest row for the page, or `null` if not yet inserted.
 * @returns The reason the page should (or should not) be processed.
 */
function classifyPage(page: PageMeta, entry: ManifestEntry | null): ChangeReason {
  if (entry === null) return 'new';
  if (entry.status === 'pending') return 'new';
  if (entry.status === 'failed') return 'retrying';
  if (page.lastModifiedDateTime !== entry.last_modified) return 'modified';
  return 'skipped';
}

/**
 * Returns the subset of pages that need processing on this pipeline run.
 *
 * All manifest reads are issued in a single `Promise.all` so that the DB
 * round-trips are concurrent rather than sequential.  For a notebook with
 * N pages this means O(1) round-trips to the database (bounded by the
 * connection pool) rather than O(N) serial queries.
 *
 * Pages are classified by {@link classifyPage} into one of four categories:
 *
 * | Reason    | Condition |
 * |-----------|-----------|
 * | `new`     | No manifest entry, or status is `'pending'` |
 * | `modified`| `lastModifiedDateTime` differs from stored `last_modified` |
 * | `retrying`| Status is `'failed'` (always retried) |
 * | `skipped` | Status is `'processed'` and timestamp is unchanged |
 *
 * @param pages - Full list of pages returned by `discoverPages`.
 * @returns Array of `PageMeta` objects that require processing this run.
 *          Returns an empty array when every page is unchanged.
 */
export async function detectChanges(pages: PageMeta[]): Promise<PageMeta[]> {
  const entries = await Promise.all(pages.map((page) => getPage(page.id)));

  const result: PageMeta[] = [];
  let newCount = 0;
  let modifiedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < pages.length; i++) {
    const reason = classifyPage(pages[i], entries[i] ?? null);

    switch (reason) {
      case 'new':
        newCount++;
        result.push(pages[i]);
        break;
      case 'modified':
        modifiedCount++;
        result.push(pages[i]);
        break;
      case 'retrying':
        failedCount++;
        result.push(pages[i]);
        break;
      case 'skipped':
        skippedCount++;
        break;
    }
  }

  console.log(
    `[detect] ${result.length} pages need processing` +
      ` (${newCount} new, ${modifiedCount} modified,` +
      ` ${failedCount} retrying, ${skippedCount} unchanged)`,
  );

  return result;
}
