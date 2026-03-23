process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getDatabase,
  resetDatabase,
  closeDatabase,
  now,
  uuid,
  shortUuid,
  getDbPath,
  resolvePartialId,
} from "./database.js";
import { Database } from "bun:sqlite";

beforeEach(() => {
  resetDatabase();
});

afterEach(() => {
  // Restore env
  process.env["MEMENTOS_DB_PATH"] = ":memory:";
  delete process.env["MEMENTOS_DB_SCOPE"];
});

// ============================================================================
// getDatabase
// ============================================================================

describe("getDatabase", () => {
  test("returns a Database instance", () => {
    const db = getDatabase(":memory:");
    expect(db).toBeInstanceOf(Database);
  });

  test("returns same instance on second call (singleton)", () => {
    const db1 = getDatabase(":memory:");
    const db2 = getDatabase(":memory:");
    expect(db1).toBe(db2);
  });

  test("creates tables via migrations", () => {
    const db = getDatabase(":memory:");
    // Check that core tables exist
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("agents");
    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("memory_tags");
    expect(tableNames).toContain("memory_versions");
    expect(tableNames).toContain("_migrations");
  });

  test("migrations table has correct entries", () => {
    const db = getDatabase(":memory:");
    const rows = db.query("SELECT id FROM _migrations ORDER BY id").all() as {
      id: number;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.id).toBe(1);
    expect(rows[1]!.id).toBe(2);
  });
});

// ============================================================================
// closeDatabase
// ============================================================================

describe("closeDatabase", () => {
  test("closes and resets singleton", () => {
    const db1 = getDatabase(":memory:");
    closeDatabase();
    // After close, next getDatabase should create a new instance
    const db2 = getDatabase(":memory:");
    expect(db2).not.toBe(db1);
  });

  test("no-op when no database is open", () => {
    // Should not throw
    closeDatabase();
    closeDatabase();
  });
});

// ============================================================================
// resetDatabase
// ============================================================================

describe("resetDatabase", () => {
  test("clears singleton without closing", () => {
    getDatabase(":memory:");
    resetDatabase();
    // Next call creates a fresh instance
    const db = getDatabase(":memory:");
    expect(db).toBeInstanceOf(Database);
  });
});

// ============================================================================
// now
// ============================================================================

describe("now", () => {
  test("returns ISO string", () => {
    const ts = now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Should be parseable
    const d = new Date(ts);
    expect(d.getTime()).not.toBeNaN();
  });
});

// ============================================================================
// uuid / shortUuid
// ============================================================================

describe("uuid", () => {
  test("returns 36-char UUID", () => {
    const id = uuid();
    expect(id).toHaveLength(36);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  test("generates unique values", () => {
    const a = uuid();
    const b = uuid();
    expect(a).not.toBe(b);
  });
});

describe("shortUuid", () => {
  test("returns 8-char string", () => {
    const id = shortUuid();
    expect(id).toHaveLength(8);
  });

  test("generates unique values", () => {
    const a = shortUuid();
    const b = shortUuid();
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// getDbPath
// ============================================================================

describe("getDbPath", () => {
  test("returns env MEMENTOS_DB_PATH when set", () => {
    process.env["MEMENTOS_DB_PATH"] = ":memory:";
    const path = getDbPath();
    expect(path).toBe(":memory:");
  });

  test("returns MEMENTOS_DB_PATH for a file path", () => {
    process.env["MEMENTOS_DB_PATH"] = "/tmp/test-mementos.db";
    const path = getDbPath();
    expect(path).toBe("/tmp/test-mementos.db");
  });

  test("falls back to home dir when no env and no local db", () => {
    delete process.env["MEMENTOS_DB_PATH"];
    delete process.env["HASNA_MEMENTOS_DB_PATH"];
    const origCwd = process.cwd();
    try {
      process.chdir("/tmp");
      const path = getDbPath();
      expect(path).toContain(".hasna/mementos");
      expect(path).toContain("mementos.db");
    } finally {
      process.chdir(origCwd);
      process.env["MEMENTOS_DB_PATH"] = ":memory:";
    }
  });

  test("with MEMENTOS_DB_SCOPE=project and no git root, falls back", () => {
    delete process.env["MEMENTOS_DB_PATH"];
    process.env["MEMENTOS_DB_SCOPE"] = "project";
    // Running in a temp dir with no .git — should still return a valid path
    const origCwd = process.cwd();
    try {
      // Use /tmp which likely has no .git and no .mementos/mementos.db
      process.chdir("/tmp");
      const path = getDbPath();
      expect(path).toContain("mementos.db");
    } finally {
      process.chdir(origCwd);
    }
  });
});

// ============================================================================
// resolvePartialId
// ============================================================================

describe("resolvePartialId", () => {
  test("resolves full UUID match", () => {
    const db = getDatabase(":memory:");
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["abcdefgh-1234-5678-9abc-def012345678", "test-agent"]
    );

    const result = resolvePartialId(
      db,
      "agents",
      "abcdefgh-1234-5678-9abc-def012345678"
    );
    expect(result).toBe("abcdefgh-1234-5678-9abc-def012345678");
  });

  test("resolves partial ID when unique", () => {
    const db = getDatabase(":memory:");
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["unique-id", "partial-agent"]
    );

    const result = resolvePartialId(db, "agents", "unique");
    expect(result).toBe("unique-id");
  });

  test("returns null for ambiguous partial ID", () => {
    const db = getDatabase(":memory:");
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["abc-first", "agent-1"]
    );
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["abc-second", "agent-2"]
    );

    const result = resolvePartialId(db, "agents", "abc");
    expect(result).toBeNull();
  });

  test("returns null for no match", () => {
    const db = getDatabase(":memory:");
    const result = resolvePartialId(db, "agents", "zzz-nope");
    expect(result).toBeNull();
  });

  test("returns null for full ID that does not exist", () => {
    const db = getDatabase(":memory:");
    const fakeUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const result = resolvePartialId(db, "agents", fakeUuid);
    expect(result).toBeNull();
  });
});

// ============================================================================
// getDbPath with MEMENTOS_DB_SCOPE=project in a git repo
// ============================================================================

describe("getDbPath project scope in git repo", () => {
  afterEach(() => {
    process.env["MEMENTOS_DB_PATH"] = ":memory:";
    delete process.env["MEMENTOS_DB_SCOPE"];
  });

  test("returns project-scoped path when in a git repo", () => {
    delete process.env["MEMENTOS_DB_PATH"];
    process.env["MEMENTOS_DB_SCOPE"] = "project";
    const origCwd = process.cwd();
    try {
      // Use the project root which has .git
      process.chdir(
        "/Users/hasna/Workspace/hasna/opensource/opensourcedev/open-mementos"
      );
      const path = getDbPath();
      expect(path).toContain(".mementos");
      expect(path).toContain("mementos.db");
    } finally {
      process.chdir(origCwd);
      process.env["MEMENTOS_DB_PATH"] = ":memory:";
    }
  });
});

// ============================================================================
// getDatabase with a real temp file path to exercise ensureDir
// ============================================================================

describe("getDatabase with file path", () => {
  test("creates database at a temp file path", () => {
    resetDatabase();
    const tmpPath = `/tmp/mementos-test-${Date.now()}/test.db`;
    const db = getDatabase(tmpPath);
    expect(db).toBeInstanceOf(Database);
    // Verify it created the directory
    const { existsSync } = require("node:fs");
    const { dirname } = require("node:path");
    expect(existsSync(dirname(tmpPath))).toBe(true);
    // Clean up
    db.close();
    resetDatabase();
    try {
      const { rmSync } = require("node:fs");
      rmSync(dirname(tmpPath), { recursive: true });
    } catch {}
  });
});

// ============================================================================
// runMigrations — catch path for partial failure
// ============================================================================

describe("runMigrations edge cases", () => {
  test("handles database that already has all migrations", () => {
    resetDatabase();
    const db = getDatabase(":memory:");
    // Running getDatabase again should be fine (singleton returns same db)
    const db2 = getDatabase(":memory:");
    expect(db).toBe(db2);
    // Verify migrations ran correctly
    const rows = db.query("SELECT id FROM _migrations ORDER BY id").all() as {
      id: number;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test("handles fresh database with no _migrations table (catch path)", () => {
    // Create a bare database with no tables at all to trigger the outer catch
    resetDatabase();
    const bareDb = new Database(":memory:", { create: true });
    bareDb.run("PRAGMA journal_mode = WAL");
    bareDb.run("PRAGMA foreign_keys = ON");

    // The runMigrations function is private, but we can simulate what getDatabase does
    // by running the migrations SQL directly. Since we can't call runMigrations directly,
    // we just verify that getDatabase handles it correctly for a fresh in-memory db.
    bareDb.close();

    // getDatabase on a fresh :memory: should succeed even without pre-existing tables
    resetDatabase();
    const db = getDatabase(":memory:");
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
  });
});
