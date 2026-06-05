# Corpus Frontmatter

This document describes the YAML frontmatter block that begins every Markdown
file written to the `corpus/` directory.  It covers the purpose of each field,
how the frontmatter is generated, and what guarantees downstream consumers can
rely on.

---

## Overview

Every corpus file opens with a `---`-delimited YAML block:

```yaml
---
page_id: "page-abc123-def456"
title: Eulerian Graphs
section: Graph Theory
last_modified: '2024-06-01T12:00:00.000Z'
source_hash: 'sha256:abcdef...'
concepts:
  - Eulerian Circuit
  - Hamiltonian Path
has_diagrams: true
confidence: high
---
```

Downstream tools (chunking, triple extraction, search indexing) parse this
block to filter and route pages without reading the full Markdown body.

---

## Fields

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `page_id` | `string` | `ConvertedPage.pageId` | OneNote page GUID — globally unique identifier. |
| `title` | `string` | `ConvertedPage.title` | Human-readable page title as returned by the Graph API. |
| `section` | `string` | `ConvertedPage.section` | Display name of the OneNote section the page belongs to. |
| `last_modified` | `string` | `ConvertedPage.lastModified` | ISO 8601 timestamp of the last modification from the Graph API. |
| `source_hash` | `string` | `ConvertedPage.contentHash` | SHA-256 hash of the rendered JPEG used for conversion, prefixed `sha256:`. Used for incremental-sync change detection. |
| `concepts` | `string[]` | `ConvertedPage.frontmatter.concepts` | Titles extracted from `[!definition]` and `[!theorem]` callout headers, **sorted alphabetically**. Empty array if no concept callouts were found. |
| `has_diagrams` | `boolean` | `ConvertedPage.diagrams.length > 0` | `true` when the page contains at least one `[!diagram]` callout with parsed adjacency data. |
| `confidence` | `string` | `ConvertedPage.confidence` | Vision model confidence: `high`, `medium`, or `low`. |

### Field ordering

Fields are written in the exact order shown above.  Downstream tools that
parse the block line-by-line (rather than loading the full YAML) should expect
this order.

### Concept sorting

Concept titles are sorted alphabetically before output, regardless of the order
the vision model returned them.  This makes the output deterministic and allows
simple prefix-search on the YAML without loading the full corpus into memory.

### String escaping

All string values are serialised by `js-yaml` with `quotingType: '"'` and
`forceQuotes: false`.  Strings that require quoting (colons, special characters,
ambiguous scalars) are quoted; plain strings that YAML can represent safely are
left unquoted.  The result is always valid, round-trippable YAML regardless of
page title content.

---

## Generation

The frontmatter string is produced by `generateFrontmatter(page: ConvertedPage)`
in `src/pipeline/frontmatter.ts`.  It returns a string ready to be prepended
to the Markdown body:

```typescript
export function generateFrontmatter(page: ConvertedPage): string
// Returns: "---\n<yaml body>\n---\n"
```

The write stage (`src/pipeline/write.ts`) calls this function and composes the
final corpus file as:

```typescript
const content = generateFrontmatter(page) + '\n' + page.markdown;
```

The `frontmatter` field on `ConvertedPage` is a plain `Record<string, unknown>`
populated by the convert stage and consumed by `generateFrontmatter`.  It
carries the same data as the YAML output but in object form, suitable for
programmatic access before serialisation.

---

## Source Hash and Incremental Sync

The `source_hash` field is the SHA-256 fingerprint of the rendered JPEG image
that the vision model converted.  On each pipeline run:

1. The render stage produces a JPEG and computes its hash via `hashBuffer`.
2. The detect stage compares the new hash against the stored `content_hash` in
   the manifest.
3. If the hashes match and `lastModifiedDateTime` is unchanged, the page is
   skipped.

The `source_hash` in the frontmatter therefore identifies the exact rendering
that produced the Markdown body.  If the OneNote page is re-exported at a
different resolution or DPI, the hash will change and the page will be
re-processed on the next run.

See [docs/pipeline-change-detection.md](pipeline-change-detection.md) for the
full change-detection design.

---

## Confidence Levels

| Value | Meaning |
|-------|---------|
| `high` | All content was legible and unambiguous |
| `medium` | Some regions or symbols were ambiguous (`[UNCERTAIN: ...]` markers present) |
| `low` | Significant sections were unclear (`[ILLEGIBLE]` markers present) |

Pages with `confidence: low` should be reviewed before being used in retrieval
or extraction, as the Markdown body may contain gaps.

---

## Test Coverage

**File:** `tests/unit/frontmatter.test.ts` — 29 tests

| Group | Tests |
|-------|-------|
| Output structure | 4 — delimiters, parseability, determinism |
| Required fields | 9 — all eight fields verified via yaml.load |
| Concept sorting | 5 — alphabetical order, empty array, no mutation |
| has_diagrams | 3 — true for 1 diagram, true for 2, false for empty |
| String escaping | 4 — quotes, colons, hashes, round-trip |
| Field ordering | 4 — spot-checks for documented key sequence |

---

## Related Documents

- [Callout Validation](callout-validation.md) — the step that runs before the frontmatter is consumed.
- [Vision Conversion](vision-conversion.md) — how concepts and diagrams are extracted from the model output.
- [Pipeline Change Detection](pipeline-change-detection.md) — how `source_hash` drives incremental sync.
- [Project Structure](project-structure.md) — source file layout.
