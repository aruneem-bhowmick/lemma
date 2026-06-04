# Database Layer

The database layer is the manifest for the sync pipeline: it tracks every OneNote page's processing status, content hash, and output path so the pipeline can skip unchanged pages, retry failed ones, and record outcomes without any pages falling silently through the cracks.

## Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Database | PostgreSQL ≥ 14 | Reliable `timestamptz` support, transactional DDL, and mature array operators used by `pruneDeletedPages` |
| Client library | postgres.js v3 | Tagged-template syntax prevents SQL injection by construction; async/await-native; minimal overhead |
| Connection pool | Built into postgres.js | `max: 5`, `idle_timeout: 20s` — sized for a single-process pipeline that runs briefly once per day |

---

## Schema

### `pages` table

The table is created by `src/db/migrations/001_pages.sql`.

```sql
CREATE TABLE IF NOT EXISTS pages (
  id             text        PRIMARY KEY,
  title          text        NOT NULL,
  section        text        NOT NULL,
  last_modified  timestamptz NOT NULL,
  content_hash   text,
  markdown_path  text,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'processed', 'failed')),
  processed_at   timestamptz,
  error_message  text        CONSTRAINT pages_error_message_len_check
                             CHECK (char_length(error_message) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

#### Column reference

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | text | No | — | OneNote page GUID (primary key) |
| `title` | text | No | — | Human-readable page title from Graph API |
| `section` | text | No | — | Display name of the containing notebook section |
| `last_modified` | timestamptz | No | — | `lastModifiedDateTime` from Graph API; drives change detection |
| `content_hash` | text | Yes | NULL | SHA-256 hash of the rendered JPEG (`sha256:<hex>`) — NULL until processed |
| `markdown_path` | text | Yes | NULL | CWD-relative path to the output `.md` file — NULL until processed |
| `status` | text | No | `'pending'` | `pending` \| `processed` \| `failed` |
| `processed_at` | timestamptz | Yes | NULL | Timestamp of the last successful processing run |
| `error_message` | text | Yes | NULL | Diagnostic message from the last failed run; enforced ≤ 2 000 chars by `pages_error_message_len_check`; cleared to NULL when a page is later successfully processed |
| `created_at` | timestamptz | No | `now()` | Row insertion timestamp |
| `updated_at` | timestamptz | No | `now()` | Updated automatically by a `BEFORE UPDATE` trigger |

#### Indexes

| Index | Column | Purpose |
|-------|--------|---------|
| `pages_status_idx` | `status` | `getPagesByStatus()` — avoids a full-table scan on every pipeline run |
| `pages_last_modified_idx` | `last_modified` | Change-detection queries that filter or sort by modification time |

#### Trigger

`pages_updated_at` is a `BEFORE UPDATE` trigger that sets `updated_at = now()` on every `UPDATE` statement.  This gives an audit trail for when rows last changed without requiring application code to manage the column.

---

## File Layout

```
src/db/
  client.ts          ← postgres.js Sql instance (db) + closeDb()
  queries.ts         ← typed CRUD functions for the pages table
  migrations/
    001_pages.sql    ← DDL for the pages table, indexes, and trigger

scripts/
  db-migrate.ts      ← migration runner CLI

tests/unit/
  queries.test.ts    ← unit tests (mock db, no real database required)
tests/integration/
  db.test.ts         ← integration tests (require TEST_DATABASE_URL)
```

---

## Connection Pool (`src/db/client.ts`)

The module exports a single `db` instance (a postgres.js `Sql` object) used throughout the query layer.

```typescript
import { db, closeDb } from './client.js';
```

**Environment variable required:** `DATABASE_URL` — a `postgres://user:pass@host/dbname` connection string.  The module throws a descriptive error at import time if it is absent; misconfigurations therefore fail loudly during startup rather than producing cryptic query errors later.

**Pool settings:**

| Setting | Value | Effect |
|---------|-------|--------|
| `max` | 5 | Maximum simultaneous connections; prevents connection exhaustion on busy Postgres instances |
| `idle_timeout` | 20 s | Releases idle connections after 20 seconds, important for scripts that exit after a short pipeline run |

**`closeDb()`** drains all open connections.  Call it once at process exit:

```typescript
import { closeDb } from '../db/client.js';
process.once('exit', () => void closeDb());
```

---

## Query Functions (`src/db/queries.ts`)

All functions are `async` and return typed values.  None of them construct SQL strings by concatenation — values are always interpolated through the postgres.js tagged-template syntax, which prevents SQL injection.

### `upsertPage(entry: SourcePageMeta): Promise<void>`

Inserts a new page or refreshes the Graph API metadata of an existing one.

- **New rows** are inserted with `status = 'pending'`.
- **Existing rows** only have `title`, `section`, and `last_modified` updated.  The fields that track pipeline state (`status`, `content_hash`, `markdown_path`, `processed_at`, `error_message`) are deliberately **not** updated — a re-run of the discovery stage must never reset a page that was already processed or failed.

```typescript
await upsertPage({
  id: 'page-guid',
  title: 'Eulerian Paths',
  section: 'Graph Theory',
  last_modified: '2024-06-01T09:00:00.000Z',
});
```

### `getPage(id: string): Promise<ManifestEntry | null>`

Returns the manifest entry for a single page, or `null` if no row exists.

```typescript
const entry = await getPage('page-guid');
if (entry === null) { /* new page */ }
```

### `getPagesByStatus(status: 'pending' | 'processed' | 'failed'): Promise<ManifestEntry[]>`

Returns all rows with the given status.  Used by the orchestrator to count pipeline outcomes and by reporting tools.

```typescript
const failed = await getPagesByStatus('failed');
console.log(`${failed.length} pages need attention`);
```

### `markProcessed(id, markdownPath, contentHash): Promise<void>`

Sets a row's status to `'processed'`, records the output path, content hash, and `processed_at` timestamp, and clears `error_message` to NULL.

Clearing `error_message` ensures that a page which previously failed and was then successfully retried shows a clean manifest row — no stale failure text lingers after the page is processed.

Absolute `markdownPath` values are converted to `process.cwd()`-relative paths before storage so the manifest is portable across machines with different root directories.

```typescript
await markProcessed('page-guid', 'graph-theory/page-guid.md', 'sha256:abc123…');
```

### `markFailed(id, errorMessage): Promise<void>`

Sets a row's status to `'failed'` and stores the error message, truncated to 2000 characters.

```typescript
await markFailed('page-guid', err.message);
```

### `getContentHash(id: string): Promise<string | null>`

Returns the `content_hash` for a page, or `null` if the page does not exist or has not yet been processed.  Used by the change-detection stage as a belt-and-suspenders check when `last_modified` has not changed.

```typescript
const storedHash = await getContentHash('page-guid');
```

### `pruneDeletedPages(currentIds: string[]): Promise<number>`

Deletes every row whose `id` is not in `currentIds` (pages removed from OneNote since the last sync) and returns the count of deleted rows.

Passing an empty array deletes **all** rows — this is the intended behaviour when a notebook is empty, but callers should guard against accidentally passing an empty list.

```typescript
const deleted = await pruneDeletedPages(allCurrentPageIds);
console.log(`Pruned ${deleted} stale entries`);
```

---

## Running Migrations

```bash
# Apply all migrations to the database specified by DATABASE_URL
npm run db:migrate

# Print migration SQL without executing — useful in CI review and dry-runs
npm run db:migrate -- --check
```

The migration runner:

1. Reads every `.sql` file from `src/db/migrations/` in alphabetical order.
2. Executes all files inside a single transaction — a failure rolls back the entire set rather than leaving the schema partially applied.
3. Logs each file name followed by `OK` or `ERROR` to stdout/stderr.  On failure the full error stack trace is emitted to stderr before exit.
4. Exits with code `0` on success and `1` on any error.

### Running migrations in CI

The migration step is intentionally **not** automated in the sync workflow to prevent accidental schema changes.  Run it manually once when first deploying a new schema version:

```bash
DATABASE_URL="$PROD_DATABASE_URL" npm run db:migrate
```

---

## Integration Tests

Integration tests live in `tests/integration/db.test.ts`.  They require a real Postgres instance and are skipped automatically when `TEST_DATABASE_URL` is not set.

```bash
# Run with a test database (separate from production)
TEST_DATABASE_URL=postgres://user:pass@localhost/lemma_test npm test
```

The test suite:
- Runs `001_pages.sql` in `beforeAll` to ensure the table exists.
- Truncates `pages` between every test case for isolation.
- Cleans up with a final `TRUNCATE` in `afterAll`.

**Never point `TEST_DATABASE_URL` at your production database** — the suite truncates the `pages` table.

---

## TypeScript Types

All query functions are typed against `ManifestEntry` from `src/types.ts`.

```typescript
export interface ManifestEntry {
  id: string;
  title: string;
  section: string;
  last_modified: string;       // ISO 8601
  content_hash: string | null;
  markdown_path: string | null;
  status: 'pending' | 'processed' | 'failed';
  processed_at: string | null; // ISO 8601
  error_message: string | null;
}
```

Timestamp columns are stored as `timestamptz` in Postgres.  postgres.js returns them as JavaScript `Date` objects; `rowToManifestEntry()` in `queries.ts` normalises these to ISO 8601 strings before returning them to callers, matching the `string` types declared in `ManifestEntry`.

---

## Status State Machine

```
           (new page discovered)
                   │
                   ▼
              ┌─────────┐
              │ pending │◄──────────────────────┐
              └────┬────┘                       │
                   │ render + convert + write    │
             ┌─────┴──────────┐                 │
             │                │                 │
             ▼                ▼                 │
        ┌──────────┐    ┌────────┐              │
        │processed │    │ failed │──(retry)─────┘
        └──────────┘    └────────┘
```

- `pending` — inserted by discovery; awaiting processing.
- `processed` — all pipeline stages completed; `markdown_path` and `content_hash` are set.
- `failed` — at least one pipeline stage threw; `error_message` records the cause.  Failed pages are unconditionally retried on the next run.
- A page re-discovered by a subsequent sync run stays in its current state; only `title`, `section`, and `last_modified` are refreshed.
