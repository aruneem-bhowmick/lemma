# Page Discovery & Manifest Seeding

## Overview

The discovery stage is the first step of every pipeline run. It calls the Microsoft Graph API to retrieve the full list of pages in the target OneNote notebook, maps each result to a `PageMeta` object, and writes every page into the `pages` manifest table.

The central design constraint for this stage is **non-destructive idempotency**: calling discovery any number of times must never reset a page that has already been processed or failed. A notebook with 100 pages where 2 were converted yesterday and 1 failed should, after re-discovery, still show exactly 97 pending, 2 processed, and 1 failed — not 100 pending.

---

## How It Works

### 1. Fetch from Graph

`discoverPages(notebookId)` instantiates a `GraphClient` and calls `listPages(notebookId)`. The client handles `@odata.nextLink` pagination transparently, so the function always returns the complete page list regardless of notebook size. Any `GraphError` thrown by the client propagates immediately — discovery cannot continue without a page list.

### 2. Map to PageMeta

Each `GraphPage` returned by the API is mapped to a `PageMeta`:

| GraphPage field | PageMeta field |
|---|---|
| `id` | `id` |
| `title` | `title` |
| `parentSection.displayName` | `section` |
| `lastModifiedDateTime` | `lastModifiedDateTime` |

### 3. Upsert into Manifest

Every page is written to the `pages` table using an `INSERT … ON CONFLICT (id) DO UPDATE` query:

```sql
INSERT INTO pages (id, title, section, last_modified, status)
VALUES ($1, $2, $3, $4, 'pending')
ON CONFLICT (id) DO UPDATE SET
  title         = EXCLUDED.title,
  section       = EXCLUDED.section,
  last_modified = EXCLUDED.last_modified
```

The `DO UPDATE` clause deliberately omits `status`, `content_hash`, `markdown_path`, `processed_at`, and `error_message`. This is the enforcement point for the non-destructive guarantee:

- **New pages** are inserted with `status = 'pending'`.
- **Existing pages** have their metadata refreshed (catching title or section renames) without any change to pipeline state.

All manifest reads (for counting new vs. existing) and all upserts run in parallel via `Promise.all` to minimise latency on large notebooks.

### 4. Count and Log

Manifest reads run in parallel before the upserts to classify each page as new or existing. After upserting, a single summary line is emitted:

```
[discover] Found 42 pages (3 new, 39 existing)
```

### 5. Large-Notebook Warning

If the Graph API returns more than 500 pages, a `console.warn` advisory is emitted:

```
[discover] Large notebook detected (>500 pages); consider section-scoped sync.
```

This is informational only; the pipeline continues normally.

---

## Safe-Merge Invariant

The upsert behaviour is sometimes called a "safe merge": it merges Graph API metadata into the manifest without ever touching pipeline state. The table below summarises which fields change for each scenario.

| Scenario | `status` | `content_hash` | `markdown_path` | `title` / `section` / `last_modified` |
|---|---|---|---|---|
| New page discovered | Set to `pending` | Unchanged (NULL) | Unchanged (NULL) | Set from Graph |
| Existing, never processed | Unchanged (`pending`) | Unchanged (NULL) | Unchanged (NULL) | Updated from Graph |
| Existing, processed | Unchanged (`processed`) | Unchanged | Unchanged | Updated from Graph |
| Existing, failed | Unchanged (`failed`) | Unchanged | Unchanged | Updated from Graph |

---

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `ONENOTE_NOTEBOOK_ID` | *(required)* | GUID of the target OneNote notebook. Obtain from `GET /me/onenote/notebooks` in Graph Explorer. |
| `AZURE_CLIENT_ID` | *(required)* | Azure AD application (client) ID. See [auth-setup.md](./auth-setup.md). |
| `GRAPH_REFRESH_TOKEN` | *(required)* | Long-lived OAuth refresh token. See [auth-setup.md](./auth-setup.md). |
| `DATABASE_URL` | *(required)* | PostgreSQL connection string. Must point to a database where the migration has been run. |

---

## Running Discovery

Discovery is normally invoked as part of the full pipeline via `npm run pipeline`. To run it in isolation during development:

```typescript
import { discoverPages } from './src/pipeline/discover.js';

const pages = await discoverPages(process.env.ONENOTE_NOTEBOOK_ID);
console.log(`Discovered ${pages.length} pages`);
```

Or run the pipeline in dry-run mode to exercise discovery without writing files or updating manifest processing state:

```bash
DRY_RUN=true npm run pipeline
```

---

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| `GraphError (httpStatus: 401)` | Token expired or revoked. | Run `npx ts-node scripts/auth-check.ts`; follow [auth-setup.md](./auth-setup.md) to refresh the token. |
| `GraphError (httpStatus: 429)` | Graph API rate limit. | `GraphClient` retries up to 3 times with the `Retry-After` delay. If it still fails, wait and re-run. |
| `GraphError (httpStatus: 5xx)` | Transient Graph API outage. | Retry after a few minutes. |
| Database connection error | `DATABASE_URL` invalid or Postgres unavailable. | Check the connection string and confirm `npm run db:migrate` has been run. |

---

## Testing

### Unit Tests

```bash
npx vitest run tests/unit/discover.test.ts
```

All dependencies (GraphClient, database queries) are mocked. The suite verifies:

- Correct mapping from `GraphPage` to `PageMeta`.
- `upsertPage` is called for every page without a `status` field in the argument.
- Processing state is not altered for existing pages.
- `GraphClient` errors propagate without modification.
- The `[discover] Found N pages` log line is emitted.
- Large-notebook warnings fire at threshold (> 500 pages).

### Integration Tests

```bash
DISCOVER_INTEGRATION=true \
AZURE_CLIENT_ID=... \
GRAPH_REFRESH_TOKEN=... \
ONENOTE_NOTEBOOK_ID=... \
TEST_DATABASE_URL=postgres://user:pass@localhost/test_db \
npx vitest run tests/integration/discover-integration.test.ts
```

The integration suite is skipped unless `DISCOVER_INTEGRATION=true` and all required environment variables are set. It makes real Graph API calls and writes to a real test database. Each test case truncates the `pages` table for a clean baseline. It verifies:

- Live notebook returns at least one page with the expected shape.
- All discovered pages are inserted with `status = 'pending'`.
- Re-running discovery is idempotent (row count unchanged).
- `processed` and `failed` statuses are preserved across re-discovery.
- Title and section renames are reflected in existing rows without touching pipeline state.

---

## Relationship to Other Pipeline Stages

```
discoverPages  →  detectChanges  →  renderPage  →  convertPage  →  writePage
     ↕                  ↑
  pages table ──────────┘
```

Discovery populates the manifest. The change-detection stage reads the manifest to determine which pages need processing on this run. Because discovery never resets status, change detection can reliably distinguish new pages (no entry), pending pages (prior run interrupted), modified pages (timestamp changed), and unchanged pages (status `processed`, same timestamp).
