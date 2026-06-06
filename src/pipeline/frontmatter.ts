/**
 * YAML frontmatter generation for Lemma corpus Markdown files.
 *
 * Every file written to the corpus begins with a YAML frontmatter block that
 * captures the page's identity, source provenance, structural properties, and
 * vision model confidence.  Downstream tools (chunking, triple extraction,
 * search indexing) parse this block to quickly filter and route pages without
 * reading the full Markdown body.
 *
 * The frontmatter is serialised from a ConvertedPage using js-yaml so that
 * string escaping is handled correctly (e.g. page titles containing colons or
 * quote characters remain valid YAML).  Concepts are sorted alphabetically so
 * the output is deterministic regardless of the order the vision model returned
 * them.
 */

import yaml from 'js-yaml';
import type { ConvertedPage } from '../types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates the YAML frontmatter block for a corpus Markdown file.
 *
 * The returned string begins with `---\n` and ends with `---\n`, ready to be
 * prepended to the Markdown body with a single `\n` separator.
 *
 * Fields are written in a fixed order:
 *   page_id, title, section, last_modified, source_hash,
 *   concepts (sorted A→Z), has_diagrams, confidence.
 *
 * Concept titles are read from `page.frontmatter['concepts']` (the array
 * populated by the convert stage) and sorted alphabetically before output.
 *
 * @param page - Fully converted page; `page.frontmatter` must contain a
 *               `concepts` key with a string array.
 * @returns A `---\n…\n---\n` YAML block string, safe to write to disk.
 */
export function generateFrontmatter(page: ConvertedPage): string {
  const rawConcepts = (page.frontmatter['concepts'] as string[] | undefined) ?? [];
  const concepts = [...rawConcepts].sort();

  // Build the data object with keys in the documented output order.
  // js-yaml preserves insertion order for plain objects.
  const data: Record<string, unknown> = {
    page_id: page.pageId,
    title: page.title,
    section: page.section,
    last_modified: page.lastModified,
    source_hash: page.contentHash,
    concepts,
    has_diagrams: page.diagrams.length > 0,
    confidence: page.confidence,
  };

  const yamlBody = yaml.dump(data, {
    // Prefer double quotes when quoting is required; do not force-quote
    // strings that yaml can represent unquoted.
    quotingType: '"',
    forceQuotes: false,
  });

  return `---\n${yamlBody}---\n`;
}
