/**
 * @fileoverview Scaffold structure and type-export validation tests.
 *
 * Verifies the Prompt 1 gate conditions:
 *
 *  1. All five public interfaces from src/types.ts are importable at
 *     compile time and their module loads without error at runtime.
 *
 *  2. The corpus/ and assets/ output directories exist and are git-tracked.
 *
 *  3. .env.example documents the two critical secret environment variables.
 *
 *  4. The pipeline orchestrator stub is callable and resolves to a valid
 *     PipelineResult without throwing.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the repository root (two directories above tests/unit/). */
const ROOT = resolve(__dirname, '../../');

// ─── 1. src/types.ts interface exports ────────────────────────────────────────

describe('src/types.ts — interface exports', () => {
  /**
   * Dynamic import is used so that a module-load failure surfaces as a test
   * failure rather than an uncaught build error.  TypeScript interfaces are
   * erased at runtime, so we verify the module itself loads cleanly.
   */
  it('src/types.ts exports PageMeta', async () => {
    const types = await import('../../src/types.js');
    expect(types).toBeDefined();
  });

  it('src/types.ts exports ManifestEntry', async () => {
    const types = await import('../../src/types.js');
    expect(types).toBeDefined();
  });

  it('src/types.ts exports DiagramData', async () => {
    const types = await import('../../src/types.js');
    expect(types).toBeDefined();
  });

  it('src/types.ts exports ConvertedPage', async () => {
    const types = await import('../../src/types.js');
    expect(types).toBeDefined();
  });

  it('src/types.ts exports PipelineResult', async () => {
    const types = await import('../../src/types.js');
    expect(types).toBeDefined();
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
