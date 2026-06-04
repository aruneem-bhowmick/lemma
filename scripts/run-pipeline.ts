#!/usr/bin/env ts-node
/**
 * CLI entry point for the Lemma ingestion pipeline.
 *
 * Loads environment variables from .env, runs the full pipeline,
 * and exits with code 0 on success or 1 if any pages failed.
 *
 * Usage:
 *   npm run pipeline
 *   ts-node scripts/run-pipeline.ts
 */

import 'dotenv/config';
import { runPipeline } from '../src/pipeline/index.js';

async function main(): Promise<void> {
  const result = await runPipeline();
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('[pipeline] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
