// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory, getMemory } from "../db/memories.js";
import { gdprErase } from "./gdpr.js";

// ============================================================================
// Regression: THE ERASE LOOP WAS NOT ATOMIC, so any mid-loop failure left the
// data subject HALF-ERASED WITH NO RECEIPT — and one such failure was reachable
// from the ordinary public save path, where it became a PERMANENT DENIAL OF
// ERASURE. Remediation cycle 1 on PR #36 (task 0a68d690); blocker measured by
// the adversarial reviewer against head 1a736623.
//
// THE ORIGINAL MECHANISM. At 1a736623 the tombstone key was `'[REDACTED]:' || id`
// — fully determined by the memory id, and ids are not secret: they are returned
// to every caller in `GdprErasureResult.memory_ids` and in ordinary get/save
// output. So an ordinary `save` under the literal key `[REDACTED]:<a memory id>`
// was at once:
//
//   * a BYSTANDER — carrying no identifier, so the erase's SELECT never matched
//     it and it was never in the set to be redacted; and
//   * a BLOCKER — already occupying the exact row that
//       CREATE UNIQUE INDEX idx_memories_unique_key
//         ON memories(key, scope, COALESCE(agent_id,''), COALESCE(project_id,''),
//                     COALESCE(session_id,''))
//     reserves for that memory's tombstone.
//
// Measured on 1a736623 with three subject rows and one squatter: attempts 1/2/3
// ALL threw `UNIQUE constraint failed: idx_memories_unique_key`, each leaving
// 2 OF 3 ROWS STILL CARRYING THE IDENTIFIER. Retry never recovered — the row
// redacted before the throw stopped matching the identifier, so every retry
// restarted at the same failing row and threw again, forever.
//
// TWO INDEPENDENT DEFECTS, TWO INDEPENDENT FIXES, AND THIS FILE SEPARATES THEM
// DELIBERATELY — because a reader who collapses them will believe the atomicity
// is tested when only the key is:
//
//   1. A DERIVED KEY (fixed at d164d14, "avoid deriving redacted keys from ids").
//      The tombstone is now `[REDACTED]:<fresh random uuid>`, derived from
//      nothing a caller can observe or control, so it cannot be squatted in
//      advance. The "squatter" tests below pin that vector.
//
//   2. A NON-ATOMIC LOOP (fixed here). A non-derived key removes the SPECIFIC
//      collision above; it does NOT make the loop atomic. Any other mid-loop
//      failure — a constraint, a trigger, a disk error — still splits the
//      subject, and a half-erased subject with no receipt is precisely what an
//      erasure API must never produce. The "atomicity" tests below inject a
//      deterministic mid-loop failure so this is pinned on its own evidence
//      rather than resting on collisions merely having become unreachable.
//
// HONEST NOTE ON WHAT EACH GROUP DISCRIMINATES. The squatter tests fail against
// 1a736623 and pass from d164d14 onward. The atomicity tests fail against BOTH
// 1a736623 and d164d14, and pass only once the loop is transactional. Both
// groups are kept: the first is the regression record for a vector that was
// live in a pushed commit, the second is this cycle's actual acceptance bar.
//
// EVERY ASSERTION ASSERTS THE LITERAL IDENTIFIER IS ABSENT rather than that a
// marker is present, matching the sibling gdpr test files: a marker-present
// assertion passes against a key rewritten to "[REDACTED]-alice@example.com",
// which would still carry the PII.
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

/** Rows anywhere in the store still exposing the identifier in ANY matched column. */
function rowsExposingIdentifier(): number {
  return (
    getDatabase()
      .query(
        `SELECT COUNT(*) AS n FROM memories
          WHERE key LIKE ? OR value LIKE ? OR summary LIKE ? OR tags LIKE ? OR metadata LIKE ?`,
      )
      .all(`%${ID}%`, `%${ID}%`, `%${ID}%`, `%${ID}%`, `%${ID}%`) as { n: number }[]
  )[0]!.n;
}

/** Seed one subject across three memories in ONE scope. Returns their ids in creation order. */
function seedSubjectAcrossThreeMemories(): string[] {
  const db = getDatabase();
  return [
    createMemory({ key: `contact-${ID}`, value: "a", scope: "global" }, "merge", db).id,
    createMemory({ key: `billing-${ID}`, value: "b", scope: "global" }, "merge", db).id,
    createMemory({ key: `support-${ID}`, value: "c", scope: "global" }, "merge", db).id,
  ];
}

const FAIL_TRIGGER = "gdpr_test_injected_midloop_failure";

/**
 * Make the erase fail when it reaches `rowId`, deterministically and from inside
 * the database — the same place a real constraint or trigger failure would come
 * from. This is how the atomicity guarantee is exercised without depending on a
 * collision, which the non-derived key has (correctly) made unreachable.
 */
function failEraseAtRow(rowId: string): void {
  getDatabase().exec(
    `CREATE TRIGGER ${FAIL_TRIGGER} BEFORE UPDATE ON memories
       WHEN NEW.id = '${rowId}' AND NEW.value = '[REDACTED]'
       BEGIN SELECT RAISE(ABORT, 'injected mid-loop failure'); END;`,
  );
}

function removeInjectedFailure(): void {
  getDatabase().exec(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER};`);
}

describe("gdprErase is atomic and its tombstone cannot be squatted (0a68d690 cycle 1)", () => {
  beforeEach(() => {
    resetDatabase();
  });

  afterEach(() => {
    // Never leave the injected failure armed for the next test.
    try {
      removeInjectedFailure();
    } catch {
      // the database may already be reset; nothing to clean
    }
  });

  // --------------------------------------------------------------------------
  // GROUP 1 — ATOMICITY. These are this cycle's acceptance bar. They fail on
  // BOTH 1a736623 and d164d14, and pass only with a transactional loop.
  // --------------------------------------------------------------------------

  it("leaves NO PARTIAL STATE when a write fails mid-loop", () => {
    const db = getDatabase();
    const subject = seedSubjectAcrossThreeMemories();

    // Positive control on the SETUP: all three rows expose the identifier before
    // the erase, so "none redacted afterwards" is a statement about the rollback
    // and not about an empty or mis-seeded store.
    expect(rowsExposingIdentifier()).toBe(3);

    // Fail on the SECOND row, so a non-transactional loop necessarily commits
    // the first one before it dies — which is exactly the state measured on
    // 1a736623 and the state this test forbids.
    failEraseAtRow(subject[1]!);

    expect(() => gdprErase(ID, {}, db)).toThrow();

    // ALL-OR-NOTHING: not one row may have survived the rollback as redacted.
    // Without the transaction this is 1, and the subject is half-erased with no
    // receipt describing which half.
    const redacted = subject.filter((id) => valueOf(id) !== "a" && valueOf(id) !== "b" && valueOf(id) !== "c");
    expect(redacted).toEqual([]);
    expect(rowsExposingIdentifier()).toBe(3);
    for (const id of subject) {
      expect(keyOf(id)).toContain(ID);
    }
  });

  it("RETRY RECOVERS after a mid-loop failure — the rollback leaves a clean, still-matching set", () => {
    const db = getDatabase();
    const subject = seedSubjectAcrossThreeMemories();

    failEraseAtRow(subject[1]!);
    expect(() => gdprErase(ID, {}, db)).toThrow();

    // The condition clears (a transient constraint, a freed lock, a fixed disk).
    removeInjectedFailure();

    // The whole subject must still be reachable by the identifier — this is the
    // property that made the pre-remediation failure PERMANENT: a partially
    // redacted set no longer fully matches, so the retry could never complete.
    const retry = gdprErase(ID, {}, db);

    expect(retry.erased_count).toBe(3);
    expect(new Set(retry.memory_ids)).toEqual(new Set(subject));
    expect(rowsExposingIdentifier()).toBe(0);
    for (const id of subject) {
      expect(keyOf(id)).not.toContain(ID);
      expect(valueOf(id)).toBe("[REDACTED]");
    }
  });

  it("a failed erase returns no receipt and erases no tags", () => {
    // The receipt ids are built inside the transaction closure. A rollback must
    // not leave behind a half-filled receipt, and the junction-table deletes in
    // the same loop must roll back with the row updates.
    const db = getDatabase();
    const first = createMemory(
      { key: `contact-${ID}`, value: "a", scope: "global", tags: ["keep-me"] },
      "merge",
      db,
    ).id;
    const second = createMemory({ key: `billing-${ID}`, value: "b", scope: "global" }, "merge", db).id;

    const tagsBefore = (
      db.query("SELECT COUNT(*) AS n FROM memory_tags WHERE memory_id = ?").all(first) as { n: number }[]
    )[0]!.n;
    // Positive control: the tag rows must exist, or "they survived" proves nothing.
    expect(tagsBefore).toBeGreaterThan(0);

    failEraseAtRow(second);
    expect(() => gdprErase(ID, {}, db)).toThrow();

    const tagsAfter = (
      db.query("SELECT COUNT(*) AS n FROM memory_tags WHERE memory_id = ?").all(first) as { n: number }[]
    )[0]!.n;
    expect(tagsAfter).toBe(tagsBefore);
    expect(valueOf(first)).toBe("a");
  });

  // --------------------------------------------------------------------------
  // GROUP 2 — TOMBSTONE SQUATTING. Regression record for the vector that was
  // live at 1a736623. These fail on 1a736623 and pass from d164d14 onward.
  // --------------------------------------------------------------------------

  it("erases every row when a bystander already occupies the id-derived tombstone key", () => {
    const db = getDatabase();
    const subject = seedSubjectAcrossThreeMemories();

    // The squat: an ORDINARY save, through the ordinary public path, under the
    // key the id-derived code computed for the SECOND subject row. It carries no
    // identifier, so the erase never matches it — a pure bystander that merely
    // occupies the tombstone's slot.
    const squattedKey = `[REDACTED]:${subject[1]}`;
    const bystander = createMemory(
      { key: squattedKey, value: "nothing sensitive in this row", scope: "global" },
      "merge",
      db,
    ).id;

    // Positive control on the SETUP: the squat must genuinely be a bystander —
    // exactly the 3 subject rows expose the identifier, and the squatter does not.
    expect(rowsExposingIdentifier()).toBe(3);
    expect(keyOf(bystander)).toBe(squattedKey);

    // (a) NO THROW. At 1a736623 this threw `UNIQUE constraint failed`.
    const result = gdprErase(ID, {}, db);

    // (b) EVERY row of the subject is redacted — no partial state.
    expect(result.erased_count).toBe(3);
    expect(new Set(result.memory_ids)).toEqual(new Set(subject));
    for (const id of subject) {
      expect(keyOf(id)).not.toContain(ID);
      expect(valueOf(id)).toBe("[REDACTED]");
    }
    expect(keysExposingIdentifier()).toEqual([]);
    expect(rowsExposingIdentifier()).toBe(0);

    // (c) The bystander is untouched — neither redacted nor displaced.
    expect(keyOf(bystander)).toBe(squattedKey);
    expect(valueOf(bystander)).toBe("nothing sensitive in this row");

    // The unique index still holds: every key in the store is distinct.
    const allKeys = (db.query("SELECT key FROM memories").all() as { key: string }[]).map((r) => r.key);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it("a bystander squatting the tombstone of EVERY subject row still does not block erasure", () => {
    // Widens the squat from one row to all of them, so a fix that merely
    // reordered the loop or skipped the first collision would not pass.
    const db = getDatabase();
    const subject = seedSubjectAcrossThreeMemories();
    const squats = subject.map(
      (id) =>
        createMemory({ key: `[REDACTED]:${id}`, value: `squat-${id}`, scope: "global" }, "merge", db).id,
    );

    expect(rowsExposingIdentifier()).toBe(3);

    const result = gdprErase(ID, {}, db);

    expect(result.erased_count).toBe(3);
    expect(rowsExposingIdentifier()).toBe(0);
    for (const id of subject) {
      expect(keyOf(id)).not.toContain(ID);
      expect(valueOf(id)).toBe("[REDACTED]");
    }
    // Every squatter survives untouched.
    for (let i = 0; i < squats.length; i++) {
      expect(keyOf(squats[i]!)).toBe(`[REDACTED]:${subject[i]}`);
      expect(valueOf(squats[i]!)).toBe(`squat-${subject[i]}`);
    }
  });

  it("the tombstone key is NOT a pure function of the memory id", () => {
    // The root cause stated as a property: a tombstone derivable from public
    // data can be squatted again by the same route.
    const db = getDatabase();

    const first = createMemory({ key: `contact-${ID}`, value: "a", scope: "global" }, "merge", db).id;
    gdprErase(ID, {}, db);
    const firstTombstone = keyOf(first);

    expect(firstTombstone).not.toBe(`[REDACTED]:${first}`);
    expect(firstTombstone).not.toContain(ID);
    expect(firstTombstone).not.toContain(first);
    expect(firstTombstone.startsWith("[REDACTED]")).toBe(true);
  });

  it("erasing twice in a row is clean — the second pass finds nothing and does not throw", () => {
    const db = getDatabase();
    const subject = seedSubjectAcrossThreeMemories();
    createMemory({ key: `[REDACTED]:${subject[1]}`, value: "bystander", scope: "global" }, "merge", db);

    const first = gdprErase(ID, {}, db);
    expect(first.erased_count).toBe(3);

    // `erased_count` 0 is the CORRECT answer — the subject is already gone — and
    // the row count below proves it is 0 because the work is done, not because
    // the query broke.
    const second = gdprErase(ID, {}, db);
    expect(second.erased_count).toBe(0);
    expect(rowsExposingIdentifier()).toBe(0);
  });

  it("dry_run still writes nothing when a squatter is present, and previews exactly what it erases", () => {
    // The preview and the erase share ONE SELECT. Neither the transaction nor
    // the key change may let the preview start writing, or split the two sets.
    const db = getDatabase();
    const subject = seedSubjectAcrossThreeMemories();
    const squattedKey = `[REDACTED]:${subject[1]}`;
    createMemory({ key: squattedKey, value: "bystander", scope: "global" }, "merge", db);

    const preview = gdprErase(ID, { dry_run: true }, db);

    expect(preview.erased_count).toBe(3);
    expect(rowsExposingIdentifier()).toBe(3);
    for (const id of subject) {
      expect(keyOf(id)).toContain(ID);
    }

    const erase = gdprErase(ID, {}, db);

    expect(erase.memory_ids).toEqual(preview.memory_ids);
    expect(erase.erased_count).toBe(preview.erased_count);
    expect(rowsExposingIdentifier()).toBe(0);
  });
});
