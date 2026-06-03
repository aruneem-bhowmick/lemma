#!/usr/bin/env ts-node
/**
 * @fileoverview Side-by-side diff tool for the Lemma validation spike.
 *
 * Reads `scripts/spike/fixtures/expected-output.md` and every
 * `<model-name>-output.md` file in the same directory, then for each model
 * computes and prints:
 *   • Levenshtein distance from the expected output
 *   • Presence of each required callout type
 *   • Presence of at least one `$$` display-math block
 *   • Presence of a complete graph adjacency JSON block (both `"vertices"`
 *     and `"edges"` keys required)
 *
 * Outputs a ranked summary table sorted by Levenshtein distance (ascending).
 *
 * Usage:
 *   npx ts-node scripts/spike/compare-output.ts
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { distance } from 'fastest-levenshtein';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ────────────────────────────────────────────────────────────────

/** Directory containing all spike fixture and model-output files. */
const FIXTURES_DIR = join(__dirname, 'fixtures');

/** Path to the manually authored ground-truth file. */
const EXPECTED_PATH = join(FIXTURES_DIR, 'expected-output.md');

/** Callout types that every model output should contain. */
export const REQUIRED_CALLOUT_TYPES = ['definition', 'theorem', 'proof', 'diagram'] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of evaluating one model's output against the ground truth. */
export interface ModelEvaluation {
  /** Model identifier derived from the filename prefix. */
  modelName: string;
  /** Levenshtein distance from the expected output. */
  levenshteinDistance: number;
  /** Map of required callout type → whether it was found. */
  calloutPresence: Record<string, boolean>;
  /** Whether at least one `$$...$$` LaTeX display block is present. */
  hasLatexBlock: boolean;
  /**
   * Whether a complete graph adjacency JSON block is present — requires both
   * a `"vertices"` key and an `"edges"` key.  A block with only `"vertices"`
   * is not considered complete.
   */
  hasCompleteAdjacency: boolean;
}

// ─── Utility functions ────────────────────────────────────────────────────────

/**
 * Checks whether each required callout type appears in `content`.
 *
 * Each callout is matched as `[!<type>]` (case-insensitive) anywhere in
 * the string.
 *
 * @param content - Markdown string to inspect.
 * @returns A record mapping each required callout type to a boolean.
 */
export function checkCalloutTypes(content: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const type of REQUIRED_CALLOUT_TYPES) {
    result[type] = new RegExp(`\\[!${type}\\]`, 'i').test(content);
  }
  return result;
}

/**
 * Returns `true` when `content` contains at least one fenced display-math block
 * of the form `$$...(non-empty)...$$`.
 *
 * @param content - Markdown string to inspect.
 */
export function hasLatexBlock(content: string): boolean {
  return /\$\$[\s\S]+?\$\$/.test(content);
}

/**
 * Returns `true` when `content` contains a JSON-like block with a `"vertices"`
 * key, indicating a graph adjacency structure was extracted.
 *
 * @param content - Markdown string to inspect.
 */
export function hasAdjacencyJson(content: string): boolean {
  return /"vertices"\s*:/.test(content);
}

/**
 * Returns `true` when `content` also contains an `"edges"` key alongside the
 * `"vertices"` key, confirming a complete adjacency structure.
 *
 * @param content - Markdown string to inspect.
 */
export function hasEdgesKey(content: string): boolean {
  return /"edges"\s*:/.test(content);
}

/**
 * Evaluates a single model output file against the ground truth.
 *
 * @param modelName    - Human-readable model identifier (used for display only).
 * @param outputContent - Raw text of the model's output file.
 * @param expectedContent - Raw text of the ground-truth file.
 * @returns A fully populated {@link ModelEvaluation}.
 */
export function evaluateOutput(
  modelName: string,
  outputContent: string,
  expectedContent: string,
): ModelEvaluation {
  return {
    modelName,
    levenshteinDistance: distance(outputContent, expectedContent),
    calloutPresence: checkCalloutTypes(outputContent),
    hasLatexBlock: hasLatexBlock(outputContent),
    // Both "vertices" and "edges" must be present for a complete adjacency block.
    hasCompleteAdjacency: hasAdjacencyJson(outputContent) && hasEdgesKey(outputContent),
  };
}

/**
 * Discovers all `*-output.md` files in `dir`, excluding `expected-output.md`.
 *
 * @param dir - Directory to scan.
 * @returns Array of `{ modelName, filePath }` objects sorted alphabetically.
 */
export function discoverOutputFiles(
  dir: string,
): Array<{ modelName: string; filePath: string }> {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('-output.md') && f !== 'expected-output.md')
    .sort()
    .map((filename) => ({
      modelName: filename.replace(/-output\.md$/, ''),
      filePath: join(dir, filename),
    }));
}

/**
 * Ranks evaluations in ascending order of Levenshtein distance (closest to
 * ground truth first).
 *
 * @param evaluations - Array of model evaluations to sort.
 * @returns New array sorted by `levenshteinDistance` ascending.
 */
export function rankModels(evaluations: ModelEvaluation[]): ModelEvaluation[] {
  return [...evaluations].sort((a, b) => a.levenshteinDistance - b.levenshteinDistance);
}

/**
 * Renders the ranked summary table to a string.
 *
 * Columns:  Rank | Model | Levenshtein | Callouts | LaTeX | JSON
 *
 * @param ranked - Pre-sorted array of evaluations (index 0 = best).
 * @returns Multi-line string ready for `console.log`.
 */
export function formatSummaryTable(ranked: ModelEvaluation[]): string {
  const allCalloutTypes = REQUIRED_CALLOUT_TYPES;

  const header =
    `${'Rank'.padEnd(6)}` +
    `${'Model'.padEnd(24)}` +
    `${'Lev. Dist'.padEnd(12)}` +
    allCalloutTypes.map((t) => t.padEnd(12)).join('') +
    `${'LaTeX $$'.padEnd(10)}` +
    `${'Adj. full'.padEnd(10)}`;

  const divider = '─'.repeat(header.length);

  const rows = ranked.map((ev, i) => {
    const rank = `#${i + 1}`.padEnd(6);
    const model = ev.modelName.padEnd(24);
    const lev = String(ev.levenshteinDistance).padEnd(12);
    const callouts = allCalloutTypes
      .map((t) => (ev.calloutPresence[t] ? '✓' : '✗').padEnd(12))
      .join('');
    const latex = (ev.hasLatexBlock ? '✓' : '✗').padEnd(10);
    const json = (ev.hasCompleteAdjacency ? '✓' : '✗').padEnd(10);
    return `${rank}${model}${lev}${callouts}${latex}${json}`;
  });

  return [divider, header, divider, ...rows, divider].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Reads all model output files, evaluates them against the ground truth,
 * and prints a ranked comparison table to stdout.
 */
function main(): void {
  if (!existsSync(EXPECTED_PATH)) {
    console.error(`[compare-output] Ground truth not found: ${EXPECTED_PATH}`);
    process.exit(1);
  }

  const expectedContent = readFileSync(EXPECTED_PATH, 'utf-8');
  const outputFiles = discoverOutputFiles(FIXTURES_DIR);

  if (outputFiles.length === 0) {
    console.warn(
      '[compare-output] No model output files found in fixtures/. ' +
      'Run vision-test.ts first.',
    );
    process.exit(0);
  }

  const evaluations: ModelEvaluation[] = outputFiles.map(({ modelName, filePath }) => {
    const content = readFileSync(filePath, 'utf-8');
    const ev = evaluateOutput(modelName, content, expectedContent);
    return ev;
  });

  const ranked = rankModels(evaluations);

  console.log('\n[compare-output] === Vision Model Bake-off Results ===\n');
  console.log(formatSummaryTable(ranked));
  console.log();

  const winner = ranked[0];
  if (winner) {
    const allCalloutsPresent = Object.values(winner.calloutPresence).every(Boolean);
    const fullyQualified =
      allCalloutsPresent && winner.hasLatexBlock && winner.hasCompleteAdjacency;

    console.log(`Best model: ${winner.modelName}`);
    console.log(`  Levenshtein distance from ground truth: ${winner.levenshteinDistance}`);
    console.log(`  All required callouts present: ${allCalloutsPresent ? 'YES' : 'NO'}`);
    console.log(`  LaTeX display block present: ${winner.hasLatexBlock ? 'YES' : 'NO'}`);
    console.log(`  Complete adjacency JSON present: ${winner.hasCompleteAdjacency ? 'YES' : 'NO'}`);
    console.log(`  Fully qualified winner: ${fullyQualified ? 'YES' : 'NO'}`);
  }
}

// Only run main() when executed directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
