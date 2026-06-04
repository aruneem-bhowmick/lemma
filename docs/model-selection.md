# Model Selection — Vision LLM Decision Record

This document records the model selection decisions for the Lemma pipeline.
It is a living document: update it whenever a model is swapped or its
configuration changes.

---

## Current Production Configuration

| Slot | Model | Version | Set by |
|------|-------|---------|--------|
| Vision conversion | **Claude claude-sonnet-4-6** | Anthropic API | Validation spike |
| Embedding | TBD | — | Not yet implemented |
| Generation (Q&A) | TBD | — | Not yet implemented |
| Triple extraction | TBD | — | Not yet implemented |

### Environment variable

```
VISION_MODEL=claude-sonnet-4-6
```

Set this in your `.env` file and in the GitHub Actions secrets before the
first production sync run.

---

## Why claude-sonnet-4-6 for Vision Conversion

See `docs/spike-findings.md` for full bake-off data.  Summary:

1. **No hallucination** — the model never invented content not visible in the
   image.  Both alternative models failed this requirement in some way.

2. **Callout convention adherence** — used `[!definition]`, `[!theorem]`,
   `[!proof]`, and `[!diagram]` exactly as instructed, including embedding
   adjacency JSON inside `[!diagram]` blocks.

3. **LaTeX fidelity** — reproduced inline and display math correctly for all
   symbols tested.  One ambiguous symbol was correctly flagged with
   `[UNCERTAIN: ...]` rather than silently guessed.

4. **Lowest edit distance** — Levenshtein distance of 312 against the
   hand-authored ground truth vs. 874 (GPT-4o) and 1 241 (Gemini 1.5 Pro).

5. **Lowest latency** — 7.8 s average vs. 11.4 s (GPT-4o) and 14.9 s
   (Gemini).  With `MAX_CONCURRENT_PAGES=3`, this matters for nightly runs.

---

## Re-evaluation Triggers

Re-run the bake-off (`scripts/spike/vision-test.ts`) when any of the
following occur:

- A new Anthropic model version is released and announced as significantly
  better on structured-output tasks.
- Production spot-checks reveal degraded LaTeX fidelity or callout
  convention violations on more than 5 % of pages.
- A new GPT-4 or Gemini version claims to have addressed hallucination on
  transcription tasks.

To run a fresh bake-off:

```bash
# Export a new representative page from OneNote to PNG
cp /path/to/new-page.png scripts/spike/fixtures/sample-page.png

# Run against all three models
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GOOGLE_API_KEY=... \
  npx ts-node scripts/spike/vision-test.ts

# Compare
npx ts-node scripts/spike/compare-output.ts
```

Update this document and `scripts/README-spike.md` with the new findings,
and change `VISION_MODEL` in `.env` and GitHub Secrets if the winner changes.

---

## Rejected Models

| Model | Rejection Reason |
|-------|-----------------|
| GPT-4o | Hallucinated a mathematically correct but absent proof step |
| Gemini 1.5 Pro | Failed to emit adjacency JSON for hand-drawn graphs |

These models remain in `scripts/spike/vision-test.ts` and will be included
in any future re-evaluation automatically.

---

## Token Cost Estimates (reference only)

Costs are rough estimates based on single-page spike inputs and approximate
published prices.  Actual costs will vary with page content density.

| Model | Avg. input tokens | Avg. output tokens | Approx. cost/page |
|-------|------------------|--------------------|-------------------|
| claude-sonnet-4-6 | ~850 | ~1 200 | ~$0.015 |
| gpt-4o | ~980 | ~1 450 | ~$0.020 |
| gemini-1.5-pro | ~1 100 | ~1 890 | ~$0.007 |

With 100 changed pages per nightly run, claude-sonnet-4-6 costs approximately
**$1.50 per run**.

---

## Pipeline Integration

The chosen model will be wired into the pipeline via `src/vision/client.ts` (`VisionClient`),
configured by the `VISION_MODEL` environment variable (defaulting to `claude-sonnet-4-6`).
`VisionClient` is currently a stub — it does not yet read `VISION_MODEL` or invoke any API.
Full implementation (including env-var wiring and the system prompt from the spike) is
pending.

See [Project Structure](project-structure.md) for the full module layout and
[Development Setup](development.md) for how to run the pipeline with a real API key.
