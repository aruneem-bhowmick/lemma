/**
 * Unit tests for src/pipeline/detect.ts.
 *
 * The database query module is mocked so that no real PostgreSQL connection
 * is made.  Tests verify:
 *
 *  - Pages with no manifest entry are included (new pages).
 *  - Pages with status 'pending' are included (interrupted prior run).
 *  - Pages with status 'failed' are included (unconditional retry).
 *  - Pages whose lastModifiedDateTime differs from the stored last_modified
 *    are included (content changed).
 *  - Pages that are 'processed' with an unchanged timestamp are excluded.
 *  - An empty input list returns an empty result without errors.
 *  - All manifest reads are issued in a single Promise.all call.
 *  - The log line is emitted with the correct format.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ManifestEntry, PageMeta } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Hoist mock functions before vi.mock calls
// ---------------------------------------------------------------------------

const mockGetPage = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock the database queries module
// ---------------------------------------------------------------------------

vi.mock('../../src/db/queries.js', () => ({
  getPage: mockGetPage,
  upsertPage: vi.fn(),
  markProcessed: vi.fn(),
  markFailed: vi.fn(),
  getPagesByStatus: vi.fn(),
  getContentHash: vi.fn(),
  pruneDeletedPages: vi.fn(),
}));

// Import under test AFTER mocks are installed
import { detectChanges } from '../../src/pipeline/detect.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Returns a minimal PageMeta fixture.
 *
 * @param id  - Page identifier suffix used to make fixtures unique.
 * @param ts  - ISO 8601 timestamp for lastModifiedDateTime.
 */
function makePageMeta(id: string, ts = '2024-01-15T10:00:00.000Z'): PageMeta {
  return {
    id,
    title: `Page ${id}`,
    section: 'Graph Theory',
    lastModifiedDateTime: ts,
    contentUrl: `https://graph.microsoft.com/v1.0/me/onenote/pages/${id}/content`,
  };
}

/**
 * Returns a ManifestEntry fixture for an already-processed page.
 *
 * @param id     - Page identifier.
 * @param status - Processing status (defaults to 'processed').
 * @param ts     - ISO 8601 timestamp stored in last_modified.
 */
function makeEntry(
  id: string,
  status: ManifestEntry['status'] = 'processed',
  ts = '2024-01-15T10:00:00.000Z',
): ManifestEntry {
  return {
    id,
    title: `Page ${id}`,
    section: 'Graph Theory',
    last_modified: ts,
    content_hash: 'sha256:deadbeef',
    markdown_path: `corpus/graph-theory/${id}.md`,
    status,
    processed_at: '2024-01-16T00:00:00.000Z',
    error_message: null,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectChanges', () => {
  it('includes new pages that have no manifest entry', async () => {
    mockGetPage.mockResolvedValue(null);
    const pages = [makePageMeta('page-1')];

    const result = await detectChanges(pages);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('page-1');
  });

  it('includes pages with status pending', async () => {
    mockGetPage.mockResolvedValue(makeEntry('page-1', 'pending'));
    const pages = [makePageMeta('page-1')];

    const result = await detectChanges(pages);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('page-1');
  });

  it('includes pages with status failed', async () => {
    mockGetPage.mockResolvedValue(makeEntry('page-1', 'failed'));
    const pages = [makePageMeta('page-1')];

    const result = await detectChanges(pages);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('page-1');
  });

  it('includes pages whose lastModifiedDateTime has changed', async () => {
    // Manifest has an old timestamp; the Graph API now reports a newer one.
    mockGetPage.mockResolvedValue(makeEntry('page-1', 'processed', '2024-01-01T00:00:00.000Z'));
    const pages = [makePageMeta('page-1', '2024-06-01T00:00:00.000Z')];

    const result = await detectChanges(pages);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('page-1');
  });

  it('excludes unchanged processed pages', async () => {
    const ts = '2024-01-15T10:00:00.000Z';
    // Both the Graph API and the manifest report the same timestamp.
    mockGetPage.mockResolvedValue(makeEntry('page-1', 'processed', ts));
    const pages = [makePageMeta('page-1', ts)];

    const result = await detectChanges(pages);

    expect(result).toHaveLength(0);
  });

  it('returns an empty array when all pages are unchanged', async () => {
    const ts = '2024-01-15T10:00:00.000Z';
    mockGetPage.mockResolvedValue(makeEntry('page-x', 'processed', ts));
    const pages = [
      makePageMeta('page-1', ts),
      makePageMeta('page-2', ts),
      makePageMeta('page-3', ts),
    ];
    // All three pages are processed with matching timestamps.
    mockGetPage
      .mockResolvedValueOnce(makeEntry('page-1', 'processed', ts))
      .mockResolvedValueOnce(makeEntry('page-2', 'processed', ts))
      .mockResolvedValueOnce(makeEntry('page-3', 'processed', ts));

    const result = await detectChanges(pages);

    expect(result).toHaveLength(0);
  });

  it('handles an empty page list without errors', async () => {
    const result = await detectChanges([]);

    expect(result).toHaveLength(0);
    expect(mockGetPage).not.toHaveBeenCalled();
  });

  it('fetches all manifest entries in a single parallel batch', async () => {
    const pages = [makePageMeta('page-1'), makePageMeta('page-2'), makePageMeta('page-3')];
    mockGetPage.mockResolvedValue(null);

    const promiseAllSpy = vi.spyOn(Promise, 'all');

    await detectChanges(pages);

    // Promise.all must have been called with an array of three promises —
    // one per page — rather than awaiting each getPage call sequentially.
    expect(promiseAllSpy).toHaveBeenCalledOnce();
    const [promisesArg] = promiseAllSpy.mock.calls[0] as [unknown[]];
    expect(promisesArg).toHaveLength(3);
  });

  it('logs a summary line matching [detect] N pages need processing', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetPage.mockResolvedValue(null);
    const pages = [makePageMeta('page-1'), makePageMeta('page-2')];

    await detectChanges(pages);

    const output = consoleSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/\[detect\] \d+ pages need processing/);
  });

  it('includes the correct breakdown counts in the log line', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ts = '2024-01-15T10:00:00.000Z';
    const oldTs = '2024-01-01T00:00:00.000Z';

    mockGetPage
      .mockResolvedValueOnce(null)                              // page-1: new
      .mockResolvedValueOnce(makeEntry('page-2', 'pending', ts)) // page-2: new (pending)
      .mockResolvedValueOnce(makeEntry('page-3', 'failed', ts))  // page-3: retrying
      .mockResolvedValueOnce(makeEntry('page-4', 'processed', oldTs)) // page-4: modified
      .mockResolvedValueOnce(makeEntry('page-5', 'processed', ts));   // page-5: skipped

    const pages = [
      makePageMeta('page-1', ts),
      makePageMeta('page-2', ts),
      makePageMeta('page-3', ts),
      makePageMeta('page-4', ts),  // newer than manifest
      makePageMeta('page-5', ts),  // same as manifest
    ];

    await detectChanges(pages);

    const output = consoleSpy.mock.calls.flat().join(' ');
    // 4 pages need processing: 2 new, 1 modified, 1 retrying, 1 unchanged
    expect(output).toContain('[detect] 4 pages need processing');
    expect(output).toContain('2 new');
    expect(output).toContain('1 modified');
    expect(output).toContain('1 retrying');
    expect(output).toContain('1 unchanged');
  });

  it('always retries failed pages regardless of whether their timestamp changed', async () => {
    // A failed page with an unchanged timestamp must still be included.
    const ts = '2024-01-15T10:00:00.000Z';
    mockGetPage.mockResolvedValue(makeEntry('page-1', 'failed', ts));
    const pages = [makePageMeta('page-1', ts)];

    const result = await detectChanges(pages);

    expect(result).toHaveLength(1);
  });

  it('correctly mixes new, modified, failed, and skipped pages', async () => {
    const ts = '2024-01-15T10:00:00.000Z';
    const oldTs = '2024-01-01T00:00:00.000Z';

    mockGetPage
      .mockResolvedValueOnce(null)                               // new
      .mockResolvedValueOnce(makeEntry('page-2', 'processed', oldTs)) // modified
      .mockResolvedValueOnce(makeEntry('page-3', 'processed', ts));   // skipped

    const pages = [
      makePageMeta('page-1', ts),
      makePageMeta('page-2', ts),
      makePageMeta('page-3', ts),
    ];

    const result = await detectChanges(pages);

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id)).toEqual(['page-1', 'page-2']);
  });
});
