/**
 * Microsoft Graph API token acquisition and refresh.
 *
 * Handles the OAuth 2.0 refresh-token flow for personal Microsoft accounts.
 * An in-process cache avoids redundant token endpoint calls within a single
 * pipeline run; the cache is invalidated when fewer than 60 seconds remain
 * before expiry.
 *
 * Personal Microsoft accounts do not support the client-credentials grant
 * (OAuth flows that skip user consent entirely).  The only viable server-side
 * flow is the refresh-token grant, which requires a long-lived `refresh_token`
 * previously captured via an interactive authorization-code flow.  See
 * docs/auth-setup.md for the one-time setup procedure.
 */

/**
 * Returns the Microsoft identity platform token endpoint URL.
 *
 * When `AZURE_TENANT_ID` is set the request is directed at that specific
 * tenant, which is required for work/school accounts and supported for
 * personal accounts.  Defaults to `common`, which accepts both account types.
 */
function buildTokenEndpoint(): string {
  const tenantId = process.env.AZURE_TENANT_ID ?? 'common';
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

/**
 * The delegated scopes required by the Lemma pipeline.
 * `offline_access` is mandatory for the token endpoint to issue a refresh token.
 */
const REQUIRED_SCOPES =
  'https://graph.microsoft.com/Notes.Read https://graph.microsoft.com/Notes.Read.All offline_access';

/** Minimum seconds of validity remaining before we treat a cached token as stale. */
const EXPIRY_BUFFER_MS = 60_000;

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/**
 * Thrown when token acquisition or refresh fails.
 *
 * The `code` field carries the OAuth error identifier returned by the Microsoft
 * identity platform (e.g. `invalid_grant`, `AADSTS70011`) so callers can
 * branch on specific failure modes without string-parsing the message.
 */
export class AuthError extends Error {
  /** OAuth error code from the token endpoint response. */
  readonly code: string;

  /**
   * @param message - Human-readable description of the failure.
   * @param code    - OAuth error code (e.g. `'invalid_grant'`, `'AADSTS70011'`).
   */
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Module-level token cache
// ---------------------------------------------------------------------------

/** Shape of an in-memory cached access token. */
interface CachedToken {
  accessToken: string;
  expiresAt: Date;
}

/** In-process token cache.  Cleared between test runs via _resetTokenCacheForTest. */
let tokenCache: CachedToken | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a valid Microsoft Graph access token, refreshing it if necessary.
 *
 * On the first call (or after the cached token expires) a POST request is sent
 * to the Microsoft identity platform token endpoint using the refresh-token
 * grant.  Subsequent calls within the same process return the cached token
 * without a network round-trip, provided it remains valid for more than 60
 * seconds.
 *
 * Required environment variables:
 * - `AZURE_CLIENT_ID`     — the Azure AD application (client) ID.
 * - `GRAPH_REFRESH_TOKEN` — the long-lived refresh token from the one-time
 *                           interactive consent flow (see docs/auth-setup.md).
 * - `AZURE_CLIENT_SECRET` — optional; included in the token request when set.
 * - `AZURE_TENANT_ID`     — optional; overrides the default `common` tenant
 *                           endpoint (required for work/school accounts).
 *
 * @param forceRefresh - When `true`, bypass the in-process cache and always
 *                       exchange the refresh token for a new access token.
 *                       Used by `GraphClient` when retrying after a 401 so the
 *                       same (rejected) token is never reused.
 * @returns An object containing the raw access token string and its expiry date.
 * @throws  AuthError if the environment variables are missing, the network
 *          request fails, the response cannot be parsed, or the token
 *          endpoint returns an error response.
 */
export async function acquireToken(forceRefresh = false): Promise<{ accessToken: string; expiresAt: Date }> {
  if (tokenCache !== null && isTokenValid(tokenCache.expiresAt) && !forceRefresh) {
    return { accessToken: tokenCache.accessToken, expiresAt: tokenCache.expiresAt };
  }

  const clientId = process.env.AZURE_CLIENT_ID;
  const refreshToken = process.env.GRAPH_REFRESH_TOKEN;

  if (!clientId) {
    throw new AuthError(
      'AZURE_CLIENT_ID environment variable is not set.  ' +
        'Set it to the Azure AD application (client) ID before running the pipeline.',
      'missing_client_id',
    );
  }
  if (!refreshToken) {
    throw new AuthError(
      'GRAPH_REFRESH_TOKEN environment variable is not set.  ' +
        'Run the one-time auth setup (see docs/auth-setup.md) to obtain a refresh token.',
      'missing_refresh_token',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: REQUIRED_SCOPES,
  });

  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  let response: Response;
  try {
    response = await fetch(buildTokenEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new AuthError(
      `Token endpoint request failed: ${(err as Error).message}`,
      'network_error',
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new AuthError(
      `Token endpoint returned an unparseable response (HTTP ${response.status})`,
      'token_error',
    );
  }

  const errorCode = data['error'] as string | undefined;
  if (!response.ok || errorCode) {
    const description =
      (data['error_description'] as string | undefined) ??
      `Token endpoint returned HTTP ${response.status}`;
    throw new AuthError(description, errorCode ?? 'token_error');
  }

  const accessToken = data['access_token'];
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new AuthError(
      'Token endpoint response is missing a valid access_token field',
      'token_error',
    );
  }

  const rawExpiresIn = Number(data['expires_in'] ?? 3600);
  const expiresIn = Number.isFinite(rawExpiresIn) && rawExpiresIn > 0 ? rawExpiresIn : 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  tokenCache = { accessToken, expiresAt };
  return { accessToken, expiresAt };
}

/**
 * Returns `true` if the token represented by `expiresAt` remains valid for
 * more than 60 seconds from now.
 *
 * The 60-second buffer prevents using a token that expires in the middle of an
 * in-flight HTTP request to the Graph API.
 *
 * @param expiresAt - The expiry date returned by `acquireToken`.
 */
export function isTokenValid(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() > EXPIRY_BUFFER_MS;
}

// ---------------------------------------------------------------------------
// Test helpers (not part of the public production API)
// ---------------------------------------------------------------------------

/**
 * Resets the module-level token cache to `null`.
 *
 * Call this in `beforeEach` blocks to prevent test isolation issues caused by
 * a valid cache entry from one test leaking into the next.
 *
 * @internal Only for use in unit tests.
 */
export function _resetTokenCacheForTest(): void {
  tokenCache = null;
}

/**
 * Injects an arbitrary cache entry, allowing tests to simulate a valid or
 * stale cached token without performing a real token exchange.
 *
 * @param cache - The token entry to inject, or `null` to clear the cache.
 * @internal Only for use in unit tests.
 */
export function _setTokenCacheForTest(
  cache: { accessToken: string; expiresAt: Date } | null,
): void {
  tokenCache = cache;
}
