// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { resetDatabase, getDatabase } from "../../db/database.js";
import { createMemory } from "../../db/memories.js";
import { recordSynthesisEvent } from "../../db/synthesis.js";
import { buildCorpus } from "./corpus-builder.js";

// ============================================================================
// Helpers
// ============================================================================

function freshDb(): Database {
  resetDatabase();
  return getDatabase(":memory:");
}

// ============================================================================
// isStale — accessed_at branch (line 77)
// isStale returns the date comparison when accessed_at is non-null
// ============================================================================

describe("buildCorpus - isStale with accessed_at set (line 77)", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("memory with old accessed_at is still considered stale (line 77-78)", async () => {
    // Create a memory with importance < 7 and accessed_at more than 30 days ago
    // This exercises line 77 (thirtyDaysAgo computation) and line 78 (comparison)
    const mem = createMemory(
      {
        key: "stale-accessed-old",
        value: "some old content",
        importance: 3,
        scope: "private",
      },
      "insert",
      db
    );

    // Set accessed_at to 60 days ago (past the 30-day threshold)
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET accessed_at = ? WHERE id = ?", [sixtyDaysAgo, mem.id]);

    const corpus = await buildCorpus({ db });
    // The memory should be detected as stale (accessed_at is old → line 78 returns true)
    const staleKeys = corpus.staleMemories.map((m) => m.key);
    expect(staleKeys).toContain("stale-accessed-old");
  });

  it("memory with recent accessed_at is NOT stale (line 77-78, returns false)", async () => {
    // Create a memory with importance < 7 but accessed_at recently
    // This exercises line 77 (thirtyDaysAgo) and line 78 returns false
    const mem = createMemory(
      {
        key: "fresh-accessed-recent",
        value: "recently accessed content",
        importance: 3,
        scope: "private",
      },
      "insert",
      db
    );

    // Set accessed_at to just 1 day ago (within 30-day window)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET accessed_at = ? WHERE id = ?", [oneDayAgo, mem.id]);

    const corpus = await buildCorpus({ db });
    // The memory should NOT be stale (recently accessed → line 78 returns false)
    const staleKeys = corpus.staleMemories.map((m) => m.key);
    expect(staleKeys).not.toContain("fresh-accessed-recent");
  });
});

// ============================================================================
// searchHits map — null memory_id branch (lines 139-140)
// A "searched" synthesis event with no memory_id causes the loop to continue
// ============================================================================

describe("buildCorpus - searched event with null memory_id (lines 139-140)", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("skips searched events with null memory_id (lines 139-140)", async () => {
    createMemory(
      { key: "search-event-test", value: "content for search hit test", importance: 5 },
      "insert",
      db
    );

    // Record a "searched" event WITHOUT a memory_id (null memory_id)
    // This triggers the `if (!event.memory_id) continue;` at line 139
    recordSynthesisEvent({ event_type: "searched", memory_id: null }, db);

    // Also record one WITH a memory_id to ensure the map works normally
    recordSynthesisEvent(
      { event_type: "searched", memory_id: "some-other-id", query: "test" },
      db
    );

    // buildCorpus should complete without error — the null memory_id event is skipped
    const corpus = await buildCorpus({ db });
    expect(typeof corpus.totalMemories).toBe("number");
    // The null memory_id event should not cause any crash
    expect(Array.isArray(corpus.items)).toBe(true);
  });
});
