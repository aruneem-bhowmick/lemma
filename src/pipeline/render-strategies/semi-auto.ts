/**
 * Rendering strategy C: semi-automated export via a local drop folder.
 *
 * The user exports a OneNote section or page to PDF from the iPad or desktop
 * app, then places the file in a configured drop folder. The strategy checks
 * for a file named `<pageId>.pdf`, rasterises it using pdfjs-dist + sharp
 * (via {@link rasterizePdfBuffer}), and returns a JPEG buffer.
 *
 * This is the current primary strategy for personal Microsoft accounts where
 * the Graph API does not support rendering handwritten-ink pages directly.
 *
 * Configuration:
 *   SEMI_AUTO_DROP_DIR   — directory the pipeline watches for exported PDFs.
 *   SEMI_AUTO_TIMEOUT_MS — maximum milliseconds to wait for the file to appear.
 *                          0 (default) means check once and throw if absent.
 *
 * Typical usage:
 *   1. Open OneNote on iPad or desktop.
 *   2. Export section → PDF (File → Export → Section → PDF).
 *   3. Place the PDF in SEMI_AUTO_DROP_DIR as `<pageId>.pdf`.
 *   4. Run the pipeline — it will find, rasterise, and process the file.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { PageMeta } from '../../types.js';
import { rasterizePdfBuffer } from './pdf-export.js';

/** Poll interval when SEMI_AUTO_TIMEOUT_MS > 0. */
const POLL_INTERVAL_MS = 200;

/**
 * Attempts to read a PDF for the given page from the drop directory.
 *
 * Uses a single `readFileSync` call rather than an `existsSync` + `readFileSync`
 * pair to avoid the TOCTOU race where a file could be deleted or replaced between
 * the existence check and the read. ENOENT (file absent) is the expected
 * not-yet-ready case and returns `null`; any other error (e.g. EISDIR, EACCES)
 * indicates an unexpected problem and is re-thrown so it surfaces clearly.
 *
 * @param dropDir - Path to the drop folder.
 * @param pageId  - OneNote page identifier; the expected filename is `<pageId>.pdf`.
 * @returns Raw PDF bytes if the file is present and readable, otherwise `null`.
 * @throws The original error for any file-system failure other than ENOENT.
 */
function tryReadDropFile(dropDir: string, pageId: string): Buffer | null {
  const filePath = join(dropDir, `${pageId}.pdf`);
  try {
    return readFileSync(filePath);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Renders a OneNote page from a manually exported PDF placed in a drop folder.
 *
 * Looks for `<page.id>.pdf` in the directory specified by `SEMI_AUTO_DROP_DIR`.
 * If `SEMI_AUTO_TIMEOUT_MS` is greater than zero the strategy polls every
 * {@link POLL_INTERVAL_MS} milliseconds until the file appears or the timeout
 * elapses. If timeout is 0 (the default), a single presence check is performed
 * and the strategy throws immediately when the file is absent.
 *
 * The found PDF is rasterised to a JPEG buffer via {@link rasterizePdfBuffer}
 * (pdfjs-dist + sharp at ~150 DPI, quality 92).
 *
 * @param page - Page metadata; `page.id` determines the expected filename.
 * @returns JPEG buffer suitable for vision model input.
 * @throws Error if `SEMI_AUTO_DROP_DIR` is not set in the environment.
 * @throws Error if `SEMI_AUTO_TIMEOUT_MS` is set to an invalid value and the
 *   caller cannot tolerate check-once fallback behaviour (the strategy will
 *   warn and proceed rather than throw on misconfiguration).
 * @throws Error if the expected PDF is not found within the timeout period.
 * @throws Error if PDF rasterisation fails.
 */
export async function semiAutoStrategy(page: PageMeta): Promise<Buffer> {
  const dropDir = process.env.SEMI_AUTO_DROP_DIR;
  if (!dropDir) {
    throw new Error(
      `semi-auto render strategy requires SEMI_AUTO_DROP_DIR to be set. ` +
        `Export the page from OneNote to PDF and configure the drop folder path.`,
    );
  }

  const rawTimeout = process.env.SEMI_AUTO_TIMEOUT_MS ?? '0';
  const parsedTimeout = Number(rawTimeout);
  let timeoutMs: number;
  if (!Number.isFinite(parsedTimeout) || !Number.isInteger(parsedTimeout) || parsedTimeout < 0) {
    console.warn(
      `[semi-auto] SEMI_AUTO_TIMEOUT_MS='${rawTimeout}' is not a valid non-negative integer; ` +
        `falling back to 0 (check-once mode).`,
    );
    timeoutMs = 0;
  } else {
    timeoutMs = parsedTimeout;
  }

  let rawBuffer = tryReadDropFile(dropDir, page.id);

  if (!rawBuffer && timeoutMs > 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      rawBuffer = tryReadDropFile(dropDir, page.id);
      if (rawBuffer) break;
    }
  }

  if (!rawBuffer) {
    const expectedPath = join(dropDir, `${page.id}.pdf`);
    throw new Error(
      `semi-auto strategy: expected PDF not found at '${expectedPath}'. ` +
        `Export the page from OneNote (File → Export → Page → PDF) and ` +
        `place it in the configured drop folder: ${dropDir}`,
    );
  }

  return rasterizePdfBuffer(rawBuffer);
}
