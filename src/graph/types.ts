/**
 * TypeScript interfaces for Microsoft Graph API responses used by GraphClient.
 *
 * Typed against the subset of the Graph API schema that the Lemma pipeline
 * requires: notebook pages, section metadata, and pagination links.
 */

/** A single OneNote page as returned by the Graph API. */
export interface GraphPage {
  /** Graph API page identifier (GUID). */
  id: string;
  /** Human-readable page title. */
  title: string;
  /** ISO 8601 timestamp of the last modification. */
  lastModifiedDateTime: string;
  /** Parent section metadata. */
  parentSection: {
    /** Section identifier. */
    id: string;
    /** Section display name. */
    displayName: string;
  };
  /** URL for fetching the page's rendered content or export. */
  contentUrl: string;
}

/** Graph API paginated response for a collection of pages. */
export interface GraphPageList {
  /** Array of pages in the current page of results. */
  value: GraphPage[];
  /** Link to the next page of results, if present. */
  '@odata.nextLink'?: string;
}

/** A single OneNote section as returned by the Graph API. */
export interface GraphSection {
  /** Section identifier. */
  id: string;
  /** Section display name. */
  displayName: string;
}
