# Callout Convention Validation & Auto-Repair

This document describes how the Lemma pipeline validates the Markdown produced
by the vision model and lightly repairs common inconsistencies before the page
is written to the corpus.

---

## Motivation

Downstream consumers — chunking, triple extraction, search indexing — parse the
callout structure assuming it is perfectly well-formed.  A single incorrect
callout type or an unbalanced `$$` delimiter can silently corrupt an entire
page's semantic extraction.  Validating and fixing problems at the source is
far cheaper than diagnosing corrupt downstream artefacts.

The validation stage sits between the vision parser and the file write stage:

```text
parseVisionResponse()
  │
  ▼  raw parsed markdown
  │
  ▼
validateAndRepair()          ← src/pipeline/validate.ts
  │
  ▼  validated (possibly repaired) markdown
  │
  ▼
writePage()                  ← corpus .md file
```

`validateAndRepair` is called inside `convertPage` immediately after
`parseVisionResponse` returns.

---

## Valid Callout Types

Exactly five callout types are valid.  Any other type is an error.

| Type | Example header |
|------|---------------|
| `definition` | `> [!definition] Eulerian Circuit` |
| `theorem` | `> [!theorem] Euler's Theorem` |
| `proof` | `> [!proof]` |
| `example` | `> [!example] K₃` |
| `diagram` | `> [!diagram] Complete Graph` |

---

## Validation Rules

The six rules are applied in order within a single pass over the raw markdown
string.  Rules are classified as either **auto-repair** (the markdown is
modified) or **detect-only** (the issue is recorded but the markdown is left
unchanged).

### Rule 1 — Overlong Line Truncation (auto-repair)

Any line exceeding **10 000 characters** is truncated to that limit and the
string `[TRUNCATED]` is appended.  This guards against runaway model output
that would make the resulting file unwieldy or trigger downstream parser limits.

```text
Before: aaaa...aaaa (12 000 chars)
After:  aaaa...aaaa (10 000 chars) [TRUNCATED]
```

An issue entry is added for each truncated line.

### Rule 2 — Callout Type Case Normalization (auto-repair)

Callout types are matched case-insensitively and normalized to lowercase:

```text
> [!Definition] Title   →   > [!definition] Title   (repaired)
> [!PROOF]              →   > [!proof]              (repaired)
> [!theorem] Title      →   > [!theorem] Title      (unchanged)
```

The `repaired` flag is set to `true` when at least one token was changed.

### Rule 3 — Unknown Callout Type Detection (detect-only)

Any `[!TYPE]` token where `TYPE` is not in the five-element valid set is
recorded as an issue.  The token is left in the markdown unchanged.

```text
> [!lemma] Lemma 1     →   issue: "unknown callout type [!lemma]"
```

Setting `repaired` to `true` for unknown types is explicitly avoided: the
correct handling of unknown types (skip, re-label, remove) requires human
judgement and is not safe to automate.

### Rule 4 — Display-Math Delimiter Pairing (detect-only)

Display-math blocks use the `$$...$$` syntax.  Each opening `$$` must be
paired with a closing `$$`, so the total count of `$$` occurrences in the
document must be **even**.  An odd count indicates at least one unclosed block.

```text
"$$a + b$$ and $$c + d"   →   issue: 3 $$ occurrences (odd)
"$$a + b$$ and $$c + d$$" →   no issue (4 occurrences)
```

### Rule 5 — Diagram Image Tag Presence (detect-only)

Every `[!diagram]` callout block must contain at least one image tag (`![`).
The image tag references the diagram asset that is later extracted to the
`assets/` directory.

```text
> [!diagram] My Graph
> Some text without an image tag.     →   issue: missing image tag
```

```text
> [!diagram] My Graph
> ![fig](./assets/page-abc-fig0.png)  →   no issue
```

### Rule 6 — Diagram JSON Parseability (detect-only)

Every ` ```json ` fence inside a `[!diagram]` callout must contain valid JSON
(parseable by `JSON.parse`).  A fence that fails to parse is recorded as an
issue; the fence is left in the markdown unchanged.

```text
> ```json
> { "type": "undirected", "vertices": [INVALID }
> ```
→ issue: JSON block in [!diagram] callout is not parseable
```

---

## ValidationResult

`validateAndRepair` returns a `ValidationResult` object:

```typescript
interface ValidationResult {
  markdown: string;   // the (possibly repaired) markdown
  issues: string[];   // human-readable problem list, each prefixed [validate]
  repaired: boolean;  // true when any auto-repair was applied
}
```

Every string in `issues` contains the `pageId` argument so log lines are
traceable back to the specific page that produced them.

---

## Integration in convertPage

`convertPage` calls `validateAndRepair` after parsing and uses the
`validated.markdown` field (not the raw parsed markdown) in the returned
`ConvertedPage`.

```typescript
const validated = validateAndRepair(parsed.markdown, page.id);

if (validated.repaired) {
  console.log(`[convert] page ${page.id}: markdown auto-repaired`);
}
for (const issue of validated.issues) {
  console.warn(issue);   // detect-only issues go to stderr
}

return { ..., markdown: validated.markdown, ... };
```

Log output on a page with a capitalized callout type:

```text
[convert] page page-abc: markdown auto-repaired (1 issue)
[validate] page page-abc: unknown callout type [!lemma] — valid types are: ...
[convert] page page-abc — confidence: high, 2 concepts, 1 diagrams
```

---

## Test Coverage

**File:** `tests/unit/validate.test.ts` — 35 tests

| Group | Tests |
|-------|-------|
| Callout type normalization | 7 — all five types, all-caps, unchanged lowercase, multiple |
| Unknown callout detection | 4 — issue content, no repair, repaired=false, multiple types |
| Display-math pairing | 5 — odd/even counts, zero, one, four |
| Diagram image tag | 3 — missing, present, multiple diagrams |
| Diagram JSON parseability | 3 — invalid, valid, multiple invalid blocks |
| Overlong line truncation | 4 — truncation length, at-limit, single, multiple lines |
| repaired flag accuracy | 4 — repair cases, detect-only cases |
| Issues array | 3 — empty for valid input, pageId in every message, accumulation |
| Markdown preservation | 2 — verbatim return, surrounding text unchanged |

---

## Related Documents

- [Vision Conversion](vision-conversion.md) — how the raw markdown being validated is produced.
- [Frontmatter Generation](frontmatter.md) — the next step after validation.
- [Project Structure](project-structure.md) — source file layout.
