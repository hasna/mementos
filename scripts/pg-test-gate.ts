#!/usr/bin/env bun
/**
 * Live PostgreSQL proof gate — `storage.pgTestGate` in hasna.contract.json.
 *
 * Exercises the repo's OWN PostgreSQL code path against a real server:
 * applies the PG schema through {@link applyPgMigrations}, then writes and
 * reads a row back through {@link PgAdapterAsync} — the same adapter and SQL
 * translation the postgres storage engine uses at runtime.
 *
 * FAIL-CLOSED BY DESIGN. With no DSN set this exits 1 rather than skipping: a
 * proof gate that reports success when it did not run is the vacuous check the
 * contract's storage clause exists to prevent. The DSN variable is TEST-ONLY
 * and deliberately distinct from `HASNA_MEMENTOS_DATABASE_URL`, so pointing
 * the gate at a live store takes a separate, explicit act.
 *
 *   MEMENTOS_TEST_DATABASE_URL=postgres://... bun run test:pg
 *
 * The probe rows are deleted before exit; the connection string is never
 * printed, in full or in part.
 */
import { createHash } from "node:crypto";
import { PgAdapterAsync } from "../src/storage.js";
import { applyPgMigrations } from "../src/db/pg-migrate.js";

const ENV_VAR = "MEMENTOS_TEST_DATABASE_URL";

function fail(message: string): never {
  console.error(`[pg-test-gate] FAIL: ${message}`);
  process.exit(1);
}

const connectionString = process.env[ENV_VAR]?.trim();
if (!connectionString) {
  fail(
    `${ENV_VAR} is not set. This gate proves live PostgreSQL support and cannot ` +
      `pass without a PostgreSQL server; point it at a throwaway test database.`
  );
}

const pg = new PgAdapterAsync(connectionString);
const probeSuffix = crypto.randomUUID();
const agentId = crypto.randomUUID();
const memoryId = crypto.randomUUID();
const probeKey = `pg-test-gate-${probeSuffix}`;
const probeValue = `pg-test-gate value ${probeSuffix}`;
let checks = 0;

try {
  // 1. Schema — the repo's own migration set must apply cleanly.
  const migrations = await applyPgMigrations(connectionString);
  if (migrations.errors.length > 0) fail(`migration errors: ${migrations.errors.join("; ")}`);
  if (migrations.totalMigrations === 0) fail("no PostgreSQL migrations were found to apply");
  checks++;

  // 2. Write and read back through the postgres adapter.
  await pg.run(
    "INSERT INTO agents (id, name, role) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    agentId,
    `pg-test-gate-agent-${agentId.slice(0, 8)}`,
    "agent"
  );
  await pg.run(
    `INSERT INTO memories (id, key, value, category, scope, importance, source, status, agent_id)
     VALUES ($1, $2, $3, 'knowledge', 'private', 5, 'system', 'active', $4)`,
    memoryId,
    probeKey,
    probeValue,
    agentId
  );
  const recalled = await pg.get("SELECT id, key, value, status FROM memories WHERE key = $1", probeKey);
  if (!recalled) fail("round-trip read returned no row: the postgres write path did not persist");
  if (recalled.id !== memoryId || recalled.value !== probeValue) {
    fail("round-trip mismatch: the row read back is not the row written");
  }
  checks++;

  // 3. The delete path, so the gate leaves no residue and proves a mutation
  //    other than INSERT reaches the server.
  await pg.run("DELETE FROM memories WHERE id = $1", memoryId);
  const afterDelete = await pg.get("SELECT id FROM memories WHERE id = $1", memoryId);
  if (afterDelete) fail("delete did not remove the probe row");
  checks++;

  // 4. Audit value hashes are REAL digests, not fabricated data.
  //
  //    The SQLite triggers wrote `hex(randomblob(16))` here until migration 37,
  //    because SQLite has no md5(); they now write NULL. Postgres has md5() and
  //    must write the true digest — this is the half of that contract that only a
  //    live server can prove. Asserting the column is merely POPULATED would pass
  //    on random data, which is exactly how the SQLite defect survived, so both
  //    assertions below compare against the digest of a value this gate knows.
  const expectedDigest = createHash("md5").update(probeValue, "utf8").digest("hex");

  const createdAudit = await pg.get(
    "SELECT new_value_hash FROM memory_audit_log WHERE memory_id = $1 AND operation = 'create'",
    memoryId
  );
  if (!createdAudit) fail("no 'create' audit row: the audit_memory_insert trigger did not fire");
  if (createdAudit.new_value_hash !== expectedDigest) {
    fail(
      `create audit new_value_hash is not md5 of the written value ` +
        `(expected ${expectedDigest}, got ${String(createdAudit.new_value_hash)})`
    );
  }

  const deletedAudit = await pg.get(
    "SELECT old_value_hash FROM memory_audit_log WHERE memory_id = $1 AND operation = 'delete'",
    memoryId
  );
  if (!deletedAudit) fail("no 'delete' audit row: the audit_memory_delete trigger did not fire");
  if (deletedAudit.old_value_hash !== expectedDigest) {
    fail(
      `delete audit old_value_hash is not md5 of the deleted value ` +
        `(expected ${expectedDigest}, got ${String(deletedAudit.old_value_hash)})`
    );
  }
  checks++;

  console.log(
    `[pg-test-gate] PASS: ${checks} live PostgreSQL checks (schema, round-trip, delete, audit-value-hash)`
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await pg.run("DELETE FROM memories WHERE id = $1", memoryId).catch(() => {});
  await pg.run("DELETE FROM agents WHERE id = $1", agentId).catch(() => {});
  await pg.close();
}
