// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory, getMemory, listMemories } from "../db/memories.js";
import {
  enforceQuotas,
  archiveStale,
  archiveUnused,
  deprioritizeStale,
  runCleanup,
} from "./retention.js";
import type { MementosConfig } from "../types/index.js";

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
  `);

  return db;
}

function makeConfig(overrides?: Partial<MementosConfig>): MementosConfig {
  return {
    default_scope: "private",
    default_category: "knowledge",
    default_importance: 5,
    max_entries: 1000,
    max_entries_per_scope: {
      global: 500,
      shared: 300,
      private: 200,
    },
    injection: {
      max_tokens: 500,
      min_importance: 5,
      categories: ["preference", "fact"],
      refresh_interval: 5,
    },
    sync_agents: ["claude", "codex", "gemini"],
    auto_cleanup: {
      enabled: true,
      expired_check_interval: 3600,
    },
    ...overrides,
  };
}

let db: Database;

beforeEach(() => {
  resetDatabase();
  db = freshDb();
});

// ============================================================================
// cleanExpiredMemories (tested via db/memories.ts export but invoked by retention)
// ============================================================================

describe("cleanExpiredMemories via retention", () => {
  it("removes expired memories", () => {
    // Create a memory with a past expiry
    const past = new Date(Date.now() - 60_000).toISOString();
    createMemory(
      { key: "expired-key", value: "old", expires_at: past },
      "create",
      db
    );
    const all = listMemories({ status: ["active"] }, db);
    expect(all.length).toBe(1);

    // The cleanExpiredMemories is called inside runCleanup
    // Let's call it directly from memories module
    const { cleanExpiredMemories } = require("../db/memories.js");
    const removed = cleanExpiredMemories(db);
    expect(removed).toBe(1);

    const afterClean = listMemories({ status: ["active"] }, db);
    expect(afterClean.length).toBe(0);
  });

  it("keeps active non-expired memories", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    createMemory(
      { key: "active-key", value: "fresh", expires_at: future },
      "create",
      db
    );
    createMemory(
      { key: "no-expiry", value: "forever" },
      "create",
      db
    );

    const { cleanExpiredMemories } = require("../db/memories.js");
    const removed = cleanExpiredMemories(db);
    expect(removed).toBe(0);

    const remaining = listMemories({ status: ["active"] }, db);
    expect(remaining.length).toBe(2);
  });

  it("keeps memories with no expires_at", () => {
    createMemory({ key: "k1", value: "v1" }, "create", db);
    createMemory({ key: "k2", value: "v2" }, "create", db);

    const { cleanExpiredMemories } = require("../db/memories.js");
    const removed = cleanExpiredMemories(db);
    expect(removed).toBe(0);
  });
});

// ============================================================================
// enforceQuotas
// ============================================================================

describe("enforceQuotas", () => {
  it("evicts when over limit for a scope", () => {
    const config = makeConfig({
      max_entries_per_scope: { global: 3, shared: 300, private: 200 },
    });

    // Create 5 global memories
    for (let i = 0; i < 5; i++) {
      createMemory(
        { key: `global-${i}`, value: `val-${i}`, scope: "global", importance: 5 },
        "create",
        db
      );
    }

    const evicted = enforceQuotas(config, db);
    expect(evicted).toBe(2); // 5 - 3 = 2

    const remaining = listMemories({ scope: "global" }, db);
    expect(remaining.length).toBe(3);
  });

  it("evicts lowest importance first", () => {
    const config = makeConfig({
      max_entries_per_scope: { global: 2, shared: 300, private: 200 },
    });

    createMemory(
      { key: "low", value: "low-val", scope: "global", importance: 1 },
      "create",
      db
    );
    createMemory(
      { key: "mid", value: "mid-val", scope: "global", importance: 5 },
      "create",
      db
    );
    createMemory(
      { key: "high", value: "high-val", scope: "global", importance: 10 },
      "create",
      db
    );

    const evicted = enforceQuotas(config, db);
    expect(evicted).toBe(1);

    const remaining = listMemories({ scope: "global" }, db);
    expect(remaining.length).toBe(2);
    // The lowest importance should be evicted
    const keys = remaining.map((m) => m.key);
    expect(keys).not.toContain("low");
    expect(keys).toContain("mid");
    expect(keys).toContain("high");
  });

  it("does not evict when under limit", () => {
    const config = makeConfig({
      max_entries_per_scope: { global: 10, shared: 300, private: 200 },
    });

    createMemory(
      { key: "g1", value: "v1", scope: "global" },
      "create",
      db
    );
    createMemory(
      { key: "g2", value: "v2", scope: "global" },
      "create",
      db
    );

    const evicted = enforceQuotas(config, db);
    expect(evicted).toBe(0);
  });

  it("does not evict pinned memories", () => {
    const config = makeConfig({
      max_entries_per_scope: { global: 1, shared: 300, private: 200 },
    });

    // Create pinned memory with low importance
    const pinned = createMemory(
      { key: "pinned", value: "important", scope: "global", importance: 1 },
      "create",
      db
    );
    // Pin it
    db.run("UPDATE memories SET pinned = 1 WHERE id = ?", [pinned.id]);

    createMemory(
      { key: "normal", value: "normal-val", scope: "global", importance: 5 },
      "create",
      db
    );

    const evicted = enforceQuotas(config, db);
    // Only the non-pinned one can be evicted
    expect(evicted).toBe(1);

    // Pinned memory should survive
    const mem = getMemory(pinned.id, db);
    expect(mem).not.toBeNull();
  });

  it("handles multiple scopes independently", () => {
    const config = makeConfig({
      max_entries_per_scope: { global: 1, shared: 1, private: 200 },
    });

    createMemory({ key: "g1", value: "v", scope: "global" }, "create", db);
    createMemory({ key: "g2", value: "v", scope: "global" }, "create", db);
    createMemory({ key: "s1", value: "v", scope: "shared" }, "create", db);
    createMemory({ key: "s2", value: "v", scope: "shared" }, "create", db);

    const evicted = enforceQuotas(config, db);
    expect(evicted).toBe(2); // 1 from global + 1 from shared
  });

  it("evicts nothing when config limit is 0 or negative", () => {
    const config = makeConfig({
      max_entries_per_scope: { global: 0, shared: 0, private: 0 },
    });

    createMemory({ key: "g1", value: "v", scope: "global" }, "create", db);
    const evicted = enforceQuotas(config, db);
    expect(evicted).toBe(0);
  });
});

// ============================================================================
// archiveStale
// ============================================================================

describe("archiveStale", () => {
  it("archives old unaccessed memories", () => {
    // Create a memory and backdate its created_at to 100 days ago
    const mem = createMemory({ key: "old", value: "old-val" }, "create", db);
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET created_at = ?, accessed_at = NULL WHERE id = ?", [
      oldDate,
      mem.id,
    ]);

    const archived = archiveStale(90, db);
    expect(archived).toBe(1);

    const updated = getMemory(mem.id, db);
    expect(updated!.status).toBe("archived");
  });

  it("does not archive recently accessed memories", () => {
    const mem = createMemory({ key: "recent", value: "v" }, "create", db);
    // Backdate created_at but set accessed_at to now
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    db.run("UPDATE memories SET created_at = ?, accessed_at = ? WHERE id = ?", [
      oldDate,
      now,
      mem.id,
    ]);

    const archived = archiveStale(90, db);
    expect(archived).toBe(0);
  });

  it("skips pinned memories", () => {
    const mem = createMemory({ key: "pinned-old", value: "v" }, "create", db);
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      "UPDATE memories SET created_at = ?, accessed_at = NULL, pinned = 1 WHERE id = ?",
      [oldDate, mem.id]
    );

    const archived = archiveStale(90, db);
    expect(archived).toBe(0);

    const updated = getMemory(mem.id, db);
    expect(updated!.status).toBe("active");
  });

  it("does not archive fresh memories", () => {
    createMemory({ key: "fresh", value: "v" }, "create", db);
    const archived = archiveStale(90, db);
    expect(archived).toBe(0);
  });

  it("uses accessed_at over created_at when available", () => {
    const mem = createMemory({ key: "accessed", value: "v" }, "create", db);
    // Old created_at, but recently accessed
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET created_at = ?, accessed_at = ? WHERE id = ?", [
      oldDate,
      recentDate,
      mem.id,
    ]);

    const archived = archiveStale(90, db);
    expect(archived).toBe(0);
  });
});

// ============================================================================
// runCleanup
// ============================================================================

describe("runCleanup", () => {
  it("combines all three cleanup operations", () => {
    const config = makeConfig({
      max_entries_per_scope: { global: 1, shared: 300, private: 200 },
    });

    // Create an expired memory
    const past = new Date(Date.now() - 60_000).toISOString();
    createMemory(
      { key: "expired", value: "v", expires_at: past },
      "create",
      db
    );

    // Create memories that exceed global quota
    createMemory({ key: "g1", value: "v", scope: "global" }, "create", db);
    createMemory({ key: "g2", value: "v", scope: "global" }, "create", db);

    // Create an old memory for archival
    const mem = createMemory({ key: "stale", value: "v" }, "create", db);
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET created_at = ?, accessed_at = NULL WHERE id = ?", [
      oldDate,
      mem.id,
    ]);

    const result = runCleanup(config, db);
    expect(result.expired).toBeGreaterThanOrEqual(0);
    expect(typeof result.evicted).toBe("number");
    expect(typeof result.archived).toBe("number");
    // At least one operation should have done something
    expect(result.expired + result.evicted + result.archived).toBeGreaterThan(0);
  });

  it("returns zeros when nothing to clean", () => {
    const config = makeConfig();
    const result = runCleanup(config, db);
    expect(result.expired).toBe(0);
    expect(result.evicted).toBe(0);
    expect(result.archived).toBe(0);
  });

  it("returns all 5 fields including unused_archived and deprioritized", () => {
    const config = makeConfig();
    const result = runCleanup(config, db);
    expect(typeof result.expired).toBe("number");
    expect(typeof result.evicted).toBe("number");
    expect(typeof result.archived).toBe("number");
    expect(typeof result.unused_archived).toBe("number");
    expect(typeof result.deprioritized).toBe("number");
  });

  it("runs archiveUnused and deprioritizeStale as part of cleanup", () => {
    const config = makeConfig({
      auto_cleanup: {
        enabled: true,
        expired_check_interval: 3600,
        unused_archive_days: 3,
        stale_deprioritize_days: 5,
      },
    });

    // Create a memory with 0 access_count, backdated beyond unused_archive_days
    const mem1 = createMemory({ key: "unused-old", value: "v" }, "create", db);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET created_at = ?, access_count = 0 WHERE id = ?", [
      oldDate,
      mem1.id,
    ]);

    // Create a memory with access, backdated beyond stale_deprioritize_days
    const mem2 = createMemory(
      { key: "stale-accessed", value: "v", importance: 5 },
      "create",
      db
    );
    const staleDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      "UPDATE memories SET created_at = ?, updated_at = ?, accessed_at = ?, access_count = 1 WHERE id = ?",
      [staleDate, staleDate, staleDate, mem2.id]
    );

    const result = runCleanup(config, db);
    expect(result.unused_archived + result.deprioritized).toBeGreaterThan(0);
  });
});

// ============================================================================
// archiveUnused
// ============================================================================

describe("archiveUnused", () => {
  it("archives memories with 0 access_count older than N days", () => {
    const mem = createMemory({ key: "never-accessed", value: "v" }, "create", db);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET created_at = ?, access_count = 0 WHERE id = ?", [
      oldDate,
      mem.id,
    ]);

    const archived = archiveUnused(7, db);
    expect(archived).toBe(1);

    const updated = getMemory(mem.id, db);
    expect(updated!.status).toBe("archived");
  });

  it("skips memories that have been accessed", () => {
    const mem = createMemory({ key: "accessed", value: "v" }, "create", db);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET created_at = ?, access_count = 3 WHERE id = ?", [
      oldDate,
      mem.id,
    ]);

    const archived = archiveUnused(7, db);
    expect(archived).toBe(0);
  });

  it("skips pinned memories", () => {
    const mem = createMemory({ key: "pinned-unused", value: "v" }, "create", db);
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      "UPDATE memories SET created_at = ?, access_count = 0, pinned = 1 WHERE id = ?",
      [oldDate, mem.id]
    );

    const archived = archiveUnused(7, db);
    expect(archived).toBe(0);

    const updated = getMemory(mem.id, db);
    expect(updated!.status).toBe("active");
  });

  it("skips recently created memories", () => {
    createMemory({ key: "new-unused", value: "v" }, "create", db);
    // created_at is now, access_count defaults to 0
    const archived = archiveUnused(7, db);
    expect(archived).toBe(0);
  });

  it("does nothing when no unused memories exist", () => {
    const archived = archiveUnused(7, db);
    expect(archived).toBe(0);
  });
});

// ============================================================================
// deprioritizeStale
// ============================================================================

describe("deprioritizeStale", () => {
  it("lowers importance for unaccessed memories older than N days", () => {
    const mem = createMemory(
      { key: "stale", value: "v", importance: 5 },
      "create",
      db
    );
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET updated_at = ?, accessed_at = NULL WHERE id = ?", [
      oldDate,
      mem.id,
    ]);

    const count = deprioritizeStale(14, db);
    expect(count).toBe(1);

    const updated = getMemory(mem.id, db);
    expect(updated!.importance).toBe(4);
  });

  it("floors importance at 1", () => {
    const mem = createMemory(
      { key: "floor-test", value: "v", importance: 2 },
      "create",
      db
    );
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET updated_at = ?, accessed_at = NULL WHERE id = ?", [
      oldDate,
      mem.id,
    ]);

    // First deprioritize: 2 -> 1
    deprioritizeStale(14, db);
    const after1 = getMemory(mem.id, db);
    expect(after1!.importance).toBe(1);

    // Second deprioritize: should stay at 1 (importance > 1 check prevents update)
    // Need to re-backdate updated_at since deprioritize updates it
    db.run("UPDATE memories SET updated_at = ? WHERE id = ?", [oldDate, mem.id]);
    const count2 = deprioritizeStale(14, db);
    expect(count2).toBe(0); // importance is already 1, skipped

    const after2 = getMemory(mem.id, db);
    expect(after2!.importance).toBe(1);
  });

  it("skips pinned memories", () => {
    const mem = createMemory(
      { key: "pinned-stale", value: "v", importance: 5 },
      "create",
      db
    );
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      "UPDATE memories SET updated_at = ?, accessed_at = NULL, pinned = 1 WHERE id = ?",
      [oldDate, mem.id]
    );

    const count = deprioritizeStale(14, db);
    expect(count).toBe(0);

    const updated = getMemory(mem.id, db);
    expect(updated!.importance).toBe(5);
  });

  it("skips recently accessed memories", () => {
    const mem = createMemory(
      { key: "recent-access", value: "v", importance: 5 },
      "create",
      db
    );
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET accessed_at = ? WHERE id = ?", [recentDate, mem.id]);

    const count = deprioritizeStale(14, db);
    expect(count).toBe(0);
  });

  it("increments version on deprioritize", () => {
    const mem = createMemory(
      { key: "version-test", value: "v", importance: 5 },
      "create",
      db
    );
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE memories SET updated_at = ?, accessed_at = NULL WHERE id = ?", [
      oldDate,
      mem.id,
    ]);

    deprioritizeStale(14, db);
    const updated = getMemory(mem.id, db);
    expect(updated!.version).toBe(2);
  });

  it("does nothing when no stale memories exist", () => {
    const count = deprioritizeStale(14, db);
    expect(count).toBe(0);
  });
});
