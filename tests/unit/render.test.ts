/**
 * Unit tests for the rendering pipeline stage.
 *
 * Coverage:
 *  - renderPage orchestration: primary strategy selection, fallback chain,
 *    RenderError when all strategies fail, quality warnings, log output.
 *  - pdfExportStrategy: PDF magic-byte detection and rasterisation path.
 *  - semiAutoStrategy: drop-folder lookup, missing-file error, missing-env error.
 *  - inkmlRasterStrategy: stub throws as expected.
 *  - RenderError shape: name, pageId, message, instanceof Error.
 *
 * All external dependencies (sharp, pdfjs-dist, canvas, GraphClient, hash)
 * are mocked so that tests run without native add-ons, network access, or a
 * real OneNote notebook. Mock implementations are re-installed in beforeEach
 * because vi.restoreAllMocks() in afterEach (required to restore console
 * spies) also resets plain vi.fn() implementations.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PageMeta } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Hoist shared mock functions so they can be referenced inside vi.mock
// ---------------------------------------------------------------------------

const mockPdfExportStrategy = vi.hoisted(() => vi.fn());
const mockSemiAutoStrategy = vi.hoisted(() => vi.fn());
const mockInkmlRasterStrategy = vi.hoisted(() => vi.fn());
const mockHashBuffer = vi.hoisted(() => vi.fn());
const mockRasterizePdfBuffer = vi.hoisted(() => vi.fn());
const mockGetDocument = vi.hoisted(() => vi.fn());
const mockCreateCanvas = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks (must be top-level; evaluated before any import)
// ---------------------------------------------------------------------------

vi.mock('../../src/pipeline/render-strategies/pdf-export.js', () => ({
  pdfExportStrategy: mockPdfExportStrategy,
  rasterizePdfBuffer: mockRasterizePdfBuffer,
}));

vi.mock('../../src/pipeline/render-strategies/semi-auto.js', () => ({
  semiAutoStrategy: mockSemiAutoStrategy,
}));

vi.mock('../../src/pipeline/render-strategies/inkml-raster.js', () => ({
  inkmlRasterStrategy: mockInkmlRasterStrategy,
}));

vi.mock('../../src/pipeline/hash.js', () => ({
  hashBuffer: mockHashBuffer,
  hashString: vi.fn().mockReturnValue('sha256:00000000'),
}));

// sharp is dynamically imported inside normalizeToJpeg; vi.mock intercepts it.
vi.mock('sharp', () => ({ default: vi.fn() }));

// pdfjs-dist and canvas are dynamically imported inside rasterizePdfBuffer.
vi.mock('pdfjs-dist', () => ({ getDocument: mockGetDocument }));
vi.mock('canvas', () => ({ createCanvas: mockCreateCanvas }));

// ---------------------------------------------------------------------------
// Imports (after mocks so they receive the mocked modules)
// ---------------------------------------------------------------------------

import sharp from 'sharp';
import { renderPage, RenderError } from '../../src/pipeline/render.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Standard JPEG-size buffer returned by the mock sharp pipeline. */
const MOCK_JPEG = Buffer.alloc(60_000, 0xff);

/** Standard SHA-256 hash string returned by the mock hashBuffer. */
const MOCK_HASH = 'sha256:cafebabe' + '0'.repeat(56);

/**
 * Builds a minimal PageMeta fixture for render tests.
 *
 * @param id - Page identifier (defaults to 'page-test-1').
 */
function makePageMeta(id = 'page-test-1'): PageMeta {
  return {
    id,
    title: `Test Page ${id}`,
    section: 'Graph Theory',
    lastModifiedDateTime: '2024-06-01T00:00:00.000Z',
    contentUrl: `https://graph.microsoft.com/v1.0/me/onenote/pages/${id}/content`,
  };
}

/**
 * Builds a minimal GraphClient mock that satisfies the renderPage signature.
 * Individual tests can override its methods as needed.
 */
function makeGraphClient() {
  return {
    renderPageAsImage: vi.fn(),
    listPages: vi.fn(),
    healthCheck: vi.fn(),
    getPageInkML: vi.fn(),
  } as unknown as import('../../src/graph/client.js').GraphClient;
}

/**
 * Installs the default sharp mock implementation.
 *
 * Called in beforeEach because vi.restoreAllMocks() (needed to restore
 * console spies) also resets plain vi.fn() implementations, including the
 * sharp default function that was installed by the vi.mock factory.
 */
function installSharpMock(jpegBuffer: Buffer = MOCK_JPEG): void {
  vi.mocked(sharp).mockImplementation(
    () =>
      ({
        metadata: vi.fn().mockResolvedValue({ width: 2000, height: 1500 }),
        jpeg: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(jpegBuffer),
      }) as unknown as ReturnType<typeof sharp>,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedRenderStrategy: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();

  // Re-install all mock implementations cleared by vi.restoreAllMocks().
  installSharpMock();
  mockHashBuffer.mockReturnValue(MOCK_HASH);
  mockPdfExportStrategy.mockResolvedValue(Buffer.alloc(60_000, 0xaa));
  mockSemiAutoStrategy.mockResolvedValue(Buffer.alloc(60_000, 0xbb));
  mockInkmlRasterStrategy.mockRejectedValue(new Error('inkml-raster strategy not yet implemented'));
  mockRasterizePdfBuffer.mockResolvedValue(Buffer.alloc(60_000, 0xfe));

  // pdfjs-dist mock: returns a minimal single-page document.
  const mockPdfPage = {
    getViewport: vi.fn().mockReturnValue({ width: 800, height: 600 }),
    render: vi.fn().mockReturnValue({ promise: Promise.resolve() }),
  };
  const mockPdfDoc = { getPage: vi.fn().mockResolvedValue(mockPdfPage) };
  mockGetDocument.mockReturnValue({ promise: Promise.resolve(mockPdfDoc) });

  // canvas mock: returns a minimal canvas that produces a PNG buffer.
  const mockCanvas = {
    getContext: vi.fn().mockReturnValue({}),
    toBuffer: vi.fn().mockReturnValue(Buffer.alloc(200, 0xcc)),
  };
  mockCreateCanvas.mockReturnValue(mockCanvas);

  savedRenderStrategy = process.env.RENDER_STRATEGY;
  process.env.RENDER_STRATEGY = 'pdf-export';
});

afterEach(() => {
  if (savedRenderStrategy === undefined) {
    delete process.env.RENDER_STRATEGY;
  } else {
    process.env.RENDER_STRATEGY = savedRenderStrategy;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// renderPage — core behaviour
// ---------------------------------------------------------------------------

describe('renderPage', () => {
  it('returns a RenderResult with a sha256: content hash', async () => {
    const page = makePageMeta();
    const client = makeGraphClient();

    const result = await renderPage(page, client);

    expect(result.contentHash).toMatch(/^sha256:/);
  });

  it('returns a RenderResult with all required fields populated', async () => {
    const page = makePageMeta('page-fields');
    const client = makeGraphClient();

    const result = await renderPage(page, client);

    expect(result.pageId).toBe('page-fields');
    expect(result.imageBuffer).toBeInstanceOf(Buffer);
    expect(result.contentHash).toMatch(/^sha256:/);
    expect(['pdf-export', 'semi-auto', 'inkml-raster']).toContain(result.renderStrategy);
    expect(typeof result.renderDurationMs).toBe('number');
  });

  it('calls the primary strategy (pdf-export) before any fallback', async () => {
    const page = makePageMeta();
    const client = makeGraphClient();

    await renderPage(page, client);

    expect(mockPdfExportStrategy).toHaveBeenCalledOnce();
    expect(mockSemiAutoStrategy).not.toHaveBeenCalled();
  });

  it('passes the page and graphClient arguments to the primary strategy', async () => {
    const page = makePageMeta('page-args');
    const client = makeGraphClient();

    await renderPage(page, client);

    expect(mockPdfExportStrategy).toHaveBeenCalledWith(page, client);
  });

  it('falls back to semi-auto when pdf-export throws', async () => {
    mockPdfExportStrategy.mockRejectedValue(new Error('Graph returned 415'));
    const page = makePageMeta();
    const client = makeGraphClient();

    const result = await renderPage(page, client);

    expect(mockPdfExportStrategy).toHaveBeenCalledOnce();
    expect(mockSemiAutoStrategy).toHaveBeenCalledOnce();
    expect(result.renderStrategy).toBe('semi-auto');
  });

  it('throws RenderError when all strategies fail', async () => {
    mockPdfExportStrategy.mockRejectedValue(new Error('pdf-export failed'));
    mockSemiAutoStrategy.mockRejectedValue(new Error('semi-auto failed'));
    mockInkmlRasterStrategy.mockRejectedValue(new Error('inkml not implemented'));
    const page = makePageMeta('page-all-fail');
    const client = makeGraphClient();

    await expect(renderPage(page, client)).rejects.toThrow(RenderError);
  });

  it('RenderError carries the pageId of the failing page', async () => {
    mockPdfExportStrategy.mockRejectedValue(new Error('pdf fail'));
    mockSemiAutoStrategy.mockRejectedValue(new Error('semi fail'));
    mockInkmlRasterStrategy.mockRejectedValue(new Error('inkml fail'));
    const page = makePageMeta('page-with-id');
    const client = makeGraphClient();

    const err = await renderPage(page, client).catch((e) => e as RenderError);

    expect(err).toBeInstanceOf(RenderError);
    expect(err.pageId).toBe('page-with-id');
  });

  it('RenderError message lists each strategy that was attempted', async () => {
    mockPdfExportStrategy.mockRejectedValue(new Error('pdf fail'));
    mockSemiAutoStrategy.mockRejectedValue(new Error('semi fail'));
    mockInkmlRasterStrategy.mockRejectedValue(new Error('inkml fail'));
    const page = makePageMeta();
    const client = makeGraphClient();

    await expect(renderPage(page, client)).rejects.toSatisfy((err: Error) => {
      return (
        err.message.includes('pdf-export') &&
        err.message.includes('semi-auto') &&
        err.message.includes('inkml-raster')
      );
    });
  });

  it('logs a render summary matching [render] page <id> rendered via', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const page = makePageMeta('page-log');
    const client = makeGraphClient();

    await renderPage(page, client);

    const output = consoleSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/\[render\] page page-log rendered via/);
  });

  it('logs a fallback warning when the primary strategy fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPdfExportStrategy.mockRejectedValue(new Error('Graph 415'));
    const page = makePageMeta();
    const client = makeGraphClient();

    await renderPage(page, client);

    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/pdf-export.*fall(ing)? back/i);
  });

  it('renderDurationMs is a non-negative number', async () => {
    const page = makePageMeta();
    const client = makeGraphClient();

    const result = await renderPage(page, client);

    expect(result.renderDurationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.renderDurationMs).toBe('number');
  });

  it('warns when the rendered JPEG buffer is smaller than 50 KB', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Override the strategy to return a tiny buffer.
    mockPdfExportStrategy.mockResolvedValue(Buffer.alloc(1, 0x01));
    // Override sharp to return a tiny JPEG.
    installSharpMock(Buffer.alloc(1, 0x00));

    const page = makePageMeta('page-small');
    const client = makeGraphClient();

    await renderPage(page, client);

    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/suspiciously small/);
  });

  it('uses semi-auto as primary when RENDER_STRATEGY=semi-auto', async () => {
    process.env.RENDER_STRATEGY = 'semi-auto';
    const page = makePageMeta();
    const client = makeGraphClient();

    const result = await renderPage(page, client);

    expect(mockSemiAutoStrategy).toHaveBeenCalledOnce();
    expect(mockPdfExportStrategy).not.toHaveBeenCalled();
    expect(result.renderStrategy).toBe('semi-auto');
  });

  it('attempts all three strategies when primary is semi-auto and all fail', async () => {
    process.env.RENDER_STRATEGY = 'semi-auto';
    mockSemiAutoStrategy.mockRejectedValue(new Error('no drop file'));
    mockPdfExportStrategy.mockRejectedValue(new Error('Graph 415'));
    mockInkmlRasterStrategy.mockRejectedValue(new Error('not implemented'));
    const page = makePageMeta('page-all-fail-2');
    const client = makeGraphClient();

    const err = await renderPage(page, client).catch((e) => e as RenderError);

    expect(err).toBeInstanceOf(RenderError);
    expect(mockSemiAutoStrategy).toHaveBeenCalledOnce();
    expect(mockPdfExportStrategy).toHaveBeenCalledOnce();
    expect(mockInkmlRasterStrategy).toHaveBeenCalledOnce();
  });

  it('propagates contentHash from hashBuffer through the RenderResult', async () => {
    const page = makePageMeta();
    const client = makeGraphClient();

    const result = await renderPage(page, client);

    expect(result.contentHash).toBe(MOCK_HASH);
    expect(mockHashBuffer).toHaveBeenCalledWith(expect.any(Buffer));
  });
});

// ---------------------------------------------------------------------------
// pdfExportStrategy — PDF magic-byte detection
// ---------------------------------------------------------------------------

describe('pdfExportStrategy (real implementation)', () => {
  // The real pdfExportStrategy is loaded via vi.importActual to bypass the
  // module-level mock. When it calls rasterizePdfBuffer internally, that call
  // is within the same module scope and therefore uses the real rasterizePdfBuffer
  // (not the hoisted mock). We verify the PDF code path by checking that
  // pdfjs-dist.getDocument was called — which only happens when the magic-byte
  // check passes and rasterisation is triggered.

  it('triggers PDF rasterisation when the response buffer starts with %PDF', async () => {
    // Use Uint8Array to avoid Node.js Buffer pooling offset issues.
    // Buffer.concat().buffer may point into a shared pool at a non-zero byteOffset,
    // causing Buffer.from(arrayBuffer) to start at the wrong position.
    const pdfUint8 = new Uint8Array(104);
    pdfUint8[0] = 0x25; // %
    pdfUint8[1] = 0x50; // P
    pdfUint8[2] = 0x44; // D
    pdfUint8[3] = 0x46; // F

    const client = {
      renderPageAsImage: vi.fn().mockResolvedValue(pdfUint8.buffer),
    } as unknown as import('../../src/graph/client.js').GraphClient;

    const page = makePageMeta('page-pdf-magic');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/pdf-export.js')
    >('../../src/pipeline/render-strategies/pdf-export.js');

    await realModule.pdfExportStrategy(page, client);

    // pdfjs-dist.getDocument is called only when the buffer is identified as PDF.
    // Its presence confirms the %PDF magic-byte check succeeded and rasterisation ran.
    expect(mockGetDocument).toHaveBeenCalledOnce();
    const [arg] = mockGetDocument.mock.calls[0] as [{ data: Uint8Array }];
    // The first four bytes of the data passed to getDocument should match %PDF.
    expect(Buffer.from(arg.data).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('returns the buffer directly without rasterisation when it is not PDF', async () => {
    // Build a Uint8Array starting with JPEG magic bytes (0xff 0xd8).
    const jpegUint8 = new Uint8Array(64);
    jpegUint8[0] = 0xff;
    jpegUint8[1] = 0xd8;
    jpegUint8[2] = 0xff;
    jpegUint8[3] = 0xe0;
    jpegUint8.fill(0xaa, 4);

    const client = {
      renderPageAsImage: vi.fn().mockResolvedValue(jpegUint8.buffer),
    } as unknown as import('../../src/graph/client.js').GraphClient;

    const page = makePageMeta('page-jpeg-direct');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/pdf-export.js')
    >('../../src/pipeline/render-strategies/pdf-export.js');

    const result = await realModule.pdfExportStrategy(page, client);

    // pdfjs-dist must NOT have been called — the JPEG path skips rasterisation.
    expect(mockGetDocument).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Buffer);
  });
});

// ---------------------------------------------------------------------------
// semiAutoStrategy — drop-folder behaviour
// ---------------------------------------------------------------------------

describe('semiAutoStrategy (real implementation)', () => {
  let tmpDir: string;
  let savedDropDir: string | undefined;
  let savedTimeout: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lemma-semi-auto-'));
    savedDropDir = process.env.SEMI_AUTO_DROP_DIR;
    savedTimeout = process.env.SEMI_AUTO_TIMEOUT_MS;
    process.env.SEMI_AUTO_DROP_DIR = tmpDir;
    process.env.SEMI_AUTO_TIMEOUT_MS = '0';
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedDropDir === undefined) {
      delete process.env.SEMI_AUTO_DROP_DIR;
    } else {
      process.env.SEMI_AUTO_DROP_DIR = savedDropDir;
    }
    if (savedTimeout === undefined) {
      delete process.env.SEMI_AUTO_TIMEOUT_MS;
    } else {
      process.env.SEMI_AUTO_TIMEOUT_MS = savedTimeout;
    }
  });

  it('throws a descriptive error mentioning the missing filename when file is absent', async () => {
    const page = makePageMeta('page-missing');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    await expect(realModule.semiAutoStrategy(page)).rejects.toThrow(/page-missing\.pdf/);
  });

  it('throws a descriptive error mentioning the drop directory path', async () => {
    const page = makePageMeta('page-no-file');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    await expect(realModule.semiAutoStrategy(page)).rejects.toSatisfy((err: Error) =>
      err.message.includes(tmpDir),
    );
  });

  it('throws when SEMI_AUTO_DROP_DIR is not set', async () => {
    delete process.env.SEMI_AUTO_DROP_DIR;
    const page = makePageMeta('page-no-dir');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    await expect(realModule.semiAutoStrategy(page)).rejects.toThrow(/SEMI_AUTO_DROP_DIR/);
  });

  it('reads and rasterises the PDF when the file exists in the drop directory', async () => {
    const page = makePageMeta('page-found');
    // Write a minimal valid PDF header so the strategy treats it as a PDF.
    writeFileSync(join(tmpDir, `${page.id}.pdf`), Buffer.from('%PDF-1.4\n%%EOF\n'));

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    const result = await realModule.semiAutoStrategy(page);

    expect(result).toBeInstanceOf(Buffer);
    expect(mockRasterizePdfBuffer).toHaveBeenCalledOnce();
  });

  it('rethrows non-ENOENT file-system errors without masking them as missing-file', async () => {
    const page = makePageMeta('page-eisdir');
    // Create a directory with the expected PDF filename. readFileSync on a
    // directory throws EISDIR, not ENOENT, so the error must be rethrown.
    mkdirSync(join(tmpDir, `${page.id}.pdf`));

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    await expect(realModule.semiAutoStrategy(page)).rejects.toSatisfy(
      (err: { code?: string }) => err.code !== undefined && err.code !== 'ENOENT',
    );
  });

  it('warns and falls back to check-once mode when SEMI_AUTO_TIMEOUT_MS is non-numeric', async () => {
    process.env.SEMI_AUTO_TIMEOUT_MS = 'not-a-number';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = makePageMeta('page-bad-timeout-nan');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    // The strategy should warn about the invalid value and proceed in check-once
    // mode. Since no file is present, it will then throw the not-found error.
    await expect(realModule.semiAutoStrategy(page)).rejects.toThrow(/page-bad-timeout-nan\.pdf/);

    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/SEMI_AUTO_TIMEOUT_MS.*not-a-number/);
    expect(output).toMatch(/not.*valid/i);
  });

  it('warns and falls back to check-once mode when SEMI_AUTO_TIMEOUT_MS is negative', async () => {
    process.env.SEMI_AUTO_TIMEOUT_MS = '-500';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = makePageMeta('page-bad-timeout-neg');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    await expect(realModule.semiAutoStrategy(page)).rejects.toThrow(/page-bad-timeout-neg\.pdf/);

    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/SEMI_AUTO_TIMEOUT_MS.*-500/);
  });

  it('warns and falls back to check-once mode when SEMI_AUTO_TIMEOUT_MS is a decimal', async () => {
    process.env.SEMI_AUTO_TIMEOUT_MS = '1.5';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = makePageMeta('page-bad-timeout-dec');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    await expect(realModule.semiAutoStrategy(page)).rejects.toThrow(/page-bad-timeout-dec\.pdf/);

    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/SEMI_AUTO_TIMEOUT_MS.*1\.5/);
  });

  it('accepts a valid SEMI_AUTO_TIMEOUT_MS of 0 without warning', async () => {
    process.env.SEMI_AUTO_TIMEOUT_MS = '0';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = makePageMeta('page-valid-timeout-zero');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/semi-auto.js')
    >('../../src/pipeline/render-strategies/semi-auto.js');

    await expect(realModule.semiAutoStrategy(page)).rejects.toThrow(/page-valid-timeout-zero\.pdf/);

    // No SEMI_AUTO_TIMEOUT_MS warning should be emitted for a valid value.
    const output = warnSpy.mock.calls.flat().join(' ');
    expect(output).not.toMatch(/SEMI_AUTO_TIMEOUT_MS/);
  });
});

// ---------------------------------------------------------------------------
// inkmlRasterStrategy — stub contract
// ---------------------------------------------------------------------------

describe('inkmlRasterStrategy (real implementation)', () => {
  it('always throws an error indicating the strategy is not yet implemented', async () => {
    const page = makePageMeta('page-inkml');

    const realModule = await vi.importActual<
      typeof import('../../src/pipeline/render-strategies/inkml-raster.js')
    >('../../src/pipeline/render-strategies/inkml-raster.js');

    await expect(realModule.inkmlRasterStrategy(page)).rejects.toThrow(/not yet implemented/);
  });
});

// ---------------------------------------------------------------------------
// RenderError — class contract
// ---------------------------------------------------------------------------

describe('RenderError', () => {
  it('has the name property set to RenderError', () => {
    const err = new RenderError('render failed', 'page-1');
    expect(err.name).toBe('RenderError');
  });

  it('carries the pageId passed to the constructor', () => {
    const err = new RenderError('render failed', 'page-abc');
    expect(err.pageId).toBe('page-abc');
  });

  it('is an instance of Error', () => {
    const err = new RenderError('render failed', 'page-1');
    expect(err).toBeInstanceOf(Error);
  });

  it('carries the message passed to the constructor', () => {
    const err = new RenderError('strategies exhausted', 'page-x');
    expect(err.message).toBe('strategies exhausted');
  });
});
