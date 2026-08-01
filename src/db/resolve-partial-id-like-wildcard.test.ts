// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase, resolvePartialId } from "./database.js";
import { getMemory, deleteMemory, bulkDeleteMemories, bulkUpsertMemories } from "./memories.js";
import { getAgent } from "./agents.js";

// ============================================================================
// Regression: `resolvePartialId` built `LIKE '<prefix>%'` with NO `ESCAPE`
// clause, so `%` and `_` arriving in a CALLER-SUPPLIED id were live SQL
// wildcards. `_` matches any single character, so `mementos forget _a` resolved
// onto — and deleted — a row the operator never named. Task ab83ea1d.
//
// This is strictly worse than the empty-id case guarded in #31. `''` expanded to
// `LIKE '%'`, which matches EVERY row, so it only resolved (length === 1) on a
// single-row store. `_a` matches a SUBSET, so it resolves whenever exactly one
// id happens to have `a` as its second character — ordinary on a populated
// store. A guard on `partialId === ""` does not cover it.
//
// Every assertion here READS THE ROW BACK. A count-only assertion is what passes
// against this bug: an implementation that returns 0 while still issuing the
// DELETE would satisfy `toBe(0)` and still destroy the row.
//
// The fixture ids are DETERMINISTIC on purpose. With random UUIDs, whether `_a`
// resolves depends on how many ids happen to carry `a` in position 2 (~2.5 of 40
// in expectation), so a random fixture reproduces the deletion only sometimes —
// a flaky test that fails to discriminate is worse than no test.
// ============================================================================

/**
 * A UUID-shaped id whose first two characters are fixed, so `LIKE '_a%'` either
 * matches by construction or cannot match at all.
 */
function idWith(head2: string, n: number): string {
  return `${head2}000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** The one row `_a` wildcard-matches: `a` sits in position 2. */
const VICTIM = idWith("0a", 0);

/** 39 rows carrying `b` in position 2 — outside the `_a` pattern by construction. */
const BYSTANDERS = Array.from({ length: 39 }, (_, i) =>
  idWith(`${i.toString(16).slice(-1)}b`, i + 1),
);

function seedRows(ids: string[]): void {
  bulkUpsertMemories(
    ids.map((id, i) => ({ id, key: `wildcard-fixture-${i}-${id.slice(0, 8)}`, value: "KEEP" })),
  );
}

function memoryCount(): number {
  return (getDatabase().query("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
}

beforeEach(() => {
  resetDatabase();
  getDatabase();
});

describe("a caller-supplied `_` is not a wildcard (populated store)", () => {
  it("bulkDeleteMemories('_a') deletes nothing and the wildcard-matched row survives", () => {
    seedRows([VICTIM, ...BYSTANDERS]);
    expect(memoryCount()).toBe(40);

    expect(bulkDeleteMemories(["_a"])).toBe(0);

    // The read-back is the assertion that matters — not the returned count.
    expect(getMemory(VICTIM)).not.toBeNull();
    expect(memoryCount()).toBe(40);
  });

  it("deleteMemory('_a') deletes nothing and the wildcard-matched row survives", () => {
    seedRows([VICTIM, ...BYSTANDERS]);

    expect(deleteMemory("_a")).toBe(false);

    expect(getMemory(VICTIM)).not.toBeNull();
    expect(memoryCount()).toBe(40);
  });

  it("resolvePartialId does not resolve `_a` onto the row whose second character is `a`", () => {
    seedRows([VICTIM, ...BYSTANDERS]);

    expect(resolvePartialId(getDatabase(), "memories", "_a")).toBeNull();
  });
});

describe("a caller-supplied `%` is not a wildcard", () => {
  // `%` is the empty-id case wearing a different character: it expands to
  // `LIKE '%%'` and matches every row, so it resolves on a single-row store.
  // The `partialId === ""` guard from #31 does not see it.
  it("bulkDeleteMemories('%') deletes nothing when the store holds exactly one row", () => {
    seedRows([VICTIM]);

    expect(bulkDeleteMemories(["%"])).toBe(0);

    expect(getMemory(VICTIM)).not.toBeNull();
    expect(memoryCount()).toBe(1);
  });

  it("deleteMemory('_') deletes nothing when the store holds exactly one row", () => {
    seedRows([VICTIM]);

    expect(deleteMemory("_")).toBe(false);

    expect(getMemory(VICTIM)).not.toBeNull();
    expect(memoryCount()).toBe(1);
  });
});

describe("the legitimate partial-id feature still works", () => {
  // A guard that rejected everything would pass every assertion above while
  // turning prefix resolution off. These are the controls that catch that.
  it("a genuine hex prefix still resolves to exactly its own row", () => {
    seedRows([VICTIM, ...BYSTANDERS]);

    expect(resolvePartialId(getDatabase(), "memories", VICTIM.slice(0, 8))).toBe(VICTIM);
  });

  it("a genuine hex prefix still deletes exactly its own row", () => {
    seedRows([VICTIM, ...BYSTANDERS]);

    expect(bulkDeleteMemories([VICTIM.slice(0, 8)])).toBe(1);

    expect(getMemory(VICTIM)).toBeNull();
    expect(getMemory(BYSTANDERS[0]!)).not.toBeNull();
    expect(memoryCount()).toBe(39);
  });

  it("a full 36-char id still resolves", () => {
    seedRows([VICTIM, ...BYSTANDERS]);

    expect(resolvePartialId(getDatabase(), "memories", VICTIM)).toBe(VICTIM);
  });

  it("a prefix that matches nothing still resolves to null", () => {
    seedRows([VICTIM, ...BYSTANDERS]);

    expect(resolvePartialId(getDatabase(), "memories", "ffffffff")).toBeNull();
  });
});

describe("ids that legitimately contain `_` resolve by their literal prefix", () => {
  // `bulkUpsertMemories` writes a CALLER-SUPPLIED id verbatim (src/db/memories.ts,
  // `const id = (mem["id"] as string) || uuid()`), and validates no charset. So the
  // memories id space is NOT UUID-only in practice, and a fix that rejected every
  // prefix outside [0-9a-f-] would make an imported row unaddressable by prefix.
  // Escaping keeps `_` addressable AS A LITERAL, which is the behaviour that is
  // both safe and complete.
  const LITERAL = "a_b12345-0000-4000-8000-00000000aaaa";
  const DECOY = "axb12345-0000-4000-8000-00000000bbbb";

  it("bulkUpsertMemories stores a non-hex id verbatim", () => {
    seedRows([LITERAL]);

    expect(getMemory(LITERAL)).not.toBeNull();
  });

  it("`a_b` resolves to the literal `a_b…` row and not to the `axb…` decoy", () => {
    seedRows([LITERAL, DECOY]);

    // Unescaped, `a_b` matches BOTH rows, the count is 2, and resolution returns
    // null — the operator's exact id silently fails to resolve.
    expect(resolvePartialId(getDatabase(), "memories", "a_b")).toBe(LITERAL);
  });

  it("the `axb…` decoy is still reachable by its own literal prefix", () => {
    seedRows([LITERAL, DECOY]);

    expect(resolvePartialId(getDatabase(), "memories", "axb")).toBe(DECOY);
  });
});

describe("getAgent's hand-rolled partial-id branch has the same hazard", () => {
  // `getAgent` does not call resolvePartialId — it builds its own
  // `LIKE '<prefix>%'`, so it carried an identical unescaped wildcard. This is a
  // READ, so the cost is a wrong agent identity rather than a deleted row, but
  // it is the same defect and the same one-line remedy.
  function seedAgent(id: string, name: string): void {
    getDatabase().run(
      "INSERT INTO agents (id, name, role, created_at, last_seen_at) VALUES (?, ?, 'agent', ?, ?)",
      [id, name, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
  }

  it("does not resolve `_a` onto the agent whose second character is `a`", () => {
    seedAgent("0a111111", "victim-agent");
    seedAgent("0b222222", "bystander-agent");

    expect(getAgent("_a")).toBeNull();
  });

  it("still resolves a genuine hex prefix to its own agent", () => {
    seedAgent("0a111111", "victim-agent");
    seedAgent("0b222222", "bystander-agent");

    expect(getAgent("0a11")?.name).toBe("victim-agent");
  });
});
