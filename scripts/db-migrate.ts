/**
 * Migration runner for the Lemma manifest database.
 *
 * Reads every `.sql` file from `src/db/migrations/` in alphabetical order
 * and executes them inside a single transaction so that a mid-run failure
 * leaves the schema unchanged rather than partially applied.
 *
 * Usage:
 *   npm run db:migrate            — execute all pending migrations
 *   npm run db:migrate -- --check — print SQL without executing (dry-run)
 *
 * Exit codes:
 *   0 — all migrations applied (or --check completed)
 *   1 — one or more migrations failed; transaction was rolled back
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHECK_ONLY = process.argv.includes('--check');
const MIGRATIONS_DIR = resolve(__dirname, '../src/db/migrations');

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (migrationFiles.length === 0) {
  console.log('[migrate] No migration files found in', MIGRATIONS_DIR);
  process.exit(0);
}

// --check: print migration SQL without connecting to the database.
if (CHECK_ONLY) {
  console.log(`[migrate] --check mode: printing ${migrationFiles.length} migration file(s) without executing.\n`);
  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}`);
    console.log(sql);
  }
  console.log('[migrate] --check complete. No SQL was executed.');
  process.exit(0);
}

// Normal execution: import the database client (this will throw if DATABASE_URL is unset).
const { db, closeDb } = await import('../src/db/client.js');

try {
  await db.begin(async (tx) => {
    for (const file of migrationFiles) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      try {
        await tx.unsafe(sql);
        console.log(`[migrate] ${file} OK`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[migrate] ${file} ERROR: ${message}`);
        throw err; // Rethrow to roll back the transaction.
      }
    }
  });

  console.log(`[migrate] All ${migrationFiles.length} migration(s) completed successfully.`);
  await closeDb();
  process.exit(0);
} catch {
  await closeDb().catch(() => undefined);
  process.exit(1);
}
