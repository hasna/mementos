// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resetDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { syncMemories } from "./sync.js";

// ============================================================================
// Helpers
// ============================================================================

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.exec(`
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
      ingested_at TEXT DEFAULT NULL,
      namespace TEXT DEFAULT NULL,
      created_by_agent TEXT DEFAULT NULL,
      updated_by_agent TEXT DEFAULT NULL,
      recall_count INTEGER NOT NULL DEFAULT 0,
      trust_score REAL DEFAULT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
  `);

  return db;
}

const TEST_AGENT_EXTRA = `__test_sync_extra_${Date.now()}`;
const agentSyncDir = join(homedir(), ".hasna", "mementos", "agents", TEST_AGENT_EXTRA);

beforeEach(() => {
  resetDatabase();
  if (existsSync(agentSyncDir)) {
    rmSync(agentSyncDir, { recursive: true });
  }
});

afterEach(() => {
  if (existsSync(agentSyncDir)) {
    rmSync(agentSyncDir, { recursive: true });
  }
});

// ============================================================================
// resolveConflict — "prefer-remote" path (line 38)
// When conflict_resolution is "prefer-remote", remote value always wins
// ============================================================================

describe("syncMemories - prefer-remote conflict resolution (line 38)", () => {
  it("prefer-remote always takes remote value", () => {
    const db = freshDb();
    createMemory({ key: "conflict-remote-key", value: "local-value" }, "create", db);

    mkdirSync(agentSyncDir, { recursive: true });
    const remoteMemories = [
      {
        id: "remote-id-prefer-remote",
        key: "conflict-remote-key",
        value: "remote-wins-value",
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
      JSON.stringify(remoteMemories),
      "utf-8"
    );

    // "prefer-remote" → resolveConflict returns "remote" (line 38 fires)
    const result = syncMemories(TEST_AGENT_EXTRA, "pull", {
      db,
      conflict_resolution: "prefer-remote",
    });
    expect(result.conflicts).toBe(1);
    // Remote wins — should be pulled
    expect(result.pulled).toBe(1);
  });
});

// ============================================================================
// pushMemories reduce — "b" branch (line 77)
// When the second memory has a later updated_at, reduce returns b
// ============================================================================

describe("syncMemories - push reduce uses b branch (line 77)", () => {
  it("high-water mark is set to the latest memory's timestamp (b branch fires when equal)", () => {
    const db = freshDb();

    // Insert two memories with the SAME updated_at.
    // listMemories orders by importance DESC, created_at DESC.
    // When both have same timestamp:
    //   reduce: a = first result, b = second result
    //   a.updated_at == b.updated_at → NOT (a > b) → returns b (line 77 fires)
    const sameDate = new Date(Date.now()).toISOString();
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, tags, metadata, created_at, updated_at)
       VALUES ('mem-alpha', 'alpha-key', 'alpha-value', 'knowledge', 'private', '[]', '{}', ?, ?)`,
      [sameDate, sameDate]
    );
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, tags, metadata, created_at, updated_at)
       VALUES ('mem-beta', 'beta-key', 'beta-value', 'knowledge', 'private', '[]', '{}', ?, ?)`,
      [sameDate, sameDate]
    );

    // Push — both memories have the same updated_at.
    // reduce((a, b)): a.updated_at == b.updated_at → NOT greater → returns b (line 77 fires)
    // setHighWaterMark is called with b's updated_at
    const result = syncMemories(TEST_AGENT_EXTRA, "push", { db });
    expect(result.pushed).toBe(2);

    // Verify the high water mark file was created
    const markFile = join(agentSyncDir, ".highwatermark");
    expect(existsSync(markFile)).toBe(true);
  });
});

// ============================================================================
// pullMemories — JSON parse failure path (line 105)
// When the memories.json file contains invalid JSON
// ============================================================================

describe("syncMemories - pull with invalid JSON (line 105)", () => {
  it("returns zeros when memories.json contains invalid JSON", () => {
    const db = freshDb();

    mkdirSync(agentSyncDir, { recursive: true });
    // Write invalid JSON to trigger JSON.parse failure (line 104-106)
    writeFileSync(
      join(agentSyncDir, "memories.json"),
      "{ this is not valid JSON !!! ]",
      "utf-8"
    );

    // JSON.parse throws → catch at line 105 returns { pulled: 0, conflicts: 0 }
    const result = syncMemories(TEST_AGENT_EXTRA, "pull", { db });
    expect(result.pulled).toBe(0);
    expect(result.conflicts).toBe(0);
    expect(result.errors.length).toBe(0);
  });
});

// ============================================================================
// syncMemories outer catch (line 220)
// When pushMemories or pullMemories throws (e.g., DB closed mid-operation)
// ============================================================================

describe("syncMemories - outer catch block (line 220)", () => {
  it("captures error from pushMemories when DB throws (line 220)", () => {
    const db = freshDb();
    // Close the DB so listMemories will throw when pushMemories tries to use it
    db.close();

    // push → listMemories(db=closed) → throws → outer catch at line 220 fires
    const result = syncMemories(TEST_AGENT_EXTRA, "push", { db });

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.pushed).toBe(0);
  });
});
