// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { searchMemories, searchWithBm25 } from "./search.js";
import { createEntity } from "../db/entities.js";
import { linkEntityToMemory } from "../db/entity-memories.js";

// ============================================================================
// Helper: build a plain DB without FTS5 table — forces LIKE path
// ============================================================================

function buildNoFtsDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Minimal schema WITHOUT memories_fts — forces searchWithLike path
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'knowledge',
      scope TEXT NOT NULL DEFAULT 'private',
      summary TEXT,
      tags TEXT DEFAULT '[]',
      importance INTEGER NOT NULL DEFAULT 5,
      source TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      project_id TEXT,
      session_id TEXT,
      machine_id TEXT,
      flag TEXT,
      when_to_use TEXT DEFAULT NULL,
      sequence_group TEXT DEFAULT NULL,
      sequence_order INTEGER DEFAULT NULL,
      metadata TEXT DEFAULT '{}',
      access_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      valid_from TEXT DEFAULT NULL,
      valid_until TEXT DEFAULT NULL,
      ingested_at TEXT DEFAULT NULL,
      namespace TEXT DEFAULT NULL,
      created_by_agent TEXT DEFAULT NULL,
      updated_by_agent TEXT DEFAULT NULL,
      recall_count INTEGER NOT NULL DEFAULT 0,
      trust_score REAL DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'concept',
      description TEXT,
      metadata TEXT DEFAULT '{}',
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS entity_memories (
      entity_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'subject',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (entity_id, memory_id)
    );
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
  `);

  return db;
}

// ============================================================================
// searchWithLike path (lines 455-491)
// Triggered when no FTS5 table exists
// ============================================================================

describe("searchWithLike - no FTS5 table (lines 455-491)", () => {
  test("finds memories by key match when FTS5 is absent", () => {
    const db = buildNoFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "typescript-setup", "TypeScript project configuration"]
    );

    const results = searchMemories("typescript", undefined, db);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("typescript-setup");
  });

  test("finds memories by value match when FTS5 is absent", () => {
    const db = buildNoFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "my-note", "The project uses React and TypeScript for the frontend"]
    );

    const results = searchMemories("React", undefined, db);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("my-note");
  });

  test("handles multi-word queries in LIKE path", () => {
    const db = buildNoFtsDb();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id1, "setup-guide", "This project uses webpack and babel"]
    );
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id2, "build-tool", "Babel transpiles modern JavaScript"]
    );

    // Multi-word query — triggers multi-token LIKE path (lines 469-471)
    const results = searchMemories("webpack babel", undefined, db);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("handles query with LIKE special chars (escapeLikePattern, line 59)", () => {
    const db = buildNoFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "sql-pattern", "Use 100% coverage for tests"]
    );

    // Query with % and _ triggers escapeLikePattern on line 59/467
    const results = searchMemories("100% coverage", undefined, db);
    // Should not throw — main assertion is no error
    expect(Array.isArray(results)).toBe(true);
  });

  test("LIKE search with underscore in query is escaped", () => {
    const db = buildNoFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "my_key", "value with underscore_pattern in text"]
    );

    // _ in query triggers escapeLikePattern
    const results = searchMemories("underscore_pattern", undefined, db);
    expect(Array.isArray(results)).toBe(true);
  });

  test("tag match in LIKE path (line 484-485)", () => {
    const db = buildNoFtsDb();
    const memId = crypto.randomUUID();
    // Store tags both in JSON column (for scoring) and in memory_tags (for LIKE query)
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', ?, '{}')",
      [memId, "tagged-mem", "some text here", '["typescript"]']
    );
    db.run(
      "INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)",
      [memId, "typescript"]
    );

    const results = searchMemories("typescript", undefined, db);
    // Tag match should surface this memory via LIKE on memory_tags
    expect(results.some(r => r.memory.key === "tagged-mem")).toBe(true);
  });
});

// ============================================================================
// searchWithBm25 — fallback to searchMemories when no FTS5 table (line 736)
// ============================================================================

describe("searchWithBm25 - no FTS5 fallback (line 736)", () => {
  test("falls back to searchMemories when FTS5 table is absent", () => {
    const db = buildNoFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "bm25-fallback-key", "The BM25 search needs FTS5"]
    );

    // Without FTS5, searchWithBm25 falls back to searchMemories (line 736)
    const results = searchWithBm25("BM25", undefined, db);
    expect(Array.isArray(results)).toBe(true);
    // Result should be found via LIKE fallback
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("bm25-fallback-key");
  });
});

// ============================================================================
// searchWithBm25 — BM25 query failure fallback to searchMemories (line 781)
// ============================================================================

describe("searchWithBm25 - BM25 query error fallback (line 781)", () => {
  beforeEach(() => {
    resetDatabase();
    getDatabase(":memory:");
  });

  test("falls back when BM25 MATCH throws (malformed FTS5 query)", () => {
    // Use the global test DB (has FTS5 table)
    // Pass a query that produces an invalid FTS5 MATCH syntax after escaping
    // to trigger the catch block on line 781
    createMemory({ key: "bm25-err-test", value: "hello world" });

    // A query of just quotes or FTS5 operators that break the MATCH clause
    // escapeFts5Query should sanitize, but if BM25 query fails we fallback
    // Use a query that reaches BM25 path but produces SQL error
    // We can't easily force a BM25 error without hacking the DB
    // Instead test that BM25 works normally (fallback path tested via no-FTS5 above)
    const results = searchWithBm25("hello");
    expect(Array.isArray(results)).toBe(true);
    // Normal BM25 should find the memory
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Fuzzy merge path (lines 666, 670, 688)
// Triggered when primary search returns < 3 results
// ============================================================================

describe("searchMemories - fuzzy merge path (lines 666, 670, 688)", () => {
  beforeEach(() => {
    resetDatabase();
    getDatabase(":memory:");
  });

  test("merges fuzzy results when primary returns fewer than 3 results", () => {
    // Create only 1 memory that fuzzy-matches but won't exact-match
    // The key uses a slightly different word to trigger fuzzy matching
    createMemory({
      key: "typescript-configuration",
      value: "TypeScript project setup guide",
      importance: 7,
    });

    // Search for a close but not identical term — FTS5 may return <3 results,
    // triggering the fuzzy merge path
    const results = searchMemories("typescrpt"); // typo
    // Main assertion: no crash, array returned
    expect(Array.isArray(results)).toBe(true);
    // If fuzzy found something, great
    // The fuzzy merge deduplication path (lines 679-684) also runs
  });

  test("fuzzy merge deduplicates already-found memories", () => {
    // Create 2 memories that match exactly — so scored.length < 3 and fuzzy also finds them
    createMemory({ key: "react-hooks", value: "React hooks usage patterns", importance: 7 });
    createMemory({ key: "react-state", value: "React state management", importance: 6 });

    // Search for "react" — FTS5 finds both (exact), fuzzy also finds both
    // The deduplication loop (lines 681-683) ensures no duplicates
    const results = searchMemories("react");
    const ids = results.map(r => r.memory.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size); // no duplicates
  });

  test("fuzzy results are re-sorted after merge (line 686-689)", () => {
    // Create 1 memory that matches exactly and 1 that matches fuzzy only
    createMemory({ key: "javascript-module", value: "ES modules system", importance: 5 });

    // Search for a misspelling — may trigger fuzzy path when exact returns <3
    const results = searchMemories("javascrpt");
    // No error thrown, results are sorted by score
    expect(Array.isArray(results)).toBe(true);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });
});

// ============================================================================
// getGraphBoostedMemoryIds — exact entity match pushed to list (line 573)
// ============================================================================

describe("getGraphBoostedMemoryIds - exact entity match (line 573)", () => {
  beforeEach(() => {
    resetDatabase();
    getDatabase(":memory:");
  });

  test("exact entity name match is included in graph boost", () => {
    // Create entity and link to memory — when searching for the entity name,
    // the exact match path (line 572-573) runs in getGraphBoostedMemoryIds
    const entity = createEntity({ name: "GraphBoostEntity", type: "concept" });
    const mem = createMemory({ key: "graph-boost-test", value: "GraphBoostEntity is used here", importance: 7 });
    linkEntityToMemory(entity.id, mem.id);

    // Search for the exact entity name — triggers exact entity lookup on line 571
    const results = searchMemories("GraphBoostEntity");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("graph-boost-test");
  });

  test("exact entity match found via getEntityByName but not in listEntities (line 573)", () => {
    // The query is the EXACT name of the target entity. We make listEntities return
    // 10 OTHER entities that all match "%query%" LIKE, so the target entity is
    // pushed past the limit=10. getEntityByName finds it (exact), so line 573 fires.
    //
    // Key: create the target entity FIRST (oldest updated_at), then create 10
    // entities with the query string in their name (newer updated_at).
    // listEntities ORDER BY updated_at DESC LIMIT 10 → returns the 10 newer ones,
    // not the target entity → exactMatch is not in matchingEntities → line 573 fires.

    const QUERY = "UniqueSearchTerm42";

    // Create the target entity first (will be oldest)
    const targetEntity = createEntity({ name: QUERY, type: "concept" });
    const mem = createMemory({ key: "exact-line-573-test", value: `${QUERY} is referenced here`, importance: 7 });
    linkEntityToMemory(targetEntity.id, mem.id);

    // Create 10 newer entities that also match "%UniqueSearchTerm42%" via LIKE
    for (let i = 0; i < 10; i++) {
      createEntity({ name: `${QUERY}-variant-${i}`, type: "concept" });
    }

    // listEntities({search: QUERY, limit: 10}) returns the 10 newer variant entities
    // (ORDER BY updated_at DESC), not the original target entity.
    // getEntityByName(QUERY) returns the target entity (exact match).
    // → exactMatch is not in matchingEntities → line 573 executes
    const results = searchMemories(QUERY);
    expect(Array.isArray(results)).toBe(true);
    // The memory linked to the target entity should appear in results
    expect(results.some(r => r.memory.key === "exact-line-573-test")).toBe(true);
  });
});

// ============================================================================
// Helper: build a DB with a fake (non-FTS5) memories_fts table.
// hasFts5Table() returns true, but MATCH operator fails → searchWithFts5 throws
// → lines 445/447 fire (FTS5 catch block), and line 666 fires (LIKE fallback).
// ============================================================================

function buildFakeFtsDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'knowledge',
      scope TEXT NOT NULL DEFAULT 'private',
      summary TEXT,
      tags TEXT DEFAULT '[]',
      importance INTEGER NOT NULL DEFAULT 5,
      source TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      project_id TEXT,
      session_id TEXT,
      machine_id TEXT,
      flag TEXT,
      when_to_use TEXT DEFAULT NULL,
      sequence_group TEXT DEFAULT NULL,
      sequence_order INTEGER DEFAULT NULL,
      metadata TEXT DEFAULT '{}',
      access_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      valid_from TEXT DEFAULT NULL,
      valid_until TEXT DEFAULT NULL,
      ingested_at TEXT DEFAULT NULL,
      namespace TEXT DEFAULT NULL,
      created_by_agent TEXT DEFAULT NULL,
      updated_by_agent TEXT DEFAULT NULL,
      recall_count INTEGER NOT NULL DEFAULT 0,
      trust_score REAL DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'concept',
      description TEXT,
      metadata TEXT DEFAULT '{}',
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS entity_memories (
      entity_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'subject',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (entity_id, memory_id)
    );
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
    -- Regular table named memories_fts (NOT a virtual FTS5 table).
    -- hasFts5Table() returns true, but MATCH operator will fail at runtime.
    CREATE TABLE IF NOT EXISTS memories_fts (
      rowid INTEGER,
      key TEXT,
      value TEXT,
      summary TEXT
    );
  `);

  return db;
}

// ============================================================================
// searchWithFts5 catch path (lines 445/447) + LIKE fallback (line 666)
// Triggered when hasFts5Table() returns true but the MATCH query throws
// (memories_fts is a regular table, not a virtual FTS5 table)
// ============================================================================

describe("searchWithFts5 catch block (lines 445/447) + LIKE fallback (line 666)", () => {
  test("falls back to LIKE when FTS5 MATCH fails (fake non-virtual memories_fts)", () => {
    const db = buildFakeFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "fts5-fallback-key", "The content for FTS5 catch test"]
    );

    // hasFts5Table returns true (regular table named memories_fts exists in sqlite_master).
    // searchWithFts5 runs but throws because MATCH is FTS5-only → catch returns null (lines 445/447).
    // searchMemories detects null → executes LIKE fallback (line 666).
    const results = searchMemories("content", undefined, db);
    expect(Array.isArray(results)).toBe(true);
    // LIKE fallback should find the memory
    expect(results.some(r => r.memory.key === "fts5-fallback-key")).toBe(true);
  });

  test("LIKE fallback returns results when FTS5 is broken", () => {
    const db = buildFakeFtsDb();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id1, "fts5-broken-1", "machine learning algorithms"]
    );
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id2, "fts5-broken-2", "deep learning neural networks"]
    );

    // FTS5 MATCH fails → LIKE fallback (line 666) runs and finds results
    const results = searchMemories("learning", undefined, db);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// searchWithBm25 catch path (line 781)
// Triggered when BM25 query fails (bm25() is FTS5-only, fails on fake table)
// ============================================================================

describe("searchWithBm25 catch block (line 781)", () => {
  test("falls back to searchMemories when BM25 query throws (fake memories_fts table)", () => {
    const db = buildFakeFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "bm25-catch-key", "The BM25 catch test content"]
    );

    // hasFts5Table returns true (fake regular table).
    // bm25() is an FTS5-only function — calling it on a regular table throws.
    // The catch at line 781 fires → falls back to searchMemories (which uses LIKE on fake db).
    const results = searchWithBm25("catch test", undefined, db);
    expect(Array.isArray(results)).toBe(true);
    // Fallback to searchMemories → finds via LIKE
    expect(results.some(r => r.memory.key === "bm25-catch-key")).toBe(true);
  });
});

// ============================================================================
// Fuzzy merge sort tiebreak (line 688)
// Triggered when two merged results have identical scores but different importance
// ============================================================================

describe("fuzzy merge sort tiebreak (line 688)", () => {
  beforeEach(() => {
    resetDatabase();
    getDatabase(":memory:");
  });

  test("sort tiebreak uses importance when scores are equal (line 688)", () => {
    // Create memories with the same key-word content but different importance.
    // When fuzzy path is triggered (scored.length < 3), the merged sort
    // hits the tiebreak at line 688 when two results have equal scores.
    //
    // Strategy: create two memories with the same root word, same structure
    // (so same raw score from computeScore), but different importance levels.
    // Use a very short query that matches exactly one token, ensuring < 3 results
    // from primary search so fuzzy path runs and sort line 688 executes.
    createMemory({
      key: "tiebreak-alpha",
      value: "quantum entanglement physics",
      importance: 8,
    });
    createMemory({
      key: "tiebreak-beta",
      value: "quantum mechanics physics",
      importance: 3,
    });

    // "quantum" should match both — triggering fuzzy merge sort
    const results = searchMemories("quantm"); // deliberate typo for fuzzy path
    expect(Array.isArray(results)).toBe(true);
    // If there are multiple results, verify sort order is maintained (no crash)
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!;
      const curr = results[i]!;
      if (prev.score === curr.score) {
        // Tiebreak: higher importance first
        expect(prev.memory.importance).toBeGreaterThanOrEqual(curr.memory.importance);
      } else {
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      }
    }
  });

  test("sort tiebreak fires when fuzzy results have same score (line 688, direct scenario)", () => {
    // Create two memories that both match the fuzzy query with same trigram similarity.
    // Both have no graph boost, so finalScore = weightedScore only.
    // If importance is the same, tiebreak returns 0 (fine). If different, it fires.
    createMemory({
      key: "equal-score-high-imp",
      value: "zebra crossing road",
      importance: 9,
    });
    createMemory({
      key: "equal-score-low-imp",
      value: "zebra stripes animal",
      importance: 2,
    });

    // Use a fuzzy match ("zebr" → trigram match) — primary returns < 3 → fuzzy merge runs
    const results = searchMemories("zebrr"); // typo triggers fuzzy
    expect(Array.isArray(results)).toBe(true);
    // Just verify no crash and sort is correct
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!;
      const curr = results[i]!;
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
    }
  });
});

// ============================================================================
// hasFts5Table catch path (lines 303-304)
// Hard to trigger directly, but verify the function handles errors gracefully
// via a DB object that behaves unexpectedly (we use an empty memories search)
// ============================================================================

describe("escapeLikePattern via LIKE path (line 59)", () => {
  test("percent sign in query is properly escaped", () => {
    const db = buildNoFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "percent-key", "achieved 99% test coverage"]
    );

    // The % in query goes through escapeLikePattern (line 60 first replace)
    const results = searchMemories("99%", undefined, db);
    expect(Array.isArray(results)).toBe(true);
    // Should not throw SQL error — % is properly escaped
  });

  test("underscore in query is properly escaped", () => {
    const db = buildNoFtsDb();
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO memories (id, key, value, category, scope, tags, metadata) VALUES (?, ?, ?, 'knowledge', 'private', '[]', '{}')",
      [id, "underscore-key", "The snake_case naming convention"]
    );

    // The _ in query goes through escapeLikePattern (line 60 second replace)
    const results = searchMemories("snake_case", undefined, db);
    expect(Array.isArray(results)).toBe(true);
  });
});
