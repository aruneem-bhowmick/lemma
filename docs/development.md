# Development Setup

Step-by-step guide to getting a local development environment running for the Lemma sync pipeline.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js     | ≥ 20    | LTS or current; ESM support required |
| npm         | ≥ 9     | Bundled with Node 20 |
| PostgreSQL  | ≥ 14    | For integration tests and local pipeline runs |
| Git         | any     | —  |

Optional for full pipeline execution:
- A Microsoft personal account with OneNote notebooks
- An Azure AD app registration (see [docs/auth-setup.md](auth-setup.md))
- An Anthropic API key

## Initial Setup

```bash
# 1. Install all dependencies
npm install

# 2. Copy the environment variable template
cp .env.example .env

# 3. Fill in the required values in .env
#    At minimum you need TEST_DATABASE_URL for integration tests
#    and ANTHROPIC_API_KEY for vision conversion.
```

> **TLS / proxy issues?** If your environment requires a custom CA certificate or
> corporate proxy, configure npm separately rather than disabling SSL verification:
> ```bash
> npm config set cafile /path/to/your-ca-bundle.crt   # custom CA
> npm config set proxy http://proxy.example.com:8080  # HTTP proxy
> npm config set https-proxy http://proxy.example.com:8080
> ```
> See the [npm documentation](https://docs.npmjs.com/cli/v10/using-npm/config#cafile)
> for the full list of network options.

## Environment Variables

All variables are documented in `.env.example`. The most important ones for local development:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes (pipeline/migrations) | Postgres connection string for the pipeline and migration runner |
| `TEST_DATABASE_URL` | Yes (integration tests) | Separate test database — never use the production URL here |
| `ANTHROPIC_API_KEY` | Yes (pipeline) | Vision LLM access |
| `AZURE_CLIENT_ID` | Yes (pipeline) | Graph API auth |
| `GRAPH_REFRESH_TOKEN` | Yes (pipeline) | Long-lived OAuth token |
| `ONENOTE_NOTEBOOK_ID` | Yes (pipeline) | Target notebook |
| `DRY_RUN` | No | Set to `true` to skip writes |
| `RENDER_STRATEGY` | No | Rendering strategy: `pdf-export` (default), `semi-auto`, or `inkml-raster` |
| `SEMI_AUTO_DROP_DIR` | Conditional | Drop folder path; required when `RENDER_STRATEGY=semi-auto` |
| `SEMI_AUTO_TIMEOUT_MS` | No | Max wait for drop-folder file in ms; `0` (default) = check once |
| `VISION_MODEL` | No | Vision model identifier (default: `claude-sonnet-4-6`) |
| `LOG_LEVEL` | No | Log verbosity: `info` (default), `debug`, `warn`, `error` |

For unit tests only, none of these are required — all external dependencies are mocked.

## Running Tests

```bash
# Run all tests once (unit tests only, no network or DB required)
npm test

# Watch mode during development
npm run test:watch

# Coverage report
npm run test:coverage
```

**Unit tests** (default): no environment variables required — all external dependencies are mocked.

**Integration tests** require `TEST_DATABASE_URL` pointing to a _test_ database (never production — the suite truncates the `pages` table between test cases):

```bash
TEST_DATABASE_URL=postgres://postgres@localhost/lemma_test npm test
```

**Live Graph API tests** require `GRAPH_LIVE=true` plus `AZURE_CLIENT_ID`, `GRAPH_REFRESH_TOKEN`, and `ONENOTE_NOTEBOOK_ID`:

```bash
GRAPH_LIVE=true \
AZURE_CLIENT_ID=... \
GRAPH_REFRESH_TOKEN=... \
ONENOTE_NOTEBOOK_ID=... \
npm test
```

These tests make real HTTP calls against the Microsoft identity platform and the Graph API.  They carry 15–60 second timeouts and should not be run in the normal CI loop.

**Discovery integration tests** exercise the full discovery flow — live Graph calls combined with real PostgreSQL upserts — and verify idempotency and status-preservation guarantees.  They require `DISCOVER_INTEGRATION=true` in addition to all Graph credentials and `TEST_DATABASE_URL`:

```bash
DISCOVER_INTEGRATION=true \
AZURE_CLIENT_ID=... \
GRAPH_REFRESH_TOKEN=... \
ONENOTE_NOTEBOOK_ID=... \
TEST_DATABASE_URL=postgres://postgres@localhost/lemma_test \
npx vitest run tests/integration/discover-integration.test.ts
```

See [docs/pipeline-discovery.md](pipeline-discovery.md) for the full list of assertions these tests make.

**Change detection and hashing unit tests** run entirely in memory — no environment variables required:

```bash
npx vitest run tests/unit/detect.test.ts tests/unit/hash.test.ts
```

The suite verifies all four classification conditions (new, modified, retrying, skipped), confirms that all manifest reads are issued in a single `Promise.all` batch, and checks the log-line format. See [docs/pipeline-change-detection.md](pipeline-change-detection.md) for a full description of the test coverage.

**Rendering unit tests** run entirely in memory — no environment variables, network access, or native add-ons required (sharp, pdfjs-dist, and canvas are all mocked):

```bash
npx vitest run tests/unit/render.test.ts
```

The suite covers `renderPage` orchestration (strategy chain, fallback, quality warnings), the PDF magic-byte detection path in `pdfExportStrategy`, the drop-folder lookup behaviour in `semiAutoStrategy`, the stub behaviour of `inkmlRasterStrategy`, and the `RenderError` class contract. See [docs/rendering-strategy.md](rendering-strategy.md) for the full design and configuration reference.

**Vision conversion unit tests** run entirely in memory — no environment variables, network access, or API calls required (the Anthropic SDK and the parser are fully mocked):

```bash
# Parser: 26 tests — confidence, concepts, diagram JSON, uncertainty flags
npx vitest run tests/unit/vision-parser.test.ts

# VisionClient: 19 tests — SDK integration, retry behaviour, VisionError
npx vitest run tests/unit/vision-client.test.ts

# convertPage stage: 20 tests — ConvertedPage shape, logging, error propagation
npx vitest run tests/unit/convert.test.ts
```

The parser test suite loads `tests/fixtures/sample-response.md` — a realistic model output for an Eulerian-graphs page — to verify end-to-end fixture parsing. The VisionClient tests mock `@anthropic-ai/sdk` via `vi.mock` so no credentials are needed. See [docs/vision-conversion.md](vision-conversion.md) for the full prompt design and parser specification.

**Callout validation and frontmatter unit tests** run entirely in memory — no external dependencies or environment variables required:

```bash
# Callout validation: 37 tests — all six rules, repaired flag, issues array
npx vitest run tests/unit/validate.test.ts

# Frontmatter generation: 30 tests — YAML structure, field values, concept sorting
npx vitest run tests/unit/frontmatter.test.ts
```

The validation tests exercise every rule branch including auto-repair (type normalization, line truncation) and detect-only checks (unknown types, unmatched `$$`, missing image tags, unparseable JSON). The frontmatter tests parse the YAML output with `js-yaml` to verify round-trip correctness of all fields. See [docs/callout-validation.md](callout-validation.md) and [docs/frontmatter.md](frontmatter.md) for the full rule and field specifications.

## Building and Linting

```bash
# Type-check all TypeScript (no output generated)
npm run build

# Lint src/, tests/, and scripts/
npm run lint
```

## Verifying Graph API credentials

Before running the pipeline, confirm that your Azure credentials are valid:

```bash
npx ts-node scripts/auth-check.ts
# exit 0 = credentials OK; exit 1 = auth failed (check the error message)
```

This script instantiates `GraphClient`, calls `healthCheck()`, and exits with the appropriate code.  Run it any time you update `GRAPH_REFRESH_TOKEN` or `AZURE_CLIENT_ID`.  It is also suitable as a CI pre-step before the main sync job.

If it fails with `AuthError: invalid_grant`, your refresh token has expired.  Follow the re-consent procedure in [docs/auth-setup.md](auth-setup.md) to obtain a new one.

## Running the Pipeline

After filling in `.env`:

```bash
# Full pipeline run
npm run pipeline

# Dry run (no file writes or DB updates)
DRY_RUN=true npm run pipeline
```

## Database Setup

The pipeline stores per-page processing state in a PostgreSQL `pages` table.  You need a running Postgres instance (≥ 14) before the pipeline or integration tests can use the database.

### 1. Create databases

```bash
# Production / local dev database
createdb lemma

# Separate test database — never share with production
createdb lemma_test
```

### 2. Configure DATABASE_URL

In your `.env`:

```
DATABASE_URL=postgres://postgres@localhost/lemma
TEST_DATABASE_URL=postgres://postgres@localhost/lemma_test
```

### 3. Run migrations

```bash
# Apply the pages table migration
npm run db:migrate

# Dry-run: print migration SQL without executing
npm run db:migrate -- --check
```

The migration runner executes every `.sql` file in `src/db/migrations/` inside a single transaction.  It exits with code `0` on success and `1` on error.

See [docs/database.md](database.md) for the full schema reference, column descriptions, and query function documentation.

## Project Layout Quick Reference

See [docs/project-structure.md](project-structure.md) for the full directory layout and module roles.

## Coding Conventions

- **Module system:** ESM throughout. Use `import`/`export`; no `require()` in `src/`.
- **No `.js` extensions in imports:** `moduleResolution: bundler` resolves TypeScript files without explicit extensions.
- **Types first:** all public APIs use the interfaces defined in `src/types.ts`.
- **Stub pattern:** unimplemented stubs throw `new Error('... not yet implemented')` so failures are loud and traceable.
- **JSDoc:** every exported function and class must have a JSDoc block (required for 80 % docstring coverage threshold).
- **Tests:** unit tests in `tests/unit/`, integration tests in `tests/integration/`. Mock all external dependencies in unit tests.
