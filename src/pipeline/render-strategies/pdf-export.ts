/**
 * Rendering strategy A: Microsoft Graph PDF export + pdfjs-dist rasterisation.
 *
 * Calls the Graph API to export the page, then checks whether the returned
 * bytes are a PDF (magic bytes `%PDF`). If so, rasterises page 1 to a JPEG
 * buffer using pdfjs-dist + sharp at 150 DPI. If the bytes are already JPEG,
 * they are returned directly.
 *
 * This strategy is the primary automated path and works reliably for typed
 * content on work/school Microsoft accounts. For personal accounts, the Graph
 * export endpoint may return HTTP 415 for handwritten-ink pages, in which case
 * the GraphError propagates and the orchestrator falls back to the next strategy.
 */

import type { PageMeta } from '../../types.js';
import type { GraphClient } from '../../graph/client.js';

/** PDF file magic bytes — the first four bytes of every valid PDF file. */
const PDF_MAGIC = Buffer.from('%PDF');

/**
 * Rasterises the first page of a PDF buffer to a JPEG buffer at ~150 DPI.
 *
 * Uses pdfjs-dist to parse and render the PDF page onto a node-canvas surface,
 * then encodes the result as JPEG quality 92 via sharp. Both libraries are
 * loaded dynamically so that this module can be imported in unit tests without
 * triggering native add-on initialisation.
 *
 * The scale factor 150/72 converts from the PDF default of 72 DPI to 150 DPI,
 * which is the minimum resolution recommended for reliable vision model input.
 *
 * @param pdfBuffer - Raw PDF bytes (must begin with the `%PDF` magic sequence).
 * @returns JPEG buffer at ~150 DPI, quality 92.
 * @throws Error if pdfjs-dist, canvas, or sharp cannot be loaded or if page
 *         rendering fails for any reason.
 */
export async function rasterizePdfBuffer(pdfBuffer: Buffer): Promise<Buffer> {
  const pdfjsLib = await import('pdfjs-dist');
  const sharpModule = await import('sharp');
  const canvasModule = await import('canvas');

  const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const page = await pdfDoc.getPage(1);

  // Scale from the PDF default of 72 DPI to ~150 DPI for adequate vision model quality.
  const scale = 150 / 72;
  const viewport = page.getViewport({ scale });

  const canvas = canvasModule.createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const context = canvas.getContext('2d');

  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;

  const pngBuffer = canvas.toBuffer('image/png');
  return sharpModule.default(pngBuffer).jpeg({ quality: 92 }).toBuffer();
}

/**
 * Fetches a OneNote page image via the Graph API export endpoint.
 *
 * Delegates the HTTP call to {@link GraphClient.renderPageAsImage}, which
 * handles JPEG vs PDF content-type negotiation. The raw bytes returned are
 * then inspected: if they begin with the PDF magic sequence (`%PDF`), this
 * strategy rasterises page 1 locally using {@link rasterizePdfBuffer} before
 * returning. Otherwise the bytes are assumed to be JPEG and returned as-is.
 *
 * The local PDF check is a defensive belt-and-suspenders measure. The Graph
 * client already attempts rasterisation server-side; the local path handles
 * the case where the client returns raw PDF bytes (e.g. when the canvas
 * package was unavailable at the time of the Graph client call).
 *
 * @param page   - Page metadata including the Graph content URL.
 * @param client - Authenticated Graph API client.
 * @returns JPEG buffer suitable for vision model input.
 * @throws {@link GraphError} propagated from the Graph client on HTTP failures.
 * @throws Error if local PDF rasterisation fails.
 */
export async function pdfExportStrategy(page: PageMeta, client: GraphClient): Promise<Buffer> {
  const arrayBuffer = await client.renderPageAsImage(page.contentUrl, page.id);
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.subarray(0, 4).equals(PDF_MAGIC)) {
    return rasterizePdfBuffer(buffer);
  }

  return buffer;
}
