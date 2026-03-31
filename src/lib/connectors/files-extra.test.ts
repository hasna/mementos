// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncFiles } from "./files.js";

// ============================================================================
// Additional files connector tests — lines 24, 38, 43, 82-85, 152-154
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

describe("syncFiles - additional coverage", () => {
  let db: Database;
  let tmpDir: string;
  const PROJECT_ID = "proj-files-extra";

  beforeEach(() => {
    db = freshDb();
    seedProject(db, PROJECT_ID, "files-extra-test", "/tmp/files-extra-test");
    tmpDir = mkdtempSync(join(tmpdir(), "mementos-files-extra-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("handles unreadable directory gracefully (line 24)", async () => {
    // Provide a path that doesn't exist — should not throw, just skip
    const config = { paths: ["/nonexistent/path/that/does/not/exist"] };
    const result = await syncFiles(db, PROJECT_ID, config);
    // Result has no memories, no crash
    expect(result.memories_created).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("skips hidden files (starting with .)", async () => {
    writeFileSync(join(tmpDir, ".hidden-file.md"), "# Hidden");
    writeFileSync(join(tmpDir, "visible.md"), "# Visible");

    const config = { paths: [tmpDir] };
    const result = await syncFiles(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(1);
    // Only the visible file
    const mem = db.query("SELECT key FROM memories").get() as { key: string } | null;
    expect(mem?.key).toContain("visible.md");
  });

  test("skips node_modules directory", async () => {
    const nodeModulesDir = join(tmpDir, "node_modules");
    mkdirSync(nodeModulesDir);
    writeFileSync(join(nodeModulesDir, "package.md"), "# Package");
    writeFileSync(join(tmpDir, "app.md"), "# App");

    const config = { paths: [tmpDir] };
    const result = await syncFiles(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(1);
  });

  test("recursively syncs nested directories", async () => {
    const subDir = join(tmpDir, "docs");
    mkdirSync(subDir);
    writeFileSync(join(tmpDir, "root.md"), "# Root");
    writeFileSync(join(subDir, "nested.md"), "# Nested");

    const config = { paths: [tmpDir] };
    const result = await syncFiles(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(2);
  });

  test("truncates large files to MAX_FILE_SIZE (10 KB)", async () => {
    const largeContent = "x".repeat(15 * 1024); // 15 KB
    writeFileSync(join(tmpDir, "large.md"), largeContent);

    const config = { paths: [tmpDir] };
    await syncFiles(db, PROJECT_ID, config);

    const mem = db.query("SELECT value FROM memories").get() as { value: string } | null;
    expect(mem).not.toBeNull();
    expect(mem!.value).toContain("(truncated)");
    expect(mem!.value.length).toBeLessThan(largeContent.length);
  });

  test("syncs multiple configured paths", async () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), "mementos-files-extra2-"));
    try {
      writeFileSync(join(tmpDir, "file1.md"), "# File 1");
      writeFileSync(join(tmpDir2, "file2.md"), "# File 2");

      const config = { paths: [tmpDir, tmpDir2] };
      const result = await syncFiles(db, PROJECT_ID, config);

      expect(result.memories_created).toBe(2);
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  test("extension filter is case-insensitive (line 43 area)", async () => {
    writeFileSync(join(tmpDir, "doc.MD"), "# Uppercase MD");
    writeFileSync(join(tmpDir, "note.md"), "# Lowercase md");
    writeFileSync(join(tmpDir, "script.ts"), "const x = 1;");

    const config = { paths: [tmpDir], extensions: [".md"] };
    const result = await syncFiles(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(2); // both .MD and .md
  });

  test("includes extension in tags", async () => {
    writeFileSync(join(tmpDir, "readme.md"), "# Readme");

    const config = { paths: [tmpDir] };
    await syncFiles(db, PROJECT_ID, config);

    const mem = db.query("SELECT tags FROM memories").get() as { tags: string } | null;
    const tags = JSON.parse(mem!.tags) as string[];
    expect(tags).toContain("file");
    expect(tags).toContain("md");
  });

  test("stores file_path and file_mtime in metadata", async () => {
    writeFileSync(join(tmpDir, "meta-test.md"), "# Meta test");

    const config = { paths: [tmpDir] };
    await syncFiles(db, PROJECT_ID, config);

    const mem = db.query("SELECT metadata FROM memories").get() as { metadata: string } | null;
    const meta = JSON.parse(mem!.metadata) as Record<string, unknown>;
    expect(meta["file_path"]).toBeTruthy();
    expect(meta["file_mtime"]).toBeTruthy();
    expect(meta["extension"]).toBe("md");
  });
});
