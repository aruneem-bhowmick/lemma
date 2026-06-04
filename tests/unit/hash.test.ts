/**
 * Unit tests for src/pipeline/hash.ts.
 *
 * These tests are purely computational — no mocks are needed because
 * hashBuffer and hashString are pure functions over the Node.js `crypto`
 * module, which is always available in the test environment.
 *
 * The suite verifies:
 *  - Output always begins with the 'sha256:' prefix.
 *  - Total length is exactly 71 characters (7-char prefix + 64-char hex digest).
 *  - Hashing the same input twice produces the same output (determinism).
 *  - Different inputs produce different outputs (collision resistance at the
 *    practical level used by the pipeline).
 */

import { describe, it, expect } from 'vitest';
import { hashBuffer, hashString } from '../../src/pipeline/hash.js';

describe('hashBuffer', () => {
  it('returns a sha256: prefixed hex string', () => {
    const result = hashBuffer(Buffer.from('hello'));
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is 71 characters in total (7-char prefix + 64-char digest)', () => {
    const result = hashBuffer(Buffer.from('hello'));
    expect(result).toHaveLength(71);
  });

  it('is deterministic — same buffer yields same hash', () => {
    const buf = Buffer.from('graph-theory-notes');
    expect(hashBuffer(buf)).toBe(hashBuffer(buf));
  });

  it('produces different hashes for different buffers', () => {
    expect(hashBuffer(Buffer.from('a'))).not.toBe(hashBuffer(Buffer.from('b')));
  });

  it('starts with sha256:', () => {
    const result = hashBuffer(Buffer.from('test'));
    expect(result.startsWith('sha256:')).toBe(true);
  });

  it('handles an empty buffer without throwing', () => {
    const result = hashBuffer(Buffer.alloc(0));
    expect(result).toHaveLength(71);
    expect(result.startsWith('sha256:')).toBe(true);
  });

  it('handles a large buffer correctly', () => {
    const large = Buffer.alloc(1024 * 1024, 0x42); // 1 MB of 'B'
    const result = hashBuffer(large);
    expect(result).toHaveLength(71);
    expect(result.startsWith('sha256:')).toBe(true);
  });
});

describe('hashString', () => {
  it('returns a sha256: prefixed hex string', () => {
    const result = hashString('2024-01-15T10:00:00.000Z');
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is 71 characters in total', () => {
    const result = hashString('any string');
    expect(result).toHaveLength(71);
  });

  it('is deterministic — same string yields same hash', () => {
    const ts = '2024-06-04T12:00:00.000Z';
    expect(hashString(ts)).toBe(hashString(ts));
  });

  it('produces different hashes for different strings', () => {
    expect(hashString('2024-01-01T00:00:00Z')).not.toBe(hashString('2024-01-02T00:00:00Z'));
  });

  it('handles an empty string without throwing', () => {
    const result = hashString('');
    expect(result).toHaveLength(71);
    expect(result.startsWith('sha256:')).toBe(true);
  });

  it('matches the known SHA-256 hash of the empty string', () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const result = hashString('');
    expect(result).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
