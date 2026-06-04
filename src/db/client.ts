/**
 * PostgreSQL connection pool for the Lemma manifest database.
 *
 * Exports a single postgres.js tagged-template instance (`db`) that all
 * query functions use.  The pool is configured with a maximum of 5
 * connections and a 20-second idle timeout so that short-lived pipeline
 * runs do not hold connections open after processing completes.
 *
 * The `DATABASE_URL` environment variable must be present before this
 * module is imported.  A descriptive error is thrown at import time if it
 * is absent so that misconfigured environments fail loudly rather than
 * producing silent query errors later.
 */

import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is not set. ' +
      'Set it to a postgres://user:pass@host/dbname connection string ' +
      'before importing this module.',
  );
}

/**
 * Postgres.js tagged-template SQL client.
 *
 * Use as a tagged template for parameterized queries:
 * ```ts
 * const rows = await db`SELECT * FROM pages WHERE id = ${pageId}`;
 * ```
 *
 * Connection pool settings:
 * - `max`: 5 simultaneous connections
 * - `idle_timeout`: 20 seconds before an idle connection is released
 */
export const db = postgres(process.env.DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
});

/**
 * Closes all idle and active connections in the pool.
 *
 * Call this once at process exit to allow Node.js to shut down cleanly
 * without waiting for the connection idle timeout.
 */
export async function closeDb(): Promise<void> {
  await db.end();
}
