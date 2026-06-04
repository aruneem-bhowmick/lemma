/**
 * Content hashing utilities for the Lemma pipeline.
 *
 * SHA-256 fingerprints are used at two points in the pipeline:
 *
 *  - The render stage hashes the JPEG image buffer it produces and stores
 *    the result as `content_hash` in the manifest.  On subsequent runs the
 *    change-detection stage can compare the stored hash against a freshly
 *    rendered buffer to detect byte-level changes even when
 *    `lastModifiedDateTime` has not advanced.
 *
 *  - All hash strings are prefixed with `'sha256:'` so that the algorithm
 *    is self-describing.  This makes it straightforward to migrate to a
 *    stronger algorithm in the future without ambiguity about what existing
 *    stored hashes represent.
 */

import { createHash } from 'crypto';

/**
 * Computes a SHA-256 digest of a binary buffer.
 *
 * Typical use: fingerprint a rendered page image so that re-renders of an
 * unchanged page produce the same hash and can be skipped in later runs.
 *
 * @param buf - The buffer to hash.  Empty buffers (`Buffer.alloc(0)`) are
 *              valid; SHA-256 of zero bytes produces a well-defined digest.
 * @returns A lowercase hex digest prefixed with `'sha256:'` (71 characters
 *          total: 7-character prefix + 64-character hex digest).
 */
export function hashBuffer(buf: Buffer): string {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

/**
 * Computes a SHA-256 digest of a UTF-8 string.
 *
 * Typical use: fast pre-filter comparison.  The `lastModifiedDateTime`
 * string from the Graph API can be hashed and compared against the stored
 * value to avoid a full render when nothing has changed.
 *
 * @param s - The string to hash.  Encoded as UTF-8 before hashing.
 * @returns A lowercase hex digest prefixed with `'sha256:'` (71 characters
 *          total: 7-character prefix + 64-character hex digest).
 */
export function hashString(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}
