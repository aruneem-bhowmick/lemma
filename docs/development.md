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
- An Azure AD app registration (see `docs-lemma/auth-setup.md`)
- An Anthropic API key

## Initial Setup

```bash
# 1. Install all dependencies
npm install

# 2. Copy the environment variable template
cp .env.example .env

# 3. Fill in the required values in .env
#    At minimum you need DATABASE_URL for integration tests
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
| `DATABASE_URL` | Yes (integration tests) | Postgres connection string |
| `ANTHROPIC_API_KEY` | Yes (pipeline) | Vision LLM access |
| `AZURE_CLIENT_ID` | Yes (pipeline) | Graph API auth |
| `GRAPH_REFRESH_TOKEN` | Yes (pipeline) | Long-lived OAuth token |
| `ONENOTE_NOTEBOOK_ID` | Yes (pipeline) | Target notebook |
| `DRY_RUN` | No | Set to `true` to skip writes |

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

**Live Graph API tests** require `GRAPH_LIVE=true` and all `AZURE_*` / `GRAPH_REFRESH_TOKEN` values set:

```bash
GRAPH_LIVE=true npm test
```

## Building and Linting

```bash
# Type-check all TypeScript (no output generated)
npm run build

# Lint src/, tests/, and scripts/
npm run lint
```

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
