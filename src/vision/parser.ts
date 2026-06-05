/**
 * Structured response parser for the vision LLM output.
 *
 * The vision model returns a single Markdown string that embeds:
 *   - Typed callout blocks (definition, theorem, proof, example, diagram)
 *   - Inline and display LaTeX math
 *   - Adjacency JSON inside [!diagram] callouts
 *   - A trailing HTML comment declaring transcription confidence
 *   - Optional uncertainty markers ([UNCERTAIN: ...]) and illegibility markers ([ILLEGIBLE])
 *
 * This module extracts all structured data from that raw string without
 * modifying the Markdown content, except to strip the confidence comment
 * (which is metadata, not body prose).
 *
 * All parsing is defensive: malformed or missing sections produce warnings
 * and degrade gracefully rather than throwing.
 */

import type { DiagramData } from '../types.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * All structured data extracted from a single raw vision model response.
 */
export interface ParsedVisionResponse {
  /** Full Markdown body with the confidence comment stripped. */
  markdown: string;
  /** Titles extracted from [!definition] and [!theorem] callout headers, trimmed. */
  concepts: string[];
  /** Parsed adjacency data from valid JSON blocks inside [!diagram] callouts. */
  diagrams: DiagramData[];
  /** True when the response contains at least one [UNCERTAIN: ...] marker. */
  hasUncertain: boolean;
  /** True when the response contains at least one [ILLEGIBLE] marker. */
  hasIllegible: boolean;
  /** Confidence level declared by the model at the end of the response. */
  confidence: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Confidence extraction
// ---------------------------------------------------------------------------

/** Regex matching the HTML confidence comment the model is instructed to append. */
const CONFIDENCE_COMMENT_RE = /<!--\s*confidence:\s*(high|medium|low)\s*-->/i;

/**
 * Extracts the confidence level from the raw response string.
 * Returns 'medium' as a safe default when the comment is absent or malformed.
 *
 * @param raw - Full raw model response string.
 * @returns Parsed confidence level.
 */
function extractConfidence(raw: string): 'high' | 'medium' | 'low' {
  const match = CONFIDENCE_COMMENT_RE.exec(raw);
  if (!match) return 'medium';
  const level = match[1].toLowerCase();
  if (level === 'high' || level === 'medium' || level === 'low') return level;
  return 'medium';
}

/**
 * Returns the raw string with the confidence HTML comment removed.
 * Also trims any trailing whitespace left after removal.
 *
 * @param raw - Full raw model response string.
 * @returns String without the confidence comment.
 */
function stripConfidenceComment(raw: string): string {
  return raw.replace(CONFIDENCE_COMMENT_RE, '').trimEnd();
}

// ---------------------------------------------------------------------------
// Concept extraction
// ---------------------------------------------------------------------------

/** Matches the opening line of a [!definition] or [!theorem] callout, capturing the title. */
const CONCEPT_CALLOUT_RE = /^>\s*\[!(definition|theorem)\]\s+(.+)$/gim;

/**
 * Extracts concept titles from [!definition] and [!theorem] callout headers.
 * Titles are trimmed but otherwise returned verbatim.
 *
 * @param raw - Raw or stripped Markdown string.
 * @returns Array of unique concept title strings.
 */
function extractConcepts(raw: string): string[] {
  const titles: string[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex because we're using the same regex object
  CONCEPT_CALLOUT_RE.lastIndex = 0;

  while ((match = CONCEPT_CALLOUT_RE.exec(raw)) !== null) {
    const title = match[2].trim();
    if (title) titles.push(title);
  }

  return titles;
}

// ---------------------------------------------------------------------------
// Diagram JSON extraction
// ---------------------------------------------------------------------------

/**
 * Walks the Markdown line-by-line to locate [!diagram] callout blocks and
 * extract the JSON adjacency object embedded in each.
 *
 * State machine:
 *   idle → inDiagramCallout (on > [!diagram] line)
 *        → inJsonBlock (on > ```json line inside a diagram callout)
 *   inJsonBlock → capture JSON lines (each stripped of leading '> ')
 *              → attempt parse on closing > ``` line
 *
 * A line that does not start with '>' ends the current callout block and
 * resets the state machine.
 *
 * @param raw      - Raw Markdown string (confidence comment may be present or stripped).
 * @param warnings - Array that receives a human-readable message for every
 *                   skipped malformed block (mutated in place).
 * @returns Array of successfully parsed DiagramData objects.
 */
function extractDiagrams(raw: string, warnings: string[]): DiagramData[] {
  const diagrams: DiagramData[] = [];
  const lines = raw.split('\n');

  let inDiagramCallout = false;
  let inJsonBlock = false;
  let jsonLines: string[] = [];

  const flushJsonBlock = (): void => {
    if (!inJsonBlock || jsonLines.length === 0) {
      inJsonBlock = false;
      jsonLines = [];
      return;
    }

    const jsonStr = jsonLines.join('\n');
    inJsonBlock = false;
    jsonLines = [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`[parser] invalid JSON in [!diagram] callout: ${msg}`);
      return;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('type' in parsed) ||
      !('vertices' in parsed) ||
      !('edges' in parsed)
    ) {
      warnings.push(
        '[parser] [!diagram] JSON block is missing required fields (type, vertices, edges)',
      );
      return;
    }

    const p = parsed as Record<string, unknown>;

    const VALID_TYPES = ['undirected', 'directed', 'weighted'];
    if (!VALID_TYPES.includes(p.type as string)) {
      warnings.push(
        `[parser] [!diagram] JSON block has invalid schema: "type" must be one of ` +
          `${VALID_TYPES.join(', ')} (got ${String(p.type)})`,
      );
      return;
    }

    if (!Array.isArray(p.vertices) || !(p.vertices as unknown[]).every((v) => typeof v === 'string')) {
      warnings.push(
        '[parser] [!diagram] JSON block has invalid schema: "vertices" must be a string[]',
      );
      return;
    }

    const isValidEdge = (e: unknown): boolean =>
      Array.isArray(e) &&
      e.length >= 2 &&
      typeof e[0] === 'string' &&
      typeof e[1] === 'string' &&
      (e.length === 2 || typeof e[2] === 'number');

    if (!Array.isArray(p.edges) || !(p.edges as unknown[]).every(isValidEdge)) {
      warnings.push(
        '[parser] [!diagram] JSON block has invalid schema: "edges" must be [string, string] or [string, string, number] pairs',
      );
      return;
    }

    diagrams.push(parsed as DiagramData);
  };

  for (const line of lines) {
    // A line not starting with '>' ends any active callout block.
    if (!line.startsWith('>') && line.trim() !== '') {
      flushJsonBlock();
      inDiagramCallout = false;
      inJsonBlock = false;
      jsonLines = [];
      continue;
    }

    // Blank lines can appear between callout paragraphs — they do not end a
    // callout in GFM, but our diagram blocks are expected to be contiguous.
    // Keep the current state across bare blank lines.
    if (line.trim() === '') {
      continue;
    }

    // Strip leading '> ' (or '>' with no space) to get the inner content.
    const inner = line.replace(/^>\s?/, '');

    if (!inDiagramCallout) {
      if (/^\[!diagram\]/i.test(inner.trim())) {
        inDiagramCallout = true;
        inJsonBlock = false;
        jsonLines = [];
      }
      continue;
    }

    // We are inside a [!diagram] callout.
    if (!inJsonBlock) {
      if (inner.trim() === '```json') {
        inJsonBlock = true;
        jsonLines = [];
      }
    } else {
      if (inner.trim() === '```') {
        flushJsonBlock();
      } else {
        jsonLines.push(inner);
      }
    }
  }

  // At end of input: an open JSON fence is malformed — warn and skip.
  if (inJsonBlock) {
    const snippet = jsonLines.slice(0, 3).join('\\n');
    warnings.push(
      `[parser] unterminated JSON fence in [!diagram] callout at end of input ` +
        `(${jsonLines.length} lines buffered): ${snippet}`,
    );
  }
  // If not in a JSON block, all properly-closed fences were already flushed
  // when their closing ``` line was processed; nothing more to do.

  return diagrams;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a raw vision model response string into all structured fields needed
 * by the convert stage.
 *
 * The function is pure and referentially transparent: the same input always
 * produces the same output. All side effects are captured in the `warnings`
 * array on the returned object (no console output).
 *
 * @param raw - The complete string returned by the vision model API.
 * @returns ParsedVisionResponse with all structured fields populated.
 */
export function parseVisionResponse(raw: string): ParsedVisionResponse {
  const confidence = extractConfidence(raw);
  const markdown = stripConfidenceComment(raw);
  const concepts = extractConcepts(markdown);
  const warnings: string[] = [];
  const diagrams = extractDiagrams(markdown, warnings);

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.warn(w);
    }
  }

  return {
    markdown,
    concepts,
    diagrams,
    hasUncertain: raw.includes('[UNCERTAIN:'),
    hasIllegible: raw.includes('[ILLEGIBLE]'),
    confidence,
  };
}
