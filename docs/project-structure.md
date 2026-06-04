# Project Structure

This document describes the repository layout and the role of every top-level directory.

## Directory Overview

```text
lemma/
├── src/                    ← All application source code
│   ├── types.ts            ← Shared TypeScript interfaces (PageMeta, ConvertedPage, …)
│   ├── pipeline/           ← Five ordered pipeline stages + orchestrator
│   │   ├── discover.ts     ← Stage 1: list pages from Graph API, seed manifest
│   │   ├── detect.ts       ← Stage 2: hash-based change detection
│   │   ├── render.ts       ← Stage 3: Graph API fetch → JPEG buffer
│   │   ├── convert.ts      ← Stage 4: vision LLM → structured Markdown
│   │   ├── write.ts        ← Stage 5: compose .md file, update manifest
│   │   └── index.ts        ← Orchestrator: runs stages 1–5 with concurrency cap
│   ├── graph/              ← Microsoft Graph API wrapper
│   │   ├── auth.ts         ← OAuth 2.0 refresh-token flow + in-process token cache
│   │   ├── client.ts       ← GraphClient class (token refresh, pagination, fallback)
│   │   └── types.ts        ← GraphPage, GraphPageList, GraphSection interfaces
│   ├── db/                 ← PostgreSQL manifest layer
│   │   ├── client.ts       ← postgres.js connection pool
│   │   ├── queries.ts      ← Typed CRUD for the pages manifest table
│   │   └── migrations/
│   │       └── 001_pages.sql  ← pages table schema
│   └── vision/             ← Vision LLM wrapper
│       └── client.ts       ← VisionClient (Anthropic SDK, retry, cost logging)
│
├── tests/                  ← All test files (mirrors src/ layout)
│   ├── unit/               ← Vitest unit tests with vi.mock (no network/DB)
│   └── integration/        ← Integration tests (require TEST_DATABASE_URL or GRAPH_LIVE)
│
├── scripts/                ← Runnable CLI scripts
│   ├── run-pipeline.ts     ← Entry point: loads .env, calls runPipeline()
│   ├── db-migrate.ts       ← Migration runner (wraps migrations/ in a transaction)
│   ├── auth-check.ts       ← Graph API auth health check (exits 0/1; used in CI)
│   └── spike/              ← Validation spike artifacts (read-only)
│
├── corpus/                 ← Generated Markdown pages (git-tracked)
│   └── <section-slug>/
│       └── <pageId>.md
│
├── assets/                 ← Extracted diagram images (git-tracked)
│   └── page-<pageId>-fig<N>.png
│
├── docs/                   ← Project documentation
├── .github/workflows/      ← CI and nightly sync workflows
└── dist/                   ← TypeScript build output (git-ignored)
```

## Module Dependency Graph

The five pipeline stages have a strict left-to-right dependency:

```text
discoverPages → detectChanges → renderPage → convertPage → writePage
     │                │              │             │            │
  GraphClient      db/queries     GraphClient  VisionClient  db/queries
```

The orchestrator (`src/pipeline/index.ts`) is the only caller of all five stages. No stage imports another stage directly.

## Source Module Conventions

### `src/types.ts`

The single source of truth for all public interfaces. Every other module imports its types from here rather than declaring local interfaces. This prevents the drift that occurs when multiple files define overlapping shapes.

Key interfaces:
- `PageMeta` — lightweight representation of a Graph API page (id, title, section, lastModifiedDateTime)
- `ManifestEntry` — a full `pages` table row, including processing status, content hash, and error message
- `DiagramData` — structured adjacency data extracted from `[!diagram]` callouts
- `ConvertedPage` — the fully assembled output of the convert stage
- `PipelineResult` — summary counts returned by `runPipeline()`

### `src/pipeline/`

Each file corresponds to exactly one pipeline stage. Stages receive typed inputs and return typed outputs; they do not share mutable state. The orchestrator (`index.ts`) is the only file that imports multiple stages.

**`discover.ts`** implements `discoverPages(notebookId)`, the first pipeline stage. It calls `GraphClient.listPages()`, maps each `GraphPage` to a `PageMeta`, and upserts every page into the manifest using an `INSERT … ON CONFLICT` query. New pages are inserted with `status = 'pending'`; existing pages have only their title, section, and `last_modified` refreshed — processing state (`status`, `content_hash`, `markdown_path`) is never overwritten. Manifest reads and upserts are issued in bounded-concurrent chunks of 50 to avoid saturating the connection pool on large notebooks. See [docs/pipeline-discovery.md](pipeline-discovery.md) for the full design and configuration reference.

### `src/graph/`

The Graph module is a thin HTTP wrapper around the Microsoft OneNote Graph API.  It contains three files:

**`auth.ts`** owns the OAuth 2.0 lifecycle.  `acquireToken()` uses the refresh-token grant (the only viable server-side flow for personal Microsoft accounts) and keeps an in-process cache so the token endpoint is called at most once per pipeline run.  `isTokenValid()` is a pure function that applies a 60-second expiry buffer.  `AuthError` (extends `Error`) carries an OAuth `code` field so callers can branch on specific failure modes without string-parsing.  See `docs/auth-setup.md` for the one-time setup procedure.

**`client.ts`** implements `GraphClient`.  Its private `_get()` method injects the `Authorization` header, logs every request to stderr, retries once on 401 (re-acquire + retry), and applies up to three Retry-After-aware retries on 429.  `listPages()` follows `@odata.nextLink` pagination; `renderPageAsImage()` prefers `image/jpeg` and falls back to `application/pdf` + rasterization on 415/404; `healthCheck()` is used by `scripts/auth-check.ts`.

**`types.ts`** contains the Graph API response interfaces (`GraphPage`, `GraphPageList`, `GraphSection`).

`discoverPages` in `discover.ts` is an explicit exception to the general pattern: it directly imports `GraphClient` from `src/graph/client.ts` and instantiates it internally, because discovery is the stage that originates every pipeline run and has no upstream caller to inject a client. All other pipeline stages do not import `src/graph/` directly; they receive any Graph-derived data as typed function parameters from the orchestrator.

### `src/db/`

`client.ts` exports a single postgres.js `Sql` instance (`db`) backed by a connection pool (`max: 5`, `idle_timeout: 20s`).  It throws a descriptive error at import time when `DATABASE_URL` is not set.

`queries.ts` contains all SQL as named typed functions against `ManifestEntry`.  Every value is an interpolated parameter in the postgres.js tagged-template syntax — no SQL string is ever constructed by concatenation.

`migrations/001_pages.sql` is the DDL for the `pages` manifest table.  Run it via `npm run db:migrate`.  The migration runner (`scripts/db-migrate.ts`) wraps all files in a single transaction and accepts `--check` for a dry-run print.

See [docs/database.md](database.md) for the full schema reference, column descriptions, and query function documentation.

### `src/vision/client.ts`

`VisionClient` wraps the Anthropic SDK. It is model-agnostic: the active model is read from the `VISION_MODEL` environment variable (defaulting to `claude-sonnet-4-6`). Prompt content lives in `src/vision/prompt.ts`.

## TypeScript Configuration

The project uses `"module": "ESNext"` with `"moduleResolution": "bundler"` — the correct pairing for code processed by a modern bundler or by ts-node in ESM mode. Key consequences:

- All imports are ES module `import`/`export` syntax. No `require()` in src/.
- Relative imports do not require `.js` extensions (bundler resolution handles them).
- `"type": "module"` in `package.json` makes Node 20 treat all `.js` output as ESM.
- ts-node runs scripts in ESM mode via the `"ts-node": { "esm": true }` config field.
