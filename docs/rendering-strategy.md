# Rendering Strategy — OneNote Page → Image

This document describes how the Lemma pipeline converts a OneNote page to a
raster image suitable for vision-model processing, and why.

---

## The Problem

Microsoft Graph API exposes OneNote content in two forms:

1. **HTML + InkML** — the structured representation.  For handwritten pages,
   ink strokes are returned as `InkNode` elements with raw coordinate data.
   Recognised text (if any) appears under `inkAnalysisOrNull`, but this
   field is populated only by the OneNote client add-in — it is `null` in
   headless API responses.

2. **Rendered export** — `GET /me/onenote/pages/{id}/content` with
   `Accept: application/pdf` or `Accept: image/jpeg`.  This endpoint works
   reliably for typed content but returns HTTP 415 for pages containing
   handwritten ink nodes on **personal Microsoft accounts**.

This means there is no clean, fully programmatic path from handwritten
OneNote page to raster image for personal accounts at the time of writing.
The validation spike confirmed this limitation.

---

## Strategy Selection

The pipeline implements three rendering strategies in priority order:

### 1. `semi-auto` — Manual PNG Export (current primary)

The user exports a OneNote section or page to PNG from the iPad or
desktop app, then places the file in a watched drop folder
(`SEMI_AUTO_DROP_DIR`).  The pipeline picks it up and processes it.

**Pros:** Reliable; produces full retina-resolution images; no API
limitations.

**Cons:** Requires a manual step.  For daily sync, this means ~one export
action per section per day.  Acceptable given the stated workflow.

**Configuration:**
```
RENDER_STRATEGY=semi-auto
SEMI_AUTO_DROP_DIR=./drop
SEMI_AUTO_TIMEOUT_MS=0    # 0 = check once; >0 = wait up to N ms
```

### 2. `pdf-export` — Graph API PDF + pdfjs-dist Rasterisation (future primary)

When the Graph API supports rendering handwritten ink pages on personal
accounts (or for work/school accounts where it already works), this strategy
fetches the page as PDF and rasterises page 1 using `pdfjs-dist` + the
`canvas` package at 150 DPI.

**Implementation:** `src/pipeline/render-strategies/pdf-export.ts`

**Configuration:**
```
RENDER_STRATEGY=pdf-export
```

### 3. `inkml-raster` — InkML → SVG → PNG (stub, not implemented)

A hypothetical fully-automated path: fetch raw InkML stroke data, render
strokes to SVG, convert to PNG.  This would avoid the manual export step
entirely, but requires a custom ink renderer.

**Status:** Stub only (`src/pipeline/render-strategies/inkml-raster.ts`
throws `NotImplemented`).  Not pursued because the semi-auto path is
adequate and the effort is disproportionate to the marginal benefit.

---

## Minimum Quality Gate

After rasterisation, the pipeline enforces a minimum quality check:

- **Minimum width:** 1 668 px (equivalent to iPad mini 6 landscape).
  Images below this threshold generate a warning but are not rejected —
  the vision model may still produce acceptable output.

- **Minimum file size:** 50 KB.  Images below this threshold are very likely
  blank or corrupt and will degrade vision accuracy significantly.
  A `WARNING: rendered image is suspiciously small` log entry is emitted.

Both thresholds are not yet enforced in the current `src/pipeline/render.ts` stub.
The values above document the intended behaviour so integrators know what to
expect once the stub is replaced with a full implementation.

---

## Spike Script API Notes

The validation spike's `render-test.ts` exposes these exports for re-use and testing:

| Export | Signature | Purpose |
|--------|-----------|---------|
| `isPdf` | `(buf: Buffer) → boolean` | Magic-byte check (`%PDF`); used by `main()` for content-based format detection |
| `rasterizePdf` | `(pdfData: Buffer) → Promise<Buffer>` | Rasterises PDF page 1 at 150 DPI; accepts a pre-read buffer so the caller reads the file exactly once |
| `normaliseToPng` | `(imageBuffer: Buffer) → Promise<Buffer>` | Converts any sharp-readable image to PNG and logs a warning if width < `MIN_WIDTH_PX` |
| `MIN_WIDTH_PX` | `1668` | Minimum acceptable width for vision-model input |

`main()` reads the input file **once**, passes the buffer to `isPdf()` for content-based
format detection (more robust than extension-only detection), then passes the same buffer
to `rasterizePdf()` or directly to `normaliseToPng()`.

---

## Adding a New Render Strategy

1. Create `src/pipeline/render-strategies/<name>.ts` and export an async
   function with signature:
   ```typescript
   export async function <name>Strategy(page: PageMeta, client?: GraphClient): Promise<Buffer>
   ```
2. Add the strategy name to the `RenderResult.renderStrategy` union in
   `src/pipeline/render.ts`.
3. Add the strategy to the fallback chain in `renderPage()`.
4. Add the strategy name as a valid value for `RENDER_STRATEGY` in
   `.env.example` and `docs/rendering-strategy.md`.

---

## Related Documents

- [Project Structure](project-structure.md) — full source directory layout and module roles.
- [Development Setup](development.md) — environment setup and how to run the pipeline locally.
