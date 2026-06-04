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
│   ├── auth-check.ts       ← Graph auth health check script
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

### `src/graph/client.ts`

`GraphClient` is a thin HTTP wrapper. It does not interpret or transform page content — that belongs to the pipeline stages. Its sole responsibilities are authentication, pagination, retry, and rate-limit backoff.

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
