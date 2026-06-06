/**
 * Stage 5 of the Lemma pipeline: file write.
 *
 * Composes the final Markdown file from frontmatter + validated body,
 * writes it to the corpus directory under a section-slug subdirectory,
 * and updates the manifest to 'processed'.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import matter from 'gray-matter';
import type { ConvertedPage } from '../types.js';
import { generateFrontmatter } from './frontmatter.js';
import { markProcessed } from '../db/queries.js';

/** Output of the write stage for a single page. */
export interface WriteResult {
  /** Absolute path to the written Markdown file. */
  markdownPath: string;
  /** File size in bytes. */
  byteSize: number;
}

/**
 * Thrown when the composed Markdown file cannot be written because the
 * assembled frontmatter block is missing one or more required fields.
 *
 * This is a non-retryable error: a missing field indicates a corrupt
 * ConvertedPage upstream, not a transient I/O failure.  The orchestrator
 * should record this as a per-page failure and move on to the next page.
 */
export class WriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteError';
  }
}

/**
 * Writes the fully assembled Markdown file to the corpus directory.
 *
 * The output path is: `<corpusDir>/<sectionSlug>/<pageId>.md` where
 * `sectionSlug` is the section name lowercased with spaces → hyphens and
 * all non-alphanumeric characters (except hyphens) removed.
 *
 * Execution order:
 * 1. Generate the YAML frontmatter block via `generateFrontmatter()`.
 * 2. Compose the full file content as `frontmatterBlock + '\n' + page.markdown`.
 * 3. Parse the composed content with `gray-matter` and verify that `page_id`,
 *    `title`, and `section` are all present.  Throws `WriteError` immediately
 *    if any field is absent — no I/O is performed.
 * 4. Create the section subdirectory (`recursive: true` keeps it idempotent).
 * 5. Write the file with `writeFileSync` — overwriting any existing file is
 *    intentional and makes re-runs safe.
 * 6. Call `markProcessed()` to set the manifest row to `processed` and store
 *    the markdown path and content hash.
 * 7. Return `{ markdownPath, byteSize }`.
 *
 * When `process.env.DRY_RUN === 'true'`, steps 4–6 are skipped.  The
 * computed path and in-memory byte size are still returned so callers can
 * produce consistent summaries without touching the filesystem or database.
 *
 * @param page      - Fully converted page with validated Markdown and
 *                    frontmatter data.  Must have non-empty `pageId`,
 *                    `title`, `section`, and `contentHash`.
 * @param corpusDir - Absolute path to the corpus root directory.  The
 *                    section subdirectory is created inside it.
 * @returns `WriteResult` with the absolute path and byte size of the file.
 * @throws `WriteError` when the composed frontmatter is missing `page_id`,
 *         `title`, or `section`.  Thrown before any I/O.
 */
export async function writePage(page: ConvertedPage, corpusDir: string): Promise<WriteResult> {
  const dryRun = process.env.DRY_RUN === 'true';

  const sectionSlug = slugifySection(page.section);
  const sectionDir = path.join(corpusDir, sectionSlug);
  const markdownPath = path.join(sectionDir, `${page.pageId}.md`);

  // Compose the full file content: frontmatter block + blank separator + body.
  const frontmatterBlock = generateFrontmatter(page);
  const content = frontmatterBlock + '\n' + page.markdown;

  // Validate the composed frontmatter before any I/O so that corrupt output
  // is never written to disk.  gray-matter is used so the same parser
  // downstream consumers rely on confirms the block is well-formed.
  const { data: fm } = matter(content);
  const missingFields: string[] = [];
  if (!fm['page_id']) missingFields.push('page_id');
  if (!fm['title']) missingFields.push('title');
  if (!fm['section']) missingFields.push('section');
  if (missingFields.length > 0) {
    throw new WriteError(
      `page ${page.pageId}: composed frontmatter is missing required fields: ` +
        missingFields.join(', '),
    );
  }

  if (dryRun) {
    const byteSize = Buffer.byteLength(content, 'utf-8');
    console.log(`[DRY RUN] [write] page ${page.pageId} → ${markdownPath} (${byteSize} bytes)`);
    return { markdownPath, byteSize };
  }

  // Create the section subdirectory.  recursive: true makes this a no-op when
  // the directory already exists, which is the normal case on re-runs.
  fs.mkdirSync(sectionDir, { recursive: true });

  // Write the file; overwriting an existing file is intentional and safe —
  // the content is deterministic given the same ConvertedPage input.
  fs.writeFileSync(markdownPath, content, 'utf-8');

  const byteSize = fs.statSync(markdownPath).size;

  console.log(`[write] page ${page.pageId} → ${markdownPath} (${byteSize} bytes)`);

  // Record the successful write in the manifest so the change-detection stage
  // can skip this page on the next run.
  await markProcessed(page.pageId, markdownPath, page.contentHash);

  return { markdownPath, byteSize };
}

/**
 * Converts a section display name to a URL-safe slug.
 *
 * First decomposes Unicode characters via NFD normalization and strips
 * combining diacritical marks so accented Latin letters (e.g. 'é' → 'e')
 * survive the ASCII reduction step.  Then lowercases, converts spaces to
 * hyphens, and removes remaining non-alphanumeric characters.
 *
 * When the result would be empty (e.g. for CJK or emoji-only names), a
 * deterministic fallback slug is returned — "untitled-section-<8-char hash>"
 * derived from the original string — so the corpus path
 * <corpusDir>/<sectionSlug>/<pageId>.md is always valid.
 *
 * @param section - Raw section name (e.g. 'Graph Theory', '数学').
 * @returns Non-empty slug string (e.g. 'graph-theory', 'untitled-section-8d08a8b7').
 */
export function slugifySection(section: string): string {
  const slug = section
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  if (slug === '') {
    const shortHash = createHash('sha256').update(section).digest('hex').slice(0, 8);
    return `untitled-section-${shortHash}`;
  }

  return slug;
}
