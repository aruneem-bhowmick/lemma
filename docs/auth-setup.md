# Microsoft Graph API — Authentication Setup

This guide walks through obtaining and storing the OAuth 2.0 refresh token that the Lemma pipeline uses to access OneNote via the Microsoft Graph API.

---

## Prerequisites

- Node.js ≥ 20 installed locally.
- Access to the [Azure portal](https://portal.azure.com) using the **same personal Microsoft account** that owns the OneNote notebooks you want to sync.
- The Lemma repository cloned and `npm install` completed.

---

## Step 1 — Register an Azure AD application

1. Sign in to the Azure portal with your personal Microsoft account.

2. Navigate to **Azure Active Directory → App registrations → New registration**.

3. Fill in the form:
   - **Name:** `lemma-sync` (or any descriptive name).
   - **Supported account types:** Select **"Accounts in any organizational directory and personal Microsoft accounts"** (the multi-tenant + personal option).  Personal Microsoft accounts require this setting.
   - **Redirect URI:** `http://localhost:3000/callback` (only needed during the one-time consent step; does not need to be hosted).

4. Click **Register**.  Copy the **Application (client) ID** — this is your `AZURE_CLIENT_ID`.

5. Under **Certificates & secrets**, create a **New client secret**.  Copy the value immediately (it is shown only once) — this is your `AZURE_CLIENT_SECRET`.  Set a long expiry (24 months).

6. Under **API permissions**, click **Add a permission → Microsoft Graph → Delegated permissions** and add:
   - `Notes.Read`
   - `Notes.Read.All`
   - `offline_access`

   Click **Grant admin consent** if you see the option (required for some tenants; optional for personal accounts).

---

## Step 2 — Perform the one-time interactive consent

The pipeline uses a long-lived **refresh token** to authenticate without requiring user interaction on every run.  The refresh token is obtained once by completing the interactive OAuth flow.

Run the provided auth-bootstrap script:

```bash
node scripts/auth-bootstrap.js
```

The script will:
1. Open a browser tab to the Microsoft login page.
2. Prompt you to sign in with the personal account that owns your OneNote notebooks.
3. Ask you to consent to the `Notes.Read`, `Notes.Read.All`, and `offline_access` permissions.
4. Exchange the authorization code for a token set and print the `refresh_token` to stdout.

Copy the `refresh_token` value.

> **Important:** If the browser does not open automatically, the script will print a URL.  Open it manually in a browser and paste the resulting redirect URL (e.g. `http://localhost:3000/callback?code=...`) back into the terminal prompt.

---

## Step 3 — Store the refresh token

### Local development (`.env` file)

In your `.env` at the project root:

```dotenv
AZURE_CLIENT_ID=<application-client-id>
AZURE_CLIENT_SECRET=<client-secret-value>
GRAPH_REFRESH_TOKEN=<refresh-token>
```

**Never commit `.env` to version control.** It is listed in `.gitignore`.

### CI / GitHub Actions

1. In your GitHub repository, navigate to **Settings → Secrets and variables → Actions**.
2. Add the following repository secrets:
   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
   - `GRAPH_REFRESH_TOKEN`

The sync workflow reads these automatically.

---

## Refresh token expiry

> **Warning:** Refresh tokens for personal Microsoft accounts expire after **90 days of inactivity**.  If a pipeline run fails with `invalid_grant`, the refresh token has expired.

To renew:
1. Re-run `node scripts/auth-bootstrap.js`.
2. Update `GRAPH_REFRESH_TOKEN` in both your `.env` and the GitHub Actions secret.

Signs of a stale token:
- Pipeline exits with `AuthError: invalid_grant` in the logs.
- `scripts/auth-check.ts` exits with code 1.

---

## Verifying the setup

Run the health check script before the main pipeline to confirm authentication works:

```bash
npx ts-node scripts/auth-check.ts
# exit 0 = auth OK; exit 1 = auth failed
```

You can also run it as a CI pre-step before the sync workflow.

---

## Troubleshooting

| Error code | Cause | Fix |
|------------|-------|-----|
| `invalid_grant` | Refresh token expired or revoked | Re-run `auth-bootstrap.js` and update the secret |
| `AADSTS70011` | Requested OAuth scope not granted on the app registration | Add the missing permission in Azure portal and re-consent |
| `AADSTS65001` | User has not consented to the required permissions | Re-run `auth-bootstrap.js` to trigger a new consent prompt |
| `AADSTS50034` | User account not found (sign-in with wrong account) | Sign in with the personal account that owns the notebooks |
| `401 Unauthorized` (on Graph calls) | Access token expired between acquire and use | The `GraphClient` retries once; if it persists, the refresh token is stale |
| `403 Forbidden` | App does not have `Notes.Read` or `Notes.Read.All` permission | Grant the permissions in Azure portal and re-consent |

---

## Security notes

- The refresh token has the same sensitivity as a password.  Treat it accordingly.
- Rotate the token every 60–80 days to avoid the 90-day expiry window.
- If you suspect the token is compromised, revoke it in the Azure portal under **App registrations → Lemma-sync → Token revocation** and re-run `auth-bootstrap.js`.
