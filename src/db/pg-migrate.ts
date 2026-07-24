/**
 * PostgreSQL migration runner — applies PG_MIGRATIONS to an RDS instance.
 *
 * Tracks applied migrations in a `_pg_migrations` table (separate from the
 * `_migrations` table used within individual migration SQL blocks).
 */
import {
  PgAdapterAsync,
  getStorageConnectionString,
  redactDatabaseUrl,
  validatePostgresConnectionString,
} from "../storage.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";

export interface PgMigrationResult {
  applied: number[];
  alreadyApplied: number[];
  errors: string[];
  totalMigrations: number;
}

export interface PgMigrationDiagnostics {
  ok: boolean;
  target: "postgres-rds-compatible";
  configured: boolean;
  redacted_connection_string: string | null;
  total_migrations: number;
  mutates_remote_on_apply: true;
  requires_approval_for_live_run: true;
  no_network: true;
  issues: string[];
  warnings: string[];
}

export function getPgMigrationDiagnostics(
  connectionString?: string
): PgMigrationDiagnostics {
  let resolvedConnectionString: string | null = connectionString ?? null;
  const issues: string[] = [];

  if (!resolvedConnectionString) {
    try {
      resolvedConnectionString = getStorageConnectionString("mementos");
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (resolvedConnectionString) {
    const validation = validatePostgresConnectionString(resolvedConnectionString);
    if (!validation.ok) {
      issues.push(...validation.issues);
    }
  }

  return {
    ok: issues.length === 0,
    target: "postgres-rds-compatible",
    configured: resolvedConnectionString !== null && issues.length === 0,
    redacted_connection_string: redactDatabaseUrl(resolvedConnectionString),
    total_migrations: PG_MIGRATIONS.length,
    mutates_remote_on_apply: true,
    requires_approval_for_live_run: true,
    no_network: true,
    issues,
    warnings: [
      "Dry-run diagnostics do not connect to PostgreSQL/RDS and do not mutate AWS or production data.",
      "Applying migrations is a live remote database mutation and requires explicit approval for production targets.",
    ],
  };
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
  const validation = validatePostgresConnectionString(connectionString);
  if (!validation.ok) {
    throw new Error(
      `Remote storage database is not configured. ${validation.issues.join(" ")}`
    );
  }

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
