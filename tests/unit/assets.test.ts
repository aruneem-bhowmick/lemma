/**
 * Unit tests for src/pipeline/assets.ts.
 *
 * Tests exercise the full extractAndWriteAssets() function using a real
 * temporary directory so that actual file writes and directory creation
 * can be verified without mocking the filesystem.  The sharp module is
 * mocked to avoid native add-on dependencies and to keep test execution fast.
 *
 * Coverage:
 *   - File creation: one PNG per diagram, named page-<pageId>-fig<N>.png.
 *   - Markdown placeholder resolution: <asset-placeholder> → relative path.
 *   - Directory creation: assetsDir created if absent (recursive: true).
 *   - Idempotency: re-running with the same inputs produces the same files.
 *   - Empty-diagram short-circuit: no filesystem access when diagrams === [].
 *   - Return shape: ExtractedAsset fields, markdown string.
 *   - Logging: console.log called with expected [assets] summary.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConvertedPage, DiagramData } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Hoist sharp mock state so it can be referenced before module loading
// ---------------------------------------------------------------------------

const mockToFile = vi.hoisted(() => vi.fn());
const mockPng = vi.hoisted(() => vi.fn());
const mockSharpInstance = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// sharp is dynamically imported inside extractAndWriteAssets; vi.mock
// intercepts the dynamic import and returns a mock that records all calls.
vi.mock('sharp', () => ({
  default: mockSharpInstance,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { extractAndWriteAssets } from '../../src/pipeline/assets.js';

// ---------------------------------------------------------------------------
// Test image buffer
// ---------------------------------------------------------------------------

/**
 * A 1×1 white PNG encoded as a Buffer.  Using a hardcoded fixture avoids a
 * real sharp call in the test setup and keeps the tests self-contained.
 *
 * Produced by: Buffer.from('<base64-1x1-white-png>', 'base64')
 */
const TEST_IMAGE_BUFFER: Buffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Returns a minimal DiagramData object for use in tests.
 *
 * @param caption - Optional caption string (default: 'Test Diagram').
 */
function makeDiagram(caption = 'Test Diagram'): DiagramData {
  return {
    type: 'undirected',
    vertices: ['A', 'B'],
    edges: [['A', 'B']],
    caption,
  };
}

/**
 * Returns a minimal ConvertedPage suitable for asset extraction tests.
 *
 * @param pageId   - Page identifier (default: 'page-test-assets-01').
 * @param diagrams - Array of DiagramData objects (default: one diagram).
 * @param markdown - Markdown body string (default: callout with placeholder).
 */
function makePage(
  pageId = 'page-test-assets-01',
  diagrams: DiagramData[] = [makeDiagram()],
  markdown = '> [!diagram] Test Diagram\n> ![fig](./assets/<asset-placeholder>.png)\n',
): ConvertedPage {
  return {
    pageId,
    title: 'Test Page',
    section: 'Graph Theory',
    lastModified: '2024-06-01T00:00:00.000Z',
    contentHash: 'sha256:aabbccdd',
    markdown,
    frontmatter: { page_id: pageId, title: 'Test Page', section: 'Graph Theory' },
    diagrams,
    assetPaths: [],
    confidence: 'high',
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpAssetsDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  // Install the sharp mock chain. The mock is installed once because
  // vi.mock is module-level, but the implementation must be set up before
  // each test suite runs.
  mockToFile.mockResolvedValue(undefined);
  mockPng.mockReturnValue({ toFile: mockToFile });
  mockSharpInstance.mockReturnValue({ png: mockPng });
});

beforeEach(() => {
  // Reset call counts between tests so assertions remain independent.
  mockToFile.mockClear();
  mockPng.mockClear();
  mockSharpInstance.mockClear();
  // Ensure mock chain is still properly set up after clear.
  mockToFile.mockResolvedValue(undefined);
  mockPng.mockReturnValue({ toFile: mockToFile });
  mockSharpInstance.mockReturnValue({ png: mockPng });

  // Create a fresh temp directory per test to guarantee isolation.
  tmpAssetsDir = mkdtempSync(join(tmpdir(), 'lemma-assets-test-'));

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up the temp directory after each test.
  if (existsSync(tmpAssetsDir)) {
    rmSync(tmpAssetsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// File creation
// ---------------------------------------------------------------------------

describe('extractAndWriteAssets — file creation', () => {
  it('calls sharp toFile once per diagram', async () => {
    const page = makePage('page-01', [makeDiagram(), makeDiagram('Second')]);
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(mockToFile).toHaveBeenCalledTimes(2);
  });

  it('names the first diagram file page-<pageId>-fig0.png', async () => {
    const page = makePage('page-abc');
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);

    const expectedPath = join(tmpAssetsDir, 'page-page-abc-fig0.png');
    expect(mockToFile).toHaveBeenCalledWith(expectedPath);
  });

  it('names subsequent diagram files with incrementing indices', async () => {
    const page = makePage('pg', [makeDiagram(), makeDiagram(), makeDiagram()]);
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);

    const calls = mockToFile.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toMatch(/page-pg-fig0\.png$/);
    expect(calls[1]).toMatch(/page-pg-fig1\.png$/);
    expect(calls[2]).toMatch(/page-pg-fig2\.png$/);
  });

  it('passes the imageBuffer directly to sharp', async () => {
    const page = makePage();
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(mockSharpInstance).toHaveBeenCalledWith(TEST_IMAGE_BUFFER);
  });

  it('calls png() on the sharp instance to ensure PNG output format', async () => {
    const page = makePage();
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(mockPng).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Markdown placeholder resolution
// ---------------------------------------------------------------------------

describe('extractAndWriteAssets — markdown resolution', () => {
  it('replaces <asset-placeholder> with the relative path', async () => {
    const page = makePage(
      'page-xyz',
      [makeDiagram()],
      '> ![fig](./assets/<asset-placeholder>.png)',
    );
    const { markdown } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(markdown).toBe('> ![fig](./assets/page-page-xyz-fig0.png)');
    expect(markdown).not.toContain('<asset-placeholder>');
  });

  it('resolves each diagram placeholder independently (sequential replacement)', async () => {
    const twoPlaceholderMarkdown =
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> ![fig](./assets/<asset-placeholder>.png)';
    const page = makePage('p-multi', [makeDiagram(), makeDiagram()], twoPlaceholderMarkdown);

    const { markdown } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);

    expect(markdown).toContain('./assets/page-p-multi-fig0.png');
    expect(markdown).toContain('./assets/page-p-multi-fig1.png');
    expect(markdown).not.toContain('<asset-placeholder>');
  });

  it('returns the original markdown unchanged when there are no diagrams', async () => {
    const originalMarkdown = '> [!definition] A vertex\n> Body with no diagrams.';
    const page = makePage('p-empty', [], originalMarkdown);
    const { markdown } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(markdown).toBe(originalMarkdown);
  });

  it('leaves non-image mentions of <asset-placeholder> untouched', async () => {
    // The full image path pattern is './assets/<asset-placeholder>.png'.
    // Any other occurrence of the bare token (inline code, prose, etc.)
    // must not be mutated — only the image tag should be resolved.
    const mixedMarkdown =
      '> [!diagram] K3\n' +
      '> ![fig](./assets/<asset-placeholder>.png)\n' +
      '> The model emits `<asset-placeholder>` as a token in image tags.\n';
    const page = makePage('p-nonimage', [makeDiagram()], mixedMarkdown);

    const { markdown } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);

    // The image tag should now point to the real asset path.
    expect(markdown).toContain('./assets/page-p-nonimage-fig0.png');
    // The inline-code mention of the bare token should be preserved verbatim.
    expect(markdown).toContain('`<asset-placeholder>`');
  });
});

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

describe('extractAndWriteAssets — directory creation', () => {
  it('creates the assets directory when it does not exist', async () => {
    const nonExistentDir = join(tmpAssetsDir, 'new-subdir', 'nested');
    expect(existsSync(nonExistentDir)).toBe(false);

    const page = makePage();
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, nonExistentDir);

    expect(existsSync(nonExistentDir)).toBe(true);
  });

  it('does not create the directory when there are no diagrams', async () => {
    const nonExistentDir = join(tmpAssetsDir, 'should-not-be-created');
    const page = makePage('p', [], 'no diagrams');
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, nonExistentDir);
    expect(existsSync(nonExistentDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('extractAndWriteAssets — idempotency', () => {
  it('completes without error when called twice with the same inputs', async () => {
    const page = makePage();
    await expect(
      extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir).then(() =>
        extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir),
      ),
    ).resolves.not.toThrow();
  });

  it('calls toFile twice (overwrite) when re-run for the same diagram', async () => {
    const page = makePage();
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(mockToFile).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Return value — assets array
// ---------------------------------------------------------------------------

describe('extractAndWriteAssets — returned assets', () => {
  it('returns an empty assets array when the page has no diagrams', async () => {
    const page = makePage('p', [], 'no diagrams');
    const { assets } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(assets).toEqual([]);
  });

  it('returns one ExtractedAsset per diagram', async () => {
    const page = makePage('p1', [makeDiagram(), makeDiagram()]);
    const { assets } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(assets).toHaveLength(2);
  });

  it('sets the correct filename on the returned asset', async () => {
    const page = makePage('p2');
    const { assets } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(assets[0].filename).toBe('page-p2-fig0.png');
  });

  it('sets relativePath to ./assets/<filename>', async () => {
    const page = makePage('p3');
    const { assets } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(assets[0].relativePath).toBe('./assets/page-p3-fig0.png');
  });

  it('sets absolutePath to the resolved filesystem path inside assetsDir', async () => {
    const page = makePage('p4');
    const { assets } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(assets[0].absolutePath).toContain('page-p4-fig0.png');
    // absolutePath must be an absolute path (starts with drive letter on Windows or / on Unix).
    expect(assets[0].absolutePath).toMatch(/^([A-Za-z]:\\|\/)/);
  });

  it('sets diagramIndex to the 0-indexed position within the page', async () => {
    const page = makePage('p5', [makeDiagram(), makeDiagram()]);
    const { assets } = await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(assets[0].diagramIndex).toBe(0);
    expect(assets[1].diagramIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('extractAndWriteAssets — logging', () => {
  it('logs [assets] wrote <n> assets for page <pageId> on success', async () => {
    const page = makePage('page-log-01', [makeDiagram()]);
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);

    const allOutput = logSpy.mock.calls.flat().join(' ');
    expect(allOutput).toMatch(/\[assets\] wrote \d+ assets for page page-log-01/);
  });

  it('logs asset count of 2 when two diagrams are present', async () => {
    const page = makePage('page-log-02', [makeDiagram(), makeDiagram()]);
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);

    const allOutput = logSpy.mock.calls.flat().join(' ');
    expect(allOutput).toContain('[assets] wrote 2 assets for page page-log-02');
  });

  it('does not log when there are no diagrams', async () => {
    const page = makePage('p', [], 'no diagrams');
    await extractAndWriteAssets(page, TEST_IMAGE_BUFFER, tmpAssetsDir);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
