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
│   │   ├── hash.ts         ← SHA-256 utilities shared by detect and render stages
│   │   ├── render.ts       ← Stage 3: orchestrates rendering via strategy chain
│   │   ├── render-strategies/
│   │   │   ├── pdf-export.ts   ← Strategy A: Graph export + rasterizePdfBuffer
│   │   │   ├── semi-auto.ts    ← Strategy B: local drop-folder PDF (personal accounts)
│   │   │   └── inkml-raster.ts ← Strategy C: stub (not yet implemented)
│   │   ├── convert.ts      ← Stage 4: vision LLM → structured Markdown + asset extraction
│   │   ├── assets.ts       ← Diagram asset writing + placeholder resolution (used in stage 4)
│   │   ├── validate.ts     ← Callout convention validation + auto-repair (used in stage 4)
│   │   ├── frontmatter.ts  ← YAML frontmatter generation (used in stage 5)
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
│       ├── prompt.ts       ← SYSTEM_PROMPT constant and USER_PROMPT_TEMPLATE
│       ├── client.ts       ← VisionClient (Anthropic SDK, retry, cost logging) + VisionError
│       └── parser.ts       ← parseVisionResponse: concepts, diagrams, confidence, flags
│
├── tests/                  ← All test files (mirrors src/ layout)
│   ├── unit/               ← Vitest unit tests with vi.mock (no network/DB)
│   ├── integration/        ← Integration tests (require TEST_DATABASE_URL or GRAPH_LIVE)
│   └── fixtures/           ← Static test data files
│       ├── sample.pdf      ← Minimal PDF for render/rasterisation tests
│       └── sample-response.md ← Realistic vision model output for parser tests
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

**`detect.ts`** implements `detectChanges(pages)`, the second pipeline stage. It issues a single parallel `Promise.all` over all pages, fetching each page's manifest entry, then classifies each page into one of four categories: new (no entry, or status `'pending'`), modified (`lastModifiedDateTime` has advanced), retrying (status `'failed'`), or skipped (status `'processed'` with unchanged timestamp). Only the first three categories are returned for processing. This is the primary mechanism that makes daily runs cheap: a notebook with 100 pages where 2 changed processes exactly 2. See [docs/pipeline-change-detection.md](pipeline-change-detection.md) for the full design and rationale.

**`hash.ts`** exports two pure utility functions: `hashBuffer(buf)` and `hashString(s)`, both returning a SHA-256 hex digest prefixed with `'sha256:'`. `hashBuffer` is used by the render stage to fingerprint each rendered JPEG; `hashString` is available for lightweight pre-filter comparisons. The `'sha256:'` prefix makes the algorithm self-describing, so the stored hash values carry enough context to support algorithm migration in the future.

**`render.ts`** implements `renderPage(page, graphClient)`, the third pipeline stage. It orchestrates a strategy fallback chain (`pdf-export → semi-auto → inkml-raster`) controlled by the `RENDER_STRATEGY` environment variable. Each attempt is delegated to the corresponding module in `render-strategies/`. If the primary strategy throws, a warning is logged and the next strategy is tried. After a successful render the raw buffer is normalised to JPEG quality 92 via `sharp`, and two quality warnings are emitted when the image is narrower than 1 668 px or smaller than 50 KB. A `RenderError` is thrown only when every strategy is exhausted; it carries the `pageId` so the orchestrator can record a targeted per-page failure without aborting the run. See [docs/rendering-strategy.md](rendering-strategy.md) for the full design, strategy descriptions, and configuration reference.

**`render-strategies/`** contains the three pluggable rendering strategies:

- `pdf-export.ts` — calls `GraphClient.renderPageAsImage()` and, if the returned bytes are raw PDF (magic-byte check), rasterises page 1 using `rasterizePdfBuffer` (pdfjs-dist + sharp at ~150 DPI). Also exports `rasterizePdfBuffer` for re-use by `semi-auto.ts`.
- `semi-auto.ts` — reads a manually placed `<pageId>.pdf` from `SEMI_AUTO_DROP_DIR`, optionally polling up to `SEMI_AUTO_TIMEOUT_MS` milliseconds, then rasterises via `rasterizePdfBuffer`. This is the primary strategy for personal Microsoft accounts where the Graph ink-export endpoint returns 415.
- `inkml-raster.ts` — stub that always throws, reserving the strategy slot in the fallback chain for future InkML → SVG → PNG rendering work.

**`convert.ts`** implements `convertPage(renderResult, page, client?, assetsDir?)`, the fourth pipeline stage. It base64-encodes the JPEG buffer from the render stage, sends it to `VisionClient.convert()` with the page title and section for prompt interpolation, and passes the raw response string to `parseVisionResponse()`. The parsed markdown is then passed through `validateAndRepair()` and subsequently through `extractAndWriteAssets()` — so the returned `ConvertedPage.markdown` always contains validated, auto-repaired content with all `<asset-placeholder>` tokens resolved to actual file paths. The returned `ConvertedPage` includes all extracted `DiagramData` objects, a pre-populated `frontmatter` object, the `contentHash` propagated from the render result, and `assetPaths` populated with the absolute paths of all written diagram image files. The optional `assetsDir` parameter defaults to `process.env.ASSETS_DIR ?? './assets'`. See [vision-conversion.md](vision-conversion.md) for the full design, [callout-validation.md](callout-validation.md) for the validation rules, and [diagram-asset-extraction.md](diagram-asset-extraction.md) for the asset extraction design.

**`assets.ts`** exports `extractAndWriteAssets(page, imageBuffer, assetsDir)`, called by `convert.ts` at the end of stage 4. For each `DiagramData` in the page, it writes the full-page JPEG (converted to PNG via `sharp`) to `<assetsDir>/page-<pageId>-fig<N>.png` and replaces the first remaining `<asset-placeholder>` token in the Markdown body with the repository-root-relative path `./assets/page-<pageId>-fig<N>.png`. The assets directory is created recursively if absent. Re-processing the same page overwrites existing files (idempotent). Returns the list of `ExtractedAsset` records and the resolved Markdown string. See [diagram-asset-extraction.md](diagram-asset-extraction.md) for the full design.

**`validate.ts`** exports `validateAndRepair(raw, pageId)`, a pure function that enforces the callout convention on a Markdown string and returns a `ValidationResult`. Two rules auto-repair the markdown (callout type case normalization; overlong line truncation); four rules are detect-only (unknown callout types, unmatched `$$` pairs, missing image tags in `[!diagram]` blocks, and unparseable diagram JSON). All problems are reported in the `issues` string array, keyed by `pageId` for traceability. See [docs/callout-validation.md](callout-validation.md) for the full rule specification.

**`frontmatter.ts`** exports `generateFrontmatter(page)`, which serialises a `ConvertedPage` to a `---…---` YAML block using `js-yaml`. Fields are written in a fixed, documented order; concept titles are sorted alphabetically. The write stage calls this function to compose the header of each corpus file. See [docs/frontmatter.md](frontmatter.md) for the field reference and design rationale.

**`write.ts`** implements `writePage(page, corpusDir)`, the fifth and final pipeline stage. It generates the YAML frontmatter block via `generateFrontmatter()`, composes the full `.md` file content as `frontmatter + '\n' + markdown body`, then validates the composed content with `gray-matter` before touching the filesystem. If any required frontmatter field (`page_id`, `title`, `section`) is missing or empty, a `WriteError` is thrown immediately — no directory is created and no file is written. On a valid page the section subdirectory is created with `mkdirSync({ recursive: true })`, the file is written with `writeFileSync` (overwrite is intentional and idempotent), and `markProcessed()` updates the manifest row to `'processed'`. When `DRY_RUN=true`, filesystem and database steps are skipped but the computed path and byte size are still returned. Also exports `slugifySection(section)`, which normalises Unicode, lowercases, converts spaces to hyphens, and strips remaining non-alphanumeric characters to produce a safe, deterministic directory name; non-ASCII-representable names fall back to `untitled-section-<8-char-hash>`. See [docs/file-write-corpus.md](file-write-corpus.md) for the full design, path conventions, and API reference.

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

### `src/vision/`

The vision module is the intelligence core of the pipeline. It contains three files:

**`prompt.ts`** exports two string constants. `SYSTEM_PROMPT` is the complete vision transcription prompt that instructs the model on callout syntax, LaTeX conventions, diagram JSON schema, confidence annotation, and honesty constraints. `USER_PROMPT_TEMPLATE` is the per-page user turn with `{{pageTitle}}` and `{{sectionName}}` placeholders.

**`client.ts`** implements `VisionClient`. The active model is read from `VISION_MODEL` (defaulting to `claude-sonnet-4-6`). Each call to `convert(imageBase64, pageTitle, sectionName)` sends the base64 JPEG together with the system prompt and interpolated user template. The client retries up to three times on HTTP 429 and 5xx errors; non-retryable 4xx errors throw `VisionError` immediately. `VisionError` (exported from this file) carries `model`, `httpStatus`, and `retryable` fields.

**`parser.ts`** exports `parseVisionResponse(raw)` which converts the raw model response string into a `ParsedVisionResponse`: the `markdown` field with the confidence comment stripped, concept titles from `[!definition]` and `[!theorem]` callout headers, structured `DiagramData` objects parsed from JSON blocks inside `[!diagram]` callouts, and `hasUncertain`/`hasIllegible` flags. Malformed diagram JSON is skipped with a warning rather than throwing.

See [docs/vision-conversion.md](vision-conversion.md) for the full design, prompt specification, and API reference.

## TypeScript Configuration

The project uses `"module": "ESNext"` with `"moduleResolution": "bundler"` — the correct pairing for code processed by a modern bundler or by ts-node in ESM mode. Key consequences:

- All imports are ES module `import`/`export` syntax. No `require()` in src/.
- Relative imports do not require `.js` extensions (bundler resolution handles them).
- `"type": "module"` in `package.json` makes Node 20 treat all `.js` output as ESM.
- ts-node runs scripts in ESM mode via the `"ts-node": { "esm": true }` config field.
