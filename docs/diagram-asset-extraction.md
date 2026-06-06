# Diagram Asset Extraction

This document describes how the Lemma pipeline saves diagram images to disk
and resolves the `<asset-placeholder>` tokens that the vision model emits in
diagram callout blocks.

---

## Overview

After the vision conversion stage produces a `ConvertedPage`, each
`[!diagram]` callout in the Markdown body contains an image reference using
the literal placeholder string `<asset-placeholder>`:

```markdown
> [!diagram] Example: K₃
> ![fig](./assets/<asset-placeholder>.png)
> ```json
> { "type": "undirected", "vertices": ["A","B","C"], "edges": [...], "caption": "..." }
> ```
```

The asset extraction stage — `extractAndWriteAssets()` in
`src/pipeline/assets.ts` — converts each placeholder into an actual file path
(`./assets/page-<pageId>-fig<N>.png`) by:

1. Writing the full-page JPEG buffer as a PNG file to the assets directory.
2. Replacing the first remaining `<asset-placeholder>` token in the Markdown
   with the diagram's relative path.

After extraction, `ConvertedPage.assetPaths` holds the absolute filesystem
paths of every written file, and `ConvertedPage.markdown` contains the fully
resolved Markdown body ready for writing to the corpus.

---

## Asset Naming Convention

Every asset file follows a deterministic naming scheme:

| Component | Value |
|-----------|-------|
| Filename | `page-<pageId>-fig<N>.png` |
| `<pageId>` | The OneNote page identifier (GUID) |
| `<N>` | Zero-indexed position of the diagram within the page |
| Format | PNG (converted from the JPEG render output via `sharp`) |

Examples:

```text
page-ABC123-fig0.png    ← first diagram on page ABC123
page-ABC123-fig1.png    ← second diagram on the same page
page-DEF456-fig0.png    ← first diagram on a different page
```

---

## File Paths

Three path representations are tracked per asset:

| Field | Description | Example |
|-------|-------------|---------|
| `filename` | Filename only | `page-ABC123-fig0.png` |
| `relativePath` | Repository-root-relative Markdown reference | `./assets/page-ABC123-fig0.png` |
| `absolutePath` | Fully resolved filesystem path | `/home/user/lemma/assets/page-ABC123-fig0.png` |

The `relativePath` is always prefixed with `./assets/` regardless of the
`ASSETS_DIR` environment variable.  This is an intentional design choice: the
`./assets/` prefix is a repository-root convention interpreted by downstream
Markdown viewers and tooling.  The `absolutePath` is used for all file I/O.

---

## Placeholder Resolution

The vision model is instructed to emit `<asset-placeholder>` as a literal
string inside every `[!diagram]` callout's image tag:

```markdown
![fig](./assets/<asset-placeholder>.png)
```

The extraction loop processes diagrams in order (index 0, 1, 2, …). On each
iteration it performs a single non-global replacement targeting the **full
image-path pattern** `./assets/<asset-placeholder>.png`, substituting it with
the computed `relativePath` for that diagram:

```text
'./assets/<asset-placeholder>.png'  →  './assets/page-<pageId>-fig<N>.png'
```

Matching the complete path rather than the bare token `<asset-placeholder>`
means that any other occurrence of that string in the Markdown body — for
example, an inline-code mention like `` `<asset-placeholder>` `` in
explanatory prose — is left untouched.  Only the image tag itself is mutated.

The one-at-a-time (non-global) replacement also ensures each loop iteration
resolves exactly the diagram-N image tag, even when multiple diagrams appear
on the same page.

---

## v1 Behaviour: Full-Page Image Per Diagram

In the current implementation every diagram asset file contains the
**complete** rendered page image (converted from JPEG to PNG via `sharp`).
There is no per-figure cropping.

This is deliberate for the first version: the vision model provides adjacency
JSON for the diagram's structure, and the full-page image provides the
visual context.  Per-figure bounding-box cropping using vision-provided
coordinates is reserved for a future iteration.

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ASSETS_DIR` | `./assets` | Directory where asset PNG files are written |

The `convertPage()` function in `src/pipeline/convert.ts` reads `ASSETS_DIR`
from the environment (with `./assets` as the fallback) and passes it as the
`assetsDir` argument to `extractAndWriteAssets()`.  The directory is created
recursively if it does not already exist.

---

## Idempotency

Re-processing the same page overwrites any existing asset files for that page
without error.  The file write uses `sharp(...).png().toFile(path)` which
replaces the file if it already exists.  This matches the broader pipeline
guarantee that any run can be safely re-executed.

---

## Integration with the Convert Stage

`extractAndWriteAssets()` is called at the end of `convertPage()`, after
vision transcription and Markdown validation.  The call site in
`src/pipeline/convert.ts`:

1. Constructs an initial `ConvertedPage` with `assetPaths: []` and the
   validated Markdown body.
2. Passes the initial page, the render-stage image buffer, and the assets
   directory path to `extractAndWriteAssets()`.
3. Spreads the result over the initial page, replacing `markdown` with the
   resolved version and `assetPaths` with the absolute paths from the
   returned asset records.

The returned `ConvertedPage` therefore always carries a fully resolved
Markdown body and a populated `assetPaths` array.

---

## ExtractedAsset Interface

```typescript
export interface ExtractedAsset {
  filename: string;       // e.g. 'page-0abc-fig1.png'
  relativePath: string;   // e.g. './assets/page-0abc-fig1.png'
  absolutePath: string;   // absolute path on disk
  diagramIndex: number;   // 0-indexed position within the page
}
```

`extractAndWriteAssets()` returns:

```typescript
{ assets: ExtractedAsset[]; markdown: string }
```

- `assets` — one entry per diagram; empty when the page has no diagrams.
- `markdown` — the updated Markdown body with all placeholders resolved.

---

## Log Output

On successful extraction:

```text
[assets] wrote 2 assets for page page-0abc
```

No log is emitted when a page has no diagrams.

---

## Related Documents

- [Vision Conversion](vision-conversion.md) — how the vision model produces
  the `<asset-placeholder>` tokens that this stage resolves.
- [Project Structure](project-structure.md) — full source layout and module
  roles, including `src/pipeline/assets.ts`.
- [Callout Validation](callout-validation.md) — the Markdown convention rules
  that govern `[!diagram]` callout structure.
- [Development Setup](development.md) — environment variables and running
  tests locally.
