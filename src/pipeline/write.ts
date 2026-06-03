/**
 * Stage 5 of the Lemma pipeline: file write.
 *
 * Composes the final Markdown file from frontmatter + validated body,
 * writes it to the corpus directory under a section-slug subdirectory,
 * and updates the manifest to 'processed'.
 *
 * Implemented in full by Prompt 10.
 */

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
  throw new Error('writePage not yet implemented — see Prompt 10');
}

/**
 * Converts a section display name to a URL-safe slug.
 *
 * Lowercases the input, replaces spaces with hyphens, and removes any
 * characters that are not alphanumeric or hyphens.
 *
 * @param section - Raw section name (e.g. 'Graph Theory').
 * @returns Slug string (e.g. 'graph-theory').
 */
export function slugifySection(section: string): string {
  return section
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}
