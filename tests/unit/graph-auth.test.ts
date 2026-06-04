/**
 * Unit tests for src/graph/auth.ts.
 *
 * The global fetch function is replaced with a vi.fn() mock for each test so
 * no real HTTP calls are made.  The module-level token cache is reset in
 * beforeEach to prevent state from one test leaking into the next.
 *
 * Test coverage:
 *  - acquireToken: success path, error path, cache hit, cache miss after expiry
 *  - isTokenValid: true/false based on remaining lifetime vs. 60-second buffer
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireToken,
  isTokenValid,
  AuthError,
  _resetTokenCacheForTest,
  _setTokenCacheForTest,
} from '../../src/graph/auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Typical successful token endpoint response. */
const VALID_TOKEN_RESPONSE = {
  access_token: 'mock-access-token-abc123',
  expires_in: 3600,
  refresh_token: 'new-refresh-token-xyz',
  token_type: 'Bearer',
};

/**
 * Creates a minimal fetch mock that returns one response object.
 *
 * @param body   - The JSON body to return from response.json().
 * @param status - HTTP status code (default 200).
 */
function makeFetchMock(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalAzureClientId: string | undefined;
let originalGraphRefreshToken: string | undefined;
let originalAzureClientSecret: string | undefined;

beforeEach(() => {
  originalAzureClientId = process.env.AZURE_CLIENT_ID;
  originalGraphRefreshToken = process.env.GRAPH_REFRESH_TOKEN;
  originalAzureClientSecret = process.env.AZURE_CLIENT_SECRET;

  _resetTokenCacheForTest();
  vi.unstubAllGlobals();
  process.env.AZURE_CLIENT_ID = 'test-client-id';
  process.env.GRAPH_REFRESH_TOKEN = 'test-refresh-token';
  delete process.env.AZURE_CLIENT_SECRET;
});

afterEach(() => {
  if (originalAzureClientId !== undefined) {
    process.env.AZURE_CLIENT_ID = originalAzureClientId;
  } else {
    delete process.env.AZURE_CLIENT_ID;
  }
  if (originalGraphRefreshToken !== undefined) {
    process.env.GRAPH_REFRESH_TOKEN = originalGraphRefreshToken;
  } else {
    delete process.env.GRAPH_REFRESH_TOKEN;
  }
  if (originalAzureClientSecret !== undefined) {
    process.env.AZURE_CLIENT_SECRET = originalAzureClientSecret;
  } else {
    delete process.env.AZURE_CLIENT_SECRET;
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// acquireToken
// ---------------------------------------------------------------------------

describe('acquireToken', () => {
  it('succeeds with valid refresh token and returns accessToken + expiresAt', async () => {
    vi.stubGlobal('fetch', makeFetchMock(VALID_TOKEN_RESPONSE));

    const result = await acquireToken();

    expect(result.accessToken).toBe(VALID_TOKEN_RESPONSE.access_token);
    expect(result.expiresAt).toBeInstanceOf(Date);
    // expiresAt should be approximately now + 3600s
    const expectedMs = Date.now() + VALID_TOKEN_RESPONSE.expires_in * 1000;
    expect(Math.abs(result.expiresAt.getTime() - expectedMs)).toBeLessThan(500);
  });

  it('throws AuthError with code invalid_grant when token endpoint returns that error', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(
        { error: 'invalid_grant', error_description: 'Refresh token has expired' },
        400,
      ),
    );

    const promise = acquireToken();

    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('uses the cached token on a second call without invoking fetch again', async () => {
    const mockFetch = makeFetchMock(VALID_TOKEN_RESPONSE);
    vi.stubGlobal('fetch', mockFetch);

    await acquireToken(); // populates cache
    const second = await acquireToken(); // should hit cache

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(second.accessToken).toBe(VALID_TOKEN_RESPONSE.access_token);
  });

  it('re-fetches when the cached token is stale (expiry <= 60s away)', async () => {
    // Inject a token that is already within the 60-second buffer window.
    _setTokenCacheForTest({
      accessToken: 'stale-access-token',
      expiresAt: new Date(Date.now() + 30_000), // only 30s remaining
    });

    const mockFetch = makeFetchMock(VALID_TOKEN_RESPONSE);
    vi.stubGlobal('fetch', mockFetch);

    const result = await acquireToken();

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.accessToken).toBe(VALID_TOKEN_RESPONSE.access_token);
  });

  it('includes AZURE_CLIENT_SECRET in the request body when the env var is set', async () => {
    process.env.AZURE_CLIENT_SECRET = 'super-secret';
    const mockFetch = makeFetchMock(VALID_TOKEN_RESPONSE);
    vi.stubGlobal('fetch', mockFetch);

    await acquireToken();

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const bodyString = callArgs[1].body as string;
    expect(bodyString).toContain('client_secret=super-secret');
  });

  it('throws AuthError with code missing_client_id when AZURE_CLIENT_ID is absent', async () => {
    delete process.env.AZURE_CLIENT_ID;

    const promise = acquireToken();

    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({ code: 'missing_client_id' });
  });
});

// ---------------------------------------------------------------------------
// isTokenValid
// ---------------------------------------------------------------------------

describe('isTokenValid', () => {
  it('returns true for a token expiring more than 60 seconds from now', () => {
    expect(isTokenValid(new Date(Date.now() + 120_000))).toBe(true);
  });

  it('returns false for a token expiring in exactly 60 seconds (at the boundary)', () => {
    // At exactly 60 000 ms remaining, the condition is > 60_000, so false.
    expect(isTokenValid(new Date(Date.now() + 60_000))).toBe(false);
  });

  it('returns false for a token expiring in less than 60 seconds', () => {
    expect(isTokenValid(new Date(Date.now() + 30_000))).toBe(false);
  });

  it('returns false for an already-expired token', () => {
    expect(isTokenValid(new Date(Date.now() - 1000))).toBe(false);
  });
});
