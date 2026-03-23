// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createMemory,
  getMemory,
  getMemoryByKey,
  getMemoriesByKey,
  listMemories,
  updateMemory,
  deleteMemory,
  bulkDeleteMemories,
  touchMemory,
  cleanExpiredMemories,
  getMemoryVersions,
} from "./memories.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
} from "../types/index.js";
import type {
  CreateMemoryInput,
  MemoryScope,
  MemoryCategory,
  MemorySource,
} from "../types/index.js";

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
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);
  `);

  return db;
}

function seedAgent(db: Database, id: string, name: string): void {
  db.run(
    "INSERT INTO agents (id, name) VALUES (?, ?)",
    [id, name]
  );
}

function seedProject(db: Database, id: string, name: string, path: string): void {
  db.run(
    "INSERT INTO projects (id, name, path) VALUES (?, ?, ?)",
    [id, name, path]
  );
}

function getTagsForMemory(db: Database, memoryId: string): string[] {
  const rows = db
    .query("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag")
    .all(memoryId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

// ============================================================================
// createMemory
// ============================================================================

describe("createMemory", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("creates with minimal input (key+value only, check defaults)", () => {
    const mem = createMemory({ key: "lang", value: "TypeScript" }, "merge", db);
    expect(mem.key).toBe("lang");
    expect(mem.value).toBe("TypeScript");
    expect(mem.category).toBe("knowledge");
    expect(mem.scope).toBe("private");
    expect(mem.importance).toBe(5);
    expect(mem.source).toBe("agent");
    expect(mem.status).toBe("active");
    expect(mem.pinned).toBe(false);
    expect(mem.version).toBe(1);
    expect(mem.access_count).toBe(0);
    expect(mem.tags).toEqual([]);
    expect(mem.metadata).toEqual({});
    expect(mem.summary).toBeNull();
    expect(mem.agent_id).toBeNull();
    expect(mem.project_id).toBeNull();
    expect(mem.session_id).toBeNull();
    expect(mem.expires_at).toBeNull();
    expect(mem.accessed_at).toBeNull();
    expect(mem.id).toBeTruthy();
    expect(mem.created_at).toBeTruthy();
    expect(mem.updated_at).toBeTruthy();
  });

  it("creates with all fields", () => {
    seedAgent(db, "agent-1", "agent1");
    seedProject(db, "proj-1", "my-proj", "/tmp/proj");

    const mem = createMemory(
      {
        key: "editor",
        value: "vim",
        category: "preference",
        scope: "shared",
        summary: "User prefers vim",
        tags: ["tools", "editor"],
        importance: 8,
        source: "user",
        agent_id: "agent-1",
        project_id: "proj-1",
        session_id: "sess-1",
        metadata: { reason: "user stated" },
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      "merge",
      db
    );

    expect(mem.key).toBe("editor");
    expect(mem.value).toBe("vim");
    expect(mem.category).toBe("preference");
    expect(mem.scope).toBe("shared");
    expect(mem.summary).toBe("User prefers vim");
    expect(mem.tags).toEqual(["tools", "editor"]);
    expect(mem.importance).toBe(8);
    expect(mem.source).toBe("user");
    expect(mem.agent_id).toBe("agent-1");
    expect(mem.project_id).toBe("proj-1");
    expect(mem.session_id).toBe("sess-1");
    expect(mem.metadata).toEqual({ reason: "user stated" });
    expect(mem.expires_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("creates with tags (verify memory_tags join table)", () => {
    const mem = createMemory(
      { key: "t", value: "v", tags: ["alpha", "beta", "gamma"] },
      "merge",
      db
    );
    const dbTags = getTagsForMemory(db, mem.id);
    expect(dbTags).toEqual(["alpha", "beta", "gamma"]);
    expect(mem.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("creates with metadata", () => {
    const meta = { nested: { deep: true }, count: 42 };
    const mem = createMemory(
      { key: "m", value: "v", metadata: meta },
      "merge",
      db
    );
    expect(mem.metadata).toEqual(meta);
  });

  it("creates with TTL (verify expires_at computed)", () => {
    const before = Date.now();
    const mem = createMemory(
      { key: "ttl-test", value: "v", ttl_ms: 60_000 },
      "merge",
      db
    );
    const after = Date.now();
    expect(mem.expires_at).not.toBeNull();
    const expiresMs = new Date(mem.expires_at!).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60_000 - 100);
    expect(expiresMs).toBeLessThanOrEqual(after + 60_000 + 100);
  });

  it("prefers explicit expires_at over ttl_ms", () => {
    const explicit = "2099-06-15T12:00:00.000Z";
    const mem = createMemory(
      { key: "exp", value: "v", expires_at: explicit, ttl_ms: 1000 },
      "merge",
      db
    );
    expect(mem.expires_at).toBe(explicit);
  });

  it("creates with scope global", () => {
    const mem = createMemory({ key: "g", value: "v", scope: "global" }, "merge", db);
    expect(mem.scope).toBe("global");
  });

  it("creates with scope shared", () => {
    const mem = createMemory({ key: "s", value: "v", scope: "shared" }, "merge", db);
    expect(mem.scope).toBe("shared");
  });

  it("creates with scope private", () => {
    const mem = createMemory({ key: "p", value: "v", scope: "private" }, "merge", db);
    expect(mem.scope).toBe("private");
  });

  it("creates with category preference", () => {
    const mem = createMemory({ key: "c1", value: "v", category: "preference" }, "merge", db);
    expect(mem.category).toBe("preference");
  });

  it("creates with category fact", () => {
    const mem = createMemory({ key: "c2", value: "v", category: "fact" }, "merge", db);
    expect(mem.category).toBe("fact");
  });

  it("creates with category knowledge", () => {
    const mem = createMemory({ key: "c3", value: "v", category: "knowledge" }, "merge", db);
    expect(mem.category).toBe("knowledge");
  });

  it("creates with category history", () => {
    const mem = createMemory({ key: "c4", value: "v", category: "history" }, "merge", db);
    expect(mem.category).toBe("history");
  });

  it("creates with source user", () => {
    const mem = createMemory({ key: "s1", value: "v", source: "user" }, "merge", db);
    expect(mem.source).toBe("user");
  });

  it("creates with source agent", () => {
    const mem = createMemory({ key: "s2", value: "v", source: "agent" }, "merge", db);
    expect(mem.source).toBe("agent");
  });

  it("creates with source system", () => {
    const mem = createMemory({ key: "s3", value: "v", source: "system" }, "merge", db);
    expect(mem.source).toBe("system");
  });

  it("creates with source auto", () => {
    const mem = createMemory({ key: "s4", value: "v", source: "auto" }, "merge", db);
    expect(mem.source).toBe("auto");
  });

  it("creates with source imported", () => {
    const mem = createMemory({ key: "s5", value: "v", source: "imported" }, "merge", db);
    expect(mem.source).toBe("imported");
  });

  it("dedup mode merge: updates existing on same key+scope+agent+project+session", () => {
    const first = createMemory(
      { key: "dup", value: "old", scope: "global", importance: 3, tags: ["a"] },
      "merge",
      db
    );
    const second = createMemory(
      { key: "dup", value: "new", scope: "global", importance: 7, tags: ["b"] },
      "merge",
      db
    );

    // Same ID — it was updated in place
    expect(second.id).toBe(first.id);
    expect(second.value).toBe("new");
    expect(second.importance).toBe(7);
    expect(second.version).toBe(2);
    // Tags updated
    const dbTags = getTagsForMemory(db, first.id);
    expect(dbTags).toEqual(["b"]);
  });

  it("dedup mode create: inserts new record even with same key", () => {
    const first = createMemory(
      { key: "dup2", value: "old", scope: "global" },
      "create",
      db
    );
    // "create" mode skips the dedup check and tries to INSERT.
    // Because of the UNIQUE index, this will throw — that's valid behavior.
    // Or it succeeds if the combination differs. Let's use a different scope to prove "create" doesn't merge.
    const second = createMemory(
      { key: "dup2", value: "new", scope: "shared" },
      "create",
      db
    );
    expect(second.id).not.toBe(first.id);
    expect(first.value).toBe("old");
    expect(second.value).toBe("new");
  });

  it("dedup mode create: always inserts new when key combo differs", () => {
    seedAgent(db, "a1", "agent-a1");
    const first = createMemory(
      { key: "k", value: "v1", agent_id: "a1" },
      "create",
      db
    );
    // Same key, no agent_id — different combo
    const second = createMemory(
      { key: "k", value: "v2" },
      "create",
      db
    );
    expect(first.id).not.toBe(second.id);
  });
});

// ============================================================================
// getMemory
// ============================================================================

describe("getMemory", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("gets by full ID", () => {
    const created = createMemory({ key: "x", value: "y" }, "merge", db);
    const found = getMemory(created.id, db);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.key).toBe("x");
    expect(found!.value).toBe("y");
  });

  it("returns null for non-existent ID", () => {
    const found = getMemory("does-not-exist-id", db);
    expect(found).toBeNull();
  });
});

// ============================================================================
// getMemoryByKey
// ============================================================================

describe("getMemoryByKey", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("gets by exact key", () => {
    createMemory({ key: "mykey", value: "myval" }, "merge", db);
    const found = getMemoryByKey("mykey", undefined, undefined, undefined, undefined, db);
    expect(found).not.toBeNull();
    expect(found!.key).toBe("mykey");
    expect(found!.value).toBe("myval");
  });

  it("filters by scope", () => {
    createMemory({ key: "scoped", value: "global-val", scope: "global" }, "merge", db);
    createMemory({ key: "scoped", value: "shared-val", scope: "shared" }, "merge", db);

    const global = getMemoryByKey("scoped", "global", undefined, undefined, undefined, db);
    expect(global).not.toBeNull();
    expect(global!.value).toBe("global-val");

    const shared = getMemoryByKey("scoped", "shared", undefined, undefined, undefined, db);
    expect(shared).not.toBeNull();
    expect(shared!.value).toBe("shared-val");
  });

  it("filters by agent_id", () => {
    seedAgent(db, "ag1", "agent-ag1");
    seedAgent(db, "ag2", "agent-ag2");
    createMemory({ key: "ak", value: "v1", agent_id: "ag1" }, "merge", db);
    createMemory({ key: "ak", value: "v2", agent_id: "ag2" }, "merge", db);

    const found = getMemoryByKey("ak", undefined, "ag1", undefined, undefined, db);
    expect(found).not.toBeNull();
    expect(found!.value).toBe("v1");
  });

  it("filters by project_id", () => {
    seedProject(db, "p1", "proj1", "/p1");
    seedProject(db, "p2", "proj2", "/p2");
    createMemory({ key: "pk", value: "v1", project_id: "p1" }, "merge", db);
    createMemory({ key: "pk", value: "v2", project_id: "p2" }, "merge", db);

    const found = getMemoryByKey("pk", undefined, undefined, "p1", undefined, db);
    expect(found).not.toBeNull();
    expect(found!.value).toBe("v1");
  });

  it("returns null for non-existent key", () => {
    const found = getMemoryByKey("nope", undefined, undefined, undefined, undefined, db);
    expect(found).toBeNull();
  });

  it("returns highest importance when multiple matches", () => {
    // Same key, same scope, but different agent => two rows in DB
    seedAgent(db, "a1", "agentA1");
    seedAgent(db, "a2", "agentA2");
    createMemory({ key: "hi", value: "low", importance: 2, agent_id: "a1" }, "merge", db);
    createMemory({ key: "hi", value: "high", importance: 9, agent_id: "a2" }, "merge", db);

    // No agent filter — should return highest importance
    const found = getMemoryByKey("hi", undefined, undefined, undefined, undefined, db);
    expect(found).not.toBeNull();
    expect(found!.value).toBe("high");
    expect(found!.importance).toBe(9);
  });
});

// ============================================================================
// listMemories
// ============================================================================

describe("listMemories", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("lists all active memories", () => {
    createMemory({ key: "a", value: "1" }, "merge", db);
    createMemory({ key: "b", value: "2" }, "merge", db);
    createMemory({ key: "c", value: "3" }, "merge", db);

    const all = listMemories(undefined, db);
    expect(all.length).toBe(3);
  });

  it("filters by scope", () => {
    createMemory({ key: "a", value: "1", scope: "global" }, "merge", db);
    createMemory({ key: "b", value: "2", scope: "shared" }, "merge", db);
    createMemory({ key: "c", value: "3", scope: "private" }, "merge", db);

    const globals = listMemories({ scope: "global" }, db);
    expect(globals.length).toBe(1);
    expect(globals[0]!.scope).toBe("global");
  });

  it("filters by category", () => {
    createMemory({ key: "a", value: "1", category: "fact" }, "merge", db);
    createMemory({ key: "b", value: "2", category: "preference" }, "merge", db);

    const facts = listMemories({ category: "fact" }, db);
    expect(facts.length).toBe(1);
    expect(facts[0]!.category).toBe("fact");
  });

  it("filters by multiple scopes (array)", () => {
    createMemory({ key: "a", value: "1", scope: "global" }, "merge", db);
    createMemory({ key: "b", value: "2", scope: "shared" }, "merge", db);
    createMemory({ key: "c", value: "3", scope: "private" }, "merge", db);

    const result = listMemories({ scope: ["global", "shared"] }, db);
    expect(result.length).toBe(2);
    const scopes = result.map((m) => m.scope).sort();
    expect(scopes).toEqual(["global", "shared"]);
  });

  it("filters by tags (AND match)", () => {
    createMemory({ key: "a", value: "1", tags: ["x", "y"] }, "merge", db);
    createMemory({ key: "b", value: "2", tags: ["x"] }, "merge", db);
    createMemory({ key: "c", value: "3", tags: ["y"] }, "merge", db);

    // Must have BOTH x and y
    const result = listMemories({ tags: ["x", "y"] }, db);
    expect(result.length).toBe(1);
    expect(result[0]!.key).toBe("a");
  });

  it("filters by min_importance", () => {
    createMemory({ key: "low", value: "v", importance: 2 }, "merge", db);
    createMemory({ key: "med", value: "v", importance: 5 }, "merge", db);
    createMemory({ key: "high", value: "v", importance: 9 }, "merge", db);

    const result = listMemories({ min_importance: 5 }, db);
    expect(result.length).toBe(2);
    expect(result.every((m) => m.importance >= 5)).toBe(true);
  });

  it("filters by pinned", () => {
    const m1 = createMemory({ key: "a", value: "v" }, "merge", db);
    const m2 = createMemory({ key: "b", value: "v" }, "merge", db);
    // Pin one
    updateMemory(m1.id, { pinned: true, version: 1 }, db);

    const pinned = listMemories({ pinned: true }, db);
    expect(pinned.length).toBe(1);
    expect(pinned[0]!.key).toBe("a");

    const notPinned = listMemories({ pinned: false }, db);
    expect(notPinned.length).toBe(1);
    expect(notPinned[0]!.key).toBe("b");
  });

  it("filters by agent_id", () => {
    seedAgent(db, "ag1", "agentListA");
    createMemory({ key: "a", value: "1", agent_id: "ag1" }, "merge", db);
    createMemory({ key: "b", value: "2" }, "merge", db);

    const result = listMemories({ agent_id: "ag1" }, db);
    expect(result.length).toBe(1);
    expect(result[0]!.agent_id).toBe("ag1");
  });

  it("filters by project_id", () => {
    seedProject(db, "p1", "proj-list", "/pl");
    createMemory({ key: "a", value: "1", project_id: "p1" }, "merge", db);
    createMemory({ key: "b", value: "2" }, "merge", db);

    const result = listMemories({ project_id: "p1" }, db);
    expect(result.length).toBe(1);
    expect(result[0]!.project_id).toBe("p1");
  });

  it("filters by session_id", () => {
    createMemory({ key: "a", value: "1", session_id: "sess-x" }, "merge", db);
    createMemory({ key: "b", value: "2" }, "merge", db);

    const result = listMemories({ session_id: "sess-x" }, db);
    expect(result.length).toBe(1);
    expect(result[0]!.session_id).toBe("sess-x");
  });

  it("filters by status", () => {
    const m = createMemory({ key: "a", value: "1" }, "merge", db);
    createMemory({ key: "b", value: "2" }, "merge", db);
    updateMemory(m.id, { status: "archived", version: 1 }, db);

    const archived = listMemories({ status: "archived" }, db);
    expect(archived.length).toBe(1);
    expect(archived[0]!.status).toBe("archived");
  });

  it("filters by search term", () => {
    createMemory({ key: "color-pref", value: "blue" }, "merge", db);
    createMemory({ key: "food-pref", value: "sushi" }, "merge", db);
    createMemory({ key: "other", value: "irrelevant", summary: "color info" }, "merge", db);

    const result = listMemories({ search: "color" }, db);
    expect(result.length).toBe(2);
    const keys = result.map((m) => m.key).sort();
    expect(keys).toEqual(["color-pref", "other"]);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      createMemory({ key: `k${i}`, value: `v${i}`, scope: "global" }, "create", db);
    }
    const result = listMemories({ limit: 3 }, db);
    expect(result.length).toBe(3);
  });

  it("respects offset", () => {
    for (let i = 0; i < 5; i++) {
      createMemory({ key: `k${i}`, value: `v${i}`, scope: "global", importance: 5 }, "create", db);
    }
    // SQLite requires LIMIT when using OFFSET, so provide both
    const withOffset = listMemories({ limit: 100, offset: 2 }, db);
    expect(withOffset.length).toBe(3);
  });

  it("default: only active memories", () => {
    const m = createMemory({ key: "a", value: "1" }, "merge", db);
    createMemory({ key: "b", value: "2" }, "merge", db);
    updateMemory(m.id, { status: "archived", version: 1 }, db);

    const result = listMemories(undefined, db);
    expect(result.length).toBe(1);
    expect(result[0]!.key).toBe("b");
  });

  it("sorts by importance DESC then created_at DESC", () => {
    createMemory({ key: "low", value: "v", importance: 1 }, "merge", db);
    createMemory({ key: "high", value: "v", importance: 10 }, "merge", db);
    createMemory({ key: "mid", value: "v", importance: 5 }, "merge", db);

    const result = listMemories(undefined, db);
    expect(result[0]!.key).toBe("high");
    expect(result[1]!.key).toBe("mid");
    expect(result[2]!.key).toBe("low");
  });
});

// ============================================================================
// updateMemory
// ============================================================================

describe("updateMemory", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("updates value", () => {
    const m = createMemory({ key: "k", value: "old" }, "merge", db);
    const updated = updateMemory(m.id, { value: "new", version: 1 }, db);
    expect(updated.value).toBe("new");
  });

  it("updates importance", () => {
    const m = createMemory({ key: "k", value: "v" }, "merge", db);
    const updated = updateMemory(m.id, { importance: 10, version: 1 }, db);
    expect(updated.importance).toBe(10);
  });

  it("updates tags (and memory_tags table)", () => {
    const m = createMemory({ key: "k", value: "v", tags: ["old"] }, "merge", db);
    expect(getTagsForMemory(db, m.id)).toEqual(["old"]);

    const updated = updateMemory(m.id, { tags: ["new1", "new2"], version: 1 }, db);
    expect(updated.tags).toEqual(["new1", "new2"]);
    expect(getTagsForMemory(db, m.id)).toEqual(["new1", "new2"]);
  });

  it("updates summary", () => {
    const m = createMemory({ key: "k", value: "v" }, "merge", db);
    const updated = updateMemory(m.id, { summary: "a summary", version: 1 }, db);
    expect(updated.summary).toBe("a summary");
  });

  it("updates summary to null", () => {
    const m = createMemory({ key: "k", value: "v", summary: "old" }, "merge", db);
    const updated = updateMemory(m.id, { summary: null, version: 1 }, db);
    expect(updated.summary).toBeNull();
  });

  it("updates pinned", () => {
    const m = createMemory({ key: "k", value: "v" }, "merge", db);
    expect(m.pinned).toBe(false);
    const updated = updateMemory(m.id, { pinned: true, version: 1 }, db);
    expect(updated.pinned).toBe(true);
  });

  it("updates category", () => {
    const m = createMemory({ key: "k", value: "v", category: "fact" }, "merge", db);
    const updated = updateMemory(m.id, { category: "preference", version: 1 }, db);
    expect(updated.category).toBe("preference");
  });

  it("updates status", () => {
    const m = createMemory({ key: "k", value: "v" }, "merge", db);
    const updated = updateMemory(m.id, { status: "archived", version: 1 }, db);
    expect(updated.status).toBe("archived");
  });

  it("updates metadata", () => {
    const m = createMemory({ key: "k", value: "v" }, "merge", db);
    const updated = updateMemory(m.id, { metadata: { foo: "bar" }, version: 1 }, db);
    expect(updated.metadata).toEqual({ foo: "bar" });
  });

  it("updates expires_at", () => {
    const m = createMemory({ key: "k", value: "v" }, "merge", db);
    const updated = updateMemory(
      m.id,
      { expires_at: "2099-12-31T23:59:59.000Z", version: 1 },
      db
    );
    expect(updated.expires_at).toBe("2099-12-31T23:59:59.000Z");
  });

  it("clears expires_at with null", () => {
    const m = createMemory(
      { key: "k", value: "v", expires_at: "2099-01-01T00:00:00.000Z" },
      "merge",
      db
    );
    const updated = updateMemory(m.id, { expires_at: null, version: 1 }, db);
    expect(updated.expires_at).toBeNull();
  });

  it("increments version", () => {
    const m = createMemory({ key: "k", value: "v" }, "merge", db);
    expect(m.version).toBe(1);

    const u1 = updateMemory(m.id, { value: "v2", version: 1 }, db);
    expect(u1.version).toBe(2);

    const u2 = updateMemory(m.id, { value: "v3", version: 2 }, db);
    expect(u2.version).toBe(3);
  });

  it("throws VersionConflictError on wrong version", () => {
    const m = createMemory({ key: "k", value: "v" }, "merge", db);
    expect(() => {
      updateMemory(m.id, { value: "new", version: 99 }, db);
    }).toThrow(VersionConflictError);
  });

  it("throws MemoryNotFoundError for bad ID", () => {
    expect(() => {
      updateMemory("nonexistent", { value: "x", version: 1 }, db);
    }).toThrow(MemoryNotFoundError);
  });

  it("partial update (only one field)", () => {
    const m = createMemory(
      { key: "k", value: "orig", importance: 3, category: "fact" },
      "merge",
      db
    );
    const updated = updateMemory(m.id, { importance: 8, version: 1 }, db);
    // Only importance changed
    expect(updated.importance).toBe(8);
    // Other fields preserved
    expect(updated.value).toBe("orig");
    expect(updated.category).toBe("fact");
  });

  it("updates scope", () => {
    const m = createMemory({ key: "k", value: "v", scope: "private" }, "merge", db);
    const updated = updateMemory(m.id, { scope: "global", version: 1 }, db);
    expect(updated.scope).toBe("global");
  });
});

// ============================================================================
// deleteMemory
// ============================================================================

describe("deleteMemory", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("deletes existing memory", () => {
    const m = createMemory({ key: "del", value: "v" }, "merge", db);
    const result = deleteMemory(m.id, db);
    expect(result).toBe(true);
    expect(getMemory(m.id, db)).toBeNull();
  });

  it("returns false for non-existent", () => {
    const result = deleteMemory("ghost-id", db);
    expect(result).toBe(false);
  });

  it("cascades to memory_tags", () => {
    const m = createMemory({ key: "del", value: "v", tags: ["a", "b"] }, "merge", db);
    expect(getTagsForMemory(db, m.id).length).toBe(2);

    deleteMemory(m.id, db);
    expect(getTagsForMemory(db, m.id).length).toBe(0);
  });
});

// ============================================================================
// bulkDeleteMemories
// ============================================================================

describe("bulkDeleteMemories", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("deletes multiple", () => {
    const m1 = createMemory({ key: "a", value: "1" }, "merge", db);
    const m2 = createMemory({ key: "b", value: "2" }, "merge", db);
    const m3 = createMemory({ key: "c", value: "3" }, "merge", db);

    const count = bulkDeleteMemories([m1.id, m2.id], db);
    expect(count).toBe(2);
    expect(getMemory(m1.id, db)).toBeNull();
    expect(getMemory(m2.id, db)).toBeNull();
    // m3 still exists
    expect(getMemory(m3.id, db)).not.toBeNull();
  });

  it("returns count", () => {
    const m1 = createMemory({ key: "x", value: "v" }, "merge", db);
    const count = bulkDeleteMemories([m1.id, "nonexistent"], db);
    expect(count).toBe(1);
  });

  it("handles empty array", () => {
    const count = bulkDeleteMemories([], db);
    expect(count).toBe(0);
  });
});

// ============================================================================
// touchMemory
// ============================================================================

describe("touchMemory", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("increments access_count", () => {
    const m = createMemory({ key: "t", value: "v" }, "merge", db);
    expect(m.access_count).toBe(0);

    touchMemory(m.id, db);
    const after1 = getMemory(m.id, db)!;
    expect(after1.access_count).toBe(1);

    touchMemory(m.id, db);
    const after2 = getMemory(m.id, db)!;
    expect(after2.access_count).toBe(2);
  });

  it("sets accessed_at", () => {
    const m = createMemory({ key: "t", value: "v" }, "merge", db);
    expect(m.accessed_at).toBeNull();

    touchMemory(m.id, db);
    const after = getMemory(m.id, db)!;
    expect(after.accessed_at).not.toBeNull();
    expect(after.accessed_at!.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// cleanExpiredMemories
// ============================================================================

describe("cleanExpiredMemories", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("removes past expires_at", () => {
    createMemory(
      { key: "expired", value: "v", expires_at: "2000-01-01T00:00:00.000Z" },
      "merge",
      db
    );
    createMemory({ key: "alive", value: "v" }, "merge", db);

    const removed = cleanExpiredMemories(db);
    expect(removed).toBe(1);

    const remaining = listMemories(undefined, db);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.key).toBe("alive");
  });

  it("keeps active (no expires_at)", () => {
    createMemory({ key: "no-exp", value: "v" }, "merge", db);
    const removed = cleanExpiredMemories(db);
    expect(removed).toBe(0);
    expect(listMemories(undefined, db).length).toBe(1);
  });

  it("keeps future expires_at", () => {
    createMemory(
      { key: "future", value: "v", expires_at: "2099-12-31T23:59:59.000Z" },
      "merge",
      db
    );
    const removed = cleanExpiredMemories(db);
    expect(removed).toBe(0);
    expect(listMemories(undefined, db).length).toBe(1);
  });
});

// ============================================================================
// getMemoriesByKey
// ============================================================================

describe("getMemoriesByKey", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns all active memories with given key", () => {
    seedAgent(db, "a1", "agentGBK1");
    seedAgent(db, "a2", "agentGBK2");
    createMemory({ key: "same-key", value: "v1", agent_id: "a1" }, "merge", db);
    createMemory({ key: "same-key", value: "v2", agent_id: "a2" }, "merge", db);
    createMemory({ key: "other-key", value: "v3" }, "merge", db);

    const results = getMemoriesByKey("same-key", undefined, undefined, undefined, db);
    expect(results.length).toBe(2);
    expect(results.every((m) => m.key === "same-key")).toBe(true);
  });

  it("filters by scope", () => {
    createMemory({ key: "sk", value: "v1", scope: "global" }, "merge", db);
    createMemory({ key: "sk", value: "v2", scope: "shared" }, "merge", db);

    const results = getMemoriesByKey("sk", "global", undefined, undefined, db);
    expect(results.length).toBe(1);
    expect(results[0]!.scope).toBe("global");
  });

  it("filters by agent_id", () => {
    seedAgent(db, "ag1", "agentGBK3");
    seedAgent(db, "ag2", "agentGBK4");
    createMemory({ key: "ak2", value: "v1", agent_id: "ag1" }, "merge", db);
    createMemory({ key: "ak2", value: "v2", agent_id: "ag2" }, "merge", db);

    const results = getMemoriesByKey("ak2", undefined, "ag1", undefined, db);
    expect(results.length).toBe(1);
    expect(results[0]!.agent_id).toBe("ag1");
  });

  it("filters by project_id", () => {
    seedProject(db, "p1", "proj-gbk1", "/gbk1");
    seedProject(db, "p2", "proj-gbk2", "/gbk2");
    createMemory({ key: "pk2", value: "v1", project_id: "p1" }, "merge", db);
    createMemory({ key: "pk2", value: "v2", project_id: "p2" }, "merge", db);

    const results = getMemoriesByKey("pk2", undefined, undefined, "p1", db);
    expect(results.length).toBe(1);
    expect(results[0]!.project_id).toBe("p1");
  });

  it("returns empty array for non-existent key", () => {
    const results = getMemoriesByKey("nope-key", undefined, undefined, undefined, db);
    expect(results).toEqual([]);
  });

  it("excludes archived memories", () => {
    const m = createMemory({ key: "arch-k", value: "v" }, "merge", db);
    updateMemory(m.id, { status: "archived", version: 1 }, db);

    const results = getMemoriesByKey("arch-k", undefined, undefined, undefined, db);
    expect(results.length).toBe(0);
  });

  it("sorted by importance DESC", () => {
    seedAgent(db, "a3", "agentGBK5");
    seedAgent(db, "a4", "agentGBK6");
    createMemory({ key: "sorted-k", value: "low", importance: 2, agent_id: "a3" }, "merge", db);
    createMemory({ key: "sorted-k", value: "high", importance: 9, agent_id: "a4" }, "merge", db);

    const results = getMemoriesByKey("sorted-k", undefined, undefined, undefined, db);
    expect(results.length).toBe(2);
    expect(results[0]!.importance).toBe(9);
    expect(results[1]!.importance).toBe(2);
  });
});

// ============================================================================
// getMemoryVersions
// ============================================================================

describe("getMemoryVersions", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
    // Create memory_versions table (from migration 2)
    db.exec(`
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
    `);
  });

  it("returns empty array for memory with no versions", () => {
    const m = createMemory({ key: "no-ver", value: "v" }, "merge", db);
    const versions = getMemoryVersions(m.id, db);
    expect(versions).toEqual([]);
  });

  it("returns versions after updates", () => {
    const m = createMemory({ key: "ver-test", value: "v1", importance: 5 }, "merge", db);
    updateMemory(m.id, { value: "v2", version: 1 }, db);
    updateMemory(m.id, { value: "v3", version: 2 }, db);

    const versions = getMemoryVersions(m.id, db);
    expect(versions.length).toBe(2);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.value).toBe("v1");
    expect(versions[1]!.version).toBe(2);
    expect(versions[1]!.value).toBe("v2");
  });

  it("version entries have correct fields", () => {
    const m = createMemory(
      { key: "ver-fields", value: "orig", importance: 7, tags: ["t1"], summary: "sum", scope: "shared", category: "fact" },
      "merge",
      db
    );
    updateMemory(m.id, { value: "new", version: 1 }, db);

    const versions = getMemoryVersions(m.id, db);
    expect(versions.length).toBe(1);
    const v = versions[0]!;
    expect(v.memory_id).toBe(m.id);
    expect(v.version).toBe(1);
    expect(v.value).toBe("orig");
    expect(v.importance).toBe(7);
    expect(v.scope).toBe("shared");
    expect(v.category).toBe("fact");
    expect(v.tags).toEqual(["t1"]);
    expect(v.summary).toBe("sum");
    expect(v.pinned).toBe(false);
    expect(v.status).toBe("active");
    expect(v.id).toBeTruthy();
    expect(v.created_at).toBeTruthy();
  });

  it("returns empty array when memory_versions table does not exist", () => {
    // Drop the table to simulate pre-migration state
    db.exec("DROP TABLE IF EXISTS memory_versions");
    const versions = getMemoryVersions("nonexistent-id", db);
    expect(versions).toEqual([]);
  });
});

// ============================================================================
// listMemories — additional coverage for source and multiple status arrays
// ============================================================================

describe("listMemories additional filters", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("filters by source (single)", () => {
    createMemory({ key: "a", value: "1", source: "user" }, "merge", db);
    createMemory({ key: "b", value: "2", source: "agent" }, "merge", db);

    const result = listMemories({ source: "user" }, db);
    expect(result.length).toBe(1);
    expect(result[0]!.source).toBe("user");
  });

  it("filters by source (array)", () => {
    createMemory({ key: "a", value: "1", source: "user" }, "merge", db);
    createMemory({ key: "b", value: "2", source: "system" }, "merge", db);
    createMemory({ key: "c", value: "3", source: "agent" }, "merge", db);

    const result = listMemories({ source: ["user", "system"] }, db);
    expect(result.length).toBe(2);
  });

  it("filters by status (array)", () => {
    const m1 = createMemory({ key: "a", value: "1" }, "merge", db);
    const m2 = createMemory({ key: "b", value: "2" }, "merge", db);
    updateMemory(m1.id, { status: "archived", version: 1 }, db);

    const result = listMemories({ status: ["active", "archived"] }, db);
    expect(result.length).toBe(2);
  });

  it("filters by multiple categories (array)", () => {
    createMemory({ key: "a", value: "1", category: "fact" }, "merge", db);
    createMemory({ key: "b", value: "2", category: "history" }, "merge", db);
    createMemory({ key: "c", value: "3", category: "preference" }, "merge", db);

    const result = listMemories({ category: ["fact", "history"] }, db);
    expect(result.length).toBe(2);
  });

  it("filters by session_id in getMemoryByKey", () => {
    createMemory({ key: "sess-k", value: "v1", session_id: "s1" }, "merge", db);
    createMemory({ key: "sess-k", value: "v2", session_id: "s2" }, "merge", db);

    const found = getMemoryByKey("sess-k", undefined, undefined, undefined, "s1", db);
    expect(found).not.toBeNull();
    expect(found!.session_id).toBe("s1");
  });
});

// ============================================================================
// Bi-temporal queries
// ============================================================================

describe("bi-temporal columns", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("new memories get valid_from and ingested_at set", () => {
    const mem = createMemory({ key: "temporal-test", value: "v1" }, "merge", db);
    expect(mem.valid_from).not.toBeNull();
    expect(mem.ingested_at).not.toBeNull();
    expect(mem.valid_until).toBeNull();
  });

  it("listMemories with as_of filters by valid_from/valid_until", () => {
    const past = "2025-01-01T00:00:00.000Z";
    const mid = "2025-06-01T00:00:00.000Z";

    // Use different session_ids to avoid unique constraint on (key, scope, agent, project, session)
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, tags, importance, source, status, pinned, session_id, access_count, version, valid_from, valid_until, ingested_at, created_at, updated_at)
       VALUES ('old-fact', 'stack', 'Python', 'fact', 'shared', '[]', 8, 'agent', 'active', 0, 'sess-old', 0, 1, ?, ?, ?, ?, ?)`,
      [past, mid, past, past, past]
    );
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, tags, importance, source, status, pinned, session_id, access_count, version, valid_from, valid_until, ingested_at, created_at, updated_at)
       VALUES ('new-fact', 'stack', 'TypeScript', 'fact', 'shared', '[]', 9, 'agent', 'active', 0, 'sess-new', 0, 1, ?, NULL, ?, ?, ?)`,
      [mid, mid, mid, mid]
    );

    // Query as of 2025-03-01 → should get Python (old fact still valid)
    const marchResults = listMemories({ as_of: "2025-03-01T00:00:00.000Z" }, db);
    const marchStack = marchResults.filter(m => m.key === "stack");
    expect(marchStack.length).toBe(1);
    expect(marchStack[0]!.value).toBe("Python");

    // Query as of 2025-09-01 → should get TypeScript (new fact, old expired)
    const septResults = listMemories({ as_of: "2025-09-01T00:00:00.000Z" }, db);
    const septStack = septResults.filter(m => m.key === "stack");
    expect(septStack.length).toBe(1);
    expect(septStack[0]!.value).toBe("TypeScript");

    // Query without as_of → should get both (no temporal filter)
    const allResults = listMemories({}, db);
    const allStack = allResults.filter(m => m.key === "stack");
    expect(allStack.length).toBe(2);
  });

  it("getMemoryByKey with as_of returns temporally correct memory", () => {
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, tags, importance, source, status, pinned, session_id, access_count, version, valid_from, valid_until, ingested_at, created_at, updated_at)
       VALUES ('v1', 'db-engine', 'MySQL', 'fact', 'shared', '[]', 8, 'agent', 'active', 0, 'sess-v1', 0, 1, '2024-01-01', '2025-06-01', '2024-01-01', '2024-01-01', '2024-01-01')`,
    );
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, tags, importance, source, status, pinned, session_id, access_count, version, valid_from, valid_until, ingested_at, created_at, updated_at)
       VALUES ('v2', 'db-engine', 'PostgreSQL', 'fact', 'shared', '[]', 9, 'agent', 'active', 0, 'sess-v2', 0, 1, '2025-06-01', NULL, '2025-06-01', '2025-06-01', '2025-06-01')`,
    );

    // Before migration: should get MySQL
    const old = getMemoryByKey("db-engine", undefined, undefined, undefined, undefined, db, "2025-01-01");
    expect(old).not.toBeNull();
    expect(old!.value).toBe("MySQL");

    // After migration: should get PostgreSQL
    const current = getMemoryByKey("db-engine", undefined, undefined, undefined, undefined, db, "2026-01-01");
    expect(current).not.toBeNull();
    expect(current!.value).toBe("PostgreSQL");

    // At migration boundary: exactly at valid_until, old should NOT match
    const boundary = getMemoryByKey("db-engine", undefined, undefined, undefined, undefined, db, "2025-06-01");
    expect(boundary).not.toBeNull();
    expect(boundary!.value).toBe("PostgreSQL");
  });
});

// ============================================================================
// Working scope (OPE4-00138)
// ============================================================================

describe("working scope", () => {
  it("creates a working scope memory with auto-set expires_at (1h)", () => {
    const db = freshDb();
    const before = Date.now();
    const mem = createMemory(
      { key: "scratch-notes", value: "temp data", scope: "working" },
      "merge",
      db
    );

    expect(mem.scope).toBe("working");
    expect(mem.expires_at).not.toBeNull();

    // expires_at should be ~1 hour from now (within a 10-second tolerance)
    const expiresMs = new Date(mem.expires_at!).getTime();
    const expectedMs = before + 60 * 60 * 1000;
    expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(10_000);
  });

  it("respects explicit expires_at when scope is working", () => {
    const db = freshDb();
    const customExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
    const mem = createMemory(
      { key: "scratch-custom", value: "custom ttl", scope: "working", expires_at: customExpiry },
      "merge",
      db
    );

    expect(mem.scope).toBe("working");
    expect(mem.expires_at).toBe(customExpiry);
  });

  it("respects ttl_ms when scope is working (ttl_ms takes precedence over auto-1h)", () => {
    const db = freshDb();
    const before = Date.now();
    const mem = createMemory(
      { key: "scratch-ttl", value: "short ttl", scope: "working", ttl_ms: 15 * 60 * 1000 },
      "merge",
      db
    );

    expect(mem.scope).toBe("working");
    expect(mem.expires_at).not.toBeNull();

    // Should be ~15 min from now, not 1h
    const expiresMs = new Date(mem.expires_at!).getTime();
    const expectedMs = before + 15 * 60 * 1000;
    expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(10_000);
  });

  it("working memories appear in listMemories queries", () => {
    const db = freshDb();
    createMemory({ key: "work-item-1", value: "transient", scope: "working" }, "merge", db);
    createMemory({ key: "regular-item", value: "persistent", scope: "shared" }, "merge", db);

    // Query all active — should include working scope
    const all = listMemories({ status: "active" }, db);
    expect(all.length).toBe(2);

    // Query working scope specifically
    const working = listMemories({ scope: "working", status: "active" }, db);
    expect(working.length).toBe(1);
    expect(working[0]!.key).toBe("work-item-1");
  });

  it("working memories are cleaned up by cleanExpiredMemories", () => {
    const db = freshDb();

    // Create a working memory with already-expired timestamp
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    createMemory(
      { key: "expired-scratch", value: "gone", scope: "working", expires_at: pastExpiry },
      "merge",
      db
    );

    // Verify it exists
    const before = listMemories({ scope: "working" }, db);
    expect(before.length).toBe(1);

    // Clean up
    const cleaned = cleanExpiredMemories(db);
    expect(cleaned).toBe(1);

    // Verify it's gone
    const after = listMemories({ scope: "working" }, db);
    expect(after.length).toBe(0);
  });

  it("working memories can be queried by key like any other scope", () => {
    const db = freshDb();
    createMemory(
      { key: "current-task", value: "implementing OPE4-00138", scope: "working" },
      "merge",
      db
    );

    const found = getMemoryByKey("current-task", "working", undefined, undefined, undefined, db);
    expect(found).not.toBeNull();
    expect(found!.value).toBe("implementing OPE4-00138");
    expect(found!.scope).toBe("working");
  });

  it("working scope memories can be updated normally", () => {
    const db = freshDb();
    const mem = createMemory(
      { key: "wip-notes", value: "draft 1", scope: "working" },
      "merge",
      db
    );

    const updated = updateMemory(mem.id, { value: "draft 2", version: mem.version }, db);
    expect(updated.value).toBe("draft 2");
    expect(updated.scope).toBe("working");
    expect(updated.version).toBe(2);
  });

  it("working scope memories can be deleted", () => {
    const db = freshDb();
    const mem = createMemory(
      { key: "temp-data", value: "delete me", scope: "working" },
      "merge",
      db
    );

    const deleted = deleteMemory(mem.id, db);
    expect(deleted).toBe(true);

    const after = getMemory(mem.id, db);
    expect(after).toBeNull();
  });
});
