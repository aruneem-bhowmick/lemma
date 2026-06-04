/**
 * Shared TypeScript interfaces for the Lemma ingestion pipeline.
 *
 * All pipeline stages (discover, detect, render, convert, write) and the
 * database layer import from this module to ensure type consistency across
 * the entire codebase.
 */

/** Metadata for a single OneNote page as returned by the Graph API. */
export interface PageMeta {
  /** OneNote page identifier (GUID). */
  id: string;
  /** Human-readable page title. */
  title: string;
  /** Display name of the section the page belongs to. */
  section: string;
  /** ISO 8601 timestamp of the last modification from Graph API. */
  lastModifiedDateTime: string;
}

/** A single row in the `pages` manifest table. */
export interface ManifestEntry {
  /** OneNote page identifier (primary key). */
  id: string;
  /** Human-readable page title. */
  title: string;
  /** Section display name. */
  section: string;
  /** ISO 8601 timestamp of the last modification stored in the manifest. */
  last_modified: string;
  /** SHA-256 content hash of the rendered image, prefixed with 'sha256:'. Null if not yet processed. */
  content_hash: string | null;
  /** Relative path to the generated Markdown file. Null if not yet processed. */
  markdown_path: string | null;
  /** Processing status: pending = not yet processed, processed = complete, failed = last run errored. */
  status: 'pending' | 'processed' | 'failed';
  /** ISO 8601 timestamp of the last successful processing run. Null if never processed. */
  processed_at: string | null;
  /**
   * Error message from the most recent failed processing attempt.
   * Null for non-failed rows and for rows that have never been processed.
   * Truncated to 2000 characters before storage.
   */
  error_message: string | null;
}

/** Structured adjacency representation of a hand-drawn graph diagram. */
export interface DiagramData {
  /** Graph type as identified by the vision model. */
  type: 'undirected' | 'directed' | 'weighted';
  /** Array of vertex labels extracted from the diagram. */
  vertices: string[];
  /**
   * Edge list. Unweighted graphs: [from, to] pairs.
   * Weighted graphs: [from, to, weight] triples.
   */
  edges: Array<[string, string] | [string, string, number]>;
  /** Caption matching the [!diagram] callout title. */
  caption: string;
}

/** Fully converted page produced by the vision conversion stage. */
export interface ConvertedPage {
  /** OneNote page identifier. */
  pageId: string;
  /** Human-readable page title. */
  title: string;
  /** Section display name. */
  section: string;
  /** ISO 8601 last-modified timestamp from Graph API. */
  lastModified: string;
  /** SHA-256 content hash of the rendered image, prefixed with 'sha256:'. */
  contentHash: string;
  /** Full Markdown body (callouts + prose), validated and with assets resolved. */
  markdown: string;
  /** YAML frontmatter fields as a plain object (used to generate the ---...--- block). */
  frontmatter: Record<string, unknown>;
  /** All structured diagram adjacency blocks extracted from [!diagram] callouts. */
  diagrams: DiagramData[];
  /** Absolute paths of diagram asset image files written to ASSETS_DIR. */
  assetPaths: string[];
  /** Confidence level declared by the vision model. */
  confidence: 'high' | 'medium' | 'low';
}

/** Summary returned by the pipeline orchestrator after a full run. */
export interface PipelineResult {
  /** Number of pages successfully written to corpus. */
  processed: number;
  /** Number of pages skipped (unchanged since last run). */
  skipped: number;
  /** Number of pages that failed processing (error recorded in manifest). */
  failed: number;
  /** Per-page failure details for logging and reporting. */
  errors: Array<{ pageId: string; error: string }>;
}
