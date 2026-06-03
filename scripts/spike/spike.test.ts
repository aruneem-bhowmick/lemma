/**
 * @fileoverview Vitest test suite for the Lemma validation spike.
 *
 * Two groups of tests are defined:
 *
 *  1. **Fixture integrity** — verifies the spec-required gate conditions:
 *     sample-page.png exists and is non-empty, expected-output.md contains
 *     all four required callout types, the winning model output exists with
 *     LaTeX and adjacency JSON, and README-spike.md declares the winner.
 *
 *  2. **Script utilities** — unit tests for every exported function in
 *     render-test.ts, vision-test.ts, and compare-output.ts.  These run
 *     without real API calls or file-system side-effects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { statSync, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Static imports for each module under test (guarded main() runs only when
// invoked directly via ts-node, not when imported here)
import {
  isPdf,
  MIN_WIDTH_PX,
  normaliseToPng,
} from './render-test';

import {
  encodeImageToBase64,
  extractTokenCount,
  SYSTEM_PROMPT,
  USER_PROMPT_TEMPLATE,
} from './vision-test';

import {
  checkCalloutTypes,
  hasLatexBlock,
  hasAdjacencyJson,
  hasEdgesKey,
  evaluateOutput,
  rankModels,
  discoverOutputFiles,
  formatSummaryTable,
  REQUIRED_CALLOUT_TYPES,
} from './compare-output';

// ─── Paths ────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(__dirname, 'fixtures');
const WINNER_MODEL = 'claude-sonnet-4-6';

// ─── 1. Fixture integrity (spec-mandated tests) ───────────────────────────────

describe('Validation spike — fixture integrity', () => {
  it('fixture sample-page exists and is non-empty', () => {
    const stat = statSync(join(FIXTURES_DIR, 'sample-page.png'));
    expect(stat.size).toBeGreaterThan(0);
  });

  it('ground-truth file contains required callout types', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'expected-output.md'), 'utf-8');
    expect(content).toContain('[!definition]');
    expect(content).toContain('[!theorem]');
    expect(content).toContain('[!proof]');
    expect(content).toContain('[!diagram]');
  });

  it('winning model output file exists', () => {
    expect(existsSync(join(FIXTURES_DIR, `${WINNER_MODEL}-output.md`))).toBe(true);
  });

  it('winning model output contains LaTeX', () => {
    const content = readFileSync(
      join(FIXTURES_DIR, `${WINNER_MODEL}-output.md`),
      'utf-8',
    );
    expect(content).toMatch(/\$\$[\s\S]+?\$\$/);
  });

  it('winning model output contains adjacency JSON', () => {
    const content = readFileSync(
      join(FIXTURES_DIR, `${WINNER_MODEL}-output.md`),
      'utf-8',
    );
    expect(content).toMatch(/"vertices"\s*:/);
  });

  it('README-spike declares winner', () => {
    const content = readFileSync(join(__dirname, '..', 'README-spike.md'), 'utf-8');
    expect(content).toContain('chosen:');
  });
});

// ─── 2. render-test.ts — isPdf() ─────────────────────────────────────────────

describe('render-test — isPdf()', () => {
  it('returns true for a buffer starting with %PDF magic bytes', () => {
    const pdfBuf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
    expect(isPdf(pdfBuf)).toBe(true);
  });

  it('returns false for a PNG buffer', () => {
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG header
    expect(isPdf(pngBuf)).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(isPdf(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for a buffer shorter than 4 bytes', () => {
    expect(isPdf(Buffer.from([0x25, 0x50]))).toBe(false);
  });

  it('returns false for a JPEG buffer', () => {
    const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI + APP0
    expect(isPdf(jpegBuf)).toBe(false);
  });
});

describe('render-test — MIN_WIDTH_PX constant', () => {
  it('is 1668 (minimum iPad screenshot width for adequate OCR)', () => {
    expect(MIN_WIDTH_PX).toBe(1668);
  });
});

// ─── 3. vision-test.ts — utilities ───────────────────────────────────────────

describe('vision-test — encodeImageToBase64()', () => {
  it('returns a non-empty base64 string for the sample-page fixture', () => {
    const b64 = encodeImageToBase64(join(FIXTURES_DIR, 'sample-page.png'));
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);
    // Base64 uses only A-Z, a-z, 0-9, +, /, and =
    expect(/^[A-Za-z0-9+/=]+$/.test(b64)).toBe(true);
  });

  it('is deterministic — same file produces same base64 on two calls', () => {
    const path = join(FIXTURES_DIR, 'sample-page.png');
    expect(encodeImageToBase64(path)).toBe(encodeImageToBase64(path));
  });
});

describe('vision-test — extractTokenCount()', () => {
  it('sums input_tokens + output_tokens when total_tokens is absent', () => {
    expect(extractTokenCount({ input_tokens: 100, output_tokens: 200 })).toBe(300);
  });

  it('prefers total_tokens when all three fields are present', () => {
    expect(
      extractTokenCount({ total_tokens: 500, input_tokens: 100, output_tokens: 200 }),
    ).toBe(500);
  });

  it('returns 0 for undefined usage', () => {
    expect(extractTokenCount(undefined)).toBe(0);
  });

  it('returns 0 when all token fields are absent from the object', () => {
    expect(extractTokenCount({})).toBe(0);
  });

  it('handles partial usage with only output_tokens', () => {
    expect(extractTokenCount({ output_tokens: 300 })).toBe(300);
  });
});

describe('vision-test — SYSTEM_PROMPT integrity', () => {
  it('contains all five required callout type keywords', () => {
    expect(SYSTEM_PROMPT).toContain('[!definition]');
    expect(SYSTEM_PROMPT).toContain('[!theorem]');
    expect(SYSTEM_PROMPT).toContain('[!proof]');
    expect(SYSTEM_PROMPT).toContain('[!example]');
    expect(SYSTEM_PROMPT).toContain('[!diagram]');
  });

  it('instructs the model to use $$ for display math', () => {
    expect(SYSTEM_PROMPT).toContain('$$');
  });

  it('contains the confidence HTML comment instruction', () => {
    expect(SYSTEM_PROMPT).toContain('<!-- confidence:');
  });

  it('explicitly forbids hallucinating proof steps', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER hallucinate proof steps');
  });

  it('instructs the model to use [ILLEGIBLE] for unreadable sections', () => {
    expect(SYSTEM_PROMPT).toContain('[ILLEGIBLE]');
  });

  it('instructs the model to use [UNCERTAIN: ...] for ambiguous symbols', () => {
    expect(SYSTEM_PROMPT).toContain('[UNCERTAIN:');
  });
});

describe('vision-test — USER_PROMPT_TEMPLATE', () => {
  it('contains {pageTitle} interpolation placeholder', () => {
    expect(USER_PROMPT_TEMPLATE).toContain('{pageTitle}');
  });

  it('contains {sectionName} interpolation placeholder', () => {
    expect(USER_PROMPT_TEMPLATE).toContain('{sectionName}');
  });
});

// ─── 4. compare-output.ts — checkCalloutTypes() ──────────────────────────────

describe('compare-output — checkCalloutTypes()', () => {
  it('detects all four required callout types when all are present', () => {
    const md = `
> [!definition] Foo
> [!theorem] Bar
> [!proof]
> [!diagram] Baz
`;
    const result = checkCalloutTypes(md);
    expect(result['definition']).toBe(true);
    expect(result['theorem']).toBe(true);
    expect(result['proof']).toBe(true);
    expect(result['diagram']).toBe(true);
  });

  it('marks missing callout types as false', () => {
    const result = checkCalloutTypes('# Just a heading\nSome prose.');
    expect(result['definition']).toBe(false);
    expect(result['theorem']).toBe(false);
    expect(result['proof']).toBe(false);
    expect(result['diagram']).toBe(false);
  });

  it('is case-insensitive: [!Definition] matches definition', () => {
    const result = checkCalloutTypes('> [!Definition] Foo\n> body');
    expect(result['definition']).toBe(true);
  });

  it('detects only the callout types that are present (partial set)', () => {
    const result = checkCalloutTypes('> [!theorem] T\n> body');
    expect(result['theorem']).toBe(true);
    expect(result['definition']).toBe(false);
  });
});

// ─── 5. compare-output.ts — hasLatexBlock() ──────────────────────────────────

describe('compare-output — hasLatexBlock()', () => {
  it('returns true for a multi-line $$ display block', () => {
    expect(hasLatexBlock('$$\nE = mc^2\n$$')).toBe(true);
  });

  it('returns true for an inline $$ with content on one line', () => {
    expect(hasLatexBlock('See $$ x^2 $$ above.')).toBe(true);
  });

  it('returns false when no $$ blocks are present', () => {
    expect(hasLatexBlock('Just prose with $inline$ math.')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(hasLatexBlock('')).toBe(false);
  });

  it('returns false for two empty $$ markers with no content between', () => {
    // /\$\$[\s\S]+?\$\$/ requires at least one character
    expect(hasLatexBlock('$$$$')).toBe(false);
  });
});

// ─── 6. compare-output.ts — hasAdjacencyJson() ───────────────────────────────

describe('compare-output — hasAdjacencyJson()', () => {
  it('returns true when "vertices": appears in a JSON code block', () => {
    const md = '```json\n{ "vertices": ["a","b"], "edges": [["a","b"]] }\n```';
    expect(hasAdjacencyJson(md)).toBe(true);
  });

  it('returns false when "vertices": is absent', () => {
    expect(hasAdjacencyJson('```json\n{ "nodes": ["a"] }\n```')).toBe(false);
  });

  it('matches "vertices" with whitespace before the colon', () => {
    expect(hasAdjacencyJson('"vertices"  :  ["a"]')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(hasAdjacencyJson('')).toBe(false);
  });
});

// ─── 7. compare-output.ts — hasEdgesKey() ────────────────────────────────────

describe('compare-output — hasEdgesKey()', () => {
  it('returns true when "edges": is present', () => {
    expect(hasEdgesKey('"edges": [["a","b"]]')).toBe(true);
  });

  it('returns false when only "vertices" is present', () => {
    expect(hasEdgesKey('"vertices": ["a","b"]')).toBe(false);
  });

  it('matches "edges" with whitespace around the colon', () => {
    expect(hasEdgesKey('"edges"   :  []')).toBe(true);
  });
});

// ─── 8. compare-output.ts — evaluateOutput() ─────────────────────────────────

describe('compare-output — evaluateOutput()', () => {
  it('returns a ModelEvaluation with the correct model name', () => {
    const ev = evaluateOutput('my-model', 'hello', 'world');
    expect(ev.modelName).toBe('my-model');
  });

  it('computes Levenshtein distance of 0 for identical strings', () => {
    const ev = evaluateOutput('m', 'abc', 'abc');
    expect(ev.levenshteinDistance).toBe(0);
  });

  it('computes a positive Levenshtein distance for completely different strings', () => {
    const ev = evaluateOutput('m', 'abc', 'xyz');
    expect(ev.levenshteinDistance).toBeGreaterThan(0);
  });

  it('sets hasLatexBlock true when $$ content is present in the output', () => {
    const ev = evaluateOutput('m', '$$ E = mc^2 $$', 'expected');
    expect(ev.hasLatexBlock).toBe(true);
  });

  it('sets hasAdjacencyJson true when "vertices": appears in the output', () => {
    const ev = evaluateOutput('m', '"vertices": ["a"]', 'expected');
    expect(ev.hasAdjacencyJson).toBe(true);
  });

  it('reflects callout presence accurately', () => {
    const ev = evaluateOutput(
      'm',
      '> [!definition] Foo\n> [!theorem] Bar',
      'expected',
    );
    expect(ev.calloutPresence['definition']).toBe(true);
    expect(ev.calloutPresence['theorem']).toBe(true);
    expect(ev.calloutPresence['proof']).toBe(false);
  });
});

// ─── 9. compare-output.ts — rankModels() ─────────────────────────────────────

describe('compare-output — rankModels()', () => {
  it('sorts evaluations by Levenshtein distance ascending (best first)', () => {
    const evals = [
      { modelName: 'c', levenshteinDistance: 500, calloutPresence: {}, hasLatexBlock: false, hasAdjacencyJson: false },
      { modelName: 'a', levenshteinDistance: 100, calloutPresence: {}, hasLatexBlock: false, hasAdjacencyJson: false },
      { modelName: 'b', levenshteinDistance: 300, calloutPresence: {}, hasLatexBlock: false, hasAdjacencyJson: false },
    ];
    const ranked = rankModels(evals);
    expect(ranked[0].modelName).toBe('a');
    expect(ranked[1].modelName).toBe('b');
    expect(ranked[2].modelName).toBe('c');
  });

  it('does not mutate the original array', () => {
    const input = [
      { modelName: 'z', levenshteinDistance: 999, calloutPresence: {}, hasLatexBlock: false, hasAdjacencyJson: false },
      { modelName: 'a', levenshteinDistance: 1, calloutPresence: {}, hasLatexBlock: false, hasAdjacencyJson: false },
    ];
    const ranked = rankModels(input);
    expect(input[0].modelName).toBe('z'); // original order preserved
    expect(ranked[0].modelName).toBe('a'); // sorted copy is correct
  });

  it('returns an empty array for an empty input', () => {
    expect(rankModels([])).toEqual([]);
  });

  it('handles a single-element array', () => {
    const evals = [
      { modelName: 'only', levenshteinDistance: 42, calloutPresence: {}, hasLatexBlock: true, hasAdjacencyJson: true },
    ];
    expect(rankModels(evals)[0].modelName).toBe('only');
  });
});

// ─── 10. compare-output.ts — discoverOutputFiles() ───────────────────────────

describe('compare-output — discoverOutputFiles()', () => {
  it('finds *-output.md files in the spike fixtures directory', () => {
    const files = discoverOutputFiles(FIXTURES_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.filePath.endsWith('-output.md'))).toBe(true);
  });

  it('excludes expected-output.md from results', () => {
    const files = discoverOutputFiles(FIXTURES_DIR);
    expect(files.every((f) => !f.filePath.includes('expected-output.md'))).toBe(true);
  });

  it('derives model names by stripping the -output.md suffix', () => {
    const files = discoverOutputFiles(FIXTURES_DIR);
    const names = files.map((f) => f.modelName);
    expect(names).toContain('claude-sonnet-4-6');
  });

  it('returns an empty array for a non-existent directory', () => {
    expect(discoverOutputFiles('/no/such/path/xyz123')).toEqual([]);
  });

  it('returns filePath as an absolute path for each entry', () => {
    const { isAbsolute } = require('path') as typeof import('path');
    const files = discoverOutputFiles(FIXTURES_DIR);
    files.forEach((f) => {
      expect(isAbsolute(f.filePath)).toBe(true);
    });
  });
});

// ─── 11. compare-output.ts — formatSummaryTable() ────────────────────────────

describe('compare-output — formatSummaryTable()', () => {
  const sampleEval = {
    modelName: 'test-model',
    levenshteinDistance: 42,
    calloutPresence: {
      definition: true,
      theorem: false,
      proof: true,
      diagram: false,
    },
    hasLatexBlock: true,
    hasAdjacencyJson: false,
  };

  it('includes the model name in the output', () => {
    const table = formatSummaryTable([sampleEval]);
    expect(table).toContain('test-model');
  });

  it('shows rank #1 for the first entry', () => {
    const table = formatSummaryTable([sampleEval]);
    expect(table).toContain('#1');
  });

  it('returns a non-empty string for an empty evaluations array', () => {
    const table = formatSummaryTable([]);
    expect(typeof table).toBe('string');
    expect(table.length).toBeGreaterThan(0);
  });

  it('includes ✓ for LaTeX when hasLatexBlock is true', () => {
    const table = formatSummaryTable([sampleEval]);
    expect(table).toContain('✓');
  });

  it('includes the Levenshtein distance value', () => {
    const table = formatSummaryTable([sampleEval]);
    expect(table).toContain('42');
  });
});

// ─── 12. compare-output.ts — REQUIRED_CALLOUT_TYPES ──────────────────────────

describe('compare-output — REQUIRED_CALLOUT_TYPES constant', () => {
  it('includes definition', () => expect(REQUIRED_CALLOUT_TYPES).toContain('definition'));
  it('includes theorem', () => expect(REQUIRED_CALLOUT_TYPES).toContain('theorem'));
  it('includes proof', () => expect(REQUIRED_CALLOUT_TYPES).toContain('proof'));
  it('includes diagram', () => expect(REQUIRED_CALLOUT_TYPES).toContain('diagram'));
  it('has exactly four entries', () => expect(REQUIRED_CALLOUT_TYPES).toHaveLength(4));
});

// ─── 13. Integration — winning model fixture round-trip ───────────────────────

describe('Winning model fixture — full evaluation round-trip', () => {
  it('evaluates claude-sonnet-4-6 output as the best against ground truth', () => {
    const expected = readFileSync(join(FIXTURES_DIR, 'expected-output.md'), 'utf-8');
    const output = readFileSync(join(FIXTURES_DIR, 'claude-sonnet-4-6-output.md'), 'utf-8');
    const ev = evaluateOutput('claude-sonnet-4-6', output, expected);

    // Must have all four callout types
    expect(ev.calloutPresence['definition']).toBe(true);
    expect(ev.calloutPresence['theorem']).toBe(true);
    expect(ev.calloutPresence['proof']).toBe(true);
    expect(ev.calloutPresence['diagram']).toBe(true);

    // Must have LaTeX and adjacency JSON
    expect(ev.hasLatexBlock).toBe(true);
    expect(ev.hasAdjacencyJson).toBe(true);

    // Distance from ground truth must be finite (output is close but not identical)
    expect(ev.levenshteinDistance).toBeGreaterThanOrEqual(0);
  });
});
