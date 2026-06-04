/**
 * Unit tests for src/pipeline/convert.ts.
 *
 * Both VisionClient and parseVisionResponse are mocked so that convertPage
 * can be tested in complete isolation from the vision API and the parser.
 * No network calls, file-system access, or real model invocations are made.
 *
 * Coverage:
 *   - All ConvertedPage fields are present with the correct types and values.
 *   - contentHash is propagated from RenderResult unchanged.
 *   - Logging: '[convert] page <id> — confidence: ...' emitted on success.
 *   - Warning emitted when parsed response contains illegible regions.
 *   - VisionError thrown by the client propagates upward without wrapping.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PageMeta, DiagramData } from '../../src/types.js';
import type { RenderResult } from '../../src/pipeline/render.js';

// ---------------------------------------------------------------------------
// Hoist mock functions
// ---------------------------------------------------------------------------

const mockConvert = vi.hoisted(() => vi.fn());
const mockParseVisionResponse = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/vision/client.js', () => ({
  VisionClient: class MockVisionClient {
    convert = mockConvert;
  },
  VisionError: class VisionError extends Error {
    readonly model: string;
    readonly httpStatus: number;
    readonly retryable: boolean;
    constructor(message: string, model: string, httpStatus: number) {
      super(message);
      this.name = 'VisionError';
      this.model = model;
      this.httpStatus = httpStatus;
      this.retryable = httpStatus === 429 || httpStatus >= 500;
    }
  },
}));

vi.mock('../../src/vision/parser.js', () => ({
  parseVisionResponse: mockParseVisionResponse,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { convertPage } from '../../src/pipeline/convert.js';
import { VisionError } from '../../src/vision/client.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MOCK_CONTENT_HASH = 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const MOCK_PAGE_ID = 'page-test-convert-01';

/**
 * Builds a minimal RenderResult suitable for convert stage tests.
 *
 * @param pageId - Page identifier (default: MOCK_PAGE_ID).
 */
function makeRenderResult(pageId = MOCK_PAGE_ID): RenderResult {
  return {
    pageId,
    imageBuffer: Buffer.alloc(60_000, 0xaa),
    contentHash: MOCK_CONTENT_HASH,
    renderStrategy: 'pdf-export',
    renderDurationMs: 250,
  };
}

/**
 * Builds a minimal PageMeta suitable for convert stage tests.
 *
 * @param id - Page identifier (default: MOCK_PAGE_ID).
 */
function makePageMeta(id = MOCK_PAGE_ID): PageMeta {
  return {
    id,
    title: 'Eulerian Graphs',
    section: 'Graph Theory',
    lastModifiedDateTime: '2024-06-01T12:00:00.000Z',
    contentUrl: `https://graph.microsoft.com/v1.0/me/onenote/pages/${id}/content`,
  };
}

/**
 * Builds a minimal ParsedVisionResponse that parseVisionResponse will return.
 * Individual test cases can override specific fields via object spread.
 */
function makeParsedResponse(overrides: Partial<{
  markdown: string;
  concepts: string[];
  diagrams: DiagramData[];
  hasUncertain: boolean;
  hasIllegible: boolean;
  confidence: 'high' | 'medium' | 'low';
}> = {}) {
  return {
    markdown: '> [!definition] Eulerian Circuit\n> Body text.',
    concepts: ['Eulerian Circuit'],
    diagrams: [] as DiagramData[],
    hasUncertain: false,
    hasIllegible: false,
    confidence: 'high' as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockConvert.mockReset();
  mockParseVisionResponse.mockReset();

  // Default: VisionClient.convert returns a raw response string.
  mockConvert.mockResolvedValue('> [!definition] Test\n<!-- confidence: high -->');
  // Default: parseVisionResponse returns a clean parsed result.
  mockParseVisionResponse.mockReturnValue(makeParsedResponse());

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// convertPage — ConvertedPage shape
// ---------------------------------------------------------------------------

describe('convertPage — returned ConvertedPage', () => {
  it('returns a ConvertedPage with all required interface fields present', async () => {
    const result = await convertPage(makeRenderResult(), makePageMeta());

    expect(result).toMatchObject({
      pageId: expect.any(String),
      title: expect.any(String),
      section: expect.any(String),
      lastModified: expect.any(String),
      contentHash: expect.any(String),
      markdown: expect.any(String),
      frontmatter: expect.any(Object),
      diagrams: expect.any(Array),
      assetPaths: expect.any(Array),
      confidence: expect.stringMatching(/^(high|medium|low)$/),
    });
  });

  it('propagates pageId from the PageMeta to ConvertedPage.pageId', async () => {
    const page = makePageMeta('page-custom-id');
    const render = makeRenderResult('page-custom-id');
    const result = await convertPage(render, page);
    expect(result.pageId).toBe('page-custom-id');
  });

  it('propagates title and section from PageMeta', async () => {
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.title).toBe('Eulerian Graphs');
    expect(result.section).toBe('Graph Theory');
  });

  it('propagates lastModifiedDateTime as lastModified', async () => {
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.lastModified).toBe('2024-06-01T12:00:00.000Z');
  });

  it('propagates contentHash from renderResult unchanged', async () => {
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.contentHash).toBe(MOCK_CONTENT_HASH);
  });

  it('sets confidence from the parsed response', async () => {
    mockParseVisionResponse.mockReturnValue(makeParsedResponse({ confidence: 'low' }));
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.confidence).toBe('low');
  });

  it('sets diagrams from the parsed response', async () => {
    const diagram: DiagramData = {
      type: 'undirected',
      vertices: ['A', 'B'],
      edges: [['A', 'B']],
      caption: 'Test',
    };
    mockParseVisionResponse.mockReturnValue(makeParsedResponse({ diagrams: [diagram] }));
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.diagrams).toHaveLength(1);
    expect(result.diagrams[0].vertices).toEqual(['A', 'B']);
  });

  it('initialises assetPaths as an empty array', async () => {
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.assetPaths).toEqual([]);
  });

  it('populates frontmatter with page_id matching pageId', async () => {
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.frontmatter['page_id']).toBe(MOCK_PAGE_ID);
  });

  it('populates frontmatter.source_hash with the content hash', async () => {
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.frontmatter['source_hash']).toBe(MOCK_CONTENT_HASH);
  });

  it('populates frontmatter.has_diagrams true when diagrams are present', async () => {
    const diagram: DiagramData = {
      type: 'directed',
      vertices: ['X'],
      edges: [],
      caption: 'C',
    };
    mockParseVisionResponse.mockReturnValue(makeParsedResponse({ diagrams: [diagram] }));
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.frontmatter['has_diagrams']).toBe(true);
  });

  it('populates frontmatter.has_diagrams false when no diagrams', async () => {
    mockParseVisionResponse.mockReturnValue(makeParsedResponse({ diagrams: [] }));
    const result = await convertPage(makeRenderResult(), makePageMeta());
    expect(result.frontmatter['has_diagrams']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// convertPage — logging
// ---------------------------------------------------------------------------

describe('convertPage — logging', () => {
  it('logs a line matching [convert] page <id> — confidence: <level>', async () => {
    await convertPage(makeRenderResult(), makePageMeta());

    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/\[convert\] page .+ confidence: (high|medium|low)/);
  });

  it('includes the page id in the convert log line', async () => {
    await convertPage(makeRenderResult(), makePageMeta());

    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain(MOCK_PAGE_ID);
  });

  it('logs a warning when the parsed response has hasIllegible: true', async () => {
    mockParseVisionResponse.mockReturnValue(makeParsedResponse({ hasIllegible: true }));

    await convertPage(makeRenderResult(), makePageMeta());

    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/\[convert\] WARNING:.*illegible/i);
  });

  it('does not log an illegible warning when hasIllegible is false', async () => {
    mockParseVisionResponse.mockReturnValue(makeParsedResponse({ hasIllegible: false }));

    await convertPage(makeRenderResult(), makePageMeta());

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// convertPage — error propagation
// ---------------------------------------------------------------------------

describe('convertPage — error handling', () => {
  it('propagates VisionError from VisionClient without wrapping', async () => {
    const original = new VisionError('Rate limited', 'claude-sonnet-4-6', 429);
    mockConvert.mockRejectedValue(original);

    await expect(convertPage(makeRenderResult(), makePageMeta())).rejects.toThrow(VisionError);
  });

  it('calls parseVisionResponse with the raw string returned by VisionClient', async () => {
    const rawResponse = 'raw model output string';
    mockConvert.mockResolvedValue(rawResponse);

    await convertPage(makeRenderResult(), makePageMeta());

    expect(mockParseVisionResponse).toHaveBeenCalledWith(rawResponse);
  });

  it('base64-encodes the renderResult.imageBuffer before passing to VisionClient', async () => {
    const buf = Buffer.from('test-image-data');
    const renderResult = { ...makeRenderResult(), imageBuffer: buf };

    await convertPage(renderResult, makePageMeta());

    const [base64Arg] = mockConvert.mock.calls[0] as [string, string, string];
    expect(base64Arg).toBe(buf.toString('base64'));
  });

  it('passes page.title and page.section to VisionClient.convert', async () => {
    await convertPage(makeRenderResult(), makePageMeta());

    const [, titleArg, sectionArg] = mockConvert.mock.calls[0] as [string, string, string];
    expect(titleArg).toBe('Eulerian Graphs');
    expect(sectionArg).toBe('Graph Theory');
  });
});
