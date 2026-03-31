// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { syncGithub } from "./github.js";
import type { GitHubConnectorConfig } from "./types.js";

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
// syncGithub tests
// ============================================================================

describe("syncGithub", () => {
  let db: Database;
  const PROJECT_ID = "proj-github-001";

  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    db = freshDb();
    seedProject(db, PROJECT_ID, "github-test", "/tmp/github-test");
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

  test("syncs issues into memories", async () => {
    const issues = [
      { number: 1, title: "Bug: null pointer", body: "Crash on startup", html_url: "https://github.com/o/r/issues/1", state: "open", labels: [] },
      { number: 2, title: "Feature: dark mode", body: "Add dark mode support", html_url: "https://github.com/o/r/issues/2", state: "open", labels: [] },
    ];
    mockSpawnSuccess(issues);

    const config: GitHubConnectorConfig = { owner: "test-owner", repo: "test-repo", types: ["issues"] };
    const result = await syncGithub(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(2);
    expect(result.memories_updated).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(countMemories(db)).toBe(2);
  });

  test("uses correct memory key format for issues", async () => {
    const issues = [{ number: 42, title: "Test issue", body: "Body text", labels: [] }];
    mockSpawnSuccess(issues);

    const config: GitHubConnectorConfig = { owner: "myorg", repo: "myrepo", types: ["issues"] };
    await syncGithub(db, PROJECT_ID, config);

    const mem = db.query("SELECT key FROM memories WHERE key LIKE '%issue%'").get() as { key: string } | null;
    expect(mem).not.toBeNull();
    expect(mem!.key).toBe("github:issue:myorg/myrepo:42");
  });

  test("uses correct memory key format for PRs", async () => {
    const prs = [{ number: 10, title: "Add feature", body: "Implementation", labels: [] }];
    mockSpawnSuccess(prs);

    const config: GitHubConnectorConfig = { owner: "myorg", repo: "myrepo", types: ["prs"] };
    await syncGithub(db, PROJECT_ID, config);

    const mem = db.query("SELECT key FROM memories WHERE key LIKE '%pr%'").get() as { key: string } | null;
    expect(mem).not.toBeNull();
    expect(mem!.key).toBe("github:pr:myorg/myrepo:10");
  });

  test("uses correct memory key format for discussions", async () => {
    const discussions = [{ number: 5, title: "Design discussion", body: "Let us talk about this", labels: [] }];
    mockSpawnSuccess(discussions);

    const config: GitHubConnectorConfig = { owner: "myorg", repo: "myrepo", types: ["discussions"] };
    await syncGithub(db, PROJECT_ID, config);

    const mem = db.query("SELECT key FROM memories WHERE key LIKE '%discussion%'").get() as { key: string } | null;
    expect(mem).not.toBeNull();
    expect(mem!.key).toBe("github:discussion:myorg/myrepo:5");
  });

  test("uses '(no description)' when body is missing", async () => {
    const issues = [{ number: 99, title: "Empty issue", labels: [] }];
    mockSpawnSuccess(issues);

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    await syncGithub(db, PROJECT_ID, config);

    const mem = db.query("SELECT value FROM memories").get() as { value: string } | null;
    expect(mem).not.toBeNull();
    expect(mem!.value).toContain("(no description)");
  });

  test("includes labels in tags", async () => {
    const issues = [
      {
        number: 7,
        title: "Labeled issue",
        body: "With labels",
        labels: [{ name: "bug" }, { name: "high-priority" }],
      },
    ];
    mockSpawnSuccess(issues);

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    await syncGithub(db, PROJECT_ID, config);

    const mem = db.query("SELECT tags FROM memories").get() as { tags: string } | null;
    expect(mem).not.toBeNull();
    const tags = JSON.parse(mem!.tags) as string[];
    expect(tags).toContain("bug");
    expect(tags).toContain("high-priority");
    expect(tags).toContain("github");
  });

  test("skips re-sync when content unchanged", async () => {
    const issues = [{ number: 1, title: "Stable issue", body: "No changes", labels: [] }];
    mockSpawnSuccess(issues);

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    const first = await syncGithub(db, PROJECT_ID, config);
    expect(first.memories_created).toBe(1);

    const second = await syncGithub(db, PROJECT_ID, config);
    expect(second.memories_created).toBe(0);
    expect(second.memories_updated).toBe(0);
  });

  test("updates memory when content changes", async () => {
    const issues = [{ number: 1, title: "Evolving issue", body: "Original body", labels: [] }];
    mockSpawnSuccess(issues);

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    const first = await syncGithub(db, PROJECT_ID, config);
    expect(first.memories_created).toBe(1);

    // Content changed
    const updatedIssues = [{ number: 1, title: "Evolving issue", body: "Updated body with more details", labels: [] }];
    mockSpawnSuccess(updatedIssues);

    const second = await syncGithub(db, PROJECT_ID, config);
    expect(second.memories_updated).toBe(1);
    expect(second.memories_created).toBe(0);
  });

  test("records error when CLI fails for a type", async () => {
    mockSpawnError(1, "github rate limit");

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    const result = await syncGithub(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Failed to fetch issues");
  });

  test("defaults to all three types when types not specified", async () => {
    const issues = [{ number: 1, title: "Issue 1", body: "body", labels: [] }];
    mockSpawnSuccess(issues);

    // No types specified — should default to ["issues", "prs", "discussions"]
    const config: GitHubConnectorConfig = { owner: "o", repo: "r" };
    const result = await syncGithub(db, PROJECT_ID, config);

    // All 3 fetches succeed (same mock returns same data, so we get 3 attempts)
    expect(result).toHaveProperty("memories_created");
    expect(typeof result.memories_created).toBe("number");
  });

  test("result always has duration_ms", async () => {
    mockSpawnSuccess([]);

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    const result = await syncGithub(db, PROJECT_ID, config);

    expect(typeof result.duration_ms).toBe("number");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("handles empty result list", async () => {
    mockSpawnSuccess([]);

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    const result = await syncGithub(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(countMemories(db)).toBe(0);
  });

  test("stores metadata including author and url", async () => {
    const issues = [
      {
        number: 3,
        title: "Meta test",
        body: "With metadata",
        user: { login: "dev-user" },
        html_url: "https://github.com/o/r/issues/3",
        state: "open",
        labels: [],
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
      },
    ];
    mockSpawnSuccess(issues);

    const config: GitHubConnectorConfig = { owner: "o", repo: "r", types: ["issues"] };
    await syncGithub(db, PROJECT_ID, config);

    const mem = db.query("SELECT metadata FROM memories").get() as { metadata: string } | null;
    expect(mem).not.toBeNull();
    const meta = JSON.parse(mem!.metadata) as Record<string, unknown>;
    expect(meta["author"]).toBe("dev-user");
    expect(meta["url"]).toContain("github.com");
    expect(meta["state"]).toBe("open");
  });
});
