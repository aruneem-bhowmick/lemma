/**
 * Integration tests for src/pipeline/discover.ts against real infrastructure.
 *
 * These tests exercise the full discovery flow — live Graph API calls to list
 * notebook pages, followed by real PostgreSQL upserts via the manifest layer —
 * and verify that the idempotency invariant holds: re-running discovery never
 * resets a page whose status is 'processed' or 'failed'.
 *
 * Prerequisites:
 *   DISCOVER_INTEGRATION=true  — opt-in gate; the suite is skipped without it.
 *   AZURE_CLIENT_ID            — Azure AD application (client) ID.
 *   GRAPH_REFRESH_TOKEN        — Long-lived refresh token (see docs-lemma/auth-setup.md).
 *   ONENOTE_NOTEBOOK_ID        — Target OneNote notebook GUID.
 *   TEST_DATABASE_URL          — PostgreSQL connection string for the test database.
 *
 * The test database is migrated automatically (pages table created or
 * verified) and the pages table is truncated between test cases to ensure
 * a clean slate for each assertion.
 *
 * Run with real credentials:
 *   DISCOVER_INTEGRATION=true \
 *   AZURE_CLIENT_ID=... \
 *   GRAPH_REFRESH_TOKEN=... \
 *   ONENOTE_NOTEBOOK_ID=... \
 *   TEST_DATABASE_URL=postgres://user:pass@localhost/test_db \
 *   npx vitest run tests/integration/discover-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type postgres from 'postgres';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const DISCOVER_INTEGRATION = process.env['DISCOVER_INTEGRATION'] === 'true';
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const REQUIRED_GRAPH_VARS = [
  'AZURE_CLIENT_ID',
  'GRAPH_REFRESH_TOKEN',
  'ONENOTE_NOTEBOOK_ID',
] as const;

const missingGraphVars = REQUIRED_GRAPH_VARS.filter((v) => !process.env[v]);

const shouldRun = DISCOVER_INTEGRATION && !!TEST_DATABASE_URL && missingGraphVars.length === 0;

if (DISCOVER_INTEGRATION && !shouldRun) {
  const missing = [
    ...missingGraphVars,
    ...(!TEST_DATABASE_URL ? ['TEST_DATABASE_URL'] : []),
  ];
  process.stderr.write(
    `[discover-integration] Skipping: missing env vars: ${missing.join(', ')}\n`,
  );
}

// ---------------------------------------------------------------------------
// Integration suite
// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun)(
  'discoverPages — live integration (DISCOVER_INTEGRATION=true)',
  () => {
    let db: postgres.Sql<Record<string, never>>;
    let closeDb: () => Promise<void>;
    let upsertPage: typeof import('../../src/db/queries.js')['upsertPage'];
    let getPage: typeof import('../../src/db/queries.js')['getPage'];
    let markProcessed: typeof import('../../src/db/queries.js')['markProcessed'];
    let markFailed: typeof import('../../src/db/queries.js')['markFailed'];
    let discoverPages: typeof import('../../src/pipeline/discover.js')['discoverPages'];

    let originalDatabaseUrl: string | undefined;
    const notebookId = process.env['ONENOTE_NOTEBOOK_ID']!;

    beforeAll(async () => {
      originalDatabaseUrl = process.env['DATABASE_URL'];
      process.env['DATABASE_URL'] = TEST_DATABASE_URL!;

      const clientModule = await import('../../src/db/client.js');
      db = clientModule.db;
      closeDb = clientModule.closeDb;

      const queriesModule = await import('../../src/db/queries.js');
      upsertPage = queriesModule.upsertPage;
      getPage = queriesModule.getPage;
      markProcessed = queriesModule.markProcessed;
      markFailed = queriesModule.markFailed;

      const discoverModule = await import('../../src/pipeline/discover.js');
      discoverPages = discoverModule.discoverPages;

      // Run the migration to ensure the pages table exists.
      const migrationPath = resolve(__dirname, '../../src/db/migrations/001_pages.sql');
      const migrationSql = readFileSync(migrationPath, 'utf-8');
      await db.unsafe(migrationSql);
    });

    afterAll(async () => {
      process.env['DATABASE_URL'] = originalDatabaseUrl;
      await closeDb();
    });

    beforeEach(async () => {
      // Truncate between tests for a clean baseline.
      await db`TRUNCATE TABLE pages`;
    });

    // -------------------------------------------------------------------------

    it('returns at least one page from the live notebook', async () => {
      const pages = await discoverPages(notebookId);
      expect(pages.length).toBeGreaterThan(0);
    }, 30_000);

    it('each returned PageMeta has the expected shape', async () => {
      const pages = await discoverPages(notebookId);
      const first = pages[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('title');
      expect(first).toHaveProperty('section');
      expect(first).toHaveProperty('lastModifiedDateTime');
    }, 30_000);

    it('inserts every discovered page into the manifest with status pending', async () => {
      const pages = await discoverPages(notebookId);

      // Spot-check first and last pages in the manifest.
      const first = await getPage(pages[0].id);
      const last = await getPage(pages[pages.length - 1].id);

      expect(first).not.toBeNull();
      expect(first!.status).toBe('pending');
      expect(last).not.toBeNull();
      expect(last!.status).toBe('pending');
    }, 30_000);

    it('is idempotent — re-running does not change the row count', async () => {
      await discoverPages(notebookId);
      const countAfterFirst = (await db`SELECT count(*)::int AS n FROM pages`)[0] as { n: number };

      await discoverPages(notebookId);
      const countAfterSecond = (await db`SELECT count(*)::int AS n FROM pages`)[0] as { n: number };

      expect(countAfterSecond.n).toBe(countAfterFirst.n);
    }, 60_000);

    it('preserves processed status on re-discovery', async () => {
      const pages = await discoverPages(notebookId);
      const targetId = pages[0].id;

      // Simulate a successful prior run by setting the page to 'processed'.
      await markProcessed(targetId, `corpus/test/${targetId}.md`, 'sha256:abc');

      // Re-run discovery.
      await discoverPages(notebookId);

      // The processed status must be preserved.
      const entry = await getPage(targetId);
      expect(entry!.status).toBe('processed');
      expect(entry!.content_hash).toBe('sha256:abc');
    }, 60_000);

    it('preserves failed status on re-discovery', async () => {
      const pages = await discoverPages(notebookId);
      const targetId = pages[0].id;

      // Simulate a failed prior run.
      await markFailed(targetId, 'RenderError: all strategies exhausted');

      // Re-run discovery.
      await discoverPages(notebookId);

      // The failed status must be preserved.
      const entry = await getPage(targetId);
      expect(entry!.status).toBe('failed');
    }, 60_000);

    it('updates title and section for existing pages without touching status', async () => {
      // Insert a page manually with a stale title.
      await upsertPage({
        id: 'test-page-stale-title',
        title: 'Old Title',
        section: 'Old Section',
        last_modified: '2020-01-01T00:00:00.000Z',
      });

      // Manually set it to processed.
      await markProcessed(
        'test-page-stale-title',
        'corpus/old-section/test-page-stale-title.md',
        'sha256:old',
      );

      // Perform a targeted upsert (simulating what discover would do if this page
      // came back from the Graph API with an updated title).
      await upsertPage({
        id: 'test-page-stale-title',
        title: 'New Title',
        section: 'New Section',
        last_modified: '2024-06-01T00:00:00.000Z',
      });

      const entry = await getPage('test-page-stale-title');
      expect(entry!.title).toBe('New Title');
      expect(entry!.section).toBe('New Section');
      // Status must remain 'processed' — the upsert only refreshes metadata.
      expect(entry!.status).toBe('processed');
      expect(entry!.content_hash).toBe('sha256:old');
    }, 15_000);
  },
);
