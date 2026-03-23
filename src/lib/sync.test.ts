// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resetDatabase } from "../db/database.js";
import { createMemory, listMemories } from "../db/memories.js";
import { syncMemories, defaultSyncAgents } from "./sync.js";

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

const TEST_AGENT = `__test_sync_agent_${Date.now()}`;
const agentSyncDir = join(homedir(), ".mementos", "agents", TEST_AGENT);

let db: Database;

beforeEach(() => {
  resetDatabase();
  db = freshDb();
  // Clean up any previous test agent sync dir
  if (existsSync(agentSyncDir)) {
    rmSync(agentSyncDir, { recursive: true });
  }
});

afterEach(() => {
  // Clean up test agent sync dir
  if (existsSync(agentSyncDir)) {
    rmSync(agentSyncDir, { recursive: true });
  }
});

// ============================================================================
// syncMemories — push
// ============================================================================

describe("syncMemories push", () => {
  it("exports memories to JSON file", () => {
    createMemory({ key: "sync-key-1", value: "sync-val-1" }, "create", db);
    createMemory({ key: "sync-key-2", value: "sync-val-2" }, "create", db);

    const result = syncMemories(TEST_AGENT, "push", { db });
    expect(result.pushed).toBe(2);
    expect(result.errors.length).toBe(0);

    const outFile = join(agentSyncDir, "memories.json");
    expect(existsSync(outFile)).toBe(true);

    const data = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
  });

  it("push with no memories exports empty array", () => {
    const result = syncMemories(TEST_AGENT, "push", { db });
    expect(result.pushed).toBe(0);

    const outFile = join(agentSyncDir, "memories.json");
    expect(existsSync(outFile)).toBe(true);

    const data = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(data.length).toBe(0);
  });
});

// ============================================================================
// syncMemories — pull
// ============================================================================

describe("syncMemories pull", () => {
  it("imports memories from JSON file", () => {
    // Create a sync file manually
    mkdirSync(agentSyncDir, { recursive: true });
    const memories = [
      {
        id: "test-id-1",
        key: "pulled-key-1",
        value: "pulled-val-1",
        category: "knowledge",
        scope: "private",
        summary: null,
        tags: [],
        importance: 5,
        source: "agent",
        status: "active",
        pinned: false,
        agent_id: null,
        project_id: null,
        session_id: null,
        metadata: {},
        access_count: 0,
        version: 1,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        accessed_at: null,
      },
    ];
    writeFileSync(
      join(agentSyncDir, "memories.json"),
      JSON.stringify(memories),
      "utf-8"
    );

    const result = syncMemories(TEST_AGENT, "pull", { db });
    expect(result.pulled).toBe(1);
    expect(result.errors.length).toBe(0);

    const local = listMemories({}, db);
    expect(local.length).toBe(1);
    expect(local[0]!.key).toBe("pulled-key-1");
  });

  it("pull with no sync file returns zeros", () => {
    const result = syncMemories(TEST_AGENT, "pull", { db });
    expect(result.pulled).toBe(0);
    expect(result.conflicts).toBe(0);
  });

  it("pull handles empty JSON array", () => {
    mkdirSync(agentSyncDir, { recursive: true });
    writeFileSync(
      join(agentSyncDir, "memories.json"),
      "[]",
      "utf-8"
    );

    const result = syncMemories(TEST_AGENT, "pull", { db });
    expect(result.pulled).toBe(0);
    expect(result.conflicts).toBe(0);
  });
});

// ============================================================================
// syncMemories — both
// ============================================================================

describe("syncMemories both", () => {
  it("pushes and pulls in both direction", () => {
    createMemory({ key: "local-mem", value: "local-val" }, "create", db);

    // First push
    const pushResult = syncMemories(TEST_AGENT, "push", { db });
    expect(pushResult.pushed).toBe(1);

    // Now do both — should push the same memory and pull it back (conflict)
    const bothResult = syncMemories(TEST_AGENT, "both", { db });
    expect(bothResult.pushed).toBe(1);
    expect(bothResult.conflicts).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// syncMemories — conflict resolution
// ============================================================================

describe("syncMemories conflict resolution", () => {
  it("prefer-newer resolves to remote when remote is newer", () => {
    // Create local memory
    createMemory({ key: "conflict-key", value: "local-value" }, "create", db);

    // Create a remote file with a newer timestamp
    mkdirSync(agentSyncDir, { recursive: true });
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const remoteMemories = [
      {
        id: "remote-id",
        key: "conflict-key",
        value: "remote-value",
        category: "knowledge",
        scope: "private",
        summary: null,
        tags: [],
        importance: 5,
        source: "agent",
        status: "active",
        pinned: false,
        agent_id: null,
        project_id: null,
        session_id: null,
        metadata: {},
        access_count: 0,
        version: 1,
        expires_at: null,
        created_at: futureDate,
        updated_at: futureDate,
        accessed_at: null,
      },
    ];
    writeFileSync(
      join(agentSyncDir, "memories.json"),
      JSON.stringify(remoteMemories),
      "utf-8"
    );

    const result = syncMemories(TEST_AGENT, "pull", {
      db,
      conflict_resolution: "prefer-newer",
    });
    expect(result.conflicts).toBe(1);
    expect(result.pulled).toBe(1);

    // The value should be the remote (newer) one
    const memories = listMemories({}, db);
    const mem = memories.find((m) => m.key === "conflict-key");
    expect(mem).toBeDefined();
    expect(mem!.value).toBe("remote-value");
  });

  it("prefer-local keeps local value on conflict", () => {
    createMemory({ key: "conflict-key-2", value: "local-value-2" }, "create", db);

    mkdirSync(agentSyncDir, { recursive: true });
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const remoteMemories = [
      {
        id: "remote-id-2",
        key: "conflict-key-2",
        value: "remote-value-2",
        category: "knowledge",
        scope: "private",
        summary: null,
        tags: [],
        importance: 5,
        source: "agent",
        status: "active",
        pinned: false,
        agent_id: null,
        project_id: null,
        session_id: null,
        metadata: {},
        access_count: 0,
        version: 1,
        expires_at: null,
        created_at: futureDate,
        updated_at: futureDate,
        accessed_at: null,
      },
    ];
    writeFileSync(
      join(agentSyncDir, "memories.json"),
      JSON.stringify(remoteMemories),
      "utf-8"
    );

    const result = syncMemories(TEST_AGENT, "pull", {
      db,
      conflict_resolution: "prefer-local",
    });
    expect(result.conflicts).toBe(1);
    // prefer-local means remote is NOT pulled
    expect(result.pulled).toBe(0);

    const memories = listMemories({}, db);
    const mem = memories.find((m) => m.key === "conflict-key-2");
    expect(mem!.value).toBe("local-value-2");
  });
});

// ============================================================================
// defaultSyncAgents
// ============================================================================

describe("defaultSyncAgents", () => {
  it("contains claude, codex, and gemini", () => {
    expect(defaultSyncAgents).toContain("claude");
    expect(defaultSyncAgents).toContain("codex");
    expect(defaultSyncAgents).toContain("gemini");
  });

  it("is an array of strings", () => {
    expect(Array.isArray(defaultSyncAgents)).toBe(true);
    for (const agent of defaultSyncAgents) {
      expect(typeof agent).toBe("string");
    }
  });
});
