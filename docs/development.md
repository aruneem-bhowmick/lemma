# Development Setup

Step-by-step guide to getting a local development environment running for the Lemma Phase 1 pipeline.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js     | ≥ 20    | LTS or current; ESM support required |
| npm         | ≥ 9     | Bundled with Node 20 |
| PostgreSQL  | ≥ 14    | For integration tests and local pipeline runs |
| Git         | any     | —  |

Optional for full pipeline execution:
- A Microsoft personal account with OneNote notebooks
- An Azure AD app registration (see `docs-lemma/auth-setup.md` — Prompt 3)
- An Anthropic API key

## Initial Setup

```bash
# 1. Install all dependencies
npm install --strict-ssl=false

# 2. Copy the environment variable template
cp .env.example .env

# 3. Fill in the required values in .env
#    At minimum you need DATABASE_URL for integration tests
#    and ANTHROPIC_API_KEY for vision conversion.
```

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

Integration tests require `TEST_DATABASE_URL` set and are skipped otherwise:

```bash
TEST_DATABASE_URL=postgres://... npm test
```

Live Graph API tests require `GRAPH_LIVE=true` and all `AZURE_*` / `GRAPH_REFRESH_TOKEN` values set:

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

When implementing Prompt 2, run migrations before first use:

```bash
npm run db:migrate
```

## Project Layout Quick Reference

See [docs/project-structure.md](project-structure.md) for the full directory layout and module roles.

## Coding Conventions

- **Module system:** ESM throughout. Use `import`/`export`; no `require()` in `src/`.
- **No `.js` extensions in imports:** `moduleResolution: bundler` resolves TypeScript files without explicit extensions.
- **Types first:** all public APIs use the interfaces defined in `src/types.ts`.
- **Stub pattern:** unimplemented stubs throw `new Error('... not yet implemented — see Prompt N')` so failures are loud and traceable.
- **JSDoc:** every exported function and class must have a JSDoc block (required for 80 % docstring coverage threshold).
- **Tests:** unit tests in `tests/unit/`, integration tests in `tests/integration/`. Mock all external dependencies in unit tests.
