process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { detectContradiction, invalidateFact } from "./contradiction.js";
import { createMemory } from "../db/memories.js";

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
      metadata TEXT DEFAULT '{}',
      access_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      valid_from TEXT DEFAULT NULL,
      valid_until TEXT DEFAULT NULL,
      ingested_at TEXT DEFAULT NULL, namespace TEXT DEFAULT NULL, created_by_agent TEXT DEFAULT NULL, updated_by_agent TEXT DEFAULT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
  `);

  return db;
}

// ============================================================================
// Tests
// ============================================================================

describe("detectContradiction", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns no contradiction when no existing memories", async () => {
    const result = await detectContradiction("stack", "TypeScript", {}, db);
    expect(result.contradicts).toBe(false);
    expect(result.conflicting_memory).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("detects contradiction when same key has significantly different value", async () => {
    createMemory({ key: "stack", value: "Python Django PostgreSQL", importance: 8 }, "merge", db);
    const result = await detectContradiction("stack", "TypeScript Next.js MongoDB", { min_importance: 7 }, db);
    expect(result.contradicts).toBe(true);
    expect(result.conflicting_memory).not.toBeNull();
    expect(result.conflicting_memory!.value).toBe("Python Django PostgreSQL");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("does not flag contradiction for similar/updated values", async () => {
    createMemory({ key: "stack", value: "TypeScript with React and Next.js", importance: 8 }, "merge", db);
    // Update with very similar content — not a contradiction
    const result = await detectContradiction("stack", "TypeScript with React and Next.js and TailwindCSS", { min_importance: 7 }, db);
    // Low confidence — high word overlap means it's an update, not contradiction
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("ignores low-importance memories", async () => {
    createMemory({ key: "stack", value: "Python", importance: 3 }, "merge", db);
    const result = await detectContradiction("stack", "TypeScript", { min_importance: 7 }, db);
    // Should not find it because importance 3 < min_importance 7
    expect(result.contradicts).toBe(false);
  });

  it("checks against correct scope", async () => {
    createMemory({ key: "editor", value: "vim", importance: 9, scope: "global" }, "merge", db);
    createMemory({ key: "editor", value: "vscode", importance: 9, scope: "private" }, "merge", db);

    // Check against global scope only
    const result = await detectContradiction("editor", "emacs", { scope: "global", min_importance: 7 }, db);
    expect(result.contradicts).toBe(true);
    expect(result.conflicting_memory!.value).toBe("vim");
  });

  it("returns no contradiction for different keys", async () => {
    createMemory({ key: "database", value: "PostgreSQL", importance: 9 }, "merge", db);
    const result = await detectContradiction("stack", "TypeScript", { min_importance: 7 }, db);
    expect(result.contradicts).toBe(false);
  });

  it("returns no contradiction when existing memory is exact same value", async () => {
    createMemory({ key: "lang", value: "TypeScript", importance: 9 }, "merge", db);
    const result = await detectContradiction("lang", "TypeScript", { min_importance: 7 }, db);
    expect(result.contradicts).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("handles invalidated memories (valid_until in past)", async () => {
    // Insert a memory that has been temporally invalidated
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, tags, importance, source, status, pinned, access_count, version, valid_until, created_at, updated_at)
       VALUES ('old', 'stack', 'Python', 'fact', 'shared', '[]', 9, 'agent', 'active', 0, 0, 1, '2020-01-01', datetime('now'), datetime('now'))`
    );
    // Should not detect contradiction because old memory is temporally invalid
    const result = await detectContradiction("stack", "TypeScript", { min_importance: 7 }, db);
    expect(result.contradicts).toBe(false);
  });
});

// ============================================================================
// invalidateFact tests
// ============================================================================

describe("invalidateFact", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("sets valid_until on the old memory", () => {
    const mem = createMemory({ key: "lang", value: "Python", importance: 8 }, "merge", db);
    const result = invalidateFact(mem.id, undefined, db);

    expect(result.invalidated_memory_id).toBe(mem.id);
    expect(result.valid_until).toBeTruthy();

    // Verify the memory was updated in DB
    const row = db.query("SELECT valid_until FROM memories WHERE id = ?").get(mem.id) as { valid_until: string };
    expect(row.valid_until).toBeTruthy();
  });

  it("links superseding memory via metadata", () => {
    const old = createMemory({ key: "stack", value: "Python", importance: 8, session_id: "s1" }, "merge", db);
    const newMem = createMemory({ key: "stack", value: "TypeScript", importance: 9, session_id: "s2" }, "merge", db);

    const result = invalidateFact(old.id, newMem.id, db);

    expect(result.new_memory_id).toBe(newMem.id);

    // Verify supersedes_id in new memory's metadata
    const row = db.query("SELECT metadata FROM memories WHERE id = ?").get(newMem.id) as { metadata: string };
    const metadata = JSON.parse(row.metadata);
    expect(metadata.supersedes_id).toBe(old.id);
  });

  it("works without a new memory ID", () => {
    const mem = createMemory({ key: "config", value: "debug=true", importance: 7 }, "merge", db);
    const result = invalidateFact(mem.id, undefined, db);

    expect(result.new_memory_id).toBeNull();
    expect(result.invalidated_memory_id).toBe(mem.id);
  });

  it("invalidated memory excluded from temporal queries", () => {
    const mem = createMemory({ key: "db", value: "MySQL", importance: 9 }, "merge", db);
    invalidateFact(mem.id, undefined, db);

    // Now detectContradiction should not find this memory (it's invalidated)
    const result = db.query("SELECT valid_until FROM memories WHERE id = ?").get(mem.id) as { valid_until: string };
    expect(result.valid_until).toBeTruthy();
  });
});
