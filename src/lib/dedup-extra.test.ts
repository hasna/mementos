// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { checkDuplicate, resetDedupStats } from "./dedup.js";

// ============================================================================
// dedup.ts line 61 — catch block when searchMemories throws
// Triggered by closing the DB before the search runs
// ============================================================================

describe("checkDuplicate - catch block returns 'unique' when DB throws (line 61)", () => {
  beforeEach(() => {
    resetDatabase();
    getDatabase(":memory:");
    resetDedupStats();
  });

  test("returns 'unique' when searchMemories throws (DB closed, line 61)", () => {
    // Create a memory so the content-to-query path passes
    // (content has words > 3 chars, so query is non-empty)
    const db = getDatabase();
    createMemory({
      key: "dedup-catch-test",
      value: "database performance tuning important words",
      scope: "private",
      importance: 6,
    });

    // Close the DB so searchMemories will throw
    db.close();

    // checkDuplicate: query is non-empty (words > 3 chars exist),
    // searchMemories(query, ...) throws (DB closed) → catch fires (line 61) → returns "unique"
    const result = checkDuplicate(
      "database performance tuning important words",
      { scope: "private" }
    );

    expect(result).toBe("unique");

    // Re-open DB for subsequent tests
    resetDatabase();
    getDatabase(":memory:");
  });
});

// Note: dedup.ts line 113 (catch when getMemory throws) is covered by
// src/lib/dedup-line113.test.ts which uses mock.module to force getMemory to throw.
