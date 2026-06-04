/**
 * Unit tests for src/pipeline/discover.ts.
 *
 * GraphClient and the database query functions are mocked so that no real
 * API calls or database connections are made.  Tests verify:
 *
 *  - All GraphPage objects are mapped to PageMeta and returned.
 *  - upsertPage is called for every page (new and existing alike).
 *  - The upsertPage argument never includes a status field, ensuring the
 *    SQL ON CONFLICT clause — not the caller — controls status for existing rows.
 *  - GraphClient errors propagate without being swallowed.
 *  - Console output matches the expected log and warning patterns.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { GraphPage } from '../../src/graph/types.js';
import type { ManifestEntry } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Hoist mock functions so they are accessible inside vi.mock factory closures
// ---------------------------------------------------------------------------

const mockListPages = vi.hoisted(() => vi.fn());
const mockUpsertPage = vi.hoisted(() => vi.fn());
const mockGetPage = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock GraphClient — only listPages is exercised by discoverPages
// ---------------------------------------------------------------------------

vi.mock('../../src/graph/client.js', () => ({
  GraphClient: vi.fn().mockImplementation(() => ({
    listPages: mockListPages,
  })),
}));

// ---------------------------------------------------------------------------
// Mock database queries
// ---------------------------------------------------------------------------

vi.mock('../../src/db/queries.js', () => ({
  upsertPage: mockUpsertPage,
  getPage: mockGetPage,
  markProcessed: vi.fn(),
  markFailed: vi.fn(),
  getPagesByStatus: vi.fn(),
  getContentHash: vi.fn(),
  pruneDeletedPages: vi.fn(),
}));

// Import the mocked GraphClient constructor so we can re-wire it in beforeEach
import { GraphClient } from '../../src/graph/client.js';

// Import under test AFTER mocks are installed
import { discoverPages } from '../../src/pipeline/discover.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Returns a minimal GraphPage fixture with predictable field values.
 *
 * @param n - Numeric suffix appended to id and title to make each fixture unique.
 */
function makeGraphPage(n: number): GraphPage {
  return {
    id: `page-${n}`,
    title: `Page ${n}`,
    lastModifiedDateTime: '2024-01-15T10:00:00.000Z',
    parentSection: { id: 'section-1', displayName: 'Graph Theory' },
    contentUrl: `https://graph.microsoft.com/v1.0/me/onenote/pages/page-${n}/content`,
  };
}

/**
 * Returns a minimal ManifestEntry fixture simulating an already-processed page.
 *
 * @param id     - Page identifier matching the corresponding GraphPage fixture.
 * @param status - Manifest status to simulate (defaults to 'processed').
 */
function makeManifestEntry(
  id: string,
  status: ManifestEntry['status'] = 'processed',
): ManifestEntry {
  return {
    id,
    title: 'Old Title',
    section: 'Graph Theory',
    last_modified: '2024-01-01T00:00:00.000Z',
    content_hash: 'sha256:deadbeef',
    markdown_path: `corpus/graph-theory/${id}.md`,
    status,
    processed_at: '2024-01-02T00:00:00.000Z',
    error_message: null,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // vi.clearAllMocks() removes the constructor's mockImplementation, so the
  // GraphClient mock needs to be re-installed before every test.
  vi.mocked(GraphClient).mockImplementation(() => ({
    listPages: mockListPages,
  }) as unknown as InstanceType<typeof GraphClient>);

  // Default mock behaviors: pages are new (not in manifest) and upserts succeed.
  mockGetPage.mockResolvedValue(null);
  mockUpsertPage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discoverPages', () => {
  it('returns all pages from GraphClient as PageMeta objects', async () => {
    const graphPages = Array.from({ length: 5 }, (_, i) => makeGraphPage(i + 1));
    mockListPages.mockResolvedValue(graphPages);

    const result = await discoverPages('notebook-abc');

    expect(result).toHaveLength(5);
    expect(result[0]).toMatchObject({
      id: 'page-1',
      title: 'Page 1',
      section: 'Graph Theory',
      lastModifiedDateTime: '2024-01-15T10:00:00.000Z',
    });
  });

  it('upserts new pages, allowing the SQL to assign pending status', async () => {
    mockListPages.mockResolvedValue([makeGraphPage(1)]);
    mockGetPage.mockResolvedValue(null); // page is not yet in the manifest

    await discoverPages('notebook-abc');

    // upsertPage must be called once for the single new page
    expect(mockUpsertPage).toHaveBeenCalledOnce();
    expect(mockUpsertPage).toHaveBeenCalledWith({
      id: 'page-1',
      title: 'Page 1',
      section: 'Graph Theory',
      last_modified: '2024-01-15T10:00:00.000Z',
    });
    // The argument must not carry a status field; the SQL ON CONFLICT clause
    // is solely responsible for writing status = 'pending' for new rows.
    expect(mockUpsertPage.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('does not reset the status of already-processed pages', async () => {
    mockListPages.mockResolvedValue([makeGraphPage(1)]);
    mockGetPage.mockResolvedValue(makeManifestEntry('page-1', 'processed'));

    await discoverPages('notebook-abc');

    // upsertPage is still called to refresh title/section/last_modified, but
    // the argument has no status field so the SQL ON CONFLICT clause will not
    // overwrite the existing 'processed' status.
    expect(mockUpsertPage).toHaveBeenCalledOnce();
    expect(mockUpsertPage.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('does not reset the status of failed pages', async () => {
    mockListPages.mockResolvedValue([makeGraphPage(1)]);
    mockGetPage.mockResolvedValue(makeManifestEntry('page-1', 'failed'));

    await discoverPages('notebook-abc');

    expect(mockUpsertPage).toHaveBeenCalledOnce();
    expect(mockUpsertPage.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('propagates errors thrown by GraphClient.listPages', async () => {
    const graphError = new Error('Graph API unreachable');
    mockListPages.mockRejectedValue(graphError);

    await expect(discoverPages('notebook-abc')).rejects.toThrow('Graph API unreachable');
  });

  it('logs a summary line containing page counts after discovery', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockListPages.mockResolvedValue([makeGraphPage(1), makeGraphPage(2)]);
    // First page is new; second already exists in the manifest
    mockGetPage
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeManifestEntry('page-2', 'processed'));

    await discoverPages('notebook-abc');

    const output = consoleSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/\[discover\] Found \d+ pages/);
  });

  it('emits a console.warn when the notebook contains more than 500 pages', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const largeSet = Array.from({ length: 501 }, (_, i) => makeGraphPage(i + 1));
    mockListPages.mockResolvedValue(largeSet);

    await discoverPages('notebook-large');

    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/Large notebook detected/);
  });
});
