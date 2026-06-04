/**
 * Live integration tests for GraphClient against the real Microsoft Graph API.
 *
 * These tests are skipped automatically unless the GRAPH_LIVE environment
 * variable is set to "true" AND all required Azure credentials are present.
 * They make real HTTP calls against the Microsoft identity platform and the
 * Graph API — never run them against production data without a dedicated test
 * notebook/account.
 *
 * To run:
 *   GRAPH_LIVE=true \
 *   AZURE_CLIENT_ID=... \
 *   AZURE_CLIENT_SECRET=... \
 *   GRAPH_REFRESH_TOKEN=... \
 *   ONENOTE_NOTEBOOK_ID=... \
 *   npx vitest run tests/integration/graph-live.test.ts
 *
 * All other tests continue to use mocked auth and fetch.
 */

import { describe, it, expect } from 'vitest';
import { GraphClient } from '../../src/graph/client.js';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const GRAPH_LIVE = process.env['GRAPH_LIVE'] === 'true';

const REQUIRED_VARS = [
  'AZURE_CLIENT_ID',
  'GRAPH_REFRESH_TOKEN',
  'ONENOTE_NOTEBOOK_ID',
] as const;

const missingVars = REQUIRED_VARS.filter((v) => !process.env[v]);

const shouldRun = GRAPH_LIVE && missingVars.length === 0;

if (!shouldRun && GRAPH_LIVE) {
  process.stderr.write(
    `[graph-live] Skipping live tests: missing env vars: ${missingVars.join(', ')}\n`,
  );
}

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun)('GraphClient — live integration (GRAPH_LIVE=true)', () => {
  const client = new GraphClient();
  const notebookId = process.env['ONENOTE_NOTEBOOK_ID']!;

  it('healthCheck returns true with real credentials', async () => {
    const result = await client.healthCheck();
    expect(result).toBe(true);
  }, 15_000);

  it('listPages returns at least one page from the target notebook', async () => {
    const pages = await client.listPages(notebookId);
    expect(pages.length).toBeGreaterThan(0);

    // Spot-check the shape of the first page.
    const first = pages[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('title');
    expect(first).toHaveProperty('lastModifiedDateTime');
    expect(first).toHaveProperty('parentSection');
    expect(first).toHaveProperty('contentUrl');
  }, 30_000);

  it('renderPageAsImage returns a non-empty ArrayBuffer for the first page', async () => {
    const pages = await client.listPages(notebookId);
    expect(pages.length).toBeGreaterThan(0);

    const first = pages[0];
    const buffer = await client.renderPageAsImage(first.contentUrl, first.id);
    expect(buffer.byteLength).toBeGreaterThan(0);
  }, 60_000);
});
