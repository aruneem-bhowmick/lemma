# Vision Conversion — OneNote Image → Structured Markdown

This document describes how the Lemma pipeline converts a rendered OneNote page
image into structured, validated Markdown. It covers the system prompt design,
the vision LLM client, the response parser, and the `convertPage` pipeline stage.

---

## Overview

Stage 4 of the Lemma pipeline receives a JPEG buffer from the render stage
and returns a fully populated `ConvertedPage`. The conversion path is:

```text
renderResult.imageBuffer (JPEG)
  │
  ▼
VisionClient.convert()          ← calls Claude via Anthropic SDK
  │
  ▼  raw Markdown string
  │
  ▼
parseVisionResponse()           ← extracts structured fields
  │
  ▼  parsed.markdown (concepts, diagrams, confidence extracted)
  │
  ▼
validateAndRepair()             ← enforces callout convention; auto-repairs case and length
  │
  ▼  validated.markdown (with <asset-placeholder> tokens still present)
  │
  ▼
extractAndWriteAssets()         ← writes PNG files; resolves <asset-placeholder> tokens
  │
  ▼
ConvertedPage                   ← ready for write stage (markdown fully resolved, assetPaths populated)
```

Five modules collaborate in `convertPage`:

| Module | Role |
|--------|------|
| `src/vision/prompt.ts` | Defines `SYSTEM_PROMPT` and `USER_PROMPT_TEMPLATE` |
| `src/vision/client.ts` | Sends the image to the model, handles retries |
| `src/vision/parser.ts` | Extracts structured data from the raw response |
| `src/pipeline/validate.ts` | Validates and repairs the parsed Markdown body |
| `src/pipeline/assets.ts` | Writes diagram PNG files and resolves `<asset-placeholder>` tokens |

The stage orchestrator is `src/pipeline/convert.ts`, which wires these five
together and populates the `ConvertedPage` returned to the orchestrator.

The `ConvertedPage.markdown` field contains the **validated and fully resolved**
Markdown string — all `<asset-placeholder>` tokens are replaced with actual
`./assets/page-<pageId>-fig<N>.png` paths before the page is returned.
Downstream stages do not need to validate or resolve placeholders again.
See [Callout Validation](callout-validation.md) for the validation rule
specification and [Diagram Asset Extraction](diagram-asset-extraction.md)
for the asset writing design.

---

## System Prompt Design

### Callout Convention

The vision model is instructed to use five callout types with exact syntax:

```markdown
> [!definition] <Title>
> <body>

> [!theorem] <Title>
> <body>

> [!proof]
> <body>

> [!example] <Title>
> <body>

> [!diagram] <Caption>
> ![fig](./assets/<asset-placeholder>.png)
> ```json
> { "type": "undirected"|"directed"|"weighted",
>   "vertices": [...],
>   "edges": [...],
>   "caption": "<same as callout title>" }
> ```
```

Only these five types are valid. The callout parser normalises case
(so `[!Definition]` becomes `[!definition]`) during the validation stage
downstream.

### Math Formatting

- Inline math: `$...$`
- Display math: `$$...$$`
- Uncertain symbols: `[UNCERTAIN: <description>]`

### Diagrams

For every hand-drawn graph, the model embeds the `[!diagram]` callout with
the full-page image reference and a JSON adjacency block. The adjacency
block uses the `<asset-placeholder>` string in the image path, which the
asset extraction stage replaces with the actual file path.

Non-graph diagrams (Venn diagrams, flowcharts) use the `[!diagram]` callout
without a JSON block and append `[NON-GRAPH-DIAGRAM]` after the image tag.

### Confidence Annotation

The model appends a confidence comment at the very end of every response:

```text
<!-- confidence: high|medium|low -->
```

| Level | Meaning |
|-------|---------|
| `high` | All content legible and unambiguous |
| `medium` | Some regions or symbols are ambiguous |
| `low` | Significant sections are unclear |

The parser strips this comment from the `markdown` field and stores the
level in `ParsedVisionResponse.confidence`.

### Honesty Constraints

The prompt instructs the model to:
- Never invent content not visible in the image.
- Never hallucinate proof steps.
- Write `[ILLEGIBLE]` for sections it cannot read.
- Write `[UNCERTAIN: <description>]` for individual uncertain symbols.

---

## VisionClient

**File:** `src/vision/client.ts`

`VisionClient` wraps the Anthropic SDK. A single instance should be created per
pipeline run and passed to each `convertPage` call so the Anthropic SDK connection
is reused across pages (see [convertPage Pipeline Stage](#convertpage-pipeline-stage)).

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `VISION_MODEL` | `claude-sonnet-4-6` | Model identifier passed to the SDK |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |

### API call structure

Each call to `VisionClient.convert()` sends:
- `system`: the full `SYSTEM_PROMPT` constant
- `messages[0].content`: two blocks — an image block (base64 JPEG) and a
  text block (the interpolated `USER_PROMPT_TEMPLATE`)
- `max_tokens`: 4096

### Retry behaviour

The client retries on **HTTP 429** (rate-limited) and **HTTP 5xx**
(server-side) errors. Non-retryable errors (HTTP 4xx other than 429) are
thrown immediately.

| Attempt | Trigger |
|---------|---------|
| 1 (initial) | Always |
| 2 (retry 1) | If attempt 1 returned a retryable error |
| 3 (retry 2) | If attempt 2 returned a retryable error |
| 4 (retry 3) | If attempt 3 returned a retryable error |

After the fourth failed attempt, a `VisionError` is thrown.

Before each retry the client waits for a bounded exponential backoff with
±50 % random jitter: `delay = min(10 000 ms, 500 ms × 2^attempt)`. This
prevents hot-loop retries under sustained rate-limiting while keeping the
first retry fast.

### Response parsing

`VisionClient.convert()` scans `response.content` for the first block with
`type === 'text'` rather than assuming position 0 is always a text block.
If no text block is found a `VisionError` is thrown immediately.

### VisionError

```typescript
class VisionError extends Error {
  readonly model: string;      // model identifier
  readonly httpStatus: number; // HTTP status (0 if no HTTP response)
  readonly retryable: boolean; // true for 429 and 5xx
}
```

`VisionError` is exported from `src/vision/client.ts`. The pipeline
orchestrator catches it and records a per-page failure in the manifest
without aborting the run.

### Logging

On every call:
```text
[vision] sending page to claude-sonnet-4-6
[vision] received 1247 tokens in 3402ms (est. $0.0023)
```

Both lines go to `process.stdout`. Token counts are drawn from
`response.usage`. The cost estimate uses hardcoded price constants and
is a rough guide only — it does not account for pricing changes.

---

## Response Parser

**File:** `src/vision/parser.ts`

`parseVisionResponse(raw: string): ParsedVisionResponse` converts the
raw model response string into all structured fields the pipeline needs.

### ParsedVisionResponse

| Field | Type | Description |
|-------|------|-------------|
| `markdown` | `string` | Full body with confidence comment removed |
| `concepts` | `string[]` | Titles from `[!definition]` and `[!theorem]` headers |
| `diagrams` | `DiagramData[]` | Adjacency data from valid JSON blocks |
| `hasUncertain` | `boolean` | True if any `[UNCERTAIN:` markers present |
| `hasIllegible` | `boolean` | True if any `[ILLEGIBLE]` markers present |
| `confidence` | `'high' \| 'medium' \| 'low'` | From confidence comment |

### Concept extraction

Concept titles are extracted from the first line of `[!definition]` and
`[!theorem]` callout blocks using a case-insensitive regex:

```text
> [!definition] Eulerian Circuit     ← concept title: "Eulerian Circuit"
> [!theorem] Euler's Theorem         ← concept title: "Euler's Theorem"
```

`[!proof]`, `[!example]`, and `[!diagram]` callouts do not produce concepts.

### Diagram JSON extraction

The parser walks line-by-line through the response looking for `[!diagram]`
callout blocks. Within each such block, it collects lines between
`` ```json `` and `` ``` ``, strips the leading `> ` prefix from each line,
and attempts `JSON.parse`.

A valid diagram JSON block must pass full schema validation:

| Field | Required type |
|-------|--------------|
| `type` | `"undirected"` \| `"directed"` \| `"weighted"` |
| `vertices` | `string[]` |
| `edges` | `Array<[string, string] \| [string, string, number]>` |
| `caption` | `string` |

```json
{
  "type": "undirected",
  "vertices": ["A", "B", "C"],
  "edges": [["A", "B"], ["B", "C"], ["A", "C"]],
  "caption": "Example: K₃"
}
```

Malformed JSON, blocks missing required fields, invalid `type` values,
malformed `vertices`, or malformed `edges` each log a descriptive warning to
`console.warn` and are skipped without throwing. An unterminated JSON fence
(no closing `` ``` `` before end of input) is also warned and discarded — the
partial buffer is never parsed. A single broken diagram block does not abort
processing of the entire page.

### Confidence default

When the confidence comment is absent or its level is not one of
`high`, `medium`, or `low`, the parser defaults to `'medium'`.

---

## convertPage Pipeline Stage

**File:** `src/pipeline/convert.ts`

`convertPage(renderResult, page, client?, assetsDir?)` orchestrates the five
modules above:

1. Base64-encodes `renderResult.imageBuffer`.
2. Calls `client.convert(base64, page.title, page.section)` on the `VisionClient`
   (or a newly constructed instance when `client` is omitted).
3. Calls `parseVisionResponse(rawResponse)` to extract the structured fields.
4. Calls `validateAndRepair(parsed.markdown, page.id)` to enforce the callout
   convention and apply safe auto-repairs.
5. Constructs an initial `ConvertedPage` with `assetPaths: []` and the validated
   Markdown body.
6. Calls `extractAndWriteAssets(partialPage, renderResult.imageBuffer, assetsDir)` to
   write PNG files for each diagram and resolve `<asset-placeholder>` tokens.
7. Returns the final `ConvertedPage` with `markdown` replaced by the resolved
   version and `assetPaths` populated from the written asset records.

Callers that process multiple pages should create a single `VisionClient` and
pass it to every `convertPage` call so the Anthropic SDK connection is shared.

The `assetsDir` parameter defaults to `process.env.ASSETS_DIR ?? './assets'`.
Passing an explicit value (e.g. a temp directory) is useful in tests to keep
file writes isolated from the working directory.

### ConvertedPage fields set by this stage

| Field | Source |
|-------|--------|
| `pageId` | `page.id` |
| `title`, `section` | `page.title`, `page.section` |
| `lastModified` | `page.lastModifiedDateTime` |
| `contentHash` | `renderResult.contentHash` |
| `markdown` | Resolved Markdown: after `validateAndRepair` and `extractAndWriteAssets` (all `<asset-placeholder>` tokens replaced) |
| `frontmatter` | Object with `page_id`, `title`, `section`, `last_modified`, `source_hash`, `concepts`, `has_diagrams`, `confidence` |
| `diagrams` | `parsed.diagrams` |
| `assetPaths` | Absolute paths of every PNG written by `extractAndWriteAssets` (empty array when no diagrams) |
| `confidence` | `parsed.confidence` |

### Log output

```text
[convert] page <id> — confidence: high, 3 concepts, 1 diagrams
[convert] WARNING: page <id> contains illegible regions    ← only when hasIllegible
```

### Error handling

`VisionError` thrown by `VisionClient` propagates upward to the orchestrator
without wrapping. The orchestrator records a per-page failure in the manifest
and continues to the next page.

---

## Test Fixture

**File:** `tests/fixtures/sample-response.md`

A realistic model output for a graph-theory page covering Eulerian circuits.
It contains:
- `[!definition] Eulerian Circuit` and `[!theorem] Euler's Theorem` callouts
- A `[!proof]` and an `[!example]` callout
- A `[!diagram]` callout with a valid three-vertex JSON adjacency block
- Display math (`$$\sum_{v \in V} \deg(v) = 2|E|$$`)
- An `[UNCERTAIN: ...]` marker
- `<!-- confidence: high -->`

The fixture is loaded directly by `tests/unit/vision-parser.test.ts` to
verify that realistic model output parses correctly end-to-end.

---

## Related Documents

- [Callout Validation](callout-validation.md) — the validation and auto-repair rules applied to the parsed Markdown.
- [Diagram Asset Extraction](diagram-asset-extraction.md) — how `<asset-placeholder>` tokens are resolved and PNG files are written.
- [Frontmatter Generation](frontmatter.md) — how the `frontmatter` object is serialised to YAML for the corpus file.
- [Project Structure](project-structure.md) — full source layout and module roles.
- [Development Setup](development.md) — environment variables and running tests locally.
- [Rendering Strategy](rendering-strategy.md) — how the JPEG buffer fed into this stage is produced.
- [Pipeline Change Detection](pipeline-change-detection.md) — how `contentHash` is used in subsequent runs.
