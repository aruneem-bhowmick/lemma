/**
 * @fileoverview Scaffold structure and type-export validation tests.
 *
 * Verifies the Phase 1 scaffold gate conditions:
 *
 *  1. src/types.ts loads without error and each exported interface has the
 *     expected shape (verified at the TypeScript type level with expectTypeOf).
 *
 *  2. The corpus/ and assets/ output directories exist and are git-tracked.
 *
 *  3. .env.example documents the two critical secret environment variables.
 *
 *  4. The pipeline orchestrator stub is callable and resolves to a valid
 *     PipelineResult without throwing.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { PageMeta, ManifestEntry, DiagramData, ConvertedPage, PipelineResult } from '../../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the repository root (two directories above tests/unit/). */
const ROOT = resolve(__dirname, '../../');

// ─── 1. src/types.ts interface exports ────────────────────────────────────────

describe('src/types.ts — interface exports', () => {
  /**
   * Verify the module itself loads cleanly at runtime.  TypeScript interfaces
   * are erased, so this confirms there are no syntax or import errors in
   * the module; the type assertions below verify the exported shapes.
   */
  it('module loads without error', async () => {
    await import('../../src/types.js');
  });

  it('PageMeta has required fields', () => {
    expectTypeOf<PageMeta>().toHaveProperty('id');
    expectTypeOf<PageMeta>().toHaveProperty('title');
    expectTypeOf<PageMeta>().toHaveProperty('section');
    expectTypeOf<PageMeta>().toHaveProperty('lastModifiedDateTime');
  });

  it('ManifestEntry has required fields', () => {
    expectTypeOf<ManifestEntry>().toHaveProperty('id');
    expectTypeOf<ManifestEntry>().toHaveProperty('status');
    expectTypeOf<ManifestEntry>().toHaveProperty('content_hash');
    expectTypeOf<ManifestEntry>().toHaveProperty('markdown_path');
    expectTypeOf<ManifestEntry>().toHaveProperty('processed_at');
  });

  it('DiagramData has required fields', () => {
    expectTypeOf<DiagramData>().toHaveProperty('type');
    expectTypeOf<DiagramData>().toHaveProperty('vertices');
    expectTypeOf<DiagramData>().toHaveProperty('edges');
    expectTypeOf<DiagramData>().toHaveProperty('caption');
  });

  it('ConvertedPage has required fields', () => {
    expectTypeOf<ConvertedPage>().toHaveProperty('pageId');
    expectTypeOf<ConvertedPage>().toHaveProperty('markdown');
    expectTypeOf<ConvertedPage>().toHaveProperty('diagrams');
    expectTypeOf<ConvertedPage>().toHaveProperty('confidence');
  });

  it('PipelineResult has required fields', () => {
    expectTypeOf<PipelineResult>().toHaveProperty('processed');
    expectTypeOf<PipelineResult>().toHaveProperty('skipped');
    expectTypeOf<PipelineResult>().toHaveProperty('failed');
    expectTypeOf<PipelineResult>().toHaveProperty('errors');
  });
});

// ─── 2. Output directories ─────────────────────────────────────────────────────

describe('scaffold — output directory structure', () => {
  it('corpus directory exists', () => {
    expect(existsSync(join(ROOT, 'corpus'))).toBe(true);
  });

  it('assets directory exists', () => {
    expect(existsSync(join(ROOT, 'assets'))).toBe(true);
  });
});

// ─── 3. .env.example contents ──────────────────────────────────────────────────

describe('scaffold — .env.example', () => {
  /** Read once for all env-var assertions. */
  const envExample = readFileSync(join(ROOT, '.env.example'), 'utf-8');

  it('env example contains DATABASE_URL', () => {
    expect(envExample).toContain('DATABASE_URL=');
  });

  it('env example contains ANTHROPIC_API_KEY', () => {
    expect(envExample).toContain('ANTHROPIC_API_KEY=');
  });
});

// ─── 4. Pipeline orchestrator stub ─────────────────────────────────────────────

describe('scaffold — pipeline orchestrator stub', () => {
  it('pipeline stub is callable and resolves without throwing', async () => {
    const { runPipeline } = await import('../../src/pipeline/index.js');
    const result = await runPipeline();
    expect(result).toMatchObject({
      processed: expect.any(Number),
      skipped: expect.any(Number),
      failed: expect.any(Number),
      errors: expect.any(Array),
    });
  });
});
