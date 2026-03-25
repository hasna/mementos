process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { rateMemory, listRatingsForMemory, getRatingsSummary } from "./ratings.js";

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_ratings (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      agent_id TEXT,
      useful INTEGER NOT NULL DEFAULT 1,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_ratings_memory ON memory_ratings(memory_id);
  `);

  return db;
}

function seedMemory(db: Database, id: string, key: string): void {
  db.run(
    `INSERT INTO memories (id, key, value, created_at, updated_at) VALUES (?, ?, 'test value', datetime('now'), datetime('now'))`,
    [id, key]
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("rateMemory", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("stores a rating for a memory", () => {
    seedMemory(db, "mem-1", "test-key");
    const rating = rateMemory("mem-1", true, "agent-1", "Helpful context", db);
    expect(rating.memory_id).toBe("mem-1");
    expect(rating.useful).toBe(true);
    expect(rating.agent_id).toBe("agent-1");
    expect(rating.context).toBe("Helpful context");
    expect(rating.id).toBeTruthy();
    expect(rating.created_at).toBeTruthy();
  });

  it("stores a not-useful rating", () => {
    seedMemory(db, "mem-2", "test-key-2");
    const rating = rateMemory("mem-2", false, "agent-1", undefined, db);
    expect(rating.useful).toBe(false);
    expect(rating.context).toBeNull();
  });

  it("allows multiple ratings on the same memory", () => {
    seedMemory(db, "mem-3", "test-key-3");
    rateMemory("mem-3", true, "agent-1", undefined, db);
    rateMemory("mem-3", false, "agent-2", "Not relevant", db);
    rateMemory("mem-3", true, "agent-3", undefined, db);

    const ratings = listRatingsForMemory("mem-3", db);
    expect(ratings.length).toBe(3);
  });
});

describe("listRatingsForMemory", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns all ratings for a memory", () => {
    seedMemory(db, "mem-list", "list-key");
    rateMemory("mem-list", true, "a1", "good", db);
    rateMemory("mem-list", false, "a2", "bad", db);

    const ratings = listRatingsForMemory("mem-list", db);
    expect(ratings.length).toBe(2);
    // Should have one useful and one not useful
    const usefulCount = ratings.filter(r => r.useful).length;
    const notUsefulCount = ratings.filter(r => !r.useful).length;
    expect(usefulCount).toBe(1);
    expect(notUsefulCount).toBe(1);
  });

  it("returns empty array for memory with no ratings", () => {
    seedMemory(db, "mem-none", "none-key");
    const ratings = listRatingsForMemory("mem-none", db);
    expect(ratings.length).toBe(0);
  });
});

describe("getRatingsSummary", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("aggregates multiple ratings correctly", () => {
    seedMemory(db, "mem-agg", "agg-key");
    rateMemory("mem-agg", true, "a1", undefined, db);
    rateMemory("mem-agg", true, "a2", undefined, db);
    rateMemory("mem-agg", false, "a3", undefined, db);

    const summary = getRatingsSummary("mem-agg", db);
    expect(summary.memory_id).toBe("mem-agg");
    expect(summary.total).toBe(3);
    expect(summary.useful_count).toBe(2);
    expect(summary.not_useful_count).toBe(1);
    expect(summary.usefulness_ratio).toBeCloseTo(2 / 3, 2);
  });

  it("returns zero ratio for memory with no ratings", () => {
    seedMemory(db, "mem-zero", "zero-key");
    const summary = getRatingsSummary("mem-zero", db);
    expect(summary.total).toBe(0);
    expect(summary.useful_count).toBe(0);
    expect(summary.not_useful_count).toBe(0);
    expect(summary.usefulness_ratio).toBe(0);
  });

  it("returns 1.0 ratio when all ratings are useful", () => {
    seedMemory(db, "mem-all", "all-key");
    rateMemory("mem-all", true, "a1", undefined, db);
    rateMemory("mem-all", true, "a2", undefined, db);

    const summary = getRatingsSummary("mem-all", db);
    expect(summary.usefulness_ratio).toBe(1.0);
  });

  it("returns 0.0 ratio when no ratings are useful", () => {
    seedMemory(db, "mem-bad", "bad-key");
    rateMemory("mem-bad", false, "a1", undefined, db);
    rateMemory("mem-bad", false, "a2", undefined, db);

    const summary = getRatingsSummary("mem-bad", db);
    expect(summary.usefulness_ratio).toBe(0.0);
  });
});
