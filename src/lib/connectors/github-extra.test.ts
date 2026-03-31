// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { syncGithub } from "./github.js";
import type { GitHubConnectorConfig } from "./types.js";

// ============================================================================
// github.ts lines 136-138 — itemErr catch block
// Triggered when createMemory fails for an individual item.
// Strategy: create a DB with the memories table but WITHOUT memory_tags.
// When createMemory tries to insert into memory_tags, it throws → itemErr fires.
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
    -- when items have labels (tags), triggering the itemErr catch block
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

describe("syncGithub - itemErr catch block (lines 136-138)", () => {
  let db: Database;
  const PROJECT_ID = "proj-github-extra";
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    db = freshDbWithoutTags();
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", [PROJECT_ID, "github-extra-test", "/tmp/github-extra"]);
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

  test("records itemErr when createMemory throws for an item with labels (lines 136-138)", async () => {
    // Issue with labels — createMemory will try to insert into memory_tags (which doesn't exist)
    // → throws → itemErr catch at lines 136-138 fires
    const issues = [
      {
        number: 1,
        title: "Issue with label",
        body: "This issue has a label that will fail",
        html_url: "https://github.com/o/r/issues/1",
        state: "open",
        labels: [{ name: "bug" }], // labels become tags → memory_tags INSERT → throws
      },
    ];
    mockSpawnSuccess(issues);

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    const result = await syncGithub(db, PROJECT_ID, config);

    // The item fails → itemErr is caught (lines 136-138)
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain("Failed to sync issues #1");
    expect(result.memories_created).toBe(0);
  });
});
