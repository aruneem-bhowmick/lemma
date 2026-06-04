/**
 * Unit tests for src/graph/client.ts (GraphClient).
 *
 * src/graph/auth.ts is mocked so no real token requests are made.
 * The global fetch function is replaced with vi.fn() mocks to control HTTP
 * responses at the test level.
 *
 * Test coverage:
 *  - listPages: pagination via @odata.nextLink, 401 retry, 401 after retry
 *  - renderPageAsImage: JPEG success, PDF fallback on 415, 429 retry exhaustion
 *  - healthCheck: true on 200, false on 401
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GraphClient, GraphError } from '../../src/graph/client.js';

// ---------------------------------------------------------------------------
// Mock auth module
// ---------------------------------------------------------------------------

vi.mock('../../src/graph/auth.js', () => ({
  acquireToken: vi.fn().mockResolvedValue({
    accessToken: 'mock-bearer-token',
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
  isTokenValid: vi.fn().mockReturnValue(true),
  AuthError: class AuthError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'AuthError';
      this.code = code;
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal GraphPage fixture. */
const makePage = (id: string) => ({
  id,
  title: `Page ${id}`,
  lastModifiedDateTime: '2024-01-01T00:00:00.000Z',
  parentSection: { id: 'section-1', displayName: 'Graph Theory' },
  contentUrl: `https://graph.microsoft.com/v1.0/me/onenote/pages/${id}/content`,
});

/**
 * Creates a mock Response-like object for a JSON API response.
 *
 * @param body   - The object to return from .json().
 * @param status - HTTP status code (default 200).
 */
function jsonResponse(body: unknown, status = 200): object {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue(body),
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(512)),
  };
}

/**
 * Creates a mock Response-like object for a binary (arrayBuffer) response.
 *
 * @param buffer      - The ArrayBuffer to return from .arrayBuffer().
 * @param status      - HTTP status code (default 200).
 * @param contentType - Value for the Content-Type header.
 */
function binaryResponse(
  buffer: ArrayBuffer,
  status = 200,
  contentType = 'image/jpeg',
): object {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? contentType : null,
    },
    json: vi.fn().mockResolvedValue({}),
    arrayBuffer: vi.fn().mockResolvedValue(buffer),
  };
}

/**
 * Creates a mock Response for a rate-limit (429) reply with a Retry-After header.
 *
 * @param retryAfter - Delta-seconds number (e.g. `0`) or an arbitrary header
 *                     string value (e.g. an HTTP-date or invalid text) used to
 *                     exercise the header-parsing branch in GraphClient._get().
 */
function rateLimitResponse(retryAfter: number | string = 0): object {
  const headerValue = typeof retryAfter === 'number' ? String(retryAfter) : retryAfter;
  return {
    ok: false,
    status: 429,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' ? headerValue : null,
    },
    json: vi.fn().mockResolvedValue({}),
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let client: GraphClient;

beforeEach(() => {
  vi.clearAllMocks();
  client = new GraphClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// listPages
// ---------------------------------------------------------------------------

describe('listPages', () => {
  it('paginates through @odata.nextLink and returns the combined page array', async () => {
    const page1 = makePage('p1');
    const page2 = makePage('p2');
    const page3 = makePage('p3');

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ value: [page1, page2], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/onenote/pages?$skiptoken=abc' }),
      )
      .mockResolvedValueOnce(jsonResponse({ value: [page3] }));

    vi.stubGlobal('fetch', mockFetch);

    const result = await client.listPages('notebook-1');

    expect(result).toHaveLength(3);
    expect(result.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns an empty array when the notebook has no pages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ value: [] })));
    const result = await client.listPages('empty-notebook');
    expect(result).toEqual([]);
  });

  it('retries once on 401 and succeeds if the second call returns 200', async () => {
    const page = makePage('p1');
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ value: [page] }));

    vi.stubGlobal('fetch', mockFetch);

    const result = await client.listPages('notebook-1');

    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws GraphError with httpStatus 401 after two consecutive 401 responses', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401));

    vi.stubGlobal('fetch', mockFetch);

    await expect(client.listPages('notebook-1')).rejects.toSatisfy(
      (err) => err instanceof GraphError && (err as GraphError).httpStatus === 401,
    );
  });
});

// ---------------------------------------------------------------------------
// renderPageAsImage
// ---------------------------------------------------------------------------

describe('renderPageAsImage', () => {
  it('returns the ArrayBuffer directly when the JPEG request succeeds', async () => {
    const fakeBuffer = new ArrayBuffer(2048);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(binaryResponse(fakeBuffer)));

    const result = await client.renderPageAsImage('https://content.url/page-1', 'page-1');

    expect(result).toBe(fakeBuffer);
  });

  it('falls back to Accept: application/pdf when the JPEG request returns 415', async () => {
    const pdfBuffer = new ArrayBuffer(4096);
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(binaryResponse(new ArrayBuffer(0), 415, 'text/plain'))
      .mockResolvedValueOnce(binaryResponse(pdfBuffer, 200, 'image/jpeg'));

    vi.stubGlobal('fetch', mockFetch);

    const result = await client.renderPageAsImage('https://content.url/page-1', 'page-1');

    expect(result).toBe(pdfBuffer);
    // Second call must have Accept: application/pdf
    const secondCallHeaders = (mockFetch.mock.calls[1] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(secondCallHeaders['Accept']).toBe('application/pdf');
  });

  it('attempts PDF rasterization when fallback response Content-Type is application/pdf', async () => {
    // The second fetch returns application/pdf — this triggers the _rasterizePdf path
    // which will fail in the test environment (canvas not available or bad PDF bytes),
    // surfacing a GraphError rather than a TypeError.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(binaryResponse(new ArrayBuffer(0), 415))
      .mockResolvedValueOnce(binaryResponse(new ArrayBuffer(32), 200, 'application/pdf'));

    vi.stubGlobal('fetch', mockFetch);

    await expect(
      client.renderPageAsImage('https://content.url/page-1', 'page-1'),
    ).rejects.toBeInstanceOf(GraphError);
  });

  it('throws GraphError with renderingUnsupported when both JPEG and PDF requests fail', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(binaryResponse(new ArrayBuffer(0), 415))
      .mockResolvedValueOnce(binaryResponse(new ArrayBuffer(0), 415));

    vi.stubGlobal('fetch', mockFetch);

    await expect(
      client.renderPageAsImage('https://content.url/page-1', 'page-1'),
    ).rejects.toSatisfy(
      (err) =>
        err instanceof GraphError && (err as GraphError).code === 'renderingUnsupported',
    );
  });

  it('throws GraphError after three 429 retries', async () => {
    // Use 0-second Retry-After so the setTimeout(0) delays resolve immediately.
    const mockFetch = vi.fn().mockResolvedValue(rateLimitResponse(0));
    vi.stubGlobal('fetch', mockFetch);

    // Attach the rejection handler immediately so there is no unhandled rejection
    // window between the promise construction and the assertion.
    await expect(
      client.renderPageAsImage('https://content.url/page-1', 'page-1'),
    ).rejects.toSatisfy(
      (err) => err instanceof GraphError && (err as GraphError).httpStatus === 429,
    );
  });

  it('handles an HTTP-date Retry-After header without treating it as NaN', async () => {
    // Use a date ~50 ms in the future so the computed positive delay is tiny
    // but exercises the HTTP-date parsing branch rather than delta-seconds.
    const httpDate = new Date(Date.now() + 50).toUTCString();
    const mockFetch = vi.fn().mockResolvedValue(rateLimitResponse(httpDate));
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      client.renderPageAsImage('https://content.url/page-1', 'page-1'),
    ).rejects.toSatisfy(
      (err) => err instanceof GraphError && (err as GraphError).httpStatus === 429,
    );
  }, 10_000);

  it('handles a malformed Retry-After header by falling back to the default delay', async () => {
    // "not-a-date" is neither pure digits nor a parseable date, so
    // DEFAULT_RETRY_AFTER_MS (1 s) is used per retry.  Extended timeout covers
    // the three 1-second waits.
    const mockFetch = vi.fn().mockResolvedValue(rateLimitResponse('not-a-date'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      client.renderPageAsImage('https://content.url/page-1', 'page-1'),
    ).rejects.toSatisfy(
      (err) => err instanceof GraphError && (err as GraphError).httpStatus === 429,
    );
  }, 10_000);
});

// ---------------------------------------------------------------------------
// getPageInkML
// ---------------------------------------------------------------------------

describe('getPageInkML', () => {
  it('throws a not-implemented error', async () => {
    await expect(client.getPageInkML('any-page-id')).rejects.toThrow(
      /not yet implemented/i,
    );
  });
});

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

describe('healthCheck', () => {
  it('returns true when the notebooks endpoint responds with 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ value: [] })));

    const result = await client.healthCheck();

    expect(result).toBe(true);
  });

  it('returns false when the notebooks endpoint responds with 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));

    const result = await client.healthCheck();

    expect(result).toBe(false);
  });

  it('throws GraphError for unexpected non-401/non-200 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 503)));

    await expect(client.healthCheck()).rejects.toBeInstanceOf(GraphError);
  });
});
