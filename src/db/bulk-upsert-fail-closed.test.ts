// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "../storage.js";
import { bulkUpsertMemories } from "./memories.js";

// ============================================================================
// Regression: bulk-upsert is a cloud write that must never report success for a
// row that did not persist.
//
// The statement used `INSERT OR IGNORE`, which on SQLite suppresses EVERY
// constraint failure — not just a uniqueness conflict. A row refused by the
// `category` CHECK came back with `changes === 0`, fell into the `skipped++`
// branch (the same bucket as an idempotent no-op), left `errors` empty, and the
// route answered 201. The cross-machine -> cloud backfill for the fleet
// self-host cutover therefore dropped rows silently and an operator could not
// tell "already present" from "refused".
//
// These tests drive the primitive against a real schema carrying the same CHECK
// constraints as the migrations, and assert the report matches what is actually
// in the table.
// ============================================================================

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
  `);
  return db;
}

function keysInTable(db: Database): string[] {
  const rows = db.query("SELECT key FROM memories ORDER BY key").all() as { key: string }[];
  return rows.map((r) => r.key);
}

describe("bulkUpsertMemories: a row that does not persist is never reported as success", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("FAILING INPUT: a bad category is rejected, not counted as skipped", () => {
    const result = bulkUpsertMemories(
      [
        { id: "b1", key: "b1", value: "ok", category: "fact" },
        { id: "b2", key: "b2", value: "bad", category: "decision" },
      ],
      db
    );

    expect(result.inserted).toBe(1);
    // The dropped row must NOT share a bucket with an idempotent no-op.
    expect(result.skipped).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("b2");
    expect(result.errors[0]).toContain("category");
    expect(result.errors[0]).toContain("decision");

    // The report must match the table: b1 landed, b2 did not.
    expect(keysInTable(db)).toEqual(["b1"]);
  });

  it("skipped means already-present: a re-run of the same ids is a no-op", () => {
    const rows = [
      { id: "s1", key: "s1", value: "v", category: "fact" },
      { id: "s2", key: "s2", value: "v", category: "knowledge" },
    ];
    const first = bulkUpsertMemories(rows, db);
    expect(first).toMatchObject({ inserted: 2, skipped: 0, rejected: 0, total: 2 });

    const second = bulkUpsertMemories(rows, db);
    expect(second).toMatchObject({ inserted: 0, skipped: 2, rejected: 0, total: 2 });
    expect(second.errors).toEqual([]);
    expect(keysInTable(db)).toEqual(["s1", "s2"]);
  });

  it("a same-key row under a NEW id is still an idempotent skip, not a rejection", () => {
    // The unique key index (key, scope, agent, project, session) must keep
    // behaving as a conflict — tightening ON CONFLICT to the primary key alone
    // would turn a benign re-import into a hard error.
    bulkUpsertMemories([{ id: "u1", key: "dup", value: "v", scope: "private" }], db);
    const again = bulkUpsertMemories(
      [{ id: "u2", key: "dup", value: "v", scope: "private" }],
      db
    );
    expect(again).toMatchObject({ inserted: 0, skipped: 1, rejected: 0 });
    expect(again.errors).toEqual([]);
  });

  it("every enum column is covered, and each rejection names its field", () => {
    const result = bulkUpsertMemories(
      [
        { id: "e1", key: "e1", value: "v", scope: "public" },
        { id: "e2", key: "e2", value: "v", source: "robot" },
        { id: "e3", key: "e3", value: "v", status: "deleted" },
      ],
      db
    );
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(3);
    expect(result.errors.join("\n")).toContain("scope");
    expect(result.errors.join("\n")).toContain("source");
    expect(result.errors.join("\n")).toContain("status");
    expect(keysInTable(db)).toEqual([]);
  });

  it("a CHECK with no enum validator behind it still fails closed", () => {
    // importance has a range CHECK, not an enum one — it must reach the catch
    // rather than be silently swallowed by the insert.
    const result = bulkUpsertMemories(
      [{ id: "i1", key: "i1", value: "v", importance: 99 }],
      db
    );
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]).toContain("i1");
    expect(keysInTable(db)).toEqual([]);
  });

  it("a row without a key is rejected, not skipped", () => {
    const result = bulkUpsertMemories([{ id: "n1", value: "v" }], db);
    expect(result.rejected).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("the buckets always account for every row", () => {
    const result = bulkUpsertMemories(
      [
        { id: "a1", key: "a1", value: "v" },
        { id: "a2", key: "a2", value: "v", category: "decision" },
        { id: "a3", value: "v" },
      ],
      db
    );
    expect(result.inserted + result.skipped + result.rejected).toBe(result.total);
    expect(result.errors.length).toBe(result.rejected);
  });

  it("a clean batch still persists everything with no errors", () => {
    const result = bulkUpsertMemories(
      [
        { id: "c1", key: "c1", value: "v", category: "procedural", scope: "working" },
        { id: "c2", key: "c2", value: "v", source: "imported", status: "archived" },
      ],
      db
    );
    expect(result).toMatchObject({ inserted: 2, skipped: 0, rejected: 0, total: 2 });
    expect(result.errors).toEqual([]);
    expect(keysInTable(db)).toEqual(["c1", "c2"]);
    const row = db.query("SELECT status FROM memories WHERE id = ?").get("c2") as { status: string };
    // Faithful restore: archived stays archived.
    expect(row.status).toBe("archived");
  });
});
