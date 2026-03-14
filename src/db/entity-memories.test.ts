// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  linkEntityToMemory,
  unlinkEntityFromMemory,
  getMemoriesForEntity,
  getEntitiesForMemory,
  bulkLinkEntities,
  getEntityMemoryLinks,
} from "./entity-memories.js";

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
      category TEXT NOT NULL DEFAULT 'knowledge' CHECK(category IN ('preference', 'fact', 'knowledge', 'history')),
      scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('global', 'shared', 'private')),
      summary TEXT,
      tags TEXT DEFAULT '[]',
      importance INTEGER NOT NULL DEFAULT 5 CHECK(importance >= 1 AND importance <= 10),
      source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('user', 'agent', 'system', 'auto', 'imported')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'expired')),
      pinned INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      session_id TEXT,
      metadata TEXT DEFAULT '{}',
      access_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
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
      type TEXT NOT NULL CHECK (type IN ('person','project','tool','concept','file','api','pattern','organization')),
      description TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS entity_memories (
      entity_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'context' CHECK (role IN ('subject','object','context')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (entity_id, memory_id),
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entity_memories_memory ON entity_memories(memory_id);
  `);

  return db;
}

function seedEntity(
  db: Database,
  id: string,
  name: string,
  type: string = "concept"
): void {
  db.run(
    "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
    [id, name, type]
  );
}

function seedMemory(
  db: Database,
  id: string,
  key: string,
  value: string = "test value",
  importance: number = 5
): void {
  db.run(
    `INSERT INTO memories (id, key, value, importance) VALUES (?, ?, ?, ?)`,
    [id, key, value, importance]
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("entity-memories", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
    // Seed test data
    seedEntity(db, "e1", "TypeScript", "tool");
    seedEntity(db, "e2", "Bun", "tool");
    seedEntity(db, "e3", "Alice", "person");
    seedMemory(db, "m1", "ts-preference", "Use strict mode", 8);
    seedMemory(db, "m2", "bun-tip", "Bun is fast", 6);
    seedMemory(db, "m3", "team-fact", "Alice leads backend", 7);
  });

  // --------------------------------------------------------------------------
  // linkEntityToMemory
  // --------------------------------------------------------------------------

  describe("linkEntityToMemory", () => {
    it("links entity to memory and returns EntityMemory", () => {
      const link = linkEntityToMemory("e1", "m1", "subject", db);

      expect(link.entity_id).toBe("e1");
      expect(link.memory_id).toBe("m1");
      expect(link.role).toBe("subject");
      expect(link.created_at).toBeTruthy();
    });

    it("defaults role to 'context'", () => {
      const link = linkEntityToMemory("e1", "m1", undefined, db);
      expect(link.role).toBe("context");
    });

    it("duplicate link does not error (INSERT OR IGNORE)", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      // Second call should not throw
      const link = linkEntityToMemory("e1", "m1", "subject", db);
      expect(link.entity_id).toBe("e1");
      expect(link.memory_id).toBe("m1");

      // Verify only one row exists
      const rows = db
        .query("SELECT COUNT(*) as c FROM entity_memories WHERE entity_id = ? AND memory_id = ?")
        .get("e1", "m1") as { c: number };
      expect(rows.c).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // unlinkEntityFromMemory
  // --------------------------------------------------------------------------

  describe("unlinkEntityFromMemory", () => {
    it("removes the link between entity and memory", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      unlinkEntityFromMemory("e1", "m1", db);

      const links = getEntityMemoryLinks("e1", "m1", db);
      expect(links.length).toBe(0);
    });

    it("does nothing if link does not exist", () => {
      // Should not throw
      unlinkEntityFromMemory("e1", "m1", db);
    });
  });

  // --------------------------------------------------------------------------
  // getMemoriesForEntity
  // --------------------------------------------------------------------------

  describe("getMemoriesForEntity", () => {
    it("returns memories linked to the entity", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      linkEntityToMemory("e1", "m2", "context", db);

      const memories = getMemoriesForEntity("e1", db);
      expect(memories.length).toBe(2);

      const ids = memories.map((m) => m.id);
      expect(ids).toContain("m1");
      expect(ids).toContain("m2");
    });

    it("returns full Memory objects with all fields", () => {
      linkEntityToMemory("e1", "m1", "subject", db);

      const memories = getMemoriesForEntity("e1", db);
      expect(memories.length).toBe(1);

      const m = memories[0]!;
      expect(m.id).toBe("m1");
      expect(m.key).toBe("ts-preference");
      expect(m.value).toBe("Use strict mode");
      expect(m.importance).toBe(8);
      expect(m.category).toBe("knowledge");
      expect(m.scope).toBe("private");
      expect(m.tags).toEqual([]);
    });

    it("returns empty array for entity with no links", () => {
      const memories = getMemoriesForEntity("e1", db);
      expect(memories).toEqual([]);
    });

    it("orders by importance DESC", () => {
      linkEntityToMemory("e1", "m1", "subject", db); // importance 8
      linkEntityToMemory("e1", "m2", "context", db); // importance 6

      const memories = getMemoriesForEntity("e1", db);
      expect(memories[0]!.importance).toBeGreaterThanOrEqual(memories[1]!.importance);
    });
  });

  // --------------------------------------------------------------------------
  // getEntitiesForMemory
  // --------------------------------------------------------------------------

  describe("getEntitiesForMemory", () => {
    it("returns entities linked to the memory", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      linkEntityToMemory("e3", "m1", "context", db);

      const entities = getEntitiesForMemory("m1", db);
      expect(entities.length).toBe(2);

      const names = entities.map((e) => e.name);
      expect(names).toContain("TypeScript");
      expect(names).toContain("Alice");
    });

    it("returns full Entity objects with all fields", () => {
      linkEntityToMemory("e1", "m1", "subject", db);

      const entities = getEntitiesForMemory("m1", db);
      expect(entities.length).toBe(1);

      const e = entities[0]!;
      expect(e.id).toBe("e1");
      expect(e.name).toBe("TypeScript");
      expect(e.type).toBe("tool");
      expect(e.description).toBeNull();
      expect(e.metadata).toEqual({});
      expect(e.project_id).toBeNull();
    });

    it("returns empty array for memory with no links", () => {
      const entities = getEntitiesForMemory("m1", db);
      expect(entities).toEqual([]);
    });

    it("orders by name ASC", () => {
      linkEntityToMemory("e3", "m1", "context", db); // Alice
      linkEntityToMemory("e2", "m1", "context", db); // Bun
      linkEntityToMemory("e1", "m1", "subject", db); // TypeScript

      const entities = getEntitiesForMemory("m1", db);
      expect(entities[0]!.name).toBe("Alice");
      expect(entities[1]!.name).toBe("Bun");
      expect(entities[2]!.name).toBe("TypeScript");
    });
  });

  // --------------------------------------------------------------------------
  // bulkLinkEntities
  // --------------------------------------------------------------------------

  describe("bulkLinkEntities", () => {
    it("links multiple entities to one memory", () => {
      bulkLinkEntities(["e1", "e2", "e3"], "m1", "context", db);

      const entities = getEntitiesForMemory("m1", db);
      expect(entities.length).toBe(3);
    });

    it("handles empty array without error", () => {
      bulkLinkEntities([], "m1", "context", db);
      const entities = getEntitiesForMemory("m1", db);
      expect(entities.length).toBe(0);
    });

    it("ignores duplicates in bulk operation", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      // Bulk link includes e1 again — should not error
      bulkLinkEntities(["e1", "e2"], "m1", "context", db);

      const entities = getEntitiesForMemory("m1", db);
      expect(entities.length).toBe(2);
    });

    it("defaults role to 'context'", () => {
      bulkLinkEntities(["e1"], "m1", undefined, db);
      const links = getEntityMemoryLinks("e1", "m1", db);
      expect(links[0]!.role).toBe("context");
    });
  });

  // --------------------------------------------------------------------------
  // getEntityMemoryLinks
  // --------------------------------------------------------------------------

  describe("getEntityMemoryLinks", () => {
    it("filters by entity only", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      linkEntityToMemory("e1", "m2", "context", db);
      linkEntityToMemory("e2", "m1", "context", db);

      const links = getEntityMemoryLinks("e1", undefined, db);
      expect(links.length).toBe(2);
      expect(links.every((l) => l.entity_id === "e1")).toBe(true);
    });

    it("filters by memory only", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      linkEntityToMemory("e2", "m1", "context", db);
      linkEntityToMemory("e1", "m2", "context", db);

      const links = getEntityMemoryLinks(undefined, "m1", db);
      expect(links.length).toBe(2);
      expect(links.every((l) => l.memory_id === "m1")).toBe(true);
    });

    it("filters by both entity and memory", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      linkEntityToMemory("e1", "m2", "context", db);

      const links = getEntityMemoryLinks("e1", "m1", db);
      expect(links.length).toBe(1);
      expect(links[0]!.entity_id).toBe("e1");
      expect(links[0]!.memory_id).toBe("m1");
    });

    it("returns all links when no filters", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      linkEntityToMemory("e2", "m2", "context", db);

      const links = getEntityMemoryLinks(undefined, undefined, db);
      expect(links.length).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Cascade delete
  // --------------------------------------------------------------------------

  describe("cascade delete", () => {
    it("deleting entity removes its links", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      linkEntityToMemory("e1", "m2", "context", db);

      // Delete entity e1
      db.run("DELETE FROM entities WHERE id = ?", ["e1"]);

      const links = getEntityMemoryLinks("e1", undefined, db);
      expect(links.length).toBe(0);

      // Memory still exists
      const mem = db.query("SELECT id FROM memories WHERE id = ?").get("m1") as { id: string } | null;
      expect(mem).not.toBeNull();
    });

    it("deleting memory removes its links", () => {
      linkEntityToMemory("e1", "m1", "subject", db);
      linkEntityToMemory("e2", "m1", "context", db);

      // Delete memory m1
      db.run("DELETE FROM memories WHERE id = ?", ["m1"]);

      const links = getEntityMemoryLinks(undefined, "m1", db);
      expect(links.length).toBe(0);

      // Entity still exists
      const ent = db.query("SELECT id FROM entities WHERE id = ?").get("e1") as { id: string } | null;
      expect(ent).not.toBeNull();
    });
  });
});
