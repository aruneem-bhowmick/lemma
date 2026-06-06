# File Write & Corpus Output

This document describes how the Lemma pipeline composes and persists the final
Markdown file for each converted page, and how the manifest is updated to
reflect successful processing.

---

## Overview

The write stage is the last step in the per-page pipeline.  Once the vision
conversion stage returns a `ConvertedPage` — with its validated Markdown body,
resolved asset paths, and populated frontmatter data — the write stage:

1. Serialises the frontmatter object to a YAML block.
2. Composes the complete `.md` file content.
3. Validates the composed frontmatter using `gray-matter`.
4. Writes the file to `<corpusDir>/<sectionSlug>/<pageId>.md`.
5. Calls `markProcessed()` to advance the manifest row to `'processed'`.

After a successful write the page is a first-class corpus artifact: a
self-contained Markdown file parseable by any standard tool, with a
machine-readable frontmatter header and validated structure.

---

## Output File Path

Every page is written to a deterministic path inside the corpus root:

```text
<CORPUS_DIR>/<section-slug>/<pageId>.md
```

| Component | Derivation |
|-----------|-----------|
| `CORPUS_DIR` | Environment variable; defaults to `./corpus` |
| `<section-slug>` | Section display name run through `slugifySection()` |
| `<pageId>` | The OneNote page identifier (GUID) |

Examples:

```text
corpus/graph-theory/ABC-123.md
corpus/trees-and-forests/DEF-456.md
corpus/untitled-section-8d08a8b7/GHI-789.md   ← CJK section name fallback
```

---

## Section Slug Generation

`slugifySection(section: string): string` converts a section display name to a
URL-safe, filesystem-safe directory component.

Steps applied in order:

1. **NFD normalisation** — decomposes accented characters into base + combining
   mark (e.g. `é` → `e` + ` ́`).
2. **Diacritic strip** — removes combining diacritical marks (U+0300–U+036F),
   so `Théorie` → `Theorie`.
3. **Lowercase**.
4. **Spaces → hyphens**.
5. **Non-alphanumeric removal** — strips everything that is not `[a-z0-9-]`.

When the result is empty (e.g. a section named entirely in CJK characters or
emoji), a deterministic fallback is returned:

```text
untitled-section-<8-char SHA-256 prefix of the original string>
```

This guarantees the path is always valid regardless of section name content.

Examples:

| Section name | Slug |
|--------------|------|
| `Graph Theory` | `graph-theory` |
| `Trees & Forests!` | `trees--forests` |
| `Théorie des Graphes` | `theorie-des-graphes` |
| `数学` | `untitled-section-8d08a8b7` |

---

## File Composition

The composed file content is:

```
<frontmatter block>
\n
<markdown body>
```

The frontmatter block is produced by `generateFrontmatter(page)` (see
[frontmatter.md](frontmatter.md)).  It begins and ends with `---` delimiters:

```yaml
---
page_id: "page-ABC123"
title: "Eulerian Circuits"
section: "Graph Theory"
last_modified: "2024-06-01T00:00:00.000Z"
source_hash: "sha256:aabbccdd..."
concepts:
  - "Eulerian Circuit"
  - "Hamiltonian Path"
has_diagrams: true
confidence: "high"
---
```

The `\n` separator between the `---` block and the body ensures Markdown
parsers see a blank line between frontmatter and prose, which is conventional
in the GFM ecosystem.

---

## Pre-write Frontmatter Validation

Before any filesystem I/O, the composed content is parsed by `gray-matter` and
the following fields are verified to be non-empty:

| Field | Source |
|-------|--------|
| `page_id` | `page.pageId` |
| `title` | `page.title` |
| `section` | `page.section` |

If any field is absent or empty a `WriteError` is thrown immediately —
**no directory is created and no file is written**.  This prevents corrupt
output from reaching the corpus in the event of an upstream bug (e.g. a
`ConvertedPage` produced with an empty `pageId`).

`WriteError` is exported from `src/pipeline/write.ts`.  The orchestrator
catches it by type and records a per-page failure in the manifest without
aborting the rest of the run.

---

## Manifest Update

After a successful write, `markProcessed()` is called with:

```typescript
markProcessed(page.pageId, markdownPath, page.contentHash)
```

This updates the manifest row:

| Column | Value after markProcessed |
|--------|--------------------------|
| `status` | `'processed'` |
| `markdown_path` | Path relative to `process.cwd()` |
| `content_hash` | SHA-256 hash of the rendered JPEG |
| `processed_at` | Current timestamp |
| `error_message` | `NULL` (clears any prior failure) |

On the next pipeline run, `detectChanges()` reads this row and skips the page
if neither `lastModifiedDateTime` nor the content hash has changed.

---

## Idempotency

Re-running `writePage()` for the same page is always safe:

- `mkdirSync({ recursive: true })` is a no-op when the directory already exists.
- `writeFileSync` overwrites the existing file with identical content.
- `markProcessed` updates the row to the same values it already holds.

This means a pipeline re-run on an already-processed page produces no
observable change to the corpus or the manifest.

---

## Dry-Run Mode

Setting `DRY_RUN=true` in the environment causes `writePage()` to:

- Skip directory creation.
- Skip the file write.
- Skip the `markProcessed()` call.
- Log `[DRY RUN] [write] page <id> → <path> (<bytes> bytes)` instead.
- Still return `{ markdownPath, byteSize }` — where `byteSize` is the
  in-memory byte size of the composed content — so callers can display a
  consistent summary.

Dry-run mode is useful for auditing what would be written during a run without
touching the filesystem or modifying the manifest.

---

## Logging

| Event | Log target | Format |
|-------|------------|--------|
| Successful write | `console.log` | `[write] page <id> → <path> (<bytes> bytes)` |
| Dry-run (skipped) | `console.log` | `[DRY RUN] [write] page <id> → <path> (<bytes> bytes)` |

No log is emitted when `WriteError` is thrown; the error propagates to the
orchestrator which logs the failure at the pipeline level.

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CORPUS_DIR` | `./corpus` | Root directory for output Markdown files |
| `DRY_RUN` | `false` | Set to `true` to skip all I/O and DB updates |

`CORPUS_DIR` is passed as the `corpusDir` argument to `writePage()` by the
orchestrator (`src/pipeline/index.ts`).

---

## API Reference

### `writePage(page, corpusDir)`

```typescript
export async function writePage(
  page: ConvertedPage,
  corpusDir: string,
): Promise<WriteResult>
```

**Parameters**

- `page` — Fully converted page.  Must have non-empty `pageId`, `title`,
  `section`, and `contentHash`.
- `corpusDir` — Absolute path to the corpus root directory.

**Returns** `WriteResult`:

```typescript
export interface WriteResult {
  markdownPath: string;  // absolute path of the written file
  byteSize: number;      // file size in bytes (or in-memory size in dry-run)
}
```

**Throws** `WriteError` when the composed frontmatter is missing `page_id`,
`title`, or `section`.  No I/O is performed when this error is thrown.

---

### `slugifySection(section)`

```typescript
export function slugifySection(section: string): string
```

Converts a section display name to a URL-safe, non-empty directory slug.

Always returns a non-empty string.  If all characters are stripped (e.g.
CJK or emoji-only input), a `untitled-section-<8-char-hash>` fallback is
returned.

---

### `WriteError`

```typescript
export class WriteError extends Error
```

Thrown before any filesystem or database I/O when the composed frontmatter
fails validation.  `error.name === 'WriteError'`.  Non-retryable: indicates
a bug in the upstream conversion stage, not a transient failure.

---

## Related Documents

- [Frontmatter](frontmatter.md) — YAML frontmatter field reference and
  `generateFrontmatter()` API.
- [Vision Conversion](vision-conversion.md) — how `ConvertedPage` is
  produced before reaching the write stage.
- [Diagram Asset Extraction](diagram-asset-extraction.md) — how diagram
  image files are written and the Markdown placeholder is resolved before
  the write stage receives the page.
- [Database](database.md) — `markProcessed()` behaviour and the `pages`
  manifest schema.
- [Project Structure](project-structure.md) — full source layout, module
  roles, and dependency graph.
- [Development Setup](development.md) — environment variables, running
  tests, and contributing guidelines.
