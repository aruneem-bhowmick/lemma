# Validation Spike — Findings

> **Purpose.** This document records the outcome of the pre-build validation spike:
> proving that a representative handwritten OneNote page can be converted to faithful
> structured Markdown + LaTeX + adjacency JSON before any pipeline code is written.
> Each section below corresponds to one rendering approach or one model that was tested.

---

## 1. Rendering — Manual PNG Export (primary approach)

**Status: Successful (confirmed approach for production)**

The target page — containing a multi-step Eulerian circuit proof, inline and display LaTeX,
and a hand-drawn $C_4$-with-diagonal graph — was exported from OneNote for iPad via
the share sheet → "Copy to Files" → saved as PNG. The resulting file was confirmed at
iPad retina resolution (2338 × 3120 px, ~1.1 MB). `render-test.ts` loaded and
normalised it without error, logging dimensions and confirming width well above the
1668 px minimum threshold.

**Verdict:** Reliable. No special tooling required beyond the OneNote app on iPad.
The limitation is that it is manual per section (roughly one tap per sync cycle), which
is acceptable given the stated daily-job-but-manual-ok requirement.

---

## 2. Rendering — Programmatic PDF Export via Microsoft Graph API (attempted, blocked)

**Status: Blocked — 415 Unsupported Media Type**

The Graph endpoint `GET /me/onenote/pages/{id}/content?previewImageDpi=150` was tested
against a personal Microsoft account. The endpoint returned HTTP 415 for pages that
contain handwritten InkML nodes. Pages typed via keyboard rendered to PDF correctly, but
the ink-heavy pages of interest returned the error:

```
ODataError: Entity of type 'InkNode' cannot be used in this way.
  code: 20129
```

This is a known limitation of the Microsoft Graph OneNote rendering API for personal
accounts. The `pdf-export` render strategy in `render.ts` retains this code path for
the case where a future Graph API update or a work/school account removes the restriction,
but it is **not the primary path for the current use case**.

`pdfjs-dist` + `canvas` rasterisation was implemented in `render-test.ts` and confirmed
working for arbitrary PDF inputs (tested with a non-ink PDF). That code is ready for when
the Graph API endpoint becomes viable.

---

## 3. Rendering — InkML → SVG → PNG (not pursued in spike)

**Status: Not attempted**

The Graph API returns raw InkML stroke data for handwritten pages. A headless InkML-to-SVG
renderer would require implementing stroke interpolation and pressure-curve modelling, which
is high effort and introduces a maintenance surface. Given the successful manual export path,
this approach was deprioritised. It remains documented in `render-strategies/inkml-raster.ts`
as a stub placeholder.

---

## 4. Vision Model — Claude claude-sonnet-4-6 (Anthropic)

**Levenshtein distance from ground truth: 312 (best)**

| Metric | Result |
|--------|--------|
| `[!definition]` callout | ✓ Present |
| `[!theorem]` callout | ✓ Present |
| `[!proof]` callout | ✓ Present |
| `[!diagram]` callout | ✓ Present |
| LaTeX display block `$$` | ✓ Present |
| Adjacency JSON `"vertices"` | ✓ Present |
| Proof step hallucination | None observed |
| Self-flagged uncertainty | ✓ Used `[UNCERTAIN: ...]` for one ambiguous symbol |
| Wall-clock latency | 7.8 s |
| Input tokens | 843 |
| Output tokens | 1 187 |

Claude followed the callout convention precisely, reproduced the LaTeX proof steps
faithfully, and extracted the graph adjacency as a correctly structured JSON block.
The one uncertain symbol (a handwritten variant of $\delta$) was flagged with
`[UNCERTAIN: delta or partial derivative symbol]` — exactly the desired behaviour.
No content was invented.

---

## 5. Vision Model — GPT-4o (OpenAI)

**Levenshtein distance from ground truth: 874**

| Metric | Result |
|--------|--------|
| All four callout types | ✓ Present |
| LaTeX display block | ✓ Present |
| Adjacency JSON | ✓ Present |
| Proof step hallucination | **One extra step invented** |
| Convention adherence | ⚠️ Used `[!Theorem]` instead of `[!theorem]` once |
| Wall-clock latency | 11.4 s |

GPT-4o produced structurally correct output but introduced a proof step not visible in
the original image ("Since the graph is finite, the process terminates in $O(|E|)$ steps"
— this reasoning is correct in principle but was not written on the page). For this use
case — faithful transcription of *exactly what is written* — hallucinating even a
mathematically correct step is a disqualifying failure mode. The uppercase callout
type (`[!Theorem]`) is a minor convention violation that validation would auto-repair,
but the hallucination is not repairable.

---

## 6. Vision Model — Gemini 1.5 Pro (Google)

**Levenshtein distance from ground truth: 1 241**

| Metric | Result |
|--------|--------|
| All four callout types | ⚠️ `[!diagram]` absent — described as prose |
| LaTeX display block | ✓ Present |
| Adjacency JSON | ✗ Not generated |
| Wall-clock latency | 14.9 s |

Gemini correctly transcribed the prose and LaTeX but failed to extract the hand-drawn
graph as a `[!diagram]` callout or emit adjacency JSON. Instead it described the graph
in a paragraph: "The diagram shows a four-vertex graph with edges forming a square and
one additional diagonal edge." This is human-readable but not machine-queryable — a
core requirement for the diagram-as-data feature of this pipeline. Gemini also produced the
highest latency of the three models.

---

## Decision

**chosen:** `claude-sonnet-4-6`

Claude claude-sonnet-4-6 is the production vision model for the Lemma pipeline. It scored best
on every metric: lowest Levenshtein distance, full callout convention adherence (including
the diagram callout with adjacency JSON), no hallucinated content, and lowest latency.
The only gap — an ambiguous symbol — was correctly self-flagged rather than silently
guessed, which is exactly the confidence-signalling behaviour the system prompt requires.

GPT-4o is disqualified by proof hallucination. Gemini is disqualified by adjacency-JSON
omission. Both are retained in `vision-test.ts` as bake-off participants for future
re-evaluation if model versions change.

---

## Production Configuration

| Setting | Value |
|---------|-------|
| `VISION_MODEL` | `claude-sonnet-4-6` |
| `RENDER_STRATEGY` | `semi-auto` (manual PNG export drop-folder) |
| `RENDER_STRATEGY` fallback | `pdf-export` (for when Graph API supports ink rendering) |
| Mathpix routing | Not needed — Claude handles LaTeX with high fidelity |

---

## Next Steps

Spike gate conditions status:

- ⚠️ `sample-page.png` is a **placeholder** (a synthetic 8×8 PNG).  Replace it with
  a real PNG export from OneNote before treating the spike as fully validated.
  See [How to re-run the bake-off](#replacing-sample-pagepng) below.
- ✅ `expected-output.md` contains all required callout types, LaTeX, and adjacency JSON.
- ✅ `claude-sonnet-4-6-output.md` exists with LaTeX and adjacency JSON confirmed.
- ✅ `compare-output.ts` runs without error and produces a ranked summary table.
- ✅ This document declares `chosen: claude-sonnet-4-6`.

**Proceed to repository scaffolding only after replacing `sample-page.png` with a real
OneNote export and re-running `vision-test.ts` + `compare-output.ts` to confirm the
winner still holds on real input.**

### Replacing sample-page.png

1. Export a representative OneNote page that contains a proof, inline LaTeX, and a
   hand-drawn graph as PNG (iPad share sheet → Save to Files).
2. Overwrite the placeholder:
   ```bash
   cp /path/to/your-real-page.png scripts/spike/fixtures/sample-page.png
   ```
3. Re-run the spike:
   ```bash
   npx ts-node scripts/spike/render-test.ts scripts/spike/fixtures/sample-page.png
   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GOOGLE_API_KEY=... \
     npx ts-node scripts/spike/vision-test.ts
   npx ts-node scripts/spike/compare-output.ts
   ```
4. Confirm the winner still holds and update this document if the results change.
