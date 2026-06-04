/**
 * Stage 5 of the Lemma pipeline: file write.
 *
 * Composes the final Markdown file from frontmatter + validated body,
 * writes it to the corpus directory under a section-slug subdirectory,
 * and updates the manifest to 'processed'.
 */

import { createHash } from 'crypto';
import type { ConvertedPage } from '../types.js';

/** Output of the write stage for a single page. */
export interface WriteResult {
  /** Absolute path to the written Markdown file. */
  markdownPath: string;
  /** File size in bytes. */
  byteSize: number;
}

/**
 * Writes the fully assembled Markdown file to the corpus directory.
 *
 * The output path is: <corpusDir>/<sectionSlug>/<pageId>.md
 * where sectionSlug is the section name lowercased with spaces → hyphens
 * and non-alphanumeric characters (except hyphens) removed.
 *
 * @param page - Fully converted page with validated Markdown and frontmatter.
 * @param corpusDir - Absolute path to the corpus root directory.
 * @returns WriteResult with the path and size of the written file.
 * @throws WriteError when frontmatter validation fails before the write.
 */
export async function writePage(page: ConvertedPage, corpusDir: string): Promise<WriteResult> {
  void page;
  void corpusDir;
  throw new Error('writePage is not yet implemented');
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
