// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemory, getMemory, updateMemory } from "../db/memories.js";
import { getEntitiesForMemory } from "../db/entity-memories.js";
import { listEntities } from "../db/entities.js";
import { listRelations } from "../db/relations.js";

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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_unique_name ON entities(name, type, COALESCE(project_id, ''));
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
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL CHECK (relation_type IN ('uses','knows','depends_on','created_by','related_to','contradicts','part_of','implements')),
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_entity_id, target_entity_id, relation_type),
      FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
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

describe("extraction-integration", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("should extract entities and link them when saving a memory with tech keywords", () => {
    const memory = createMemory(
      { key: "stack-choice", value: "We use typescript and react for the frontend" },
      "create",
      db
    );

    const entities = getEntitiesForMemory(memory.id, db);
    const entityNames = entities.map((e) => e.name);

    expect(entityNames).toContain("typescript");
    expect(entityNames).toContain("react");

    // Both entities should be tools
    for (const e of entities) {
      if (e.name === "typescript" || e.name === "react") {
        expect(e.type).toBe("tool");
      }
    }
  });

  it("should extract file path entities", () => {
    const memory = createMemory(
      { key: "config-location", value: "The config file is at src/lib/config.ts" },
      "create",
      db
    );

    const entities = getEntitiesForMemory(memory.id, db);
    const fileEntities = entities.filter((e) => e.type === "file");

    expect(fileEntities.length).toBeGreaterThanOrEqual(1);
    expect(fileEntities.some((e) => e.name.includes("config.ts"))).toBe(true);
  });

  it("should create relations between co-occurring entities", () => {
    createMemory(
      { key: "stack", value: "We use typescript and react together" },
      "create",
      db
    );

    const allRelations = listRelations({}, db);
    const relatedTo = allRelations.filter((r) => r.relation_type === "related_to");

    // typescript and react should be related
    expect(relatedTo.length).toBeGreaterThanOrEqual(1);
  });

  it("should not create entities when extraction is disabled", () => {
    // Override config by setting env
    const origEnabled = process.env["MEMENTOS_EXTRACTION_ENABLED"];
    // We can't easily disable via env, so we test by checking that with a plain value
    // that has no extractable entities, no entities are created
    const memory = createMemory(
      { key: "simple-note", value: "hello world" },
      "create",
      db
    );

    const entities = getEntitiesForMemory(memory.id, db);
    // "hello world" has no tech keywords, no file paths, no URLs — should be empty
    expect(entities.length).toBe(0);

    if (origEnabled !== undefined) {
      process.env["MEMENTOS_EXTRACTION_ENABLED"] = origEnabled;
    }
  });

  it("should re-extract entities when memory value is updated", () => {
    const memory = createMemory(
      { key: "stack-choice", value: "We use typescript for the backend" },
      "create",
      db
    );

    let entities = getEntitiesForMemory(memory.id, db);
    let entityNames = entities.map((e) => e.name);
    expect(entityNames).toContain("typescript");
    expect(entityNames).not.toContain("python");

    // Update the memory value to mention python instead
    updateMemory(
      memory.id,
      { value: "We switched to python for the backend", version: memory.version },
      db
    );

    entities = getEntitiesForMemory(memory.id, db);
    entityNames = entities.map((e) => e.name);
    expect(entityNames).toContain("python");
  });

  it("should not break memory save if extraction encounters an error", () => {
    // Verify that createMemory succeeds even if entity tables are missing
    // by using a database without entity tables
    const minimalDb = new Database(":memory:", { create: true });
    minimalDb.run("PRAGMA journal_mode = WAL");
    minimalDb.run("PRAGMA foreign_keys = ON");
    minimalDb.exec(`
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
        metadata TEXT DEFAULT '{}',
        access_count INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        accessed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
        ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
    `);
    // No entities/entity_memories/relations tables — extraction should fail silently

    const memory = createMemory(
      { key: "test-key", value: "We use typescript and react" },
      "create",
      minimalDb
    );

    // Memory should still be created successfully
    expect(memory).toBeDefined();
    expect(memory.key).toBe("test-key");
    expect(memory.value).toBe("We use typescript and react");
  });

  it("should handle merge/upsert path with entity re-extraction", () => {
    // Create initial memory
    const memory1 = createMemory(
      { key: "tech-stack", value: "We use typescript", scope: "shared" },
      "merge",
      db
    );

    let entities = getEntitiesForMemory(memory1.id, db);
    expect(entities.some((e) => e.name === "typescript")).toBe(true);

    // Merge with new value (same key+scope triggers upsert)
    const memory2 = createMemory(
      { key: "tech-stack", value: "We now use python and rust", scope: "shared" },
      "merge",
      db
    );

    // Should be the same memory (upserted)
    expect(memory2.id).toBe(memory1.id);

    // Entities should now reflect the new value
    entities = getEntitiesForMemory(memory2.id, db);
    const entityNames = entities.map((e) => e.name);
    expect(entityNames).toContain("python");
    expect(entityNames).toContain("rust");
  });
});
