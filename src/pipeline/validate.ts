/**
 * Callout convention validation and auto-repair for Lemma pipeline output.
 *
 * Vision model output is generally well-formed but may contain minor
 * inconsistencies — an uppercase callout type, an overlong line from a
 * runaway generation — that would silently corrupt downstream consumers
 * (chunking, triple extraction) if left uncorrected.  This module detects
 * and, where safe, repairs those inconsistencies before the page is written
 * to the corpus.
 *
 * Auto-repaired rules:
 *   - Callout type case normalization  ([!Definition] → [!definition])
 *   - Overlong line truncation         (lines > 10 000 chars)
 *
 * Detected-only rules (logged but not repaired):
 *   - Unknown callout types            ([!lemma] etc.)
 *   - Unmatched display-math delimiters (odd number of $$)
 *   - [!diagram] callouts without an image tag
 *   - Unparseable JSON blocks inside [!diagram] callouts
 */

/** The five callout types the vision model is allowed to emit. */
const VALID_CALLOUT_TYPES = new Set(['definition', 'theorem', 'proof', 'example', 'diagram']);

/** Lines longer than this threshold are truncated and flagged. */
const MAX_LINE_LENGTH = 10_000;

/**
 * Regex that matches any [!TYPE] callout header token in Markdown.
 * Captures the type string (everything between [! and ]).
 */
const CALLOUT_TOKEN_RE = /\[!([\w-]+)\]/g;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Result returned by validateAndRepair. */
export interface ValidationResult {
  /** The (possibly repaired) Markdown string. */
  markdown: string;
  /** Human-readable list of problems found, each prefixed with [validate]. */
  issues: string[];
  /** True when at least one automatic repair was applied. */
  repaired: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates and lightly repairs the Markdown string produced by the vision
 * model, enforcing the callout convention required by downstream consumers.
 *
 * Rules applied in order:
 * 1. Truncate lines exceeding 10 000 characters (auto-repair).
 * 2. Normalize callout type case to lowercase (auto-repair).
 * 3. Log unknown callout types (detect-only).
 * 4. Check that display-math $$ delimiters are paired (detect-only).
 * 5. Check that [!diagram] callouts contain an image tag (detect-only).
 * 6. Check that JSON fences inside [!diagram] callouts are parseable (detect-only).
 *
 * @param raw    - Raw Markdown string, typically from parseVisionResponse.
 * @param pageId - Page identifier, included in every issue message for traceability.
 * @returns ValidationResult with the processed markdown, issue list, and repaired flag.
 */
export function validateAndRepair(raw: string, pageId: string): ValidationResult {
  const issues: string[] = [];
  let repaired = false;

  // ─── Rule 1: Truncate overlong lines ──────────────────────────────────────
  let markdown = raw
    .split('\n')
    .map((line) => {
      if (line.length > MAX_LINE_LENGTH) {
        issues.push(
          `[validate] page ${pageId}: line truncated ` +
            `(${line.length} chars exceeds limit of ${MAX_LINE_LENGTH})`,
        );
        repaired = true;
        return line.slice(0, MAX_LINE_LENGTH) + '[TRUNCATED]';
      }
      return line;
    })
    .join('\n');

  // ─── Rules 2 & 3: Normalize callout types ─────────────────────────────────
  // The regex is re-created on each call because CALLOUT_TOKEN_RE has the 'g'
  // flag; resetting lastIndex or using a fresh instance is safer in practice.
  markdown = markdown.replace(/\[!([\w-]+)\]/g, (match, type: string) => {
    const lower = type.toLowerCase();
    if (VALID_CALLOUT_TYPES.has(lower)) {
      if (type !== lower) {
        repaired = true;
      }
      return `[!${lower}]`;
    }
    // Unknown type: record issue, leave token unchanged.
    issues.push(
      `[validate] page ${pageId}: unknown callout type [!${type}] — ` +
        `valid types are: ${[...VALID_CALLOUT_TYPES].join(', ')}`,
    );
    return match;
  });

  // ─── Rule 4: Display-math delimiter pairing ───────────────────────────────
  const ddCount = (markdown.match(/\$\$/g) ?? []).length;
  if (ddCount % 2 !== 0) {
    issues.push(
      `[validate] page ${pageId}: unmatched display-math delimiters — ` +
        `found ${ddCount} \`$$\` occurrence${ddCount === 1 ? '' : 's'} (expected an even number)`,
    );
  }

  // ─── Rules 5 & 6: Diagram callout structural checks ──────────────────────
  const diagramIssues = checkDiagramBlocks(markdown, pageId);
  issues.push(...diagramIssues);

  return { markdown, issues, repaired };
}

// ---------------------------------------------------------------------------
// Diagram block checker (internal)
// ---------------------------------------------------------------------------

/**
 * Walks the Markdown string line-by-line to locate every [!diagram] callout
 * block and verify structural invariants.
 *
 * For each [!diagram] block the function checks:
 * - Rule 5: the block body contains at least one image tag `![`.
 * - Rule 6: every ```json fence inside the block is parseable by JSON.parse.
 *
 * Uses the same blockquote state-machine conventions as the vision response
 * parser: a non-blockquote, non-blank line exits the current callout block.
 *
 * @param markdown - Post-normalization Markdown string (callout types lowercased).
 * @param pageId   - Page identifier for issue message traceability.
 * @returns Array of issue strings; empty when no structural problems are found.
 */
function checkDiagramBlocks(markdown: string, pageId: string): string[] {
  const issues: string[] = [];
  const lines = markdown.split('\n');

  let inDiagram = false;
  /** Non-JSON body lines within the current [!diagram] block. */
  let bodyLines: string[] = [];
  let inJson = false;
  /** Lines accumulated inside the current ```json fence. */
  let jsonAcc: string[] = [];

  /**
   * Validates and closes the current [!diagram] block.
   * Resets all tracking state after running checks.
   */
  const endDiagram = (): void => {
    if (!inDiagram) return;

    // Rule 5: must contain at least one image tag.
    if (!bodyLines.join('\n').includes('![')) {
      issues.push(
        `[validate] page ${pageId}: [!diagram] callout is missing an image tag (expected ![...)`,
      );
    }

    // Rule 6: an open JSON fence at block end is unterminated — still check it.
    if (inJson && jsonAcc.length > 0) {
      checkJsonParseable(jsonAcc.join('\n'), pageId, issues);
    }

    inDiagram = false;
    bodyLines = [];
    inJson = false;
    jsonAcc = [];
  };

  for (const line of lines) {
    // Non-blockquote, non-blank lines exit any active callout.
    if (!line.startsWith('>') && line.trim() !== '') {
      endDiagram();
      continue;
    }

    // Blank lines do not break blockquotes in GFM; preserve current state.
    if (line.trim() === '') continue;

    const inner = line.replace(/^>\s?/, '');
    const innerTrimmed = inner.trim();

    // Detect a new callout header.
    const calloutMatch = /^\[!([\w-]+)\]/i.exec(innerTrimmed);
    if (calloutMatch) {
      endDiagram(); // flush + validate the previous diagram (if any)
      if (calloutMatch[1].toLowerCase() === 'diagram') {
        inDiagram = true;
        bodyLines = [];
        inJson = false;
        jsonAcc = [];
      }
      continue;
    }

    if (!inDiagram) continue;

    if (!inJson) {
      if (innerTrimmed === '```json') {
        inJson = true;
        jsonAcc = [];
      } else {
        bodyLines.push(inner);
      }
    } else {
      if (innerTrimmed === '```') {
        // Closing fence: validate the accumulated JSON and return to diagram body.
        checkJsonParseable(jsonAcc.join('\n'), pageId, issues);
        inJson = false;
        jsonAcc = [];
      } else {
        jsonAcc.push(inner);
      }
    }
  }

  // End of input: flush any open diagram block.
  endDiagram();

  return issues;
}

/**
 * Attempts JSON.parse on a string and appends a descriptive issue if it fails.
 *
 * @param jsonStr - The raw string to parse.
 * @param pageId  - Page identifier for the issue message.
 * @param issues  - Mutable array to push into on parse failure.
 */
function checkJsonParseable(jsonStr: string, pageId: string, issues: string[]): void {
  try {
    JSON.parse(jsonStr);
  } catch {
    issues.push(
      `[validate] page ${pageId}: JSON block in [!diagram] callout is not parseable`,
    );
  }
}
