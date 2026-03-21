// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createMemory,
  getMemory,
  updateMemory,
  getMemoryVersions,
} from "./memories.js";
import type { MemoryVersion } from "../types/index.js";

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(memory_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_versions_version ON memory_versions(memory_id, version);
  `);

  return db;
}

// ============================================================================
// Version snapshot on update
// ============================================================================

describe("version snapshots", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("creates a version snapshot when updating a memory", () => {
    const mem = createMemory(
      { key: "test-key", value: "original value", importance: 5 },
      "merge",
      db
    );
    expect(mem.version).toBe(1);

    // Update the memory
    const updated = updateMemory(
      mem.id,
      { value: "updated value", version: 1 },
      db
    );
    expect(updated.version).toBe(2);
    expect(updated.value).toBe("updated value");

    // Check version snapshot was created
    const versions = getMemoryVersions(mem.id, db);
    expect(versions.length).toBe(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.value).toBe("original value");
    expect(versions[0]!.importance).toBe(5);
    expect(versions[0]!.memory_id).toBe(mem.id);
  });

  it("creates multiple version snapshots across updates", () => {
    const mem = createMemory(
      { key: "multi", value: "v1", importance: 3, tags: ["a"] },
      "merge",
      db
    );

    const v2 = updateMemory(
      mem.id,
      { value: "v2", importance: 5, version: 1 },
      db
    );
    expect(v2.version).toBe(2);

    const v3 = updateMemory(
      mem.id,
      { value: "v3", importance: 8, tags: ["a", "b"], version: 2 },
      db
    );
    expect(v3.version).toBe(3);

    const versions = getMemoryVersions(mem.id, db);
    expect(versions.length).toBe(2);

    // First snapshot: version 1
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.value).toBe("v1");
    expect(versions[0]!.importance).toBe(3);
    expect(versions[0]!.tags).toEqual(["a"]);

    // Second snapshot: version 2
    expect(versions[1]!.version).toBe(2);
    expect(versions[1]!.value).toBe("v2");
    expect(versions[1]!.importance).toBe(5);
  });

  it("snapshots preserve all fields correctly", () => {
    const mem = createMemory(
      {
        key: "full-fields",
        value: "original",
        importance: 7,
        scope: "shared",
        category: "fact",
        tags: ["tag1", "tag2"],
        summary: "A summary",
      },
      "merge",
      db
    );

    updateMemory(
      mem.id,
      { value: "changed", version: 1 },
      db
    );

    const versions = getMemoryVersions(mem.id, db);
    expect(versions.length).toBe(1);

    const snap = versions[0]!;
    expect(snap.value).toBe("original");
    expect(snap.importance).toBe(7);
    expect(snap.scope).toBe("shared");
    expect(snap.category).toBe("fact");
    expect(snap.tags).toEqual(["tag1", "tag2"]);
    expect(snap.summary).toBe("A summary");
    expect(snap.pinned).toBe(false);
    expect(snap.status).toBe("active");
    expect(snap.memory_id).toBe(mem.id);
    expect(snap.id).toBeTruthy();
    expect(snap.created_at).toBeTruthy();
  });

  it("returns empty array for memory with no history", () => {
    const mem = createMemory(
      { key: "no-history", value: "val" },
      "merge",
      db
    );

    const versions = getMemoryVersions(mem.id, db);
    expect(versions.length).toBe(0);
  });

  it("returns empty array for non-existent memory", () => {
    const versions = getMemoryVersions("non-existent-id", db);
    expect(versions.length).toBe(0);
  });

  it("versions are ordered by version number ascending", () => {
    const mem = createMemory(
      { key: "ordered", value: "v1" },
      "merge",
      db
    );

    updateMemory(mem.id, { value: "v2", version: 1 }, db);
    updateMemory(mem.id, { value: "v3", version: 2 }, db);
    updateMemory(mem.id, { value: "v4", version: 3 }, db);

    const versions = getMemoryVersions(mem.id, db);
    expect(versions.length).toBe(3);
    expect(versions[0]!.version).toBe(1);
    expect(versions[1]!.version).toBe(2);
    expect(versions[2]!.version).toBe(3);
  });

  it("snapshot captures scope changes", () => {
    const mem = createMemory(
      { key: "scope-change", value: "val", scope: "private" },
      "merge",
      db
    );

    updateMemory(
      mem.id,
      { scope: "shared", version: 1 },
      db
    );

    const versions = getMemoryVersions(mem.id, db);
    expect(versions[0]!.scope).toBe("private");

    const current = getMemory(mem.id, db);
    expect(current!.scope).toBe("shared");
  });

  it("snapshot captures pinned changes", () => {
    const mem = createMemory(
      { key: "pin-change", value: "val" },
      "merge",
      db
    );
    expect(mem.pinned).toBe(false);

    updateMemory(
      mem.id,
      { pinned: true, version: 1 },
      db
    );

    const versions = getMemoryVersions(mem.id, db);
    expect(versions[0]!.pinned).toBe(false);

    const current = getMemory(mem.id, db);
    expect(current!.pinned).toBe(true);
  });
});
