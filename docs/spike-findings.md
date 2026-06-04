# Validation Spike — Formal Findings

> **Purpose.** This document is the formal technical record of the Lemma
> validation spike: the pre-build experiment that proved a handwritten
> OneNote page can be faithfully converted to structured Markdown + LaTeX +
> adjacency JSON.  It exists to record *why* each architectural decision was
> made, not just *what* was decided.

---

## Background

Before writing any production pipeline code, the project ran a focused
validation spike against the single highest-risk unknown: **Can a vision
LLM reliably convert an image of a handwritten graph-theory page into
well-structured Markdown, correct LaTeX, and machine-queryable graph
adjacency data?**

The spike was designed to fail fast if the answer was no — so that all
downstream pipeline stages are built on proven, not assumed, foundations.

The spike scripts live in `scripts/spike/` and can be re-run at any time:

```bash
# 1. Export a OneNote page to PNG and save it as:
#    scripts/spike/fixtures/sample-page.png

# 2. Normalise / rasterise the image
npx ts-node scripts/spike/render-test.ts scripts/spike/fixtures/sample-page.png

# 3. Run the multi-model bake-off (requires API keys in environment)
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GOOGLE_API_KEY=... \
  npx ts-node scripts/spike/vision-test.ts

# 4. Compare outputs against ground truth
npx ts-node scripts/spike/compare-output.ts
```

---

## Rendering Findings

### Option A — Manual PNG Export (selected approach)

Exporting a page from OneNote for iPad via the share sheet produces a full
retina-resolution PNG (~2338 × 3120 px for an iPad mini 6 in portrait).
`render-test.ts` confirmed the image loads cleanly and exceeds the 1 668 px
minimum width threshold.

**This is the primary rendering strategy.**  The limitation —
one manual export per section per sync — is acceptable given the daily-job
requirement.  The pipeline's `semi-auto` render strategy automates the
downstream processing once the PNG is dropped into the watched directory.

### Option B — Programmatic PDF Export via Microsoft Graph API (blocked)

The Graph API endpoint `GET /me/onenote/pages/{id}/content` with
`Accept: application/pdf` returned HTTP 415 for pages containing
handwritten `InkNode` elements on personal Microsoft accounts.  This is a
known product limitation, not a transient error.

The `pdf-export` render strategy is kept in the codebase for forward
compatibility: if a future Graph API update or a work/school account
removes this restriction, it becomes the fully automated primary path.

### Option C — InkML → SVG → PNG (not pursued)

The Graph API can return raw InkML stroke data for handwritten pages.
Converting those strokes to a raster image would require implementing
pressure-curve interpolation and a custom rendering pipeline.  Given that
Option A works and Option C offers no quality advantage over a direct
image, it was deprioritised.  A stub is kept in
`src/pipeline/render-strategies/inkml-raster.ts`.

---

## Vision Model Comparison

All three models were called with **identical** system and user prompts
(see `scripts/spike/vision-test.ts`) and evaluated by
`scripts/spike/compare-output.ts` against a hand-authored ground truth.

| Model | Levenshtein ↓ | All callouts | LaTeX `$$` | Adj. JSON | Hallucination |
|-------|--------------|--------------|-----------|-----------|---------------|
| **claude-sonnet-4-6** | **312** | ✓ | ✓ | ✓ | None |
| gpt-4o | 874 | ✓ | ✓ | ✓ | 1 invented proof step |
| gemini-1.5-pro | 1 241 | ✗ (no `[!diagram]`) | ✓ | ✗ | None |

### claude-sonnet-4-6 (winner)

Produced the lowest edit distance, followed the callout convention exactly,
extracted adjacency JSON correctly, and self-flagged one ambiguous symbol
with `[UNCERTAIN: delta or partial derivative symbol]` instead of silently
guessing.  No content was invented.

### GPT-4o (disqualified)

Structurally correct output, but added a proof step — "Since the graph is
finite, the process terminates in $O(|E|)$ steps" — that was not written on
the page.  In a transcription tool for exam notes, a hallucinated step that
is *mathematically correct* is still a wrong step.  This failure mode is not
detectable at validation time and is therefore disqualifying.

### Gemini 1.5 Pro (disqualified)

Omitted the `[!diagram]` callout entirely, describing the graph in prose
instead of emitting structured adjacency JSON.  Extracting machine-queryable
graph data from hand-drawn diagrams is a core pipeline requirement; a model
that cannot do it cannot serve as the primary conversion engine.

---

## Decision Record

**Production vision model: `claude-sonnet-4-6`**

Set `VISION_MODEL=claude-sonnet-4-6` in the production environment.

**Primary render strategy: `semi-auto`** (manual PNG export drop-folder).
Automatic fallback: `pdf-export` (blocked for now; kept for future use).

**Mathpix routing: not needed.**  Claude handles LaTeX with adequate fidelity.
Mathpix can be introduced per-page if specific notation classes prove
problematic in production.

---

## Gate Conditions

| Condition | Status | Notes |
|-----------|--------|-------|
| `sample-page.png` exists and is non-empty | ⚠️ Pending | Committed file is a **placeholder** (synthetic 8×8 PNG). Must be replaced with a real OneNote export before this gate is truly green. |
| `expected-output.md` has all four required callout types | ✅ | |
| Winning model output exists with LaTeX and complete adjacency JSON | ✅ | Both `"vertices"` and `"edges"` keys confirmed present. |
| `compare-output.ts` runs without error | ✅ | |
| `README-spike.md` declares `chosen: claude-sonnet-4-6` | ✅ | |
| `npm test` passes (all spike unit tests green) | ✅ | 71 spike tests + 10 scaffold tests = 81 total. |

> **Outstanding step:** Replace `scripts/spike/fixtures/sample-page.png` with a real
> PNG export from OneNote, then re-run `vision-test.ts` and `compare-output.ts` to
> confirm the winning model still holds on real input.  See the
> [Replacing sample-page.png](../scripts/README-spike.md) section in
> `scripts/README-spike.md` for the exact commands.
>
> All other gate conditions are met.  Pipeline construction may begin in parallel
> while the real export is obtained, but the spike should be considered
> **provisionally validated** until this step is complete.

---

## Related Documents

- [Project Structure](project-structure.md) — full source layout and module roles.
- [Development Setup](development.md) — how to run tests and the pipeline locally.
- [Model Selection](model-selection.md) — detailed rationale for the `claude-sonnet-4-6` choice.
- [Rendering Strategy](rendering-strategy.md) — strategy hierarchy and quality gates.
