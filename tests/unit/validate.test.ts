/**
 * Unit tests for src/pipeline/validate.ts.
 *
 * All tests work on in-memory strings; no file-system or network access is
 * required.  Tests are grouped by the validation rule they cover so it is
 * easy to map a failing test to the relevant rule in validate.ts.
 *
 * Rules under test:
 *   1. Callout type normalization (auto-repair)
 *   2. Unknown callout type detection
 *   3. Display-math delimiter pairing
 *   4. [!diagram] callout image-tag presence
 *   5. [!diagram] JSON block parseability
 *   6. Overlong line truncation (auto-repair)
 *   7. repaired / !repaired flag accuracy
 */

import { vi, describe, it, expect, afterEach } from 'vitest';
import { validateAndRepair } from '../../src/pipeline/validate.js';

const PAGE_ID = 'page-validate-test-01';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Rule 1: Callout type case normalization (auto-repair)
// ---------------------------------------------------------------------------

describe('validateAndRepair — callout type normalization', () => {
  it('normalizes [!Definition] to [!definition] in the output markdown', () => {
    const input = '> [!Definition] Some Title\n> Body text.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toContain('[!definition]');
    expect(result.markdown).not.toContain('[!Definition]');
  });

  it('normalizes [!Theorem] to [!theorem] in the output markdown', () => {
    const input = '> [!Theorem] Some Title\n> Body text.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toContain('[!theorem]');
    expect(result.markdown).not.toContain('[!Theorem]');
  });

  it('normalizes [!PROOF] (all-caps) to [!proof]', () => {
    const input = '> [!PROOF]\n> This is a proof.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toContain('[!proof]');
    expect(result.markdown).not.toContain('[!PROOF]');
  });

  it('normalizes [!Example] to [!example]', () => {
    const input = '> [!Example] Title\n> Body.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toContain('[!example]');
  });

  it('normalizes [!Diagram] to [!diagram]', () => {
    const input =
      '> [!Diagram] Caption\n' +
      '> ![fig](./assets/placeholder.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": ["A"], "edges": [], "caption": "C" }\n' +
      '> ```';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toContain('[!diagram]');
    expect(result.markdown).not.toContain('[!Diagram]');
  });

  it('leaves already-lowercase callout types unchanged', () => {
    const input = '> [!definition] Title\n> Body.';
    const before = input;
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toBe(before);
  });

  it('normalizes multiple callout types in a single response', () => {
    const input =
      '> [!Definition] First\n> d1.\n\n> [!Theorem] Second\n> t1.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toContain('[!definition]');
    expect(result.markdown).toContain('[!theorem]');
  });
});

// ---------------------------------------------------------------------------
// Rule 2: Unknown callout type detection
// ---------------------------------------------------------------------------

describe('validateAndRepair — unknown callout types', () => {
  it('adds an issue mentioning the unknown type name when [!lemma] is found', () => {
    const input = '> [!lemma] Some Lemma\n> Body.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.issues.some((s) => s.includes('lemma'))).toBe(true);
  });

  it('does not repair the unknown callout type — leaves it in the markdown', () => {
    const input = '> [!lemma] Some Lemma\n> Body.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toContain('[!lemma]');
  });

  it('does not set repaired=true for unknown types (detect-only)', () => {
    const input = '> [!lemma] Some Lemma\n> Body.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.repaired).toBe(false);
  });

  it('logs an issue for each distinct unknown type in the response', () => {
    const input = '> [!lemma] L\n> B.\n\n> [!corollary] C\n> B.';
    const result = validateAndRepair(input, PAGE_ID);
    const hasLemma = result.issues.some((s) => s.includes('lemma'));
    const hasCorollary = result.issues.some((s) => s.includes('corollary'));
    expect(hasLemma).toBe(true);
    expect(hasCorollary).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: Display-math $$ delimiter pairing
// ---------------------------------------------------------------------------

describe('validateAndRepair — display-math delimiter pairing', () => {
  it('adds an issue when there are three $$ occurrences (odd count)', () => {
    // Three $$ → one display-math block opened but never closed
    const input = 'Some text. $$a + b$$ and then $$c + d without closing.';
    const result = validateAndRepair(input, PAGE_ID);
    const hasIssue = result.issues.some(
      (s) => s.includes('$$') || s.toLowerCase().includes('math'),
    );
    expect(hasIssue).toBe(true);
  });

  it('adds no issue when $$ count is zero', () => {
    const input = 'No display math here.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.issues.length).toBe(0);
  });

  it('adds no issue when $$ count is two (one complete block)', () => {
    const input = 'Text $$x = y$$ text.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.issues.length).toBe(0);
  });

  it('adds no issue when $$ count is four (two complete blocks)', () => {
    const input = 'First $$a$$ and second $$b$$.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.issues.length).toBe(0);
  });

  it('adds one issue when $$ count is one (single unpaired delimiter)', () => {
    const input = 'Only one $$ delimiter.';
    const result = validateAndRepair(input, PAGE_ID);
    const hasIssue = result.issues.some(
      (s) => s.includes('$$') || s.toLowerCase().includes('math'),
    );
    expect(hasIssue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: [!diagram] callout image-tag presence
// ---------------------------------------------------------------------------

describe('validateAndRepair — diagram callout image tag', () => {
  it('adds an issue when a [!diagram] callout has no image tag', () => {
    const input = '> [!diagram] My Graph\n> Some descriptive text without an image tag.';
    const result = validateAndRepair(input, PAGE_ID);
    const hasIssue = result.issues.some(
      (s) => s.toLowerCase().includes('image') || s.includes('!['),
    );
    expect(hasIssue).toBe(true);
  });

  it('adds no issue when the [!diagram] callout contains an image tag', () => {
    const input =
      '> [!diagram] My Graph\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": ["A"], "edges": [], "caption": "My Graph" }\n' +
      '> ```';
    const result = validateAndRepair(input, PAGE_ID);
    const diagramIssues = result.issues.filter(
      (s) => s.toLowerCase().includes('image') || s.includes('!['),
    );
    expect(diagramIssues.length).toBe(0);
  });

  it('adds an issue for each [!diagram] callout missing an image tag', () => {
    const input =
      '> [!diagram] First\n> No image here.\n\n' +
      '> [!diagram] Second\n> Also no image here.';
    const result = validateAndRepair(input, PAGE_ID);
    const imageIssues = result.issues.filter(
      (s) => s.toLowerCase().includes('image') || s.includes('!['),
    );
    expect(imageIssues.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: JSON block parseability inside [!diagram] callouts
// ---------------------------------------------------------------------------

describe('validateAndRepair — diagram JSON parseability', () => {
  it('adds an issue when the JSON block inside [!diagram] is invalid', () => {
    const input =
      '> [!diagram] Bad Graph\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": [INVALID }\n' +
      '> ```';
    const result = validateAndRepair(input, PAGE_ID);
    const hasJsonIssue = result.issues.some(
      (s) => s.toLowerCase().includes('json') || s.toLowerCase().includes('parseable'),
    );
    expect(hasJsonIssue).toBe(true);
  });

  it('adds no issue when the JSON block is valid', () => {
    const input =
      '> [!diagram] Good Graph\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": ["A", "B"], "edges": [["A","B"]], "caption": "G" }\n' +
      '> ```';
    const result = validateAndRepair(input, PAGE_ID);
    const jsonIssues = result.issues.filter(
      (s) => s.toLowerCase().includes('json') || s.toLowerCase().includes('parseable'),
    );
    expect(jsonIssues.length).toBe(0);
  });

  it('adds an issue for each unparseable JSON block across multiple diagrams', () => {
    const badJson = (label: string): string =>
      `> [!diagram] ${label}\n` +
      `> ![fig](./assets/placeholder.png)\n` +
      `> \`\`\`json\n` +
      `> { INVALID\n` +
      `> \`\`\`\n`;

    const input = badJson('First') + '\n' + badJson('Second');
    const result = validateAndRepair(input, PAGE_ID);
    const jsonIssues = result.issues.filter(
      (s) => s.toLowerCase().includes('json') || s.toLowerCase().includes('parseable'),
    );
    expect(jsonIssues.length).toBe(2);
  });

  it('adds an issue when the JSON fence is unclosed (no closing ```) and JSON is invalid', () => {
    // The JSON fence is never closed — endDiagram is called at end-of-input with inJson=true
    const input =
      '> [!diagram] Unclosed Invalid\n' +
      '> ![fig](./assets/placeholder.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": [INVALID ';
    // No closing > ``` line
    const result = validateAndRepair(input, PAGE_ID);
    const jsonIssues = result.issues.filter(
      (s) => s.toLowerCase().includes('json') || s.toLowerCase().includes('parseable'),
    );
    expect(jsonIssues.length).toBe(1);
  });

  it('adds no JSON issue when an unclosed fence contains valid JSON', () => {
    // The JSON fence is never closed — endDiagram is called at end-of-input with inJson=true
    // but the accumulated JSON is valid, so no issue is added
    const input =
      '> [!diagram] Unclosed Valid\n' +
      '> ![fig](./assets/placeholder.png)\n' +
      '> ```json\n' +
      '> { "type": "undirected", "vertices": ["A"], "edges": [], "caption": "Test" }';
    // No closing > ``` line
    const result = validateAndRepair(input, PAGE_ID);
    const jsonIssues = result.issues.filter(
      (s) => s.toLowerCase().includes('json') || s.toLowerCase().includes('parseable'),
    );
    expect(jsonIssues.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 6: Overlong line truncation (auto-repair)
// ---------------------------------------------------------------------------

describe('validateAndRepair — overlong line truncation', () => {
  it('truncates a line exceeding 10 000 characters and appends [TRUNCATED]', () => {
    const longLine = 'a'.repeat(12_000);
    const result = validateAndRepair(longLine, PAGE_ID);
    expect(result.markdown.endsWith('[TRUNCATED]')).toBe(true);
    // The truncated portion must be exactly 10 000 chars + '[TRUNCATED]'
    const lines = result.markdown.split('\n');
    expect(lines[0]).toHaveLength(10_000 + '[TRUNCATED]'.length);
  });

  it('does not truncate a line that is exactly 10 000 characters', () => {
    const line = 'b'.repeat(10_000);
    const result = validateAndRepair(line, PAGE_ID);
    expect(result.markdown).toBe(line);
    expect(result.repaired).toBe(false);
  });

  it('adds an issue message for each truncated line', () => {
    const longLine = 'c'.repeat(11_000);
    const input = `Normal line.\n${longLine}\nAnother normal line.`;
    const result = validateAndRepair(input, PAGE_ID);
    const truncIssues = result.issues.filter((s) => s.toLowerCase().includes('truncat'));
    expect(truncIssues.length).toBe(1);
  });

  it('truncates multiple overlong lines independently', () => {
    const line1 = 'x'.repeat(11_000);
    const line2 = 'y'.repeat(15_000);
    const input = `${line1}\n${line2}`;
    const result = validateAndRepair(input, PAGE_ID);
    const lines = result.markdown.split('\n');
    expect(lines[0].endsWith('[TRUNCATED]')).toBe(true);
    expect(lines[1].endsWith('[TRUNCATED]')).toBe(true);
    const truncIssues = result.issues.filter((s) => s.toLowerCase().includes('truncat'));
    expect(truncIssues.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// repaired flag accuracy
// ---------------------------------------------------------------------------

describe('validateAndRepair — repaired flag', () => {
  it('sets repaired to true when a callout type is normalized', () => {
    const input = '> [!Definition] Title\n> Body.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.repaired).toBe(true);
  });

  it('sets repaired to true when a line is truncated', () => {
    const input = 'd'.repeat(11_000);
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.repaired).toBe(true);
  });

  it('sets repaired to false when no repair was needed (well-formed input)', () => {
    const input =
      '> [!definition] Vertex\n' +
      '> A node in a graph.\n\n' +
      '> [!theorem] Handshaking Lemma\n' +
      '> $\\sum_{v} \\deg(v) = 2|E|$.\n\n' +
      '<!-- confidence: high -->';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.repaired).toBe(false);
  });

  it('sets repaired to false even when detect-only issues are present', () => {
    // Unmatched $$ and unknown type are detect-only; they do not set repaired
    const input = '> [!lemma] Title\n> Body. $$unclosed';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.repaired).toBe(false);
    // But issues should be present
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// issues array accuracy
// ---------------------------------------------------------------------------

describe('validateAndRepair — issues array', () => {
  it('returns an empty issues array for perfectly well-formed input', () => {
    const input =
      '> [!definition] Vertex\n> A node.\n\n' +
      '> [!diagram] Example\n> ![fig](./assets/p.png)\n> ```json\n' +
      '> { "type": "undirected", "vertices": ["A"], "edges": [], "caption": "Ex" }\n> ```\n\n' +
      'Text with $$a + b$$ math.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.issues).toEqual([]);
  });

  it('includes the pageId in every issue message for traceability', () => {
    const input = '> [!Unknown] Title\n> Body.';
    const result = validateAndRepair(input, PAGE_ID);
    for (const issue of result.issues) {
      expect(issue).toContain(PAGE_ID);
    }
  });

  it('accumulates issues from multiple rule violations in one call', () => {
    // Unknown callout type + odd $$ count + diagram without image
    const input =
      '> [!lemma] Title\n> Body.\n\n' +
      '> [!diagram] Diagram\n> No image here.\n\n' +
      'Text $$odd delimiter.';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Markdown preservation
// ---------------------------------------------------------------------------

describe('validateAndRepair — markdown preservation', () => {
  it('returns the markdown field unchanged when no rules fire', () => {
    const input = '> [!proof]\n> Simple proof body.\n\n$$a = b$$';
    const result = validateAndRepair(input, PAGE_ID);
    expect(result.markdown).toBe(input);
  });

  it('only modifies callout type tokens, not other content', () => {
    const input = '> [!Theorem] Title\n> Body with [!important] inline note.';
    const result = validateAndRepair(input, PAGE_ID);
    // Callout-style tokens with unknown type are logged and left, but their
    // surrounding text is not altered
    expect(result.markdown).toContain('Body with');
    expect(result.markdown).toContain('inline note');
  });
});
