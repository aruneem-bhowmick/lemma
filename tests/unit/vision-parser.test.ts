/**
 * Unit tests for src/vision/parser.ts.
 *
 * All tests operate on in-memory strings; no network or file-system access
 * is required. The sample-response.md fixture is loaded from disk once at
 * module load time and used in several tests that need a realistic input.
 *
 * Coverage:
 *   - confidence extraction (high, medium, low, missing → default)
 *   - concept title extraction (definition, theorem)
 *   - diagram JSON parsing (valid, malformed, absent)
 *   - hasUncertain / hasIllegible flags
 *   - confidence comment stripped from markdown field
 *   - graceful handling of empty or minimal input
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseVisionResponse } from '../../src/vision/parser.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Loads the sample-response.md fixture used for realistic-input tests.
 * Path is relative to this test file.
 */
const SAMPLE_RESPONSE = readFileSync(
  join(__dirname, '..', 'fixtures', 'sample-response.md'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Confidence extraction
// ---------------------------------------------------------------------------

describe('parseVisionResponse — confidence', () => {
  it('extracts confidence: high from the trailing comment', () => {
    const result = parseVisionResponse('Some content.\n<!-- confidence: high -->');
    expect(result.confidence).toBe('high');
  });

  it('extracts confidence: low from the trailing comment', () => {
    const result = parseVisionResponse('Some content.\n<!-- confidence: low -->');
    expect(result.confidence).toBe('low');
  });

  it('extracts confidence: medium from the trailing comment', () => {
    const result = parseVisionResponse('Some content.\n<!-- confidence: medium -->');
    expect(result.confidence).toBe('medium');
  });

  it('defaults to medium when confidence comment is absent', () => {
    const result = parseVisionResponse('Some content with no confidence comment.');
    expect(result.confidence).toBe('medium');
  });

  it('is case-insensitive for the confidence level', () => {
    const result = parseVisionResponse('Content.\n<!-- confidence: HIGH -->');
    expect(result.confidence).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Markdown stripping
// ---------------------------------------------------------------------------

describe('parseVisionResponse — markdown field', () => {
  it('strips the confidence comment from the returned markdown', () => {
    const result = parseVisionResponse('Body text.\n<!-- confidence: high -->');
    expect(result.markdown).not.toContain('<!-- confidence:');
  });

  it('preserves all non-comment body content in the markdown field', () => {
    const body = '> [!definition] Test\n> Some definition text.';
    const result = parseVisionResponse(`${body}\n<!-- confidence: medium -->`);
    expect(result.markdown).toContain('> [!definition] Test');
    expect(result.markdown).toContain('Some definition text.');
  });

  it('handles input without a confidence comment gracefully', () => {
    const result = parseVisionResponse('Plain markdown content.');
    expect(result.markdown).toBe('Plain markdown content.');
  });
});

// ---------------------------------------------------------------------------
// Concept extraction
// ---------------------------------------------------------------------------

describe('parseVisionResponse — concepts', () => {
  it('extracts the title from a [!definition] callout header', () => {
    const input = '> [!definition] Eulerian Circuit\n> Body text.\n<!-- confidence: high -->';
    const result = parseVisionResponse(input);
    expect(result.concepts).toContain('Eulerian Circuit');
  });

  it("extracts the title from a [!theorem] callout header", () => {
    const input = "> [!theorem] Euler's Theorem\n> Body.\n<!-- confidence: high -->";
    const result = parseVisionResponse(input);
    expect(result.concepts).toContain("Euler's Theorem");
  });

  it('extracts concepts from multiple callouts in order', () => {
    const input =
      '> [!definition] Graph\n> d1.\n\n' +
      '> [!theorem] Handshaking Lemma\n> t1.\n\n' +
      '<!-- confidence: medium -->';
    const result = parseVisionResponse(input);
    expect(result.concepts).toEqual(['Graph', 'Handshaking Lemma']);
  });

  it('does not extract titles from [!proof], [!example], or [!diagram] callouts', () => {
    const input =
      '> [!proof]\n> Proof body.\n\n' +
      '> [!example] Example Title\n> Example body.\n\n' +
      '<!-- confidence: high -->';
    const result = parseVisionResponse(input);
    expect(result.concepts).toHaveLength(0);
  });

  it('returns an empty array when no concept callouts are present', () => {
    const result = parseVisionResponse('Plain prose.\n<!-- confidence: high -->');
    expect(result.concepts).toEqual([]);
  });

  it('extracts concepts from the realistic sample fixture', () => {
    const result = parseVisionResponse(SAMPLE_RESPONSE);
    expect(result.concepts).toContain('Eulerian Circuit');
    expect(result.concepts).toContain("Euler's Theorem");
  });
});

// ---------------------------------------------------------------------------
// Diagram JSON extraction
// ---------------------------------------------------------------------------

describe('parseVisionResponse — diagrams', () => {
  it('parses a valid diagram adjacency JSON block', () => {
    const input =
      '> [!diagram] Test Graph\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": ["A", "B"], "edges": [["A", "B"]], "caption": "Test Graph" }\n' +
      '> ```\n' +
      '<!-- confidence: high -->';

    const result = parseVisionResponse(input);
    expect(result.diagrams).toHaveLength(1);
    expect(result.diagrams[0].type).toBe('undirected');
    expect(result.diagrams[0].vertices).toEqual(['A', 'B']);
    expect(result.diagrams[0].edges).toEqual([['A', 'B']]);
  });

  it('parses a multi-line JSON block correctly', () => {
    const input =
      '> [!diagram] K3\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected",\n' +
      '>   "vertices": ["A", "B", "C"],\n' +
      '>   "edges": [["A","B"],["B","C"],["A","C"]],\n' +
      '>   "caption": "K3" }\n' +
      '> ```\n' +
      '<!-- confidence: high -->';

    const result = parseVisionResponse(input);
    expect(result.diagrams).toHaveLength(1);
    expect(result.diagrams[0].vertices).toHaveLength(3);
  });

  it('parses the diagram from the realistic sample fixture', () => {
    const result = parseVisionResponse(SAMPLE_RESPONSE);
    expect(result.diagrams).toHaveLength(1);
    expect(result.diagrams[0].caption).toBe('Example: $K_3$ Eulerian circuit');
  });

  it('skips and warns on malformed diagram JSON', () => {
    const input =
      '> [!diagram] Bad Graph\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": [INVALID JSON }\n' +
      '> ```\n' +
      '<!-- confidence: medium -->';

    const result = parseVisionResponse(input);
    expect(result.diagrams).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/invalid JSON/i));
  });

  it('skips and warns on a JSON block missing required fields', () => {
    const input =
      '> [!diagram] Incomplete\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "caption": "only caption, no type/vertices/edges" }\n' +
      '> ```\n' +
      '<!-- confidence: medium -->';

    const result = parseVisionResponse(input);
    expect(result.diagrams).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/required fields/i));
  });

  it('returns an empty array when no [!diagram] callouts are present', () => {
    const input = '> [!definition] Vertex\n> A node in a graph.\n<!-- confidence: high -->';
    const result = parseVisionResponse(input);
    expect(result.diagrams).toEqual([]);
  });

  it('parses multiple diagram blocks in one response', () => {
    const block = (label: string): string =>
      `> [!diagram] ${label}\n` +
      `> ![fig](./assets/<asset-placeholder>.png)\n` +
      `> \`\`\`json\n` +
      `> { "type": "undirected", "vertices": ["X"], "edges": [], "caption": "${label}" }\n` +
      `> \`\`\`\n`;

    const input = block('First') + '\n' + block('Second') + '\n<!-- confidence: high -->';
    const result = parseVisionResponse(input);
    expect(result.diagrams).toHaveLength(2);
  });

  it('skips and warns when diagram JSON has an invalid type value', () => {
    const input =
      '> [!diagram] Bad Type\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "hypergraph", "vertices": ["A"], "edges": [], "caption": "Bad" }\n' +
      '> ```\n' +
      '<!-- confidence: medium -->';

    const result = parseVisionResponse(input);
    expect(result.diagrams).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/invalid schema.*type/i));
  });

  it('skips and warns when diagram JSON has malformed edges', () => {
    const input =
      '> [!diagram] Bad Edges\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": ["A", "B"], "edges": "not-an-array", "caption": "Bad" }\n' +
      '> ```\n' +
      '<!-- confidence: medium -->';

    const result = parseVisionResponse(input);
    expect(result.diagrams).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/invalid schema.*edges/i));
  });

  it('skips and warns on an unterminated JSON fence at end of input', () => {
    const input =
      '> [!diagram] Unterminated\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": ["A"],\n';

    const result = parseVisionResponse(input);
    expect(result.diagrams).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/unterminated/i));
  });
});

// ---------------------------------------------------------------------------
// hasUncertain / hasIllegible
// ---------------------------------------------------------------------------

describe('parseVisionResponse — uncertainty and illegibility flags', () => {
  it('sets hasUncertain to true when the response contains [UNCERTAIN:', () => {
    const result = parseVisionResponse(
      'Some text [UNCERTAIN: symbol is unclear].\n<!-- confidence: medium -->',
    );
    expect(result.hasUncertain).toBe(true);
  });

  it('sets hasUncertain to false when no [UNCERTAIN: marker is present', () => {
    const result = parseVisionResponse('Clear text.\n<!-- confidence: high -->');
    expect(result.hasUncertain).toBe(false);
  });

  it('sets hasIllegible to true when the response contains [ILLEGIBLE]', () => {
    const result = parseVisionResponse('[ILLEGIBLE] some content.\n<!-- confidence: low -->');
    expect(result.hasIllegible).toBe(true);
  });

  it('sets hasIllegible to false when no [ILLEGIBLE] marker is present', () => {
    const result = parseVisionResponse('Legible content.\n<!-- confidence: high -->');
    expect(result.hasIllegible).toBe(false);
  });

  it('correctly detects both flags in the sample fixture', () => {
    const result = parseVisionResponse(SAMPLE_RESPONSE);
    expect(result.hasUncertain).toBe(true);
    expect(result.hasIllegible).toBe(false);
  });
});
