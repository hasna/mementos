// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncFiles } from "./files.js";
import { syncConnector } from "./index.js";
import type { FilesConnectorConfig, ConnectorConfig } from "./types.js";
import { extractFile } from "../extractors/index.js";
import { emptyResult } from "../extractors/types.js";
import {
  categorizeMemoryBatch,
  vectorTag,
} from "../asmr/categorizer.js";

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

function seedProject(db: Database, id: string, name: string, path: string): void {
  db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", [id, name, path]);
}

function countMemories(db: Database): number {
  const row = db.query("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number };
  return row.cnt;
}

// ============================================================================
// File connector
// ============================================================================

describe("syncFiles", () => {
  let db: Database;
  let tmpDir: string;
  const PROJECT_ID = "proj-test-001";

  beforeEach(() => {
    db = freshDb();
    seedProject(db, PROJECT_ID, "test-project", "/tmp/test-project");
    tmpDir = mkdtempSync(join(tmpdir(), "mementos-test-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("syncs .md files into memories", async () => {
    writeFileSync(join(tmpDir, "readme.md"), "# Hello World");
    writeFileSync(join(tmpDir, "notes.md"), "Some notes here");

    const config: FilesConnectorConfig = { paths: [tmpDir] };
    const result = await syncFiles(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(2);
    expect(result.memories_updated).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(countMemories(db)).toBe(2);
  });

  test("re-sync with no changes creates/updates nothing", async () => {
    writeFileSync(join(tmpDir, "readme.md"), "# Hello World");
    writeFileSync(join(tmpDir, "notes.md"), "Some notes here");

    const config: FilesConnectorConfig = { paths: [tmpDir] };
    await syncFiles(db, PROJECT_ID, config);

    // Second sync — files unchanged
    const result = await syncFiles(db, PROJECT_ID, config);
    expect(result.memories_created).toBe(0);
    expect(result.memories_updated).toBe(0);
  });

  test("modified file triggers update on re-sync", async () => {
    const filePath = join(tmpDir, "readme.md");
    writeFileSync(filePath, "# Hello World");

    const config: FilesConnectorConfig = { paths: [tmpDir] };
    await syncFiles(db, PROJECT_ID, config);

    // Modify the file — we need to change the mtime by writing new content
    // Use a small delay to ensure mtime changes on the filesystem
    const originalStat = Bun.file(filePath);
    writeFileSync(filePath, "# Updated content");
    // Force mtime to be different (some fast filesystems have 1s granularity)
    const { utimesSync } = await import("node:fs");
    const futureTime = new Date(Date.now() + 2000);
    utimesSync(filePath, futureTime, futureTime);

    const result = await syncFiles(db, PROJECT_ID, config);
    expect(result.memories_updated).toBe(1);
    expect(result.memories_created).toBe(0);
  });

  test("extension filter limits which files are synced", async () => {
    writeFileSync(join(tmpDir, "code.ts"), "const x = 1;");
    writeFileSync(join(tmpDir, "notes.md"), "# Notes");
    writeFileSync(join(tmpDir, "data.json"), '{"a":1}');

    const config: FilesConnectorConfig = {
      paths: [tmpDir],
      extensions: [".ts"],
    };
    const result = await syncFiles(db, PROJECT_ID, config);

    expect(result.memories_created).toBe(1);
    expect(countMemories(db)).toBe(1);

    // Verify the synced memory is the .ts file
    const mem = db
      .query("SELECT key FROM memories LIMIT 1")
      .get() as { key: string };
    expect(mem.key).toBe("file:code.ts");
  });
});

// ============================================================================
// syncConnector dispatcher
// ============================================================================

describe("syncConnector", () => {
  test("disabled connector returns early with error message", async () => {
    const db = freshDb();
    const config: ConnectorConfig = {
      type: "files",
      enabled: false,
      config: { paths: [] },
    };
    const result = await syncConnector(db, "proj-1", config);
    expect(result.memories_created).toBe(0);
    expect(result.errors).toContain("Connector is disabled");
    db.close();
  });
});

// ============================================================================
// Extractor routing (auto-detect by extension)
// ============================================================================

describe("extractFile routing", () => {
  test("routes .pdf to PDF extractor (not unsupported)", async () => {
    // extractPdf will fail (missing package or file), but it should
    // route to the PDF extractor — NOT return "Unsupported file extension"
    const result = await extractFile("/tmp/nonexistent-test-file.pdf");
    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    const meta = result.metadata as Record<string, string>;
    // The error should be about the PDF extractor failing, NOT unsupported extension
    expect(meta["error_detail"] ?? "").not.toContain("Unsupported file extension");
  });

  test("routes .png to OCR extractor (not unsupported)", async () => {
    const result = await extractFile("/tmp/nonexistent-test-file.png");
    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    const meta = result.metadata as Record<string, string>;
    expect(meta["error_detail"] ?? "").not.toContain("Unsupported file extension");
  });

  test("routes .mp3 to audio extractor (not unsupported)", async () => {
    const result = await extractFile("/tmp/nonexistent-test-file.mp3");
    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    const meta = result.metadata as Record<string, string>;
    expect(meta["error_detail"] ?? "").not.toContain("Unsupported file extension");
  });

  test("unsupported extension returns empty result with error_detail", async () => {
    const result = await extractFile("/tmp/test.xyz");
    expect(result.text).toBe("");
    expect(result.confidence).toBe(0);
    const meta = result.metadata as Record<string, string>;
    expect(meta["error_detail"]).toContain("Unsupported file extension");
  });
});

// ============================================================================
// Categorizer batch tests (integration with connectors context)
// ============================================================================

describe("categorizeMemoryBatch for connector-ingested memories", () => {
  test("mixed memories each get correct vector category", async () => {
    const memories = [
      { key: "user-role", value: "backend engineer", category: "fact" },
      { key: "preferred-editor", value: "neovim", category: "preference" },
      { key: "meeting-standup", value: "daily at 9am", category: "knowledge" },
      { key: "agent-workflow", value: "run tests first", category: "procedural" },
    ];
    const categories = await categorizeMemoryBatch(memories);
    expect(categories[0]).toBe("personal");
    expect(categories[1]).toBe("preferences");
    expect(categories[2]).toBe("events");
    expect(categories[3]).toBe("assistant");

    // Each category maps to a valid vector tag
    for (const cat of categories) {
      expect(vectorTag(cat as VectorCategory)).toMatch(/^vector:/);
    }
  });

  test("empty batch returns empty result", async () => {
    const categories = await categorizeMemoryBatch([]);
    expect(categories).toEqual([]);
  });
});
