// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createMemory,
  getMemory,
  updateMemory,
  getMemoryVersions,
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
// Tests
// ============================================================================

describe("when_to_use", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  // --------------------------------------------------------------------------
  // Schema basics
  // --------------------------------------------------------------------------
  describe("schema", () => {
    it("stores when_to_use on create", () => {
      const m = createMemory(
        { key: "wtu-create", value: "some value", when_to_use: "Use when debugging TypeScript errors" },
        "merge",
        db
      );
      expect(m.when_to_use).toBe("Use when debugging TypeScript errors");
    });

    it("returns null when_to_use when not set", () => {
      const m = createMemory(
        { key: "wtu-null", value: "some value" },
        "merge",
        db
      );
      expect(m.when_to_use).toBeNull();
    });

    it("persists when_to_use through getMemory", () => {
      const created = createMemory(
        { key: "wtu-persist", value: "v", when_to_use: "Use during code review" },
        "merge",
        db
      );
      const fetched = getMemory(created.id, db);
      expect(fetched).not.toBeNull();
      expect(fetched!.when_to_use).toBe("Use during code review");
    });

    it("stores when_to_use in memory_versions on update", () => {
      const m = createMemory(
        { key: "wtu-version", value: "v1", when_to_use: "Use for initial setup" },
        "merge",
        db
      );
      // Update to trigger version snapshot
      updateMemory(m.id, { value: "v2", version: 1 }, db);

      // The version snapshot should have captured the original when_to_use
      const row = db
        .query("SELECT when_to_use FROM memory_versions WHERE memory_id = ? AND version = 1")
        .get(m.id) as { when_to_use: string | null } | null;

      expect(row).not.toBeNull();
      expect(row!.when_to_use).toBe("Use for initial setup");
    });
  });

  // --------------------------------------------------------------------------
  // createMemory with when_to_use
  // --------------------------------------------------------------------------
  describe("createMemory with when_to_use", () => {
    it("creates memory with when_to_use field", () => {
      const m = createMemory(
        {
          key: "wtu-full",
          value: "Always prefer bun over npm",
          category: "preference",
          scope: "shared",
          importance: 8,
          when_to_use: "Use when choosing a package manager for new projects",
        },
        "merge",
        db
      );
      expect(m.key).toBe("wtu-full");
      expect(m.value).toBe("Always prefer bun over npm");
      expect(m.when_to_use).toBe("Use when choosing a package manager for new projects");
      expect(m.category).toBe("preference");
      expect(m.scope).toBe("shared");
      expect(m.importance).toBe(8);
    });

    it("creates memory without when_to_use (defaults to null)", () => {
      const m = createMemory(
        { key: "wtu-default", value: "no hint" },
        "merge",
        db
      );
      expect(m.when_to_use).toBeNull();
    });

    it("preserves when_to_use through merge/upsert", () => {
      // First create
      const m1 = createMemory(
        { key: "wtu-upsert", value: "v1", when_to_use: "Use in morning standup" },
        "merge",
        db
      );
      expect(m1.when_to_use).toBe("Use in morning standup");

      // Merge-upsert with new value and new when_to_use
      const m2 = createMemory(
        { key: "wtu-upsert", value: "v2", when_to_use: "Use in sprint planning" },
        "merge",
        db
      );
      expect(m2.id).toBe(m1.id); // same memory, merged
      expect(m2.value).toBe("v2");
      expect(m2.when_to_use).toBe("Use in sprint planning");
    });
  });

  // --------------------------------------------------------------------------
  // updateMemory with when_to_use
  // --------------------------------------------------------------------------
  describe("updateMemory with when_to_use", () => {
    it("updates when_to_use on existing memory", () => {
      const m = createMemory(
        { key: "wtu-update", value: "v", when_to_use: "original hint" },
        "merge",
        db
      );
      expect(m.when_to_use).toBe("original hint");

      const updated = updateMemory(m.id, { when_to_use: "updated hint", version: 1 }, db);
      expect(updated.when_to_use).toBe("updated hint");

      // Verify persistence
      const fetched = getMemory(m.id, db);
      expect(fetched!.when_to_use).toBe("updated hint");
    });

    it("clears when_to_use by setting to null", () => {
      const m = createMemory(
        { key: "wtu-clear", value: "v", when_to_use: "should be removed" },
        "merge",
        db
      );
      expect(m.when_to_use).toBe("should be removed");

      const updated = updateMemory(m.id, { when_to_use: null, version: 1 }, db);
      expect(updated.when_to_use).toBeNull();

      const fetched = getMemory(m.id, db);
      expect(fetched!.when_to_use).toBeNull();
    });

    it("snapshots when_to_use in memory_versions before update", () => {
      const m = createMemory(
        { key: "wtu-snap", value: "v1", when_to_use: "hint-v1" },
        "merge",
        db
      );

      // First update — snapshots version 1
      updateMemory(m.id, { value: "v2", when_to_use: "hint-v2", version: 1 }, db);

      // Second update — snapshots version 2
      updateMemory(m.id, { value: "v3", when_to_use: "hint-v3", version: 2 }, db);

      // Check version snapshots at DB level (since getMemoryVersions doesn't map when_to_use)
      const rows = db
        .query("SELECT version, when_to_use FROM memory_versions WHERE memory_id = ? ORDER BY version ASC")
        .all(m.id) as { version: number; when_to_use: string | null }[];

      expect(rows.length).toBe(2);
      expect(rows[0]!.version).toBe(1);
      expect(rows[0]!.when_to_use).toBe("hint-v1");
      expect(rows[1]!.version).toBe(2);
      expect(rows[1]!.when_to_use).toBe("hint-v2");

      // Current memory should have the latest when_to_use
      const current = getMemory(m.id, db);
      expect(current!.when_to_use).toBe("hint-v3");
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------
  describe("edge cases", () => {
    it("handles empty string when_to_use", () => {
      const m = createMemory(
        { key: "wtu-empty", value: "v", when_to_use: "" },
        "merge",
        db
      );
      // Empty string is falsy, so the `input.when_to_use || null` in createMemory coerces to null
      expect(m.when_to_use).toBeNull();
    });

    it("handles very long when_to_use text", () => {
      const longText = "Use when ".repeat(1000) + "the stars align";
      const m = createMemory(
        { key: "wtu-long", value: "v", when_to_use: longText },
        "merge",
        db
      );
      expect(m.when_to_use).toBe(longText);

      // Verify it survives round-trip
      const fetched = getMemory(m.id, db);
      expect(fetched!.when_to_use).toBe(longText);
    });
  });
});
