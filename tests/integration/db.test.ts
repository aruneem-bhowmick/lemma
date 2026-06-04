/**
 * Integration tests for the database manifest layer.
 *
 * These tests run against a real PostgreSQL instance and verify that the
 * migration SQL, connection pool, and query functions all work together
 * correctly.
 *
 * Prerequisites:
 *   - Set TEST_DATABASE_URL to a valid postgres connection string.
 *   - The target database must exist and be accessible; the test suite
 *     creates and truncates the `pages` table automatically.
 *
 * The entire suite is skipped when TEST_DATABASE_URL is not set so that
 * the standard `npm test` run (unit tests only) never fails due to a
 * missing database.
 *
 * Run with a real database:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost/test_db npm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type postgres from 'postgres';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// All tests in this file require a real database — skip the whole suite
// when TEST_DATABASE_URL is absent.
describe.skipIf(!TEST_DATABASE_URL)('db integration — pages manifest', () => {
  // Lazy-import the real client so that the module is only loaded (and
  // DATABASE_URL validated) when the suite is actually going to run.
  let db: postgres.Sql<Record<string, never>>;
  let closeDb: () => Promise<void>;

  let upsertPage: typeof import('../../src/db/queries.js')['upsertPage'];
  let getPage: typeof import('../../src/db/queries.js')['getPage'];
  let getPagesByStatus: typeof import('../../src/db/queries.js')['getPagesByStatus'];
  let markProcessed: typeof import('../../src/db/queries.js')['markProcessed'];
  let markFailed: typeof import('../../src/db/queries.js')['markFailed'];
  let getContentHash: typeof import('../../src/db/queries.js')['getContentHash'];
  let pruneDeletedPages: typeof import('../../src/db/queries.js')['pruneDeletedPages'];

  // Preserve the original DATABASE_URL so other suites are not affected by
  // the temporary override this suite needs to point the client at the test DB.
  let originalDatabaseUrl: string | undefined;

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    // Override DATABASE_URL for the duration of this suite.
    process.env.DATABASE_URL = TEST_DATABASE_URL;

    const clientModule = await import('../../src/db/client.js');
    db = clientModule.db;
    closeDb = clientModule.closeDb;

    const queriesModule = await import('../../src/db/queries.js');
    upsertPage = queriesModule.upsertPage;
    getPage = queriesModule.getPage;
    getPagesByStatus = queriesModule.getPagesByStatus;
    markProcessed = queriesModule.markProcessed;
    markFailed = queriesModule.markFailed;
    getContentHash = queriesModule.getContentHash;
    pruneDeletedPages = queriesModule.pruneDeletedPages;

    // Run the migration so the table definitely exists in the test DB.
    const migrationPath = resolve(__dirname, '../../src/db/migrations/001_pages.sql');
    const migrationSql = readFileSync(migrationPath, 'utf-8');
    await db.unsafe(migrationSql);
  });

  afterAll(async () => {
    // Leave the table but clear rows so repeated runs start clean.
    await db`TRUNCATE TABLE pages`;
    await closeDb();
    // Restore DATABASE_URL so the original value is visible to any suites
    // that run after this one in the same worker process.
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    await db`TRUNCATE TABLE pages`;
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  const BASE_ENTRY = {
    id: 'integ-page-001',
    title: 'Eulerian Paths',
    section: 'Graph Theory',
    last_modified: '2024-06-01T09:00:00.000Z',
  } as const;

  // ── Migration ─────────────────────────────────────────────────────────────

  it('migration creates the pages table', async () => {
    // The table was created in beforeAll; a simple SELECT confirms it exists.
    const rows = await db`SELECT 1 AS probe FROM pages LIMIT 1`;
    expect(rows).toBeDefined();
  });

  // ── upsertPage ────────────────────────────────────────────────────────────

  it('upsertPage inserts a new row', async () => {
    await upsertPage(BASE_ENTRY);
    const [{ count }] = await db`SELECT count(*)::int AS count FROM pages` as [{ count: number }];
    expect(count).toBe(1);
  });

  it('upsertPage is idempotent — re-running does not duplicate the row', async () => {
    await upsertPage(BASE_ENTRY);
    await upsertPage(BASE_ENTRY);
    const [{ count }] = await db`SELECT count(*)::int AS count FROM pages` as [{ count: number }];
    expect(count).toBe(1);
  });

  it('upsertPage sets status to pending for new rows', async () => {
    await upsertPage(BASE_ENTRY);
    const entry = await getPage(BASE_ENTRY.id);
    expect(entry?.status).toBe('pending');
  });

  it('upsertPage updates title and section without resetting status', async () => {
    await upsertPage(BASE_ENTRY);
    await markProcessed(BASE_ENTRY.id, 'graph-theory/integ-page-001.md', 'sha256:hash1');

    // Re-upsert with changed title — status must remain 'processed'.
    await upsertPage({ ...BASE_ENTRY, title: 'Eulerian Paths (updated)' });
    const entry = await getPage(BASE_ENTRY.id);
    expect(entry?.title).toBe('Eulerian Paths (updated)');
    expect(entry?.status).toBe('processed');
  });

  // ── getPage ───────────────────────────────────────────────────────────────

  it('getPage retrieves the inserted row with all fields', async () => {
    await upsertPage(BASE_ENTRY);
    const entry = await getPage(BASE_ENTRY.id);
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(BASE_ENTRY.id);
    expect(entry?.title).toBe(BASE_ENTRY.title);
    expect(entry?.section).toBe(BASE_ENTRY.section);
    expect(entry?.status).toBe('pending');
    expect(entry?.content_hash).toBeNull();
    expect(entry?.markdown_path).toBeNull();
    expect(entry?.processed_at).toBeNull();
    expect(entry?.error_message).toBeNull();
  });

  it('getPage returns null for an id that does not exist', async () => {
    const entry = await getPage('does-not-exist');
    expect(entry).toBeNull();
  });

  it('getPage returns last_modified as a valid ISO 8601 string', async () => {
    await upsertPage(BASE_ENTRY);
    const entry = await getPage(BASE_ENTRY.id);
    // Verify the value is a string and parses to a finite timestamp.
    // new Date(...) never throws — checking .getTime() is the reliable way
    // to detect an invalid date.
    expect(typeof entry?.last_modified).toBe('string');
    const ts = new Date(entry!.last_modified).getTime();
    expect(Number.isFinite(ts)).toBe(true);
  });

  // ── markProcessed ─────────────────────────────────────────────────────────

  it('markProcessed sets status, markdown_path, content_hash, and processed_at', async () => {
    await upsertPage(BASE_ENTRY);
    await markProcessed(BASE_ENTRY.id, 'graph-theory/integ-page-001.md', 'sha256:abc123');
    const entry = await getPage(BASE_ENTRY.id);
    expect(entry?.status).toBe('processed');
    expect(entry?.markdown_path).toBe('graph-theory/integ-page-001.md');
    expect(entry?.content_hash).toBe('sha256:abc123');
    expect(entry?.processed_at).not.toBeNull();
  });

  it('markProcessed clears a stale error_message from a prior failure', async () => {
    await upsertPage(BASE_ENTRY);
    await markFailed(BASE_ENTRY.id, 'Transient render error');
    // Confirm the error was recorded.
    const failed = await getPage(BASE_ENTRY.id);
    expect(failed?.error_message).toBe('Transient render error');
    // Now successfully process the page — error_message must be cleared.
    await markProcessed(BASE_ENTRY.id, 'graph-theory/integ-page-001.md', 'sha256:retry');
    const processed = await getPage(BASE_ENTRY.id);
    expect(processed?.status).toBe('processed');
    expect(processed?.error_message).toBeNull();
  });

  // ── markFailed ────────────────────────────────────────────────────────────

  it('markFailed sets status to failed and stores the error message', async () => {
    await upsertPage(BASE_ENTRY);
    await markFailed(BASE_ENTRY.id, 'Vision API returned 503');
    const entry = await getPage(BASE_ENTRY.id);
    expect(entry?.status).toBe('failed');
    expect(entry?.error_message).toBe('Vision API returned 503');
  });

  it('markFailed truncates error_message to at most 2000 characters', async () => {
    await upsertPage(BASE_ENTRY);
    await markFailed(BASE_ENTRY.id, 'z'.repeat(3000));
    const entry = await getPage(BASE_ENTRY.id);
    expect(entry?.error_message?.length).toBeLessThanOrEqual(2000);
  });

  // ── getPagesByStatus ──────────────────────────────────────────────────────

  it('getPagesByStatus returns only rows matching the requested status', async () => {
    await upsertPage({ ...BASE_ENTRY, id: 'page-a' });
    await upsertPage({ ...BASE_ENTRY, id: 'page-b' });
    await upsertPage({ ...BASE_ENTRY, id: 'page-c' });

    await markProcessed('page-a', 'path/a.md', 'sha256:a');
    await markProcessed('page-b', 'path/b.md', 'sha256:b');
    // page-c remains pending

    const processed = await getPagesByStatus('processed');
    expect(processed).toHaveLength(2);
    expect(processed.map((r) => r.id)).toEqual(expect.arrayContaining(['page-a', 'page-b']));

    const pending = await getPagesByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('page-c');
  });

  it('getPagesByStatus returns an empty array when no rows match', async () => {
    await upsertPage(BASE_ENTRY);
    const failed = await getPagesByStatus('failed');
    expect(failed).toEqual([]);
  });

  // ── getContentHash ────────────────────────────────────────────────────────

  it('getContentHash returns null for a page that has not been processed', async () => {
    await upsertPage(BASE_ENTRY);
    const hash = await getContentHash(BASE_ENTRY.id);
    expect(hash).toBeNull();
  });

  it('getContentHash returns null for a non-existent page id', async () => {
    const hash = await getContentHash('no-such-page');
    expect(hash).toBeNull();
  });

  it('getContentHash returns the stored hash after markProcessed', async () => {
    await upsertPage(BASE_ENTRY);
    await markProcessed(BASE_ENTRY.id, 'path.md', 'sha256:myhash99');
    const hash = await getContentHash(BASE_ENTRY.id);
    expect(hash).toBe('sha256:myhash99');
  });

  // ── pruneDeletedPages ─────────────────────────────────────────────────────

  it('pruneDeletedPages removes rows not in the currentIds list', async () => {
    await upsertPage({ ...BASE_ENTRY, id: 'keep-1' });
    await upsertPage({ ...BASE_ENTRY, id: 'keep-2' });
    await upsertPage({ ...BASE_ENTRY, id: 'stale-1' });
    await upsertPage({ ...BASE_ENTRY, id: 'stale-2' });

    const deleted = await pruneDeletedPages(['keep-1', 'keep-2']);
    expect(deleted).toBe(2);

    const [{ count }] = await db`SELECT count(*)::int AS count FROM pages` as [{ count: number }];
    expect(count).toBe(2);
  });

  it('pruneDeletedPages deletes all rows when currentIds is empty', async () => {
    await upsertPage({ ...BASE_ENTRY, id: 'will-be-gone-1' });
    await upsertPage({ ...BASE_ENTRY, id: 'will-be-gone-2' });

    const deleted = await pruneDeletedPages([]);
    expect(deleted).toBe(2);

    const [{ count }] = await db`SELECT count(*)::int AS count FROM pages` as [{ count: number }];
    expect(count).toBe(0);
  });

  it('pruneDeletedPages returns 0 when all current ids are still present', async () => {
    await upsertPage({ ...BASE_ENTRY, id: 'alive-1' });
    await upsertPage({ ...BASE_ENTRY, id: 'alive-2' });

    const deleted = await pruneDeletedPages(['alive-1', 'alive-2']);
    expect(deleted).toBe(0);
  });

  // ── updated_at trigger ────────────────────────────────────────────────────

  it('updated_at trigger advances after an update', async () => {
    await upsertPage(BASE_ENTRY);

    const [before] = await db`
      SELECT updated_at FROM pages WHERE id = ${BASE_ENTRY.id}
    ` as [{ updated_at: Date }];

    // A small delay to guarantee clock advancement on fast machines.
    await new Promise((r) => setTimeout(r, 20));

    await markProcessed(BASE_ENTRY.id, 'path.md', 'sha256:trigger-test');

    const [after] = await db`
      SELECT updated_at FROM pages WHERE id = ${BASE_ENTRY.id}
    ` as [{ updated_at: Date }];

    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});
