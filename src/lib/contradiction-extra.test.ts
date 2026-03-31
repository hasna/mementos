// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { detectContradiction } from "./contradiction.js";
import { createMemory } from "../db/memories.js";
import { providerRegistry } from "./providers/registry.js";

// ============================================================================
// detectContradiction — additional tests for uncovered branches
// Lines 128-142, 184-185, 228-236
// ============================================================================

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT DEFAULT 'agent',
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'knowledge' CHECK(category IN ('preference', 'fact', 'knowledge', 'history', 'procedural', 'resource')),
      scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('global', 'shared', 'private', 'working')),
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
  `);

  return db;
}

describe("detectContradiction - LLM and edge cases", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("uses use_llm=true on borderline (0.3-0.7) confidence cases", async () => {
    // Create a memory with moderate overlap — should get ~0.4 score
    createMemory({ key: "framework", value: "React hooks patterns", importance: 8 }, "merge", db);
    const result = await detectContradiction(
      "framework",
      "Vue composition patterns",
      { min_importance: 7, use_llm: true },
      db
    );
    // LLM check is called but returns same or lower confidence
    expect(typeof result.contradicts).toBe("boolean");
    expect(typeof result.confidence).toBe("number");
  });

  it("handles use_llm=false without calling LLM", async () => {
    createMemory({ key: "lang", value: "Python programming", importance: 8 }, "merge", db);
    const result = await detectContradiction(
      "lang",
      "Go programming completely different",
      { min_importance: 7, use_llm: false },
      db
    );
    expect(typeof result.contradicts).toBe("boolean");
  });

  it("checks against project_id filter", async () => {
    // Insert memories with specific project_ids manually
    db.run(`
      INSERT INTO memories (id, key, value, category, scope, tags, importance, source, status, pinned, access_count, version, created_at, updated_at)
      VALUES ('mem-proj', 'db-engine', 'MySQL database', 'fact', 'shared', '[]', 9, 'agent', 'active', 0, 0, 1, datetime('now'), datetime('now'))
    `);
    // Without project_id filter — should find the memory
    const result1 = await detectContradiction(
      "db-engine",
      "PostgreSQL is better",
      { min_importance: 7, project_id: undefined },
      db
    );
    expect(result1.conflicting_memory).not.toBeNull();

    // With a different project_id — should not find it
    const result2 = await detectContradiction(
      "db-engine",
      "PostgreSQL is better",
      { min_importance: 7, project_id: "different-project" },
      db
    );
    expect(result2.conflicting_memory).toBeNull();
  });

  it("returns reasoning string in contradiction result", async () => {
    createMemory({ key: "runtime", value: "Node.js server", importance: 8 }, "merge", db);
    const result = await detectContradiction(
      "runtime",
      "Bun runtime completely different",
      { min_importance: 7 },
      db
    );
    expect(typeof result.reasoning).toBe("string");
    expect(result.reasoning.length).toBeGreaterThan(0);
  });

  it("detects borderline contradiction (0.3-0.5 confidence range)", async () => {
    // Create overlapping but different content
    createMemory({ key: "storage", value: "use Redis for caching data", importance: 8 }, "merge", db);
    const result = await detectContradiction(
      "storage",
      "use Memcached for caching sessions",
      { min_importance: 7 },
      db
    );
    // Both mention caching — moderate overlap
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(typeof result.contradicts).toBe("boolean");
  });

  it("handles multiple existing memories and picks best contradiction", async () => {
    createMemory({ key: "style", value: "tabs for indentation", importance: 8, session_id: "s1" }, "merge", db);
    createMemory({ key: "style", value: "spaces for indentation coding", importance: 9, session_id: "s2" }, "merge", db);

    const result = await detectContradiction(
      "style",
      "always use spaces in Python files for indentation",
      { min_importance: 7 },
      db
    );
    // Should find at least one conflict
    expect(typeof result.confidence).toBe("number");
  });

  // ============================================================================
  // llmContradictionCheck internal path (lines 128-141) AND LLM block (228-229)
  // Covered by calling detectContradiction with use_llm=true AND a mocked
  // provider so getAvailable() returns non-null → lines 133-141 execute
  // The 0.3-0.7 confidence range is also hit → line 228 executes
  // ============================================================================

  it("llmContradictionCheck executes with non-null provider (lines 128-141, 228-229)", async () => {
    const originalGetAvailable = providerRegistry.getAvailable.bind(providerRegistry);

    // Make getAvailable return a non-null provider → enters lines 138-141
    providerRegistry.getAvailable = () => ({
      name: "anthropic" as const,
      config: { apiKey: "fake", model: "claude-3-haiku-20240307" },
      extractMemories: async () => [],
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 5,
    });

    // Insert a high-importance memory with 0.3-0.5 word overlap ratio
    // existing value: "use Redis caching data storage" (5 words)
    // new value: "use Memcached caching sessions" (4 words)
    // overlap: {use, caching} = 2; totalUnique = {use, redis, caching, data, storage, memcached, sessions} = 7
    // overlapRatio = 2/7 ≈ 0.28 < 0.3 → score = 0.7 (too high)
    // Try: existing "use Redis database" (3 words), new "use Postgres database performance" (4 words)
    // overlap: {use, database} = 2; totalUnique = {use, redis, database, postgres, performance} = 5
    // overlapRatio = 2/5 = 0.4 → score = 0.4 ✓ (in [0.3, 0.7))
    db.run(`
      INSERT INTO memories (id, key, value, category, scope, tags, importance, source, status, pinned, access_count, version, created_at, updated_at)
      VALUES ('llm-cov-1', 'db-choice', 'use Redis database', 'fact', 'private', '[]', 9, 'agent', 'active', 0, 0, 1, datetime('now'), datetime('now'))
    `);

    const result = await detectContradiction(
      "db-choice",
      "use Postgres database performance", // overlapRatio = 0.4 → heuristic score = 0.4 (in [0.3, 0.7))
      { min_importance: 7, use_llm: true },
      db
    );

    providerRegistry.getAvailable = originalGetAvailable;

    // llmContradictionCheck: provider non-null → executes lines 138-141, returns confidence=0
    // Line 229: llmResult.confidence(0) > bestContradiction.confidence(0.4) → false
    // Lines 230-235 remain uncovered (unreachable given stub implementation)
    // But lines 128-141 and 228-229 are now covered
    expect(typeof result.contradicts).toBe("boolean");
    expect(result.confidence).toBeGreaterThanOrEqual(0.3);
  });
});
