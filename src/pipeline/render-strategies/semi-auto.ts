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

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { PageMeta } from '../../types.js';
import { rasterizePdfBuffer } from './pdf-export.js';

/** Poll interval when SEMI_AUTO_TIMEOUT_MS > 0. */
const POLL_INTERVAL_MS = 200;

/**
 * Checks whether a PDF file exists for the given page in the drop directory.
 *
 * @param dropDir - Path to the drop folder.
 * @param pageId  - OneNote page identifier; the expected filename is `<pageId>.pdf`.
 * @returns Raw PDF bytes if the file is present, otherwise `null`.
 */
function tryReadDropFile(dropDir: string, pageId: string): Buffer | null {
  const filePath = join(dropDir, `${pageId}.pdf`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath);
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

  const timeoutMs = parseInt(process.env.SEMI_AUTO_TIMEOUT_MS ?? '0', 10);

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
