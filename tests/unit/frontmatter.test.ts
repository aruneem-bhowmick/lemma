/**
 * Unit tests for src/pipeline/frontmatter.ts.
 *
 * generateFrontmatter is a pure function: the same ConvertedPage always
 * produces the same output.  All tests operate on in-memory ConvertedPage
 * objects; no file-system or network access is required.
 *
 * Coverage:
 *   - Output structure: starts and ends with ---
 *   - Required fields: page_id, title, section, last_modified,
 *     source_hash, concepts, has_diagrams, confidence
 *   - Concept sorting: alphabetical regardless of input order
 *   - has_diagrams: true when diagrams present, false when absent
 *   - String escaping: YAML remains parseable for titles with special chars
 *   - Determinism: calling twice with the same input yields identical output
 */

import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import type { ConvertedPage, DiagramData } from '../../src/types.js';
import { generateFrontmatter } from '../../src/pipeline/frontmatter.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal ConvertedPage for frontmatter generation tests.
 * Individual fields can be overridden via the overrides parameter.
 */
function makePage(
  overrides: Partial<ConvertedPage> = {},
  frontmatterOverrides: Record<string, unknown> = {},
): ConvertedPage {
  return {
    pageId: 'page-fm-test-01',
    title: 'Eulerian Graphs',
    section: 'Graph Theory',
    lastModified: '2024-06-01T12:00:00.000Z',
    contentHash: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    markdown: '> [!definition] Eulerian Circuit\n> A circuit that visits every edge.',
    frontmatter: {
      page_id: 'page-fm-test-01',
      title: 'Eulerian Graphs',
      section: 'Graph Theory',
      last_modified: '2024-06-01T12:00:00.000Z',
      source_hash: 'sha256:abcdef',
      concepts: ['Eulerian Circuit'],
      has_diagrams: false,
      confidence: 'high',
      ...frontmatterOverrides,
    },
    diagrams: [],
    assetPaths: [],
    confidence: 'high',
    ...overrides,
  };
}

/**
 * Parses the YAML body from a generateFrontmatter result.
 * Strips the surrounding --- delimiters before calling yaml.load.
 */
function parseFrontmatterYaml(output: string): Record<string, unknown> {
  // Remove opening and closing ---
  const body = output.replace(/^---\n/, '').replace(/\n---\n$/, '');
  return yaml.load(body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Output structure
// ---------------------------------------------------------------------------

describe('generateFrontmatter — output structure', () => {
  it('starts with ---\\n', () => {
    const output = generateFrontmatter(makePage());
    expect(output.startsWith('---\n')).toBe(true);
  });

  it('ends with ---\\n', () => {
    const output = generateFrontmatter(makePage());
    expect(output.endsWith('---\n')).toBe(true);
  });

  it('is parseable YAML between the delimiters', () => {
    const output = generateFrontmatter(makePage());
    expect(() => parseFrontmatterYaml(output)).not.toThrow();
  });

  it('produces the same output on repeated calls with the same input', () => {
    const page = makePage();
    const first = generateFrontmatter(page);
    const second = generateFrontmatter(page);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

describe('generateFrontmatter — required fields', () => {
  it('includes page_id matching page.pageId', () => {
    const output = generateFrontmatter(makePage());
    const fm = parseFrontmatterYaml(output);
    expect(fm['page_id']).toBe('page-fm-test-01');
  });

  it('includes title matching page.title', () => {
    const page = makePage({ title: 'Hamiltonian Paths' });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['title']).toBe('Hamiltonian Paths');
  });

  it('includes section matching page.section', () => {
    const page = makePage({ section: 'Advanced Topics' });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['section']).toBe('Advanced Topics');
  });

  it('includes last_modified matching page.lastModified', () => {
    const page = makePage({ lastModified: '2024-09-15T08:30:00.000Z' });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    // YAML may parse ISO strings as Date objects or strings depending on the
    // yaml engine; compare the string representation.
    expect(String(fm['last_modified'])).toContain('2024-09-15');
  });

  it('includes source_hash matching page.contentHash', () => {
    const hash = 'sha256:deadbeef1234567890deadbeef1234567890deadbeef1234567890deadbeef12';
    const page = makePage({ contentHash: hash });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['source_hash']).toBe(hash);
  });

  it('includes a confidence field', () => {
    const output = generateFrontmatter(makePage());
    expect(output).toContain('confidence');
  });

  it('includes confidence value matching page.confidence', () => {
    const page = makePage({ confidence: 'low' });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['confidence']).toBe('low');
  });

  it('includes a has_diagrams field', () => {
    const output = generateFrontmatter(makePage());
    expect(output).toContain('has_diagrams');
  });

  it('includes a concepts field', () => {
    const output = generateFrontmatter(makePage());
    expect(output).toContain('concepts');
  });
});

// ---------------------------------------------------------------------------
// Concept sorting
// ---------------------------------------------------------------------------

describe('generateFrontmatter — concept sorting', () => {
  it('sorts concepts alphabetically when input is out of order', () => {
    const page = makePage(
      {},
      { concepts: ['Z-Concept', 'A-Concept', 'M-Concept'] },
    );
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    const concepts = fm['concepts'] as string[];
    expect(concepts).toEqual(['A-Concept', 'M-Concept', 'Z-Concept']);
  });

  it('produces alphabetically sorted YAML list output for concepts', () => {
    const page = makePage({}, { concepts: ['Vertex', 'Alpha', 'Edge'] });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    const concepts = fm['concepts'] as string[];
    // Sorted: Alpha, Edge, Vertex
    expect(concepts[0]).toBe('Alpha');
    expect(concepts[1]).toBe('Edge');
    expect(concepts[2]).toBe('Vertex');
  });

  it('handles an empty concepts array without error', () => {
    const page = makePage({}, { concepts: [] });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(Array.isArray(fm['concepts'])).toBe(true);
    expect((fm['concepts'] as string[]).length).toBe(0);
  });

  it('handles a single concept without sorting issues', () => {
    const page = makePage({}, { concepts: ['Only One'] });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['concepts']).toEqual(['Only One']);
  });

  it('returns an empty concepts list when the concepts key is absent from frontmatter', () => {
    // Explicitly set concepts to undefined to trigger the ?? [] fallback
    const page = makePage({}, { concepts: undefined as unknown as string[] });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(Array.isArray(fm['concepts'])).toBe(true);
    expect((fm['concepts'] as string[]).length).toBe(0);
  });

  it('does not mutate the concepts array on page.frontmatter', () => {
    const original = ['Z', 'A', 'M'];
    const page = makePage({}, { concepts: original });
    generateFrontmatter(page);
    // The original array inside page.frontmatter must not be sorted in place
    expect(page.frontmatter['concepts']).toEqual(['Z', 'A', 'M']);
  });
});

// ---------------------------------------------------------------------------
// has_diagrams
// ---------------------------------------------------------------------------

describe('generateFrontmatter — has_diagrams', () => {
  it('sets has_diagrams to true when page.diagrams has entries', () => {
    const diagram: DiagramData = {
      type: 'undirected',
      vertices: ['A', 'B'],
      edges: [['A', 'B']],
      caption: 'Test',
    };
    const page = makePage({ diagrams: [diagram] });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['has_diagrams']).toBe(true);
  });

  it('sets has_diagrams to true when there are two or more diagrams', () => {
    const d: DiagramData = {
      type: 'directed',
      vertices: ['X'],
      edges: [],
      caption: 'D',
    };
    const page = makePage({ diagrams: [d, d] });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['has_diagrams']).toBe(true);
  });

  it('sets has_diagrams to false when page.diagrams is empty', () => {
    const page = makePage({ diagrams: [] });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['has_diagrams']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// String escaping and YAML safety
// ---------------------------------------------------------------------------

describe('generateFrontmatter — string escaping', () => {
  it('generates valid YAML when title contains double quotes', () => {
    const page = makePage({ title: 'He said "hello" to the graph' });
    expect(() => parseFrontmatterYaml(generateFrontmatter(page))).not.toThrow();
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['title']).toBe('He said "hello" to the graph');
  });

  it('generates valid YAML when title contains a colon', () => {
    const page = makePage({ title: 'Graph Theory: An Introduction' });
    expect(() => parseFrontmatterYaml(generateFrontmatter(page))).not.toThrow();
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['title']).toBe('Graph Theory: An Introduction');
  });

  it('generates valid YAML when title contains a hash character', () => {
    const page = makePage({ title: 'Chapter #3: Trees' });
    expect(() => parseFrontmatterYaml(generateFrontmatter(page))).not.toThrow();
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['title']).toBe('Chapter #3: Trees');
  });

  it('round-trips page_id correctly through YAML serialisation', () => {
    const page = makePage({ pageId: 'page-abc-def-ghi' });
    const fm = parseFrontmatterYaml(generateFrontmatter(page));
    expect(fm['page_id']).toBe('page-abc-def-ghi');
  });
});

// ---------------------------------------------------------------------------
// Field ordering (spot-checks; order is part of the spec)
// ---------------------------------------------------------------------------

describe('generateFrontmatter — field ordering', () => {
  it('lists page_id before title in the output', () => {
    const output = generateFrontmatter(makePage());
    expect(output.indexOf('page_id')).toBeLessThan(output.indexOf('title:'));
  });

  it('lists source_hash before concepts in the output', () => {
    const output = generateFrontmatter(makePage());
    expect(output.indexOf('source_hash')).toBeLessThan(output.indexOf('concepts'));
  });

  it('lists has_diagrams after concepts in the output', () => {
    const output = generateFrontmatter(makePage());
    expect(output.indexOf('concepts')).toBeLessThan(output.indexOf('has_diagrams'));
  });

  it('lists confidence last, after has_diagrams', () => {
    const output = generateFrontmatter(makePage());
    expect(output.indexOf('has_diagrams')).toBeLessThan(output.indexOf('confidence'));
  });
});
