// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory, getMemory } from "../db/memories.js";
import { gdprErase } from "./gdpr.js";

// ============================================================================
// Regression: `gdprErase` SELECTed on five columns (key, value, summary, tags,
// metadata) and UPDATEd only four of them — `key` was never written. The
// docstring claimed otherwise ("Replaces value, summary, and key"), so the code
// contradicted its own documented contract. Task 0a68d690.
//
// Measured on main a4da1f5, erasing "alice@example.com" across three seeded
// rows:
//   receipt                          {"erased_count": 3, ...}
//   key AFTER erase                  "contact-alice@example.com"  <- PII intact
//   rows still matching identifier   2
//   memories_fts rows with the PII   [{rowid:1},{rowid:3}]        <- searchable
//
// This is the third defect in this file of the same shape as the first two
// (dd80bbe1 LIKE-wildcard injection, 80b3c695 empty-identifier total erase):
// reachable from ordinary input, invisible in preview, AND IT REPORTS SUCCESS.
// That last property is what makes it worse than an error — the receipt is the
// artefact an operator relies on to certify a subject was erased, and it was
// truthful about the COUNT while the identifier itself survived in the very
// column that was matched on.
//
// WHY THE KEY IS REDACTED PER-ROW AND NOT TO A BARE "[REDACTED]": the schema
// carries
//   CREATE UNIQUE INDEX idx_memories_unique_key
//     ON memories(key, scope, COALESCE(agent_id,''), COALESCE(project_id,''),
//                 COALESCE(session_id,''))
// so writing the same literal to two erased rows in one scope throws
// `UNIQUE constraint failed: index 'idx_memories_unique_key'` — MEASURED, not
// inferred. The erase loop is not wrapped in a transaction, so that throw would
// abort a multi-row erase PART-WAY THROUGH: some rows scrubbed, some not, and an
// exception instead of a receipt. One data subject appearing in several memories
// is the ORDINARY case for this function, so the naive fix fails on the common
// path rather than an exotic one. The `<marker>:<id>` form is unique by
// construction because `id` is the primary key, and it discloses nothing new —
// those same ids are already returned to the caller in `memory_ids`.
//
// Every assertion asserts THE LITERAL IDENTIFIER IS ABSENT rather than that a
// marker is present. A marker-present assertion passes against a key rewritten
// to "[REDACTED]-alice@example.com", which would still carry the PII.
// ============================================================================

const ID = "alice@example.com";

function keyOf(id: string): string {
  return getMemory(id, getDatabase())!.key;
}

function valueOf(id: string): string {
  return getMemory(id, getDatabase())!.value;
}

/** Rows anywhere in the store whose key still exposes the identifier. */
function keysExposingIdentifier(): string[] {
  return (
    getDatabase()
      .query("SELECT key FROM memories WHERE key LIKE ?")
      .all(`%${ID}%`) as { key: string }[]
  ).map((r) => r.key);
}

/** FTS5 rowids still matching the identifier as a phrase. */
function ftsRowidsMatchingIdentifier(): number[] {
  return (
    getDatabase()
      .query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
      .all(`"${ID}"`) as { rowid: number }[]
  ).map((r) => r.rowid);
}

describe("gdprErase redacts the key column (0a68d690)", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("removes the identifier from the key of a row matched ONLY on its key", () => {
    const target = createMemory(
      { key: `contact-${ID}`, value: "no address in the value", scope: "global" },
      "merge",
      getDatabase(),
    ).id;

    const result = gdprErase(ID, {}, getDatabase());

    expect(result.erased_count).toBe(1);
    // The defect: this row was reported erased with the identifier still in place.
    expect(keyOf(target)).not.toContain(ID);
    expect(keysExposingIdentifier()).toEqual([]);
    // Positive control: the row genuinely WAS erased, not merely skipped. A fix
    // that narrowed the SELECT so this row never matched would satisfy the two
    // assertions above while silently breaking erasure.
    expect(valueOf(target)).toBe("[REDACTED]");
  });

  it("leaves no row full-text searchable by the identifier", () => {
    const target = createMemory(
      { key: `contact-${ID}`, value: "no address in the value", scope: "global" },
      "merge",
      getDatabase(),
    ).id;

    // Positive control on the probe itself: FTS must FIND the identifier before
    // the erase, or "no rows afterwards" proves nothing about the erase.
    expect(ftsRowidsMatchingIdentifier().length).toBeGreaterThan(0);

    gdprErase(ID, {}, getDatabase());

    expect(ftsRowidsMatchingIdentifier()).toEqual([]);
    expect(valueOf(target)).toBe("[REDACTED]");
  });

  it("erases SEVERAL key-bearing rows in one scope without a UNIQUE collision", () => {
    // The case a bare "[REDACTED]" key fails on: two erased rows sharing
    // scope/agent/project/session collide on idx_memories_unique_key. Measured
    // to throw `UNIQUE constraint failed`. One subject across several memories
    // is the ordinary GDPR case, so this is the common path, not an edge.
    const db = getDatabase();
    const first = createMemory({ key: `contact-${ID}`, value: "a", scope: "global" }, "merge", db).id;
    const second = createMemory({ key: `billing-${ID}`, value: "b", scope: "global" }, "merge", db).id;
    const third = createMemory({ key: `support-${ID}`, value: "c", scope: "global" }, "merge", db).id;

    const result = gdprErase(ID, {}, db);

    expect(result.erased_count).toBe(3);
    expect(keysExposingIdentifier()).toEqual([]);
    for (const id of [first, second, third]) {
      expect(keyOf(id)).not.toContain(ID);
      expect(valueOf(id)).toBe("[REDACTED]");
    }
    // Redacted keys stay distinct — the property the unique index requires.
    const keys = [keyOf(first), keyOf(second), keyOf(third)];
    expect(new Set(keys).size).toBe(3);
  });

  it("does not disturb a bystander whose key never carried the identifier", () => {
    const db = getDatabase();
    const target = createMemory({ key: `contact-${ID}`, value: "a", scope: "global" }, "merge", db).id;
    const bystander = createMemory(
      { key: "unrelated-key", value: "nothing sensitive in this row", scope: "global" },
      "merge",
      db,
    ).id;

    gdprErase(ID, {}, db);

    expect(keyOf(bystander)).toBe("unrelated-key");
    expect(valueOf(bystander)).toBe("nothing sensitive in this row");
    expect(keyOf(target)).not.toContain(ID);
  });

  it("scrubs the key of a matched row even when the PII was in the value", () => {
    // Pins the blanket decision deliberately. `value` is already redacted on a
    // row matched only on its KEY, so "a matched memory is scrubbed entirely" is
    // the function's established semantics; leaving `key` as the one
    // conditionally-preserved column would be a new inconsistency, in the column
    // most likely to carry the identifier.
    const db = getDatabase();
    const target = createMemory(
      { key: "no-pii-in-this-key", value: `${ID} uses this account`, scope: "global" },
      "merge",
      db,
    ).id;

    gdprErase(ID, {}, db);

    expect(keyOf(target)).not.toBe("no-pii-in-this-key");
    expect(keyOf(target)).not.toContain(ID);
    expect(valueOf(target)).toBe("[REDACTED]");
  });

  it("the dry_run preview redacts no key, and previews exactly the set it erases", () => {
    // The preview and the erase share one SELECT. Adding a column to the UPDATE
    // must not let the preview start writing, and must not split the two sets.
    const db = getDatabase();
    const target = createMemory({ key: `contact-${ID}`, value: "a", scope: "global" }, "merge", db).id;
    const bystander = createMemory({ key: "unrelated-key", value: "b", scope: "global" }, "merge", db).id;

    const preview = gdprErase(ID, { dry_run: true }, db);

    expect(keyOf(target)).toBe(`contact-${ID}`);
    expect(keyOf(bystander)).toBe("unrelated-key");

    const erase = gdprErase(ID, {}, db);

    expect(erase.memory_ids).toEqual(preview.memory_ids);
    expect(erase.erased_count).toBe(preview.erased_count);
    expect(preview.memory_ids).toEqual([target]);
    expect(keyOf(target)).not.toContain(ID);
    expect(keyOf(bystander)).toBe("unrelated-key");
  });

  it("erasing twice in a row does not throw on the second pass", () => {
    // A redacted key must not itself become a collision source for a later
    // erase of a DIFFERENT subject in the same scope.
    const db = getDatabase();
    createMemory({ key: `contact-${ID}`, value: "a", scope: "global" }, "merge", db);
    createMemory({ key: "contact-bob@example.com", value: "b", scope: "global" }, "merge", db);

    gdprErase(ID, {}, db);
    const second = gdprErase("bob@example.com", {}, db);

    expect(second.erased_count).toBe(1);
    expect(keysExposingIdentifier()).toEqual([]);
    expect(
      (db.query("SELECT key FROM memories WHERE key LIKE ?").all("%bob@example.com%") as unknown[]).length,
    ).toBe(0);
  });
});
