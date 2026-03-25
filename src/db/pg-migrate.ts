/**
 * PostgreSQL migration runner — applies PG_MIGRATIONS to an RDS instance.
 *
 * Tracks applied migrations in a `_pg_migrations` table (separate from the
 * `_migrations` table used within individual migration SQL blocks).
 */
import { PgAdapterAsync } from "@hasna/cloud";
import { PG_MIGRATIONS } from "./pg-migrations.js";

export interface PgMigrationResult {
  applied: number[];
  alreadyApplied: number[];
  errors: string[];
  totalMigrations: number;
}

/**
 * Apply all pending PostgreSQL migrations to the given database.
 *
 * @param connectionString - PostgreSQL connection string
 * @returns Summary of which migrations were applied / skipped / errored.
 */
export async function applyPgMigrations(
  connectionString: string
): Promise<PgMigrationResult> {
  const pg = new PgAdapterAsync(connectionString);

  const result: PgMigrationResult = {
    applied: [],
    alreadyApplied: [],
    errors: [],
    totalMigrations: PG_MIGRATIONS.length,
  };

  try {
    // Create tracking table if it doesn't exist
    await pg.run(
      `CREATE TABLE IF NOT EXISTS _pg_migrations (
        id SERIAL PRIMARY KEY,
        version INT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );

    // Check which migrations are already applied
    const applied = await pg.all(
      "SELECT version FROM _pg_migrations ORDER BY version"
    );
    const appliedSet = new Set(
      applied.map((r: { version: number }) => r.version)
    );

    // Apply new ones in order
    for (let i = 0; i < PG_MIGRATIONS.length; i++) {
      if (appliedSet.has(i)) {
        result.alreadyApplied.push(i);
        continue;
      }

      try {
        await pg.exec(PG_MIGRATIONS[i]!);
        await pg.run(
          "INSERT INTO _pg_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
          i
        );
        result.applied.push(i);
      } catch (err: any) {
        result.errors.push(
          `Migration ${i}: ${err?.message ?? String(err)}`
        );
        // Stop on first error to avoid applying later migrations on a broken schema
        break;
      }
    }
  } finally {
    await pg.close();
  }

  return result;
}
