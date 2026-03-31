// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { syncNotion } from "./notion.js";
import type { NotionConnectorConfig } from "./types.js";

// ============================================================================
// notion.ts lines 147-149 — pageErr catch block
// Triggered when createMemory fails for an individual page.
// Strategy: create a DB with the memories table but WITHOUT memory_tags.
// When createMemory tries to insert into memory_tags, it throws → pageErr fires.
// ============================================================================

function freshDbWithoutTags(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = OFF"); // Need to disable FK to avoid cascade issues

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
    -- NOTE: memory_tags is intentionally OMITTED to cause createMemory to throw
    -- when pages have tags, triggering the pageErr catch block at lines 147-149
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      project_id TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
  `);

  return db;
}

describe("syncNotion - pageErr catch block (lines 147-149)", () => {
  let db: Database;
  const PROJECT_ID = "proj-notion-extra";
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    db = freshDbWithoutTags();
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", [PROJECT_ID, "notion-extra-test", "/tmp/notion-extra"]);
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    db.close();
    // @ts-ignore
    Bun.spawn = originalSpawn;
  });

  function mockSpawnSuccess(output: unknown): void {
    const json = JSON.stringify(output);
    // @ts-ignore
    Bun.spawn = mock((_args: string[], _opts: unknown) => ({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(json));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) { controller.close(); }
      }),
      exited: Promise.resolve(0),
    }));
  }

  test("records pageErr when createMemory throws (lines 147-149)", async () => {
    // syncNotion always inserts with tags: ["notion", "page"]
    // createMemory tries to INSERT INTO memory_tags (which doesn't exist) → throws
    // → pageErr catch at lines 147-149 fires
    const pages = [
      {
        id: "page-err-001",
        title: "Page that will fail",
        content: "This page content will cause createMemory to throw",
        url: "https://notion.so/page-err-001",
      },
    ];
    mockSpawnSuccess(pages);

    const config: NotionConnectorConfig = { database_id: "db-err-test" };
    const result = await syncNotion(db, PROJECT_ID, config);

    // The page fails → pageErr is caught (lines 147-149)
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain("Failed to sync page page-err-001");
    expect(result.memories_created).toBe(0);
  });
});
