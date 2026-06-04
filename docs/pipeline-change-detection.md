# Change Detection & Content Hashing

## Overview

The change-detection stage is the second step of every pipeline run. It receives the full list of pages from the discovery stage and returns only the subset that actually needs processing on this run — new pages, modified pages, interrupted pages, and pages that previously failed. Every other page is skipped without touching the rendering or conversion machinery.

The effect is that a daily run over a 100-page notebook where two pages changed processes exactly two pages. The Graph API `lastModifiedDateTime` timestamp is the primary signal; a SHA-256 content hash stored in the manifest provides a belt-and-suspenders check inside the render stage for the rare case where the timestamp is stale.

---

## Files

| File | Role |
|------|------|
| [src/pipeline/detect.ts](../src/pipeline/detect.ts) | `detectChanges(pages)` — the stage entry point |
| [src/pipeline/hash.ts](../src/pipeline/hash.ts) | `hashBuffer` and `hashString` — SHA-256 utilities |
| [tests/unit/detect.test.ts](../tests/unit/detect.test.ts) | Unit tests for change detection |
| [tests/unit/hash.test.ts](../tests/unit/hash.test.ts) | Unit tests for hashing utilities |

---

## How Change Detection Works

### 1. Parallel manifest reads

`detectChanges(pages)` issues a single `Promise.all` over all pages, calling `getPage(id)` for every entry simultaneously. For a notebook with N pages this is one parallel batch rather than N serial round-trips, which keeps the stage fast even on large notebooks.

### 2. Four-condition classification

Each page is passed to an internal `classifyPage` function that applies four conditions in priority order:

| Condition | Category | Why |
|-----------|----------|-----|
| No manifest entry (`getPage` returns `null`) | `new` | The page has never been seen; it must be processed. |
| Manifest status is `'pending'` | `new` | A previous run started but did not finish; resume it. |
| Manifest status is `'failed'` | `retrying` | All failed pages are unconditionally retried on every run to recover from transient errors. |
| `lastModifiedDateTime` ≠ `last_modified` | `modified` | The Graph API reports a newer modification time; the content has changed. |
| None of the above | `skipped` | Status is `'processed'` and the timestamp is unchanged. |

The `'failed'` check intentionally precedes the timestamp check so that a failed page with an unchanged timestamp is still retried. This avoids permanently stranding a page that failed due to a transient error (e.g. an API timeout) rather than a content problem.

### 3. Summary log

After classification, a single log line is emitted:

```text
[detect] 4 pages need processing (2 new, 1 modified, 1 retrying, 38 unchanged)
```

The function then returns only the pages classified as `new`, `modified`, or `retrying`.

---

## Why the Render Stage, Not Here, Does Content Hashing

Fetching and rendering a page image is expensive — it requires a Graph API round-trip, possible PDF rasterization, and a large JPEG buffer in memory. The `lastModifiedDateTime` timestamp is a reliable and cheap pre-filter that avoids all of that overhead when nothing has changed.

The content hash stored in `content_hash` in the manifest acts as a secondary check inside the render stage. After rendering, the render stage hashes the resulting JPEG buffer and compares it against the stored hash. If the hashes differ despite matching timestamps (e.g. a rendering engine bug was fixed between runs), the pipeline re-converts the page. This belt-and-suspenders approach keeps the detect stage lightweight while preserving correctness.

---

## Content Hashing Utilities

### `hashBuffer(buf: Buffer): string`

Computes a SHA-256 digest of a binary buffer, typically a rendered JPEG image. Returns a 71-character string of the form `sha256:<64-hex-chars>`.

```typescript
import { hashBuffer } from './hash.js';

const hash = hashBuffer(jpegBuffer);
// → 'sha256:a3f5c8e2...b91d'
```

### `hashString(s: string): string`

Computes a SHA-256 digest of a UTF-8 string. Used for lightweight pre-filter comparisons, such as verifying that a stored timestamp matches an incoming one before committing to a full render.

```typescript
import { hashString } from './hash.js';

const hash = hashString('2024-06-04T12:00:00.000Z');
// → 'sha256:f4c2a0b1...7e3d'
```

Both functions are deterministic and pure — the same input always yields the same output.

---

## Configuration

The change-detection stage reads from the `pages` manifest table and requires no additional environment variables beyond what the discovery stage already needs. See [docs/development.md](development.md) for the full environment variable reference.

---

## Retry Behaviour

Every page with `status = 'failed'` in the manifest is included in the processing set on every pipeline run. There is no maximum retry count and no exponential back-off at this stage — those controls belong in the pipeline orchestrator. The rationale: a page that failed due to a transient issue (network blip, API timeout, rate-limit spike) should recover automatically on the next run without operator intervention. Pages that fail repeatedly will keep being retried, and their `error_message` column will be updated with the most recent failure reason so the cause can be diagnosed.

---

## Testing

### Unit tests

```bash
npx vitest run tests/unit/detect.test.ts tests/unit/hash.test.ts
```

All database calls are mocked. The test suite verifies:

- Pages with no manifest entry are included.
- Pages with `status = 'pending'` are included.
- Pages with `status = 'failed'` are included, even when the timestamp is unchanged.
- Pages whose `lastModifiedDateTime` has advanced are included.
- Pages with `status = 'processed'` and an unchanged timestamp are excluded.
- An empty page list returns an empty result.
- All `getPage` calls are issued in a single `Promise.all` batch.
- The `[detect]` log line is emitted with accurate per-category counts.

For the hashing utilities:

- Output is always prefixed with `'sha256:'` and is exactly 71 characters.
- Results are deterministic — same input produces same output.
- Different inputs produce different outputs.
- Known digest cross-check: `hashString('')` matches the canonical SHA-256 of the empty string.

---

## Relationship to Other Pipeline Stages

```text
discoverPages  →  detectChanges  →  renderPage  →  convertPage  →  writePage
     ↕                  ↑
  pages table ──────────┘
                         ↓
                    hash.ts used
                    by renderPage
                    to compute
                    content_hash
```

Discovery populates the manifest. Change detection reads it to decide what to process. The render stage uses `hashBuffer` (from `hash.ts`) to fingerprint the JPEG it produces and stores the result in the manifest via `markProcessed`. On the next run, change detection skips that page if the timestamp is unchanged; the render stage double-checks with the stored hash.
