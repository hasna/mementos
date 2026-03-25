// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import {
  createMemory,
  getMemory,
  parseMemoryRow,
} from "../db/memories.js";

// ============================================================================
// Helpers
// ============================================================================

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT UNIQUE NOT NULL,
      description TEXT,
      memory_prefix TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
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
      importance INTEGER NOT NULL DEFAULT 5 CHECK(importance >= 1 AND importance <= 10),
      source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('user', 'agent', 'system', 'auto', 'imported')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'expired')),
      pinned INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
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
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      value TEXT NOT NULL,
      importance INTEGER NOT NULL,
      scope TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      when_to_use TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(memory_id, version)
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);
  `);

  return db;
}

// ============================================================================
// Tests — Phase 5: Memory Chains
// ============================================================================

describe("memory chains", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("stores sequence_group and sequence_order on create", () => {
    const m = createMemory(
      {
        key: "chain-step-1",
        value: "First step of deployment",
        sequence_group: "deploy-flow",
        sequence_order: 1,
      },
      "merge",
      db
    );

    expect(m.sequence_group).toBe("deploy-flow");
    expect(m.sequence_order).toBe(1);

    // Verify persistence through getMemory
    const fetched = getMemory(m.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.sequence_group).toBe("deploy-flow");
    expect(fetched!.sequence_order).toBe(1);
  });

  it("retrieves chain members by sequence_group", () => {
    const groupId = "onboarding-flow";

    // Create 3 memories in the same chain
    const m1 = createMemory(
      { key: "onboard-step-1", value: "Clone the repo", sequence_group: groupId, sequence_order: 1 },
      "merge",
      db
    );
    const m2 = createMemory(
      { key: "onboard-step-2", value: "Install dependencies", sequence_group: groupId, sequence_order: 2 },
      "merge",
      db
    );
    const m3 = createMemory(
      { key: "onboard-step-3", value: "Run the tests", sequence_group: groupId, sequence_order: 3 },
      "merge",
      db
    );

    // Also create a memory outside the chain
    createMemory(
      { key: "unrelated-memory", value: "Not in the chain" },
      "merge",
      db
    );

    // Query chain members directly via SQL
    const chain = db
      .query("SELECT * FROM memories WHERE sequence_group = ? ORDER BY sequence_order ASC")
      .all(groupId) as Record<string, unknown>[];

    expect(chain.length).toBe(3);

    const parsed = chain.map(parseMemoryRow);
    expect(parsed[0]!.id).toBe(m1.id);
    expect(parsed[1]!.id).toBe(m2.id);
    expect(parsed[2]!.id).toBe(m3.id);
  });

  it("orders chain by sequence_order", () => {
    const groupId = "build-pipeline";

    // Create memories in reverse order to verify ordering is by sequence_order, not insert order
    createMemory(
      { key: "build-step-3", value: "Deploy", sequence_group: groupId, sequence_order: 3 },
      "merge",
      db
    );
    createMemory(
      { key: "build-step-1", value: "Lint", sequence_group: groupId, sequence_order: 1 },
      "merge",
      db
    );
    createMemory(
      { key: "build-step-2", value: "Test", sequence_group: groupId, sequence_order: 2 },
      "merge",
      db
    );

    const chain = db
      .query("SELECT * FROM memories WHERE sequence_group = ? ORDER BY sequence_order ASC")
      .all(groupId) as Record<string, unknown>[];

    const parsed = chain.map(parseMemoryRow);

    expect(parsed[0]!.value).toBe("Lint");
    expect(parsed[0]!.sequence_order).toBe(1);
    expect(parsed[1]!.value).toBe("Test");
    expect(parsed[1]!.sequence_order).toBe(2);
    expect(parsed[2]!.value).toBe("Deploy");
    expect(parsed[2]!.sequence_order).toBe(3);
  });

  it("allows memories without sequence_group", () => {
    const m = createMemory(
      { key: "standalone-memory", value: "Not part of any chain" },
      "merge",
      db
    );

    expect(m.sequence_group).toBeNull();
    expect(m.sequence_order).toBeNull();

    // Verify it does not appear in any chain query
    const chain = db
      .query("SELECT * FROM memories WHERE sequence_group IS NOT NULL")
      .all() as Record<string, unknown>[];

    expect(chain.length).toBe(0);
  });
});

// ============================================================================
// Tests — Phase 5: Contradiction Auto-Decay
// ============================================================================

describe("contradiction auto-decay", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("memories with same key can coexist", () => {
    // Two memories with same key but different scopes — unique index allows this
    const m1 = createMemory(
      { key: "preferred-lang", value: "TypeScript", scope: "shared" },
      "merge",
      db
    );
    const m2 = createMemory(
      { key: "preferred-lang", value: "Rust", scope: "private" },
      "merge",
      db
    );

    expect(m1.id).not.toBe(m2.id);
    expect(m1.value).toBe("TypeScript");
    expect(m2.value).toBe("Rust");

    // Both should be independently retrievable
    const fetched1 = getMemory(m1.id, db);
    const fetched2 = getMemory(m2.id, db);
    expect(fetched1).not.toBeNull();
    expect(fetched2).not.toBeNull();
    expect(fetched1!.value).toBe("TypeScript");
    expect(fetched2!.value).toBe("Rust");
  });

  it("newer memory has higher version after upsert", () => {
    // First create — version 1
    const m1 = createMemory(
      { key: "db-engine", value: "PostgreSQL", scope: "shared" },
      "merge",
      db
    );
    expect(m1.version).toBe(1);

    // Upsert same key+scope — should merge into same memory with bumped version
    const m2 = createMemory(
      { key: "db-engine", value: "SQLite is better for this use case", scope: "shared" },
      "merge",
      db
    );
    expect(m2.id).toBe(m1.id); // same memory, merged
    expect(m2.version).toBeGreaterThan(m1.version);
    expect(m2.value).toBe("SQLite is better for this use case");

    // Third upsert — version should keep incrementing
    const m3 = createMemory(
      { key: "db-engine", value: "Actually, DuckDB for analytics", scope: "shared" },
      "merge",
      db
    );
    expect(m3.id).toBe(m1.id);
    expect(m3.version).toBeGreaterThan(m2.version);
  });
});
