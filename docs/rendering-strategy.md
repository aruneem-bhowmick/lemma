# Rendering Strategy — OneNote Page → Image

This document describes how the Lemma pipeline converts a OneNote page to a
raster image suitable for vision-model processing, why the current strategy
was chosen, and how to configure and extend the rendering stage.

---

## The Problem

Microsoft Graph API exposes OneNote content in two forms:

1. **HTML + InkML** — the structured representation. For handwritten pages,
   ink strokes are returned as `InkNode` elements with raw coordinate data.
   Recognised text (if any) appears under `inkAnalysisOrNull`, but this
   field is populated only by the OneNote client add-in — it is `null` in
   headless API responses.

2. **Rendered export** — `GET /me/onenote/pages/{id}/content` with
   `Accept: application/pdf` or `Accept: image/jpeg`. This endpoint works
   reliably for typed content but returns HTTP 415 for pages containing
   handwritten ink nodes on **personal Microsoft accounts**.

This means there is no clean, fully programmatic path from handwritten
OneNote page to raster image for personal accounts at the time of writing.
The validation spike confirmed this limitation.

---

## Architecture

The rendering stage is implemented in `src/pipeline/render.ts`. It exposes a
single public function:

```typescript
export async function renderPage(page: PageMeta, graphClient: GraphClient): Promise<RenderResult>
```

`renderPage` delegates to one of three interchangeable strategy modules:

```text
src/pipeline/render-strategies/
  pdf-export.ts    ← Strategy A: Graph API export + local rasterisation
  semi-auto.ts     ← Strategy B: local drop-folder PDF (primary for personal accounts)
  inkml-raster.ts  ← Strategy C: stub (not yet implemented)
```

After a successful render, the raw buffer is normalised to JPEG quality 92
via `sharp` and two quality gates are applied (see
[Quality Gates](#quality-gates) below).

---

## Strategy Selection and Fallback Chain

The primary strategy is controlled by the `RENDER_STRATEGY` environment
variable (default: `pdf-export`). If the primary strategy throws, `renderPage`
logs a warning and tries the next strategy in the fixed fallback order:

```text
pdf-export  →  semi-auto  →  inkml-raster
```

The primary strategy is placed at the head; the remaining strategies follow in
that order. A `RenderError` is thrown only when every strategy in the chain is
exhausted. The `pageId` field on `RenderError` lets the pipeline orchestrator
record a targeted per-page failure without aborting the entire run.

### Fallback log format

Each fallback emits a `console.warn` line:

```text
[render] pdf-export failed, falling back to semi-auto: <error message>
```

A successful render emits a `console.log` line:

```text
[render] page <id> rendered via <strategy> in <ms>ms (<bytes> bytes)
```

---

## Strategy Details

### Strategy A — `pdf-export` (Graph API export + rasterisation)

**Module:** `src/pipeline/render-strategies/pdf-export.ts`

Calls `graphClient.renderPageAsImage(page.contentUrl, page.id)`, which
handles content-type negotiation (JPEG preferred, PDF fallback) and Graph-side
rasterisation. The returned bytes are then inspected locally:

- If the first four bytes are `%PDF` (magic bytes of a PDF file), the buffer
  is rasterised using `rasterizePdfBuffer` (see below) and the resulting JPEG
  is returned.
- Otherwise the bytes are assumed to be JPEG and returned directly.

The local PDF check is a defensive second pass that handles cases where
`GraphClient` returns raw PDF bytes (e.g. when the optional `canvas` package
was unavailable at the time of the Graph client call).

**When this strategy works:** typed content on work/school Microsoft accounts.

**When it fails:** handwritten-ink pages on personal accounts (Graph returns
HTTP 415).

**Configuration:** `RENDER_STRATEGY=pdf-export`

---

### Strategy B — `semi-auto` (drop-folder PDF)

**Module:** `src/pipeline/render-strategies/semi-auto.ts`

The user exports a OneNote section or page to PDF from the iPad or desktop
app and places it in the configured drop folder. The strategy:

1. Validates `SEMI_AUTO_TIMEOUT_MS`: accepts a non-negative integer only.
   Non-numeric strings (e.g. `abc`), negative values (e.g. `-1`), and
   decimals (e.g. `1.5`) are rejected with a `console.warn` that names the
   offending value, and the strategy falls back to check-once mode (0 ms).
2. Attempts to read `<page.id>.pdf` from `SEMI_AUTO_DROP_DIR` with a single
   `readFileSync` call. An ENOENT result (file not yet present) is treated as
   a not-ready signal; any other file-system error (EISDIR, EACCES, etc.) is
   re-thrown immediately.
3. If `SEMI_AUTO_TIMEOUT_MS > 0`, polls every 200 ms until the file appears
   or the deadline passes. If timeout is 0 (the default), a single attempt
   is made.
4. Rasterises the PDF with `rasterizePdfBuffer` (pdfjs-dist + sharp at ~150
   DPI, JPEG quality 92).

**When this strategy works:** all personal Microsoft account pages, regardless
of whether the ink export endpoint is available.

**Typical workflow:**

1. Open OneNote on iPad or desktop.
2. Export section → PDF (File → Export → Section → PDF).
3. Place the PDF in `SEMI_AUTO_DROP_DIR` named `<pageId>.pdf`.
4. Run the pipeline — it finds, rasterises, and processes the file.

**Configuration:**

```bash
RENDER_STRATEGY=semi-auto
SEMI_AUTO_DROP_DIR=./drop
SEMI_AUTO_TIMEOUT_MS=0    # 0 = check once; must be a non-negative integer
```

**`SEMI_AUTO_TIMEOUT_MS` validation:** the value must be a non-negative integer
(e.g. `0`, `5000`, `30000`). Decimals, negative numbers, and non-numeric
strings are rejected at runtime: a warning naming the offending value is
emitted and the timeout defaults to 0. Example warning:

```text
[semi-auto] SEMI_AUTO_TIMEOUT_MS='not-a-number' is not a valid non-negative integer; falling back to 0 (check-once mode).
```

---

### Strategy C — `inkml-raster` (stub, not implemented)

**Module:** `src/pipeline/render-strategies/inkml-raster.ts`

A placeholder for a hypothetical fully-automated path: fetch raw InkML stroke
data from the Graph API, render strokes to SVG paths, and convert to PNG. This
would eliminate the manual export step but requires a custom ink renderer.

**Current status:** the function always throws `Error('inkml-raster strategy
not yet implemented')`, allowing the fallback chain to proceed to the next
candidate.

---

## Shared Rasterisation Utility

Both `pdf-export` and `semi-auto` use the `rasterizePdfBuffer` function,
exported from `src/pipeline/render-strategies/pdf-export.ts`:

```typescript
export async function rasterizePdfBuffer(pdfBuffer: Buffer): Promise<Buffer>
```

This function:

1. Loads pdfjs-dist dynamically to parse the PDF and obtain the first page.
2. Scales the page viewport from the PDF default of 72 DPI to ~150 DPI
   (scale factor: 150 / 72 ≈ 2.08).
3. Renders the page onto a node-canvas surface.
4. Converts the resulting PNG to JPEG quality 92 using sharp.

Both pdfjs-dist and canvas are loaded dynamically (`await import(...)`) so the
module can be imported in unit test environments without triggering native
add-on initialisation.

---

## Quality Gates

After a strategy succeeds and the buffer is normalised to JPEG, two checks
are applied:

### Minimum width

If the rendered image is narrower than 1 668 px (equivalent to iPad mini 6
landscape resolution), `renderPage` logs a `console.warn`:

```text
[render] WARNING: image for page <id> is only <N>px wide (minimum recommended: 1668px) — vision accuracy may be degraded.
```

The image is still used; low resolution degrades vision accuracy rather than
causing a hard failure.

### Minimum file size

If the JPEG buffer is smaller than 50 KB, `renderPage` logs:

```text
[render] WARNING: rendered image for page <id> is suspiciously small (<N> bytes) — vision accuracy may be degraded.
```

A buffer this small is likely blank or corrupt. The warning alerts the
operator without aborting the pipeline.

---

## RenderResult

`renderPage` returns a `RenderResult` on success:

| Field              | Type                                   | Description                                      |
|--------------------|----------------------------------------|--------------------------------------------------|
| `pageId`           | `string`                               | OneNote page identifier                          |
| `imageBuffer`      | `Buffer`                               | JPEG bytes at quality 92                         |
| `contentHash`      | `string`                               | `sha256:` + hex digest of `imageBuffer`          |
| `renderStrategy`   | `'pdf-export' \| 'semi-auto' \| 'inkml-raster'` | Strategy that succeeded         |
| `renderDurationMs` | `number`                               | Wall-clock time from start to completion         |

The `contentHash` is stored in the manifest (`pages.content_hash`) and used by
the change-detection stage in subsequent runs to skip unchanged pages even if
`lastModifiedDateTime` has not advanced.

---

## Error Handling

`renderPage` throws `RenderError` (exported from `src/pipeline/render.ts`)
when every strategy in the chain fails:

```typescript
class RenderError extends Error {
  readonly pageId: string;
}
```

The pipeline orchestrator catches `RenderError`, calls
`markFailed(page.id, error.message)` to record the failure in the manifest,
and continues to the next page. The run-level `PipelineResult` reports the
failed page in its `errors` array.

---

## Adding a New Render Strategy

1. Create `src/pipeline/render-strategies/<name>.ts` and export an async
   function with signature:

   ```typescript
   export async function <name>Strategy(page: PageMeta, client?: GraphClient): Promise<Buffer>
   ```

2. Add the strategy name to the `RenderStrategy` union in
   `src/pipeline/render.ts` and extend the `STRATEGY_ORDER` array.

3. Add a `case '<name>':` branch to the `runStrategy` switch in
   `src/pipeline/render.ts`.

4. Update `RenderResult.renderStrategy` to include the new name.

5. Add `'<name>'` as a valid value for `RENDER_STRATEGY` in `.env.example`.

6. Add unit tests in `tests/unit/render.test.ts` that mock the new strategy
   function via `vi.mock` and verify it is called when `RENDER_STRATEGY=<name>`.

---

## Configuration Quick Reference

| Variable                | Default        | Description                                           |
|-------------------------|----------------|-------------------------------------------------------|
| `RENDER_STRATEGY`       | `pdf-export`   | Primary strategy (`pdf-export`, `semi-auto`, `inkml-raster`) |
| `SEMI_AUTO_DROP_DIR`    | —              | Drop folder path (required when strategy is `semi-auto`) |
| `SEMI_AUTO_TIMEOUT_MS`  | `0`            | Max wait for drop-folder file in ms; must be a non-negative integer; invalid values warn and fall back to 0 |

---

## Related Documents

- [Project Structure](project-structure.md) — full source directory layout and module roles.
- [Development Setup](development.md) — environment setup and running the pipeline locally.
- [Pipeline Change Detection](pipeline-change-detection.md) — how `contentHash` is used to skip unchanged pages.
