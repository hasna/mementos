// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { syncNotion } from "./notion.js";
import type { NotionConnectorConfig } from "./types.js";

// ============================================================================
// Helpers
// ============================================================================

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
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
      importance INTEGER NOT NULL DEFAULT 5,
      source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('user', 'agent', 'system', 'auto', 'imported')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'expired')),
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
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
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

function seedProject(db: Database, id: string, name: string, path: string): void {
  db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", [id, name, path]);
}

function countMemories(db: Database): number {
  const row = db.query("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number };
  return row.cnt;
}

// ============================================================================
// syncNotion tests — mock Bun.spawn
// ============================================================================

describe("syncNotion", () => {
  let db: Database;
  const PROJECT_ID = "proj-notion-001";

  // Save/restore Bun.spawn
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    db = freshDb();
    seedProject(db, PROJECT_ID, "notion-test", "/tmp/notion-test");
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

  function mockSpawnError(exitCode: number, stderrMsg: string): void {
    // @ts-ignore
    Bun.spawn = mock((_args: string[], _opts: unknown) => ({
      stdout: new ReadableStream({
        start(controller) { controller.close(); }
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderrMsg));
          controller.close();
        },
      }),
      exited: Promise.resolve(exitCode),
    }));
  }

  test("creates memories from database pages", async () => {
    const pages = [
      { id: "page-001", title: "Architecture Decisions", content: "Use microservices", url: "https://notion.so/p1" },
      { id: "page-002", title: "Team Handbook", content: "Code review process", url: "https://notion.so/p2" },
    ];
    mockSpawnSuccess(pages);

    const config: NotionConnectorConfig = { database_id: "db-123" };
    const result = await syncNotion(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(2);
    expect(result.memories_updated).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(countMemories(db)).toBe(2);
  });

  test("creates memory with correct key and content", async () => {
    const pages = [
      { id: "page-abc", title: "Project Setup", content: "Run bun install first", url: "https://notion.so/setup" },
    ];
    mockSpawnSuccess(pages);

    const config: NotionConnectorConfig = { database_id: "db-456" };
    await syncNotion(db, PROJECT_ID, config);

    const mem = db.query("SELECT key, value FROM memories WHERE key = 'notion:page:page-abc'").get() as { key: string; value: string } | null;
    expect(mem).not.toBeNull();
    expect(mem!.key).toBe("notion:page:page-abc");
    expect(mem!.value).toContain("Project Setup");
    expect(mem!.value).toContain("Run bun install first");
  });

  test("uses 'Untitled' when page has no title", async () => {
    const pages = [{ id: "page-notitle", content: "Some content" }];
    mockSpawnSuccess(pages);

    const config: NotionConnectorConfig = { database_id: "db-789" };
    await syncNotion(db, PROJECT_ID, config);

    const mem = db.query("SELECT value FROM memories WHERE key = 'notion:page:page-notitle'").get() as { value: string } | null;
    expect(mem).not.toBeNull();
    expect(mem!.value).toContain("Untitled");
  });

  test("uses '(empty page)' when page has no content", async () => {
    const pages = [{ id: "page-empty", title: "Empty Page" }];
    mockSpawnSuccess(pages);

    const config: NotionConnectorConfig = { database_id: "db-empty" };
    await syncNotion(db, PROJECT_ID, config);

    const mem = db.query("SELECT value FROM memories WHERE key = 'notion:page:page-empty'").get() as { value: string } | null;
    expect(mem).not.toBeNull();
    expect(mem!.value).toContain("(empty page)");
  });

  test("skips re-sync when content is unchanged", async () => {
    const pages = [{ id: "page-x", title: "Stable Doc", content: "No changes here" }];
    mockSpawnSuccess(pages);

    const config: NotionConnectorConfig = { database_id: "db-stable" };

    // First sync
    const first = await syncNotion(db, PROJECT_ID, config);
    expect(first.memories_created).toBe(1);

    // Second sync with same content
    const second = await syncNotion(db, PROJECT_ID, config);
    expect(second.memories_created).toBe(0);
    expect(second.memories_updated).toBe(0);
  });

  test("updates memory when content changes", async () => {
    const pages = [{ id: "page-change", title: "Changing Doc", content: "Original content" }];
    mockSpawnSuccess(pages);

    const config: NotionConnectorConfig = { database_id: "db-change" };
    const first = await syncNotion(db, PROJECT_ID, config);
    expect(first.memories_created).toBe(1);

    // Now mock updated content
    const updatedPages = [{ id: "page-change", title: "Changing Doc", content: "Updated content with new info" }];
    mockSpawnSuccess(updatedPages);

    const second = await syncNotion(db, PROJECT_ID, config);
    expect(second.memories_updated).toBe(1);
    expect(second.memories_created).toBe(0);
  });

  test("returns error when CLI fails during database fetch", async () => {
    mockSpawnError(1, "notion auth failed");

    const config: NotionConnectorConfig = { database_id: "bad-db" };
    const result = await syncNotion(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Failed to list Notion pages");
  });

  test("fetches individual pages by ID", async () => {
    const page = { id: "page-individual", title: "Specific Page", content: "Direct page content" };
    mockSpawnSuccess(page);

    const config: NotionConnectorConfig = { page_ids: ["page-individual"] };
    const result = await syncNotion(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  test("records per-page error when individual page fetch fails", async () => {
    // First call (page-001) succeeds, but the mock returns error
    mockSpawnError(1, "page not found");

    const config: NotionConnectorConfig = { page_ids: ["page-001"] };
    const result = await syncNotion(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Failed to fetch page page-001");
  });

  test("result always has duration_ms", async () => {
    mockSpawnSuccess([]);

    const config: NotionConnectorConfig = { database_id: "db-dur" };
    const result = await syncNotion(db, PROJECT_ID, config);

    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("empty page list creates no memories", async () => {
    mockSpawnSuccess([]);

    const config: NotionConnectorConfig = { database_id: "db-empty-list" };
    const result = await syncNotion(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(0);
    expect(result.memories_updated).toBe(0);
    expect(countMemories(db)).toBe(0);
  });

  test("no config (no database_id, no page_ids) creates no memories", async () => {
    // No spawn calls expected
    const config: NotionConnectorConfig = {};
    const result = await syncNotion(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
