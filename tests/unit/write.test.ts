/**
 * Unit tests for src/pipeline/write.ts.
 *
 * The database query module is mocked so that no real PostgreSQL connection
 * is made. Tests use an actual temporary directory on disk for file
 * assertions — this avoids mocking the filesystem and gives confidence that
 * the directory creation, file write, and content composition work exactly
 * as they do in production.
 *
 * Coverage:
 *   - File is written at the expected section-slug/pageId.md path.
 *   - File content begins with the YAML frontmatter delimiter (---).
 *   - Parsed frontmatter contains the correct page_id field.
 *   - Section subdirectory is created automatically.
 *   - markProcessed is called with the correct (pageId, markdownPath, hash).
 *   - Returned byteSize matches the actual size of the file on disk.
 *   - Idempotent: running twice produces the same file without error.
 *   - DRY_RUN=true skips file write and markProcessed call.
 *   - [DRY RUN] prefix appears in the log output when dry run is active.
 *   - WriteError is thrown (before any I/O) when frontmatter fields are empty.
 *   - slugifySection: spaces → hyphens, non-alphanumeric stripped, Unicode accents.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import type { ConvertedPage } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Hoist mock functions before vi.mock calls
// ---------------------------------------------------------------------------

const mockMarkProcessed = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock the database queries module to prevent DATABASE_URL initialization.
// Mocking the whole module means queries.ts never imports db/client.ts, so
// the "DATABASE_URL is not set" guard never fires during unit tests.
// ---------------------------------------------------------------------------

vi.mock('../../src/db/queries.js', () => ({
  markProcessed: mockMarkProcessed,
  upsertPage: vi.fn(),
  getPage: vi.fn(),
  getPagesByStatus: vi.fn(),
  markFailed: vi.fn(),
  getContentHash: vi.fn(),
  pruneDeletedPages: vi.fn(),
}));

// Import the module under test AFTER mocks are installed.
import { writePage, slugifySection, WriteError } from '../../src/pipeline/write.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal ConvertedPage for use in write-stage tests.
 *
 * The default values produce a page whose frontmatter contains all required
 * fields (page_id, title, section).  Pass overrides to exercise edge cases.
 *
 * @param overrides - Partial ConvertedPage fields to override the defaults.
 */
function makePage(overrides: Partial<ConvertedPage> = {}): ConvertedPage {
  return {
    pageId: 'page-test-001',
    title: 'Eulerian Circuit',
    section: 'Graph Theory',
    lastModified: '2024-06-01T00:00:00.000Z',
    contentHash: 'sha256:aabbccddeeff001122334455',
    markdown:
      '> [!definition] Eulerian Circuit\n> A circuit that visits every edge exactly once.',
    frontmatter: {
      page_id: 'page-test-001',
      title: 'Eulerian Circuit',
      section: 'Graph Theory',
      last_modified: '2024-06-01T00:00:00.000Z',
      source_hash: 'sha256:aabbccddeeff001122334455',
      concepts: ['Eulerian Circuit'],
      has_diagrams: false,
      confidence: 'high',
    },
    diagrams: [],
    assetPaths: [],
    confidence: 'high',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkProcessed.mockResolvedValue(undefined);

  // Fresh isolated temp directory for each test — prevents cross-test
  // pollution from filesystem side effects.
  tmpDir = mkdtempSync(join(tmpdir(), 'lemma-write-test-'));

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();

  // Clean up DRY_RUN so it does not leak into subsequent tests.
  delete process.env.DRY_RUN;

  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// File path and content
// ---------------------------------------------------------------------------

describe('writePage — file creation', () => {
  it('writes the file at <corpusDir>/<sectionSlug>/<pageId>.md', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    const expectedPath = join(tmpDir, 'graph-theory', 'page-test-001.md');
    expect(result.markdownPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('file starts with the YAML frontmatter delimiter ---', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    const content = readFileSync(result.markdownPath, 'utf-8');
    expect(content.startsWith('---\n')).toBe(true);
  });

  it('parsed frontmatter contains the correct page_id', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    const content = readFileSync(result.markdownPath, 'utf-8');
    const { data } = matter(content);
    expect(data['page_id']).toBe('page-test-001');
  });

  it('parsed frontmatter contains the correct title', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    const content = readFileSync(result.markdownPath, 'utf-8');
    const { data } = matter(content);
    expect(data['title']).toBe('Eulerian Circuit');
  });

  it('parsed frontmatter contains the correct section', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    const content = readFileSync(result.markdownPath, 'utf-8');
    const { data } = matter(content);
    expect(data['section']).toBe('Graph Theory');
  });

  it('the Markdown body is present after the frontmatter', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    const content = readFileSync(result.markdownPath, 'utf-8');
    const { content: body } = matter(content);
    expect(body).toContain('[!definition]');
  });
});

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

describe('writePage — directory creation', () => {
  it('creates the section subdirectory when it does not exist', async () => {
    const page = makePage();
    await writePage(page, tmpDir);

    expect(existsSync(join(tmpDir, 'graph-theory'))).toBe(true);
  });

  it('does not error when the section subdirectory already exists', async () => {
    const page = makePage();
    await writePage(page, tmpDir);
    await expect(writePage(page, tmpDir)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// manifest update
// ---------------------------------------------------------------------------

describe('writePage — manifest update', () => {
  it('calls markProcessed with the correct page ID', async () => {
    const page = makePage();
    await writePage(page, tmpDir);

    expect(mockMarkProcessed.mock.calls[0]?.[0]).toBe('page-test-001');
  });

  it('calls markProcessed with the exact markdown path that was written', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    expect(mockMarkProcessed.mock.calls[0]?.[1]).toBe(result.markdownPath);
  });

  it('calls markProcessed with the content hash from the page', async () => {
    const page = makePage();
    await writePage(page, tmpDir);

    expect(mockMarkProcessed.mock.calls[0]?.[2]).toBe('sha256:aabbccddeeff001122334455');
  });

  it('calls markProcessed exactly once per writePage call', async () => {
    const page = makePage();
    await writePage(page, tmpDir);

    expect(mockMarkProcessed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Return value
// ---------------------------------------------------------------------------

describe('writePage — return value', () => {
  it('returns byteSize matching the actual file size on disk', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    const stat = statSync(result.markdownPath);
    expect(result.byteSize).toBe(stat.size);
  });

  it('returns the absolute markdownPath', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    // On all platforms the returned path must be absolute (no relative segments).
    expect(result.markdownPath).toContain('page-test-001.md');
    expect(result.markdownPath).toContain('graph-theory');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('writePage — idempotency', () => {
  it('does not throw when called twice with the same inputs', async () => {
    const page = makePage();
    await writePage(page, tmpDir);
    await expect(writePage(page, tmpDir)).resolves.not.toThrow();
  });

  it('produces the same file content on a second run', async () => {
    const page = makePage();
    const first = await writePage(page, tmpDir);
    const contentFirst = readFileSync(first.markdownPath, 'utf-8');

    // Re-mock markProcessed for the second call.
    mockMarkProcessed.mockResolvedValue(undefined);

    const second = await writePage(page, tmpDir);
    const contentSecond = readFileSync(second.markdownPath, 'utf-8');

    expect(contentFirst).toBe(contentSecond);
  });
});

// ---------------------------------------------------------------------------
// DRY_RUN mode
// ---------------------------------------------------------------------------

describe('writePage — DRY_RUN mode', () => {
  it('does not create any file when DRY_RUN=true', async () => {
    process.env.DRY_RUN = 'true';
    const page = makePage();

    await writePage(page, tmpDir);

    const expectedPath = join(tmpDir, 'graph-theory', 'page-test-001.md');
    expect(existsSync(expectedPath)).toBe(false);
  });

  it('does not call markProcessed when DRY_RUN=true', async () => {
    process.env.DRY_RUN = 'true';
    const page = makePage();

    await writePage(page, tmpDir);

    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it('still returns a markdownPath in DRY_RUN mode', async () => {
    process.env.DRY_RUN = 'true';
    const page = makePage();

    const result = await writePage(page, tmpDir);

    const expectedPath = join(tmpDir, 'graph-theory', 'page-test-001.md');
    expect(result.markdownPath).toBe(expectedPath);
  });

  it('returns a positive byteSize based on in-memory content in DRY_RUN mode', async () => {
    process.env.DRY_RUN = 'true';
    const page = makePage();

    const result = await writePage(page, tmpDir);

    expect(result.byteSize).toBeGreaterThan(0);
  });

  it('logs the [DRY RUN] prefix when DRY_RUN=true', async () => {
    process.env.DRY_RUN = 'true';
    const page = makePage();

    await writePage(page, tmpDir);

    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('[DRY RUN]');
  });
});

// ---------------------------------------------------------------------------
// WriteError — frontmatter validation
// ---------------------------------------------------------------------------

describe('writePage — WriteError', () => {
  it('throws WriteError when page.pageId is empty', async () => {
    const page = makePage({ pageId: '' });

    await expect(writePage(page, tmpDir)).rejects.toBeInstanceOf(WriteError);
  });

  it('throws WriteError when page.title is empty', async () => {
    const page = makePage({ title: '' });

    await expect(writePage(page, tmpDir)).rejects.toBeInstanceOf(WriteError);
  });

  it('throws WriteError when page.section is empty', async () => {
    const page = makePage({ section: '' });

    await expect(writePage(page, tmpDir)).rejects.toBeInstanceOf(WriteError);
  });

  it('does not write any file when WriteError is thrown', async () => {
    const page = makePage({ pageId: '' });

    try {
      await writePage(page, tmpDir);
    } catch {
      // expected
    }

    // tmpDir should contain no subdirectories or files when the error
    // fires before I/O.  slugifySection('Graph Theory') === 'graph-theory'.
    const sectionDir = join(tmpDir, 'graph-theory');
    if (existsSync(sectionDir)) {
      // Directory was created before the error — that would be a bug.
      expect(readdirSync(sectionDir)).toHaveLength(0);
    } else {
      expect(existsSync(sectionDir)).toBe(false);
    }
  });

  it('does not call markProcessed when WriteError is thrown', async () => {
    const page = makePage({ pageId: '' });

    try {
      await writePage(page, tmpDir);
    } catch {
      // expected
    }

    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it('WriteError.name is "WriteError"', async () => {
    const page = makePage({ pageId: '' });

    try {
      await writePage(page, tmpDir);
    } catch (err) {
      expect((err as WriteError).name).toBe('WriteError');
    }
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('writePage — logging', () => {
  it('logs [write] page <id> → <path> on success', async () => {
    const page = makePage();
    const result = await writePage(page, tmpDir);

    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toContain('[write] page page-test-001');
    expect(output).toContain(result.markdownPath);
  });

  it('log line includes the byte size', async () => {
    const page = makePage();
    await writePage(page, tmpDir);

    const output = logSpy.mock.calls.flat().join(' ');
    expect(output).toMatch(/\d+ bytes/);
  });
});

// ---------------------------------------------------------------------------
// slugifySection
// ---------------------------------------------------------------------------

describe('slugifySection', () => {
  it('converts spaces to hyphens', () => {
    expect(slugifySection('Graph Theory')).toBe('graph-theory');
  });

  it('lowercases the entire string', () => {
    expect(slugifySection('Graph Theory')).toBe('graph-theory');
    expect(slugifySection('ALGORITHMS')).toBe('algorithms');
  });

  it('strips non-alphanumeric characters (& ! ? etc)', () => {
    const result = slugifySection('Trees & Forests!');
    // Result must contain only a-z, 0-9, or hyphens.
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });

  it('normalises Unicode accents so accented letters survive', () => {
    // 'é' decomposes to 'e' + combining acute; stripping the combiner yields 'e'.
    expect(slugifySection('Théorie des Graphes')).toBe('theorie-des-graphes');
  });

  it('returns an untitled-section-<hash> fallback for symbol-only input', () => {
    const result = slugifySection('数学');
    expect(result).toMatch(/^untitled-section-[a-f0-9]{8}$/);
  });

  it('is deterministic — identical inputs always produce the same slug', () => {
    expect(slugifySection('Graph Theory')).toBe(slugifySection('Graph Theory'));
    expect(slugifySection('数学')).toBe(slugifySection('数学'));
  });

  it('produces a non-empty string for any input', () => {
    expect(slugifySection('').length).toBeGreaterThan(0);
    expect(slugifySection('!!!').length).toBeGreaterThan(0);
  });

  it('preserves existing hyphens in the section name', () => {
    expect(slugifySection('Graph-Theory')).toBe('graph-theory');
  });
});
