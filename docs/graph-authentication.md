# Graph API Authentication

This document describes how the Lemma pipeline authenticates to the Microsoft Graph API, the design decisions behind the implementation, and how to diagnose failures.

---

## Overview

The pipeline accesses OneNote via the Microsoft Graph REST API.  Every API call requires a short-lived Bearer access token.  Tokens are obtained using the **OAuth 2.0 refresh-token grant** — a server-side flow that exchanges a long-lived refresh token (captured once during an interactive consent session) for a new access token without requiring user interaction.

Personal Microsoft accounts do not support the client-credentials grant (the flow that issues tokens without user consent).  The refresh-token grant is therefore the only viable server-side authentication mechanism for personal-account notebooks.

---

## Module layout

```
src/graph/
  auth.ts      ← token acquisition, cache, AuthError
  client.ts    ← GraphClient (uses auth.ts internally)
  types.ts     ← Graph API response interfaces
scripts/
  auth-check.ts  ← CLI health check (calls GraphClient.healthCheck())
docs/
  auth-setup.md  ← one-time setup walkthrough
```

---

## `src/graph/auth.ts`

### `acquireToken()`

```typescript
export async function acquireToken(): Promise<{ accessToken: string; expiresAt: Date }>
```

The function:

1. Checks the module-level token cache.  If a cached token is present **and** has more than 60 seconds of remaining validity, it is returned immediately without a network round-trip.
2. Otherwise, sends a `POST` to `https://login.microsoftonline.com/common/oauth2/v2.0/token` with:
   - `grant_type=refresh_token`
   - `client_id` from `AZURE_CLIENT_ID`
   - `refresh_token` from `GRAPH_REFRESH_TOKEN`
   - `scope=Notes.Read Notes.Read.All offline_access`
   - `client_secret` from `AZURE_CLIENT_SECRET` (included only when the variable is set)
3. Stores the returned access token and computed `expiresAt` in the module-level cache.
4. Returns `{ accessToken, expiresAt }`.

On error the function throws `AuthError` with the OAuth `error` code from the token endpoint response (e.g. `invalid_grant`, `AADSTS70011`).

**60-second buffer.** The token is treated as stale when fewer than 60 seconds remain before expiry.  This prevents a race where a token is valid at acquire-time but expires before an in-flight Graph request completes.

### `isTokenValid(expiresAt: Date)`

```typescript
export function isTokenValid(expiresAt: Date): boolean
```

Returns `true` if `expiresAt.getTime() - Date.now() > 60_000`.  Pure function with no side effects; used internally by `acquireToken()` and available for testing.

### `AuthError`

```typescript
export class AuthError extends Error {
  readonly code: string;
}
```

Thrown when token acquisition fails.  The `code` field holds the OAuth error identifier so callers can branch on specific failure modes:

| `code` | Meaning |
|--------|---------|
| `invalid_grant` | Refresh token expired or revoked — re-run the auth setup |
| `missing_client_id` | `AZURE_CLIENT_ID` not set |
| `missing_refresh_token` | `GRAPH_REFRESH_TOKEN` not set |
| `token_error` | Generic token endpoint failure |

---

## `src/graph/client.ts`

### `GraphClient`

All public methods call the private `_get()` helper, which:

1. Calls `acquireToken()` to obtain the current token.
2. Sets `Authorization: Bearer <token>` on the request.
3. Logs `[GraphClient] GET <url> → <status> (<ms>ms)` to stderr.
4. On **401**: re-acquires the token (forcing a cache miss) and retries the request once.  A second 401 throws `GraphError({ httpStatus: 401 })`.
5. On **429**: reads the `Retry-After` header (falling back to 1 s if absent), waits, and retries up to three times.  After the third retry throws `GraphError({ httpStatus: 429 })`.

#### `listPages(notebookId)`

Retrieves all pages in the target notebook by querying:

```
GET /me/onenote/pages
    ?$expand=parentSection
    &$top=100
    &$filter=parentNotebook/id eq '<notebookId>'
    &$select=id,title,lastModifiedDateTime,contentUrl,parentSection
```

Follows `@odata.nextLink` pagination until there are no more pages.

#### `renderPageAsImage(contentUrl, pageId)`

Attempts to fetch a JPEG rendering of the page via `Accept: image/jpeg`.  If the response is 415 or 404 (the Graph endpoint does not support direct JPEG export for this page type), retries with `Accept: application/pdf`.  The PDF is rasterized to JPEG at ~150 DPI using `pdfjs-dist` + `sharp`.  Requires the optional `canvas` package for PDF rasterization.

Throws `GraphError({ code: 'renderingUnsupported' })` if both attempts fail.

#### `healthCheck()`

Calls `GET /me/onenote/notebooks` and returns `true` on 200, `false` on 401, or throws `GraphError` for any other status.  Used by `scripts/auth-check.ts` for CI pre-validation.

### `GraphError`

```typescript
export class GraphError extends Error {
  readonly httpStatus: number;
  readonly code?: string;
}
```

Thrown by `GraphClient` methods on non-success HTTP responses.  The `httpStatus` field carries the raw status code; the optional `code` string is set for named failure modes such as `'renderingUnsupported'` and `'rasterizationFailed'`.

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `AZURE_CLIENT_ID` | Yes | Azure AD application (client) ID |
| `GRAPH_REFRESH_TOKEN` | Yes | Long-lived refresh token from interactive consent |
| `AZURE_CLIENT_SECRET` | No | Client secret; included in token request when set |
| `AZURE_TENANT_ID` | No | Tenant ID; defaults to `common` (personal accounts) |

See [docs/auth-setup.md](auth-setup.md) for the one-time procedure to obtain these values.

---

## Refresh token lifecycle

| Event | Action |
|-------|--------|
| Normal pipeline run | `acquireToken()` returns the cached token; no network call |
| Token expires (cache miss) | `acquireToken()` calls the token endpoint; updates cache |
| Refresh token expires (90-day inactivity) | Token endpoint returns `invalid_grant`; `AuthError` thrown |
| `invalid_grant` in logs | Re-run `node scripts/auth-bootstrap.js`; update `GRAPH_REFRESH_TOKEN` |

Refresh tokens for personal Microsoft accounts expire after **90 days of inactivity**.  The pipeline emits `AuthError: invalid_grant` when this happens.  The `auth-check.ts` script will exit with code 1, making the failure visible in CI before the pipeline attempts to process pages.

---

## Diagnosing auth failures

### Quick check

```bash
npx ts-node scripts/auth-check.ts
```

- **Exit 0 + "OK"**: credentials are valid.
- **Exit 1 + `AuthError: invalid_grant`**: refresh token expired — re-run `auth-bootstrap.js`.
- **Exit 1 + `AuthError: missing_client_id`**: `AZURE_CLIENT_ID` not set in `.env`.
- **Exit 1 + `GraphError: 401`**: access token was acquired but Graph rejected it — possible permission scope issue.
- **Exit 1 + `GraphError: 403`**: token valid but the app lacks `Notes.Read` or `Notes.Read.All` — re-consent via `auth-bootstrap.js`.

### Verbose token debugging

Add a temporary `console.log` around `acquireToken()` to inspect the raw token response, or check the Azure portal under **App registrations → Lemma-sync → Token events** for server-side audit logs.

---

## Testing

Unit tests in `tests/unit/graph-auth.test.ts` and `tests/unit/graph-client.test.ts` mock `fetch` at the global level and never make real network calls.  The live integration tests in `tests/integration/graph-live.test.ts` are skipped unless `GRAPH_LIVE=true` is set.

See [docs/development.md](development.md) for instructions on running each test tier.
