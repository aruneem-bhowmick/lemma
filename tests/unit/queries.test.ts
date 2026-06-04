/**
 * Unit tests for src/db/queries.ts.
 *
 * The postgres.js client is mocked at the module level so these tests
 * never require a real database or DATABASE_URL.  Each test controls the
 * return value of the db tagged-template mock to exercise specific code
 * paths in the query functions.
 *
 * Tagged-template calls capture arguments as follows:
 *   mockDb.mock.calls[0][0]  — TemplateStringsArray (static SQL parts)
 *   mockDb.mock.calls[0][1+] — interpolated parameter values
 *
 * Joining the TemplateStringsArray with '' gives the SQL skeleton; the
 * dynamic values are the subsequent arguments.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// vi.hoisted() is required so that the mock variable is available inside
// the vi.mock() factory, which is hoisted to the top of the file before
// any import statements.
const mockDb = vi.hoisted(() => {
  const fn = vi.fn();
  return fn;
});

vi.mock('../../src/db/client.js', () => ({
  db: mockDb,
  closeDb: vi.fn(),
}));

import {
  upsertPage,
  getPage,
  getPagesByStatus,
  markProcessed,
  markFailed,
  getContentHash,
  pruneDeletedPages,
} from '../../src/db/queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the joined SQL skeleton from the first tagged-template call. */
function capturedSql(callIndex = 0): string {
  return (mockDb.mock.calls[callIndex][0] as TemplateStringsArray).join('');
}

/** Extract a specific interpolated parameter from the first call. */
function capturedParam(paramIndex: number, callIndex = 0): unknown {
  return mockDb.mock.calls[callIndex][paramIndex + 1];
}

const SAMPLE_ENTRY = {
  id: 'page-test-001',
  title: 'Graph Colouring',
  section: 'Graph Theory',
  last_modified: '2024-03-15T10:00:00.000Z',
} as const;

const FULL_ROW = {
  ...SAMPLE_ENTRY,
  content_hash: 'sha256:abc123',
  markdown_path: 'graph-theory/page-test-001.md',
  status: 'processed' as const,
  processed_at: '2024-03-16T08:00:00.000Z',
  error_message: null,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.mockResolvedValue([]);
  // Attach a no-op array helper so calls to db.array() inside queries don't
  // throw a TypeError when the function is mocked.
  (mockDb as unknown as Record<string, unknown>).array = vi.fn((v: unknown) => v);
});

// ---------------------------------------------------------------------------
// upsertPage
// ---------------------------------------------------------------------------

describe('upsertPage', () => {
  it('calls db with the correct page id as first interpolated value', async () => {
    await upsertPage(SAMPLE_ENTRY);
    expect(mockDb).toHaveBeenCalledOnce();
    expect(capturedParam(0)).toBe(SAMPLE_ENTRY.id);
  });

  it('SQL skeleton contains INSERT INTO pages', async () => {
    await upsertPage(SAMPLE_ENTRY);
    expect(capturedSql()).toContain('INSERT INTO pages');
  });

  it('SQL skeleton contains ON CONFLICT upsert clause', async () => {
    await upsertPage(SAMPLE_ENTRY);
    expect(capturedSql()).toContain('ON CONFLICT');
    expect(capturedSql()).toContain('DO UPDATE SET');
  });

  it('passes all four metadata fields as parameters', async () => {
    await upsertPage(SAMPLE_ENTRY);
    // id, title, section, last_modified are parameters 1–4
    expect(capturedParam(0)).toBe(SAMPLE_ENTRY.id);
    expect(capturedParam(1)).toBe(SAMPLE_ENTRY.title);
    expect(capturedParam(2)).toBe(SAMPLE_ENTRY.section);
    expect(capturedParam(3)).toBe(SAMPLE_ENTRY.last_modified);
  });
});

// ---------------------------------------------------------------------------
// getPage
// ---------------------------------------------------------------------------

describe('getPage', () => {
  it('returns null when the db returns an empty array', async () => {
    mockDb.mockResolvedValueOnce([]);
    const result = await getPage('nonexistent-id');
    expect(result).toBeNull();
  });

  it('returns a ManifestEntry with all required fields when a row is found', async () => {
    mockDb.mockResolvedValueOnce([FULL_ROW]);
    const entry = await getPage(SAMPLE_ENTRY.id);
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(FULL_ROW.id);
    expect(entry?.title).toBe(FULL_ROW.title);
    expect(entry?.section).toBe(FULL_ROW.section);
    expect(entry?.status).toBe('processed');
    expect(entry?.content_hash).toBe(FULL_ROW.content_hash);
    expect(entry?.markdown_path).toBe(FULL_ROW.markdown_path);
  });

  it('normalises a Date last_modified to an ISO string', async () => {
    const date = new Date('2024-03-15T10:00:00.000Z');
    mockDb.mockResolvedValueOnce([{ ...FULL_ROW, last_modified: date }]);
    const entry = await getPage(SAMPLE_ENTRY.id);
    expect(typeof entry?.last_modified).toBe('string');
    expect(entry?.last_modified).toBe(date.toISOString());
  });

  it('normalises a Date processed_at to an ISO string', async () => {
    const date = new Date('2024-03-16T08:00:00.000Z');
    mockDb.mockResolvedValueOnce([{ ...FULL_ROW, processed_at: date }]);
    const entry = await getPage(SAMPLE_ENTRY.id);
    expect(typeof entry?.processed_at).toBe('string');
    expect(entry?.processed_at).toBe(date.toISOString());
  });

  it('passes the id as a query parameter', async () => {
    mockDb.mockResolvedValueOnce([FULL_ROW]);
    await getPage('my-page-id');
    expect(capturedParam(0)).toBe('my-page-id');
  });
});

// ---------------------------------------------------------------------------
// getPagesByStatus
// ---------------------------------------------------------------------------

describe('getPagesByStatus', () => {
  it('passes the status value as a query parameter', async () => {
    await getPagesByStatus('pending');
    expect(capturedParam(0)).toBe('pending');
  });

  it('returns an empty array when the db returns no rows', async () => {
    mockDb.mockResolvedValueOnce([]);
    const rows = await getPagesByStatus('failed');
    expect(rows).toEqual([]);
  });

  it('returns a mapped array of ManifestEntry objects', async () => {
    mockDb.mockResolvedValueOnce([FULL_ROW, { ...FULL_ROW, id: 'page-002' }]);
    const rows = await getPagesByStatus('processed');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(FULL_ROW.id);
    expect(rows[1].id).toBe('page-002');
  });

  it('SQL skeleton contains WHERE status =', async () => {
    await getPagesByStatus('failed');
    expect(capturedSql()).toContain('WHERE');
    expect(capturedSql()).toContain('status');
  });
});

// ---------------------------------------------------------------------------
// markProcessed
// ---------------------------------------------------------------------------

describe('markProcessed', () => {
  it("SQL skeleton contains status = 'processed'", async () => {
    await markProcessed('page-1', 'graph-theory/page-1.md', 'sha256:xyz');
    expect(capturedSql()).toContain("status        = 'processed'");
  });

  it('passes the markdown path as a parameter', async () => {
    await markProcessed('page-1', 'some/relative/path.md', 'sha256:hash');
    // storedPath is the first param, contentHash second, id third
    const args = mockDb.mock.calls[0];
    const paramValues = args.slice(1); // skip TemplateStringsArray
    expect(paramValues).toContain('some/relative/path.md');
  });

  it('passes the content hash as a parameter', async () => {
    await markProcessed('page-1', 'path.md', 'sha256:deadbeef');
    const paramValues = mockDb.mock.calls[0].slice(1);
    expect(paramValues).toContain('sha256:deadbeef');
  });

  it('SQL skeleton contains processed_at = NOW()', async () => {
    await markProcessed('page-1', 'path.md', 'sha256:hash');
    expect(capturedSql()).toContain('processed_at  = NOW()');
  });
});

// ---------------------------------------------------------------------------
// markFailed
// ---------------------------------------------------------------------------

describe('markFailed', () => {
  it("SQL skeleton contains status = 'failed'", async () => {
    await markFailed('page-1', 'Vision API timed out');
    expect(capturedSql()).toContain("status        = 'failed'");
  });

  it('passes the error message as an interpolated parameter', async () => {
    await markFailed('page-1', 'Connection refused');
    const paramValues = mockDb.mock.calls[0].slice(1);
    expect(paramValues).toContain('Connection refused');
  });

  it('truncates error messages longer than 2000 characters', async () => {
    const longMessage = 'x'.repeat(3000);
    await markFailed('page-1', longMessage);
    const paramValues = mockDb.mock.calls[0].slice(1);
    const storedMessage = paramValues.find(
      (v) => typeof v === 'string' && v.length <= 2000,
    );
    expect(storedMessage).toBeDefined();
    expect((storedMessage as string).length).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// getContentHash
// ---------------------------------------------------------------------------

describe('getContentHash', () => {
  it('returns null when no row is found', async () => {
    mockDb.mockResolvedValueOnce([]);
    const result = await getContentHash('nonexistent-id');
    expect(result).toBeNull();
  });

  it('returns null when content_hash column is null', async () => {
    mockDb.mockResolvedValueOnce([{ content_hash: null }]);
    const result = await getContentHash('pending-page');
    expect(result).toBeNull();
  });

  it('returns the hash string when a row exists', async () => {
    mockDb.mockResolvedValueOnce([{ content_hash: 'sha256:abc123' }]);
    const result = await getContentHash('processed-page');
    expect(result).toBe('sha256:abc123');
  });

  it('passes the id as a query parameter', async () => {
    mockDb.mockResolvedValueOnce([]);
    await getContentHash('my-specific-id');
    expect(capturedParam(0)).toBe('my-specific-id');
  });
});

// ---------------------------------------------------------------------------
// pruneDeletedPages
// ---------------------------------------------------------------------------

describe('pruneDeletedPages', () => {
  it('returns the count of deleted rows from the CTE result', async () => {
    mockDb.mockResolvedValueOnce([{ count: 3 }]);
    const deleted = await pruneDeletedPages(['id1', 'id2']);
    expect(deleted).toBe(3);
  });

  it('returns 0 when no rows are deleted', async () => {
    mockDb.mockResolvedValueOnce([{ count: 0 }]);
    const deleted = await pruneDeletedPages(['id-still-exists']);
    expect(deleted).toBe(0);
  });

  it('calls db when currentIds is empty (delete all path)', async () => {
    mockDb.mockResolvedValueOnce([{ count: 5 }]);
    const deleted = await pruneDeletedPages([]);
    expect(mockDb).toHaveBeenCalledOnce();
    expect(deleted).toBe(5);
  });

  it('calls db.array() with the currentIds array when non-empty', async () => {
    mockDb.mockResolvedValueOnce([{ count: 2 }]);
    await pruneDeletedPages(['id1', 'id2', 'id3']);
    const arrayHelper = (mockDb as unknown as { array: ReturnType<typeof vi.fn> }).array;
    expect(arrayHelper).toHaveBeenCalledWith(['id1', 'id2', 'id3']);
  });
});
