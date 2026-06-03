#!/usr/bin/env ts-node
/**
 * @fileoverview Rendering experiment runner for the Lemma validation spike.
 *
 * Accepts a PNG, JPEG, or PDF file path as its only argument and normalises it
 * to a PNG buffer suitable for vision-model processing.  For PDF input, page 1
 * is rasterised at 150 DPI using pdfjs-dist + the `canvas` package.  The
 * resulting image is written to `scripts/spike/fixtures/rendered.png`.
 *
 * Usage:
 *   npx ts-node scripts/spike/render-test.ts <path-to-png-or-pdf>
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Minimum width in pixels for adequate vision-model accuracy. */
export const MIN_WIDTH_PX = 1668;

/** Path where the normalised PNG is written. */
export const OUTPUT_PATH = join(__dirname, 'fixtures', 'rendered.png');

/** PDF magic-byte signature (first 4 bytes). */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

/** Target DPI for rasterising PDF pages. */
const TARGET_DPI = 150;

/** PDF internal unit size (points per inch). */
const PDF_PPI = 72;

/**
 * Returns `true` when the leading bytes of `buf` match the PDF magic signature.
 *
 * @param buf - Buffer whose first bytes are checked.
 */
export function isPdf(buf: Buffer): boolean {
  if (buf.length < PDF_MAGIC.length) return false;
  return buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/**
 * Rasterises the first page of a PDF file to a PNG buffer at {@link TARGET_DPI} DPI.
 *
 * Accepts the PDF as a pre-read `Buffer` so the caller reads the file exactly
 * once and can reuse the same buffer for both magic-byte detection and rendering.
 * Requires the optional `canvas` npm package for Node.js rendering.  Throws a
 * descriptive error if `canvas` is absent so the caller can fall back gracefully.
 *
 * @param pdfData - Raw bytes of the PDF file.
 * @returns PNG-encoded buffer of the first page.
 * @throws Error if the `canvas` package is not installed or rendering fails.
 */
export async function rasterizePdf(pdfData: Buffer): Promise<Buffer> {
  let createCanvas: (width: number, height: number) => {
    getContext(type: '2d'): CanvasRenderingContext2D;
    toBuffer(mime: string): Buffer;
  };

  try {
    // canvas is an optional dev dependency — inform the user clearly if missing
    const canvasPkg = await import('canvas');
    createCanvas = canvasPkg.createCanvas as typeof createCanvas;
  } catch {
    throw new Error(
      'PDF rasterisation requires the canvas package.\n' +
      'Run: npm install canvas\n' +
      'Then retry: npx ts-node scripts/spike/render-test.ts <pdf-path>',
    );
  }

  // pdfjs-dist v4 — disable the web worker to run headlessly in Node.js
  const pdfjsLib = await import('pdfjs-dist');
  (pdfjsLib.GlobalWorkerOptions as { workerSrc: string }).workerSrc = '';

  const data = new Uint8Array(pdfData);
  const pdfDoc = await pdfjsLib.getDocument({
    data,
    disableAutoFetch: true,
    disableStream: true,
  }).promise;

  const page = await pdfDoc.getPage(1);
  const scale = TARGET_DPI / PDF_PPI;
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');

  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;

  return canvas.toBuffer('image/png');
}

/**
 * Normalises a raw image buffer to PNG using sharp and validates the resolution.
 *
 * Logs a warning when the image width is below {@link MIN_WIDTH_PX} because
 * low-resolution images degrade vision-model accuracy.
 *
 * @param imageBuffer - Raw image bytes (any format accepted by sharp).
 * @returns PNG-encoded buffer.
 */
export async function normaliseToPng(imageBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();

  console.log(
    `[render-test] Input dimensions: ${metadata.width ?? '?'}×${metadata.height ?? '?'}px`,
  );

  if ((metadata.width ?? 0) < MIN_WIDTH_PX) {
    console.warn(
      `[render-test] WARNING: image width ${metadata.width}px is below the ` +
      `${MIN_WIDTH_PX}px minimum — vision accuracy may be degraded.`,
    );
  }

  return sharp(imageBuffer).png().toBuffer();
}

/**
 * Main entry point.  Reads the input file once, uses {@link isPdf} on the
 * buffer for content-based format detection, normalises to PNG, and writes the
 * result to the fixtures directory.
 */
async function main(): Promise<void> {
  const inputArg = process.argv[2];

  if (!inputArg) {
    console.error('Usage: npx ts-node scripts/spike/render-test.ts <path-to-png-or-pdf>');
    process.exit(1);
  }

  const absolutePath = resolve(inputArg);

  // Read the file once; the same buffer is used for detection and processing.
  const rawBuffer = readFileSync(absolutePath);

  let inputBuffer: Buffer;

  if (isPdf(rawBuffer)) {
    // Content-based detection takes priority over file extension.
    console.log('[render-test] PDF detected by magic bytes — rasterising page 1 at 150 DPI…');
    inputBuffer = await rasterizePdf(rawBuffer);
  } else {
    const ext = extname(absolutePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      console.warn(
        `[render-test] Unrecognised extension '${ext}' — ` +
        'will attempt to process as image via sharp.',
      );
    } else {
      console.log(`[render-test] Image file (${ext}) — reading…`);
    }
    inputBuffer = rawBuffer;
  }

  const pngBuffer = await normaliseToPng(inputBuffer);
  writeFileSync(OUTPUT_PATH, pngBuffer);

  const outMeta = await sharp(pngBuffer).metadata();
  console.log(`[render-test] Written to: ${OUTPUT_PATH}`);
  console.log(
    `[render-test] Dimensions: ${outMeta.width ?? '?'}×${outMeta.height ?? '?'}px`,
  );
  console.log(`[render-test] File size: ${pngBuffer.length.toLocaleString()} bytes`);
}

// Only run main() when executed directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('[render-test] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
