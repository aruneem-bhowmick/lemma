/**
 * Graph API authentication health check.
 *
 * Instantiates GraphClient, calls healthCheck(), and exits with code 0 when
 * credentials are valid or code 1 when they are not.  Designed for use as a
 * CI pre-step before the main pipeline run to surface auth failures early and
 * prevent the pipeline from executing with stale tokens.
 *
 * Usage:
 *   npx ts-node scripts/auth-check.ts
 *
 * Required environment variables (see .env.example):
 *   AZURE_CLIENT_ID, GRAPH_REFRESH_TOKEN
 * Optional:
 *   AZURE_CLIENT_SECRET
 */

import 'dotenv/config';
import { GraphClient } from '../src/graph/client.js';
import { AuthError } from '../src/graph/auth.js';

async function main(): Promise<void> {
  const client = new GraphClient();

  process.stdout.write('[auth-check] Testing Graph API authentication…\n');

  let healthy: boolean;
  try {
    healthy = await client.healthCheck();
  } catch (err) {
    if (err instanceof AuthError) {
      process.stderr.write(
        `[auth-check] FAIL — AuthError (${err.code}): ${err.message}\n` +
          `  Run the one-time auth setup to refresh your token: see docs/auth-setup.md\n`,
      );
    } else {
      process.stderr.write(
        `[auth-check] FAIL — Unexpected error: ${(err as Error).message}\n`,
      );
    }
    process.exit(1);
  }

  if (healthy) {
    process.stdout.write('[auth-check] OK — Graph API credentials are valid.\n');
    process.exit(0);
  } else {
    process.stderr.write(
      '[auth-check] FAIL — Graph API returned 401. The token may be expired or revoked.\n' +
        '  Run the one-time auth setup to obtain a new token: see docs/auth-setup.md\n',
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[auth-check] Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
