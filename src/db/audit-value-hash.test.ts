process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import { createMemory, updateMemory, deleteMemory } from "./memories.js";
import { MIGRATIONS } from "./migrations.js";

/**
 * THE CONTRACT UNDER TEST
 *
 * `memory_audit_log.old_value_hash` / `new_value_hash` exist so that an operator
 * can prove, per row, WHAT was written or deleted without the audit log storing
 * the content. The only way to use them is to compare `md5(candidate)` against
 * the stored column.
 *
 * INVARIANT: each column is either NULL — the backend cannot compute a digest in
 * a trigger and says so honestly — or the genuine md5 hex digest of the value it
 * names. It is NEVER a non-NULL value that is not that digest.
 *
 * WHY THE OBVIOUS TEST DOES NOT WORK. Asserting the column is non-empty PASSES on
 * random data, which is exactly the state this file was written against: the
 * SQLite triggers populated all four hash slots with `hex(randomblob(16))`, since
 * SQLite ships no `md5()`. A verification routine built on that column therefore
 * returned "no match" for every row and read as "nothing is recoverable" rather
 * than "the instrument is broken" — a confident wrong answer on the exact surface
 * an operator reaches for during a data-loss incident.
 *
 * Every assertion below must be able to FAIL on fabricated data. The determinism
 * case is the sharpest: md5 of one value is one digest, forever, on any backend.
 * Random data cannot satisfy it under any choice of hash algorithm.
 */

const md5 = (value: string): string =>
  createHash("md5").update(value, "utf8").digest("hex");

interface AuditRow {
  operation: string;
  old_value_hash: string | null;
  new_value_hash: string | null;
}

function auditRows(memoryId: string): AuditRow[] {
  return getDatabase()
    .query(
      "SELECT operation, old_value_hash, new_value_hash FROM memory_audit_log WHERE memory_id = ? ORDER BY rowid ASC"
    )
    .all(memoryId) as AuditRow[];
}

function rowFor(memoryId: string, operation: string): AuditRow {
  const row = auditRows(memoryId).find((r) => r.operation === operation);
  // Positive control: the trigger must have fired at all. Without this, an
  // absent row would make every "hash is null" assertion below pass vacuously.
  expect(row, `no '${operation}' audit row for ${memoryId}`).toBeTruthy();
  return row!;
}

/**
 * The invariant, in one place: null is honest, the true digest is honest,
 * anything else is fabrication.
 */
function expectHonestDigest(
  stored: string | null,
  value: string,
  what: string
): void {
  if (stored === null || stored === "") return;
  expect(stored, `${what} is non-null but is not md5(${JSON.stringify(value)})`).toBe(
    md5(value)
  );
}

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

describe("memory_audit_log value hashes are never fabricated", () => {
  it("delete: old_value_hash is null or md5 of the deleted value", () => {
    const value = "the value that was deleted";
    const mem = createMemory({ key: "hash-del", value });
    deleteMemory(mem.id);

    const row = rowFor(mem.id, "delete");
    expectHonestDigest(row.old_value_hash, value, "delete.old_value_hash");
  });

  it("create: new_value_hash is null or md5 of the created value", () => {
    const value = "the value that was created";
    const mem = createMemory({ key: "hash-create", value });

    const row = rowFor(mem.id, "create");
    expectHonestDigest(row.new_value_hash, value, "create.new_value_hash");
  });

  it("update: both hashes are null or md5 of the values they name", () => {
    const before = "value before the update";
    const after = "value after the update";
    const mem = createMemory({ key: "hash-update", value: before });
    updateMemory(mem.id, { value: after, version: mem.version });

    const row = rowFor(mem.id, "update");
    expectHonestDigest(row.old_value_hash, before, "update.old_value_hash");
    expectHonestDigest(row.new_value_hash, after, "update.new_value_hash");
  });

  it("is DETERMINISTIC: the same value never yields two different hashes", () => {
    // This is the assertion random data cannot satisfy under ANY hash algorithm,
    // so it holds even if the digest choice were later revisited.
    const value = "identical content in two separate rows";
    const a = createMemory({ key: "hash-det-a", value });
    const b = createMemory({ key: "hash-det-b", value });

    const hashA = rowFor(a.id, "create").new_value_hash;
    const hashB = rowFor(b.id, "create").new_value_hash;

    expect(hashA).toBe(hashB as never);
  });

  it("DISCRIMINATES: different values never yield the same non-null hash", () => {
    // The negative control for the determinism case above. Without it, a trigger
    // that wrote one constant string would pass "deterministic" while carrying no
    // information at all.
    const a = createMemory({ key: "hash-diff-a", value: "first distinct value" });
    const b = createMemory({ key: "hash-diff-b", value: "second distinct value" });

    const hashA = rowFor(a.id, "create").new_value_hash;
    const hashB = rowFor(b.id, "create").new_value_hash;

    if (hashA !== null && hashB !== null) {
      expect(hashA).not.toBe(hashB as never);
    }
  });

  it("SQLite writes NULL rather than a value that merely looks like a digest", () => {
    // The backend-specific half. SQLite has no md5() and `bun:sqlite` exposes no
    // user-defined-function API (measured on bun 1.3.14: neither `db.function`
    // nor `db.createFunction` exists), so a trigger cannot compute a digest here.
    // NULL is the honest answer; a 32-hex random string is indistinguishable from
    // a real md5 and is therefore worse than an absent column.
    const value = "sqlite has no md5";
    const mem = createMemory({ key: "hash-sqlite-null", value });
    updateMemory(mem.id, { value: `${value} v2`, version: mem.version });
    deleteMemory(mem.id);

    for (const row of auditRows(mem.id)) {
      expect(row.old_value_hash, `${row.operation}.old_value_hash`).toBeNull();
      expect(row.new_value_hash, `${row.operation}.new_value_hash`).toBeNull();
    }
  });
});

describe("migration 37 repairs rows the old triggers already fabricated", () => {
  const MIGRATION_37 = MIGRATIONS.find((sql) =>
    sql.includes("INSERT OR IGNORE INTO _migrations (id) VALUES (37);")
  );
  if (!MIGRATION_37) {
    throw new Error("shipped migration 37 is missing");
  }

  // Exactly what `hex(randomblob(16))` produced: 32 UPPERCASE hex characters.
  const FABRICATED = "8DDF06929AE396FC4D7461AE1F629E4D";
  // A genuine md5 hex digest is lowercase, and must survive the repair untouched.
  const GENUINE = md5("a value whose digest is real");

  function seedLegacyRow(id: string, oldHash: string, newHash: string): void {
    getDatabase().run(
      `INSERT INTO memory_audit_log (id, memory_id, memory_key, operation, agent_id, old_value_hash, new_value_hash, created_at)
       VALUES (?, ?, ?, 'update', 'legacy-agent', ?, ?, datetime('now'))`,
      [id, `mem-${id}`, `key-${id}`, oldHash, newHash]
    );
  }

  function hashesOf(id: string): { old: string | null; new: string | null } {
    const row = getDatabase()
      .query("SELECT old_value_hash, new_value_hash FROM memory_audit_log WHERE id = ?")
      .get(id) as { old_value_hash: string | null; new_value_hash: string | null };
    expect(row, `seeded row ${id} vanished`).toBeTruthy();
    return { old: row.old_value_hash, new: row.new_value_hash };
  }

  it("nulls the fabricated shape and PRESERVES a genuine digest", () => {
    seedLegacyRow("legacy-fabricated", FABRICATED, FABRICATED);
    seedLegacyRow("legacy-genuine", GENUINE, GENUINE);

    // Positive control on the SEEDING, not just on the repair: prove the rows
    // went in carrying the values, so that a post-repair NULL is the repair's
    // doing and not an insert that silently dropped them.
    expect(hashesOf("legacy-fabricated").old).toBe(FABRICATED);
    expect(hashesOf("legacy-genuine").old).toBe(GENUINE);

    // Re-run the shipped migration text itself, not a copy of its SQL.
    getDatabase().exec(MIGRATION_37);

    const fabricated = hashesOf("legacy-fabricated");
    expect(fabricated.old, "fabricated old_value_hash survived the repair").toBeNull();
    expect(fabricated.new, "fabricated new_value_hash survived the repair").toBeNull();

    const genuine = hashesOf("legacy-genuine");
    expect(genuine.old, "the repair destroyed a genuine digest").toBe(GENUINE);
    expect(genuine.new, "the repair destroyed a genuine digest").toBe(GENUINE);
  });

  it("is idempotent — re-running it changes nothing further", () => {
    seedLegacyRow("legacy-idem", GENUINE, GENUINE);

    getDatabase().exec(MIGRATION_37);
    getDatabase().exec(MIGRATION_37);

    const after = hashesOf("legacy-idem");
    expect(after.old).toBe(GENUINE);
    expect(after.new).toBe(GENUINE);

    // And the triggers still work after being dropped and recreated twice.
    const value = "written after two migration replays";
    const mem = createMemory({ key: "hash-idem-trigger", value });
    expect(rowFor(mem.id, "create").new_value_hash).toBeNull();
  });
});
