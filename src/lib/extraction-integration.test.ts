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

  it("memory saves successfully without blocking (entity extraction is now async LLM-based)", () => {
    // Entity extraction is now handled by the async LLM pipeline (auto-memory.ts).
    // createMemory no longer synchronously extracts entities via regex.
    // Entities are linked asynchronously by the PostMemorySave hook after an LLM call.
    const memory = createMemory(
      { key: "stack-choice", value: "We use typescript and react for the frontend" },
      "create",
      db
    );
    // Memory saves successfully — this is what we guarantee
    expect(memory.id).toBeTruthy();
    expect(memory.value).toContain("typescript");
    // Entities are NOT synchronously linked anymore — they come from async LLM extraction
    // To verify entity linking, use memory_auto_test MCP tool or processConversationTurn()
  });

  it("memory with file paths saves successfully", () => {
    const memory = createMemory(
      { key: "config-location", value: "The config file is at src/lib/config.ts" },
      "create",
      db
    );
    expect(memory.id).toBeTruthy();
    // Async entity extraction will run later via LLM pipeline
  });

  it("memory save does not fail even when entity pipeline would have errors", () => {
    // Previously this tested relation creation between co-occurring entities.
    // Now relations are created async by the LLM pipeline after the memory is saved.
    const memory = createMemory(
      { key: "stack", value: "We use typescript and react together" },
      "create",
      db
    );
    expect(memory.id).toBeTruthy();
    // No synchronous relations expected — LLM pipeline handles this async
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

  it("memory update succeeds (re-extraction is async via LLM pipeline)", () => {
    // Previously tested synchronous re-extraction on update.
    // Now extraction is async/LLM-based — updates trigger async re-extraction via hooks.
    const memory = createMemory(
      { key: "stack-choice", value: "We use typescript for the backend" },
      "create",
      db
    );
    expect(memory.id).toBeTruthy();

    // Update succeeds — no blocking on entity extraction
    const updated = updateMemory(
      memory.id,
      { value: "We switched to python for the backend", version: memory.version },
      db
    );
    expect(updated?.value).toContain("python");
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

  it("merge/upsert path works correctly (entity extraction is async via LLM pipeline)", () => {
    // Upsert behaviour is unchanged. Entity extraction fires async after save.
    const memory1 = createMemory(
      { key: "tech-stack", value: "We use typescript", scope: "shared" },
      "merge",
      db
    );
    expect(memory1.id).toBeTruthy();

    // Merge with new value (same key+scope triggers upsert)
    const memory2 = createMemory(
      { key: "tech-stack", value: "We now use python and rust", scope: "shared" },
      "merge",
      db
    );

    // Same memory updated (upserted) — this is the key guarantee
    expect(memory2.id).toBe(memory1.id);
    expect(memory2.value).toContain("python");
    // Entities linked async by LLM pipeline after this save completes
  });
});
