/**
 * PostgreSQL connection pool for the Lemma manifest database.
 *
 * Exports a single tagged-template SQL client (db) backed by postgres.js.
 * The DATABASE_URL environment variable must be set before this module is
 * imported; an error is thrown at import time if it is absent.
 *
 * Implemented in full by Prompt 2.
 */

/** Stub database client — replaced with a real postgres.js instance in Prompt 2. */
export const db: unknown = null;

/**
 * Closes all idle and active connections in the pool.
 *
 * Call this at process exit to allow Node.js to shut down cleanly.
 */
export async function closeDb(): Promise<void> {
  // Stub — implemented in Prompt 2
}
