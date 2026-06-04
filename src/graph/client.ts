/**
 * Authenticated HTTP client for Microsoft Graph OneNote API operations.
 *
 * Responsibilities:
 *  - Acquiring and caching access tokens via `src/graph/auth.ts`.
 *  - Following @odata.nextLink pagination when listing pages.
 *  - Automatic one-shot retry on 401 (expired token) by re-acquiring and retrying.
 *  - Exponential-like back-off on 429 (rate limit) using the Retry-After header,
 *    up to three attempts.
 *  - Rendering fallback: prefers image/jpeg from the Graph export endpoint;
 *    falls back to application/pdf + rasterization when the image endpoint
 *    returns a 4xx status.
 *  - Structured stderr logging for every outbound request.
 *
 * This class is intentionally thin: it does not interpret or transform page
 * content.  That belongs to the pipeline stages in src/pipeline/.
 */

import { acquireToken } from './auth.js';
import type { GraphPage, GraphPageList } from './types.js';

/** Microsoft Graph API base URL. */
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Maximum number of 429 retries before giving up on a single request. */
const MAX_RATE_LIMIT_RETRIES = 3;

/** Fallback Retry-After delay (ms) when the header is absent or unparseable. */
const DEFAULT_RETRY_AFTER_MS = 1000;

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/**
 * Thrown by GraphClient when an API call returns an unexpected HTTP status.
 *
 * The `httpStatus` field carries the raw HTTP response code so callers can
 * branch on specific failure modes (401 vs 429 vs 5xx) without string-parsing.
 * The optional `code` field holds a semantic identifier for errors that have
 * named failure modes (e.g. `'renderingUnsupported'`).
 */
export class GraphError extends Error {
  /** HTTP status code of the failing response. */
  readonly httpStatus: number;
  /** Optional semantic error code (e.g. `'renderingUnsupported'`). */
  readonly code?: string;

  /**
   * @param message    - Human-readable description of the failure.
   * @param httpStatus - HTTP status code returned by Graph.
   * @param code       - Optional semantic error identifier.
   */
  constructor(message: string, httpStatus: number, code?: string) {
    super(message);
    this.name = 'GraphError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// GraphClient
// ---------------------------------------------------------------------------

/**
 * Authenticated client for Microsoft Graph OneNote API operations.
 *
 * All methods acquire a fresh access token before each request and
 * automatically retry once on 401 (token expiry) and up to three times on
 * 429 (rate limit).
 */
export class GraphClient {
  // ─── Private helpers ────────────────────────────────────────────────────

  /**
   * Performs an authenticated HTTP GET, handling 401 retry and 429 back-off.
   *
   * Logs `[GraphClient] GET <url> → <status> (<ms>ms)` to stderr after each
   * attempt so every network call is observable in CI logs.
   *
   * @param url           - Absolute URL to fetch.
   * @param acceptHeader  - Value for the `Accept` request header.
   * @param retryOn401    - When true (default), re-acquires the token and
   *                        retries once on a 401 response before throwing.
   * @returns The successful HTTP Response object.
   * @throws  GraphError on non-success status after all retries are exhausted.
   */
  private async _get(
    url: string,
    acceptHeader: string,
    retryOn401 = true,
  ): Promise<Response> {
    let rateLimitRetries = 0;

    const attempt = async (refreshToken: boolean): Promise<Response> => {
      // When retrying after a 401 (refreshToken === false) force the cache to
      // be bypassed so the stale token that was just rejected is not reused.
      const { accessToken } = await acquireToken(!refreshToken);
      const start = Date.now();

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: acceptHeader,
        },
      });

      const ms = Date.now() - start;
      process.stderr.write(`[GraphClient] GET ${url} → ${response.status} (${ms}ms)\n`);

      if (response.status === 401) {
        if (refreshToken) {
          // Re-acquire (force cache invalidation) then retry once.
          return attempt(false);
        }
        throw new GraphError(`Graph API returned 401 Unauthorized for ${url}`, 401);
      }

      if (response.status === 429) {
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          throw new GraphError(
            `Graph API rate limit exceeded after ${MAX_RATE_LIMIT_RETRIES} retries for ${url}`,
            429,
          );
        }
        rateLimitRetries += 1;
        const retryAfterHeader = response.headers.get('Retry-After');
        let retryAfterMs = DEFAULT_RETRY_AFTER_MS;
        if (retryAfterHeader !== null) {
          if (/^\d+$/.test(retryAfterHeader.trim())) {
            // Delta-seconds form: "120"
            retryAfterMs = parseInt(retryAfterHeader.trim(), 10) * 1000;
          } else {
            // HTTP-date form: "Wed, 21 Oct 2015 07:28:00 GMT"
            const parsedDate = Date.parse(retryAfterHeader);
            if (!isNaN(parsedDate)) {
              const ms = parsedDate - Date.now();
              retryAfterMs = ms > 0 ? ms : DEFAULT_RETRY_AFTER_MS;
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        return attempt(refreshToken);
      }

      return response;
    };

    return attempt(retryOn401);
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Returns all pages in the target notebook, following @odata.nextLink
   * pagination until the full result set is retrieved.
   *
   * Uses a single Graph endpoint with the `parentSection` expansion to
   * populate the `parentSection` field on each returned GraphPage.  The
   * `$top=100` parameter caps each page of results; most notebooks will be
   * fully returned in one or two requests.
   *
   * @param notebookId - OneNote notebook identifier (GUID).
   * @returns Complete array of GraphPage objects for every page in the notebook.
   * @throws  GraphError with the HTTP status field set on any API failure.
   */
  async listPages(notebookId: string): Promise<GraphPage[]> {
    const filter = encodeURIComponent(`parentNotebook/id eq '${notebookId}'`);
    const initialUrl =
      `${GRAPH_BASE}/me/onenote/pages` +
      `?$expand=parentSection` +
      `&$top=100` +
      `&$select=id,title,lastModifiedDateTime,contentUrl,parentSection` +
      `&$filter=${filter}`;

    const pages: GraphPage[] = [];
    let nextUrl: string | undefined = initialUrl;

    while (nextUrl !== undefined) {
      const response = await this._get(nextUrl, 'application/json');

      if (!response.ok) {
        throw new GraphError(
          `Graph API returned ${response.status} when listing pages for notebook ${notebookId}`,
          response.status,
        );
      }

      const body = (await response.json()) as GraphPageList;
      pages.push(...body.value);
      nextUrl = body['@odata.nextLink'];
    }

    return pages;
  }

  /**
   * Fetches a rendered image of a single OneNote page as an ArrayBuffer.
   *
   * Prefers `image/jpeg` from the page's content URL.  If the Graph API
   * returns 415 (Unsupported Media Type) or 404 for the JPEG request — which
   * can happen for pages whose ink content cannot be directly exported as an
   * image — the method falls back to requesting `application/pdf` and
   * rasterizing the first page to JPEG using pdfjs-dist + sharp.  If both
   * formats fail, `GraphError` is thrown with `code: 'renderingUnsupported'`.
   *
   * The returned ArrayBuffer always contains JPEG bytes regardless of the
   * rendering path taken.
   *
   * @param contentUrl - Graph API export URL for the page (from GraphPage.contentUrl).
   * @param pageId     - Page identifier used in error messages for diagnostics.
   * @returns ArrayBuffer containing JPEG image bytes.
   * @throws  GraphError with httpStatus on failure; code 'renderingUnsupported'
   *          if neither JPEG nor PDF rendering succeeds.
   */
  async renderPageAsImage(contentUrl: string, pageId: string): Promise<ArrayBuffer> {
    // Attempt 1: request JPEG directly.
    const jpegResponse = await this._get(contentUrl, 'image/jpeg');

    if (jpegResponse.ok) {
      return jpegResponse.arrayBuffer();
    }

    // 415 or 404: the Graph export endpoint does not support JPEG for this page type.
    // Fall back to PDF and rasterize the first page.
    if (jpegResponse.status === 415 || jpegResponse.status === 404) {
      const pdfResponse = await this._get(contentUrl, 'application/pdf');

      if (pdfResponse.ok) {
        const contentType = pdfResponse.headers.get('Content-Type') ?? '';

        if (contentType.includes('image/')) {
          // Some Graph endpoints return an image even when Accept: application/pdf is sent.
          return pdfResponse.arrayBuffer();
        }

        // Convert the PDF buffer to JPEG using pdfjs-dist + sharp.
        const pdfBuffer = await pdfResponse.arrayBuffer();
        return this._rasterizePdf(pdfBuffer, pageId);
      }

      throw new GraphError(
        `Graph API returned ${pdfResponse.status} for PDF export of page ${pageId}`,
        pdfResponse.status,
        'renderingUnsupported',
      );
    }

    throw new GraphError(
      `Graph API returned ${jpegResponse.status} for JPEG export of page ${pageId}`,
      jpegResponse.status,
      'renderingUnsupported',
    );
  }

  /**
   * Rasterizes the first page of a PDF buffer to a JPEG Buffer using
   * pdfjs-dist and sharp.
   *
   * Requires the optional `canvas` npm package.  If it is not installed, a
   * descriptive GraphError is thrown so the caller can surface a clear message
   * rather than an obscure module-not-found error.
   *
   * @param pdfBuffer - Raw PDF bytes.
   * @param pageId    - Page identifier for error context.
   * @returns Buffer containing JPEG bytes at approximately 150 DPI.
   */
  private async _rasterizePdf(pdfBuffer: ArrayBuffer, pageId: string): Promise<ArrayBuffer> {
    try {
      const pdfjsLib = await import('pdfjs-dist');
      const sharpModule = await import('sharp');
      const { createCanvas } = await import('canvas');

      const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
      const page = await pdfDoc.getPage(1);

      // Scale from the PDF default 72 DPI to ~150 DPI for adequate vision model quality.
      const scale = 150 / 72;
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');

      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      const pngBuffer = canvas.toBuffer('image/png');
      const jpegBuffer = await sharpModule.default(pngBuffer).jpeg({ quality: 92 }).toBuffer();
      return jpegBuffer.buffer.slice(
        jpegBuffer.byteOffset,
        jpegBuffer.byteOffset + jpegBuffer.byteLength,
      ) as ArrayBuffer;
    } catch (err) {
      throw new GraphError(
        `PDF rasterization failed for page ${pageId}: ${(err as Error).message}. ` +
          `Ensure the optional 'canvas' package is installed (npm install canvas).`,
        0,
        'rasterizationFailed',
      );
    }
  }

  /**
   * Returns the raw InkML content for a page.
   *
   * @param pageId - Page identifier.
   * @throws Error — not yet implemented; reserved for a future rendering strategy.
   */
  async getPageInkML(pageId: string): Promise<string> {
    void pageId;
    throw new Error('getPageInkML is not yet implemented');
  }

  /**
   * Performs a lightweight health check by calling the notebooks list endpoint.
   *
   * Returns `true` when Graph responds with 200 (credentials are valid and the
   * required permissions are granted).  Returns `false` on 401 (credentials
   * invalid or token expired).  Throws `GraphError` for any other response
   * status so that unexpected server errors are surfaced rather than silently
   * treated as auth failures.
   *
   * Intended for use in CI pre-steps and local diagnostics via
   * `scripts/auth-check.ts`.
   *
   * @returns `true` if the Graph API is reachable and the token is valid.
   * @throws  GraphError for responses other than 200 or 401.
   */
  async healthCheck(): Promise<boolean> {
    const url = `${GRAPH_BASE}/me/onenote/notebooks`;

    try {
      // Pass retryOn401=false so a 401 here is returned rather than retried;
      // we want to distinguish auth failure from a transient network error.
      const response = await this._get(url, 'application/json', false);

      if (response.status === 200) return true;

      throw new GraphError(
        `Health check returned unexpected status ${response.status}`,
        response.status,
      );
    } catch (err) {
      if (err instanceof GraphError && err.httpStatus === 401) return false;
      throw err;
    }
  }
}
