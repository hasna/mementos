#!/usr/bin/env bun
/**
 * Cloud readiness proof for the mementos remote (pure `cloud`) storage path.
 *
 * Exercises the repo's OWN remote code path end to end against a PostgreSQL
 * target:
 *   1. Applies the PG schema via {@link applyPgMigrations}.
 *   2. Checks pgvector availability (embeddings foundation).
 *   3. Runs a save -> recall cycle through {@link PgAdapterAsync} (the same
 *      adapter/translation the cloud path uses).
 *   4. Measures round-trip query latency (p50/avg) from THIS machine.
 *
 * Connection string comes from $HASNA_MEMENTOS_DATABASE_URL (or argv[2]).
 * NEVER pass secrets on the CLI in shared shells — prefer the env var.
 * Prints a JSON summary; never prints the connection string or any password.
 *
 * Usage:
 *   HASNA_MEMENTOS_DATABASE_URL=postgres://... bun run scripts/cloud-readiness-proof.ts
 */
import { PgAdapterAsync } from "../src/storage.js";
import { applyPgMigrations } from "../src/db/pg-migrate.js";

function fail(msg: string): never {
  console.error(`[readiness] ${msg}`);
  process.exit(1);
}

const connectionString =
  process.argv[2] ?? process.env["HASNA_MEMENTOS_DATABASE_URL"] ?? process.env["MEMENTOS_DATABASE_URL"];
if (!connectionString) {
  fail("Set HASNA_MEMENTOS_DATABASE_URL (or pass a connection string as argv[2]).");
}

const summary: Record<string, unknown> = { ok: false, steps: {} };
const steps = summary.steps as Record<string, unknown>;

const pg = new PgAdapterAsync(connectionString);

try {
  // 1. Schema
  const migrations = await applyPgMigrations(connectionString);
  steps.migrations = {
    total: migrations.totalMigrations,
    applied: migrations.applied.length,
    alreadyApplied: migrations.alreadyApplied.length,
    errors: migrations.errors,
  };
  if (migrations.errors.length > 0) fail(`Migration errors: ${migrations.errors.join("; ")}`);

  // 2. pgvector availability (embeddings foundation — schema stores embeddings as TEXT today)
  const vectorRow = await pg.get(
    "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'vector'"
  );
  steps.pgvector = {
    available: Boolean(vectorRow),
    default_version: vectorRow?.default_version ?? null,
    installed_version: vectorRow?.installed_version ?? null,
  };

  // 3. Save -> recall cycle through the remote adapter (the cloud write/read path)
  const probeKey = `readiness-probe-${Date.now()}`;
  const agentId = crypto.randomUUID();
  await pg.run(
    "INSERT INTO agents (id, name, role) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    agentId,
    `readiness-agent-${agentId.slice(0, 8)}`,
    "agent"
  );
  const memoryId = crypto.randomUUID();
  await pg.run(
    `INSERT INTO memories (id, key, value, category, scope, importance, source, status, agent_id)
     VALUES ($1, $2, $3, 'knowledge', 'private', 5, 'system', 'active', $4)`,
    memoryId,
    probeKey,
    "cloud readiness proof value",
    agentId
  );
  const recalled = await pg.get(
    "SELECT id, key, value, status FROM memories WHERE key = $1",
    probeKey
  );
  const recallOk = recalled?.id === memoryId && recalled?.value === "cloud readiness proof value";
  steps.saveRecall = { saved_id: memoryId, recalled: recallOk };
  if (!recallOk) fail("Save/recall mismatch — remote code path did not round-trip the memory.");

  // Clean up the probe rows so the proof leaves no residue.
  await pg.run("DELETE FROM memories WHERE id = $1", memoryId);
  await pg.run("DELETE FROM agents WHERE id = $1", agentId);

  // 4. Round-trip latency from this machine
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await pg.get("SELECT 1 AS one");
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  steps.latencyMs = {
    samples: samples.length,
    min: Number(samples[0]!.toFixed(2)),
    p50: Number(samples[Math.floor(samples.length / 2)]!.toFixed(2)),
    max: Number(samples[samples.length - 1]!.toFixed(2)),
    avg: Number(avg.toFixed(2)),
  };

  summary.ok = true;
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  steps.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
} finally {
  await pg.close();
}
