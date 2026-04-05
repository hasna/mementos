import { SqliteAdapter as Database } from "@hasna/cloud";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MIGRATIONS } from "./migrations.js";

// ============================================================================
// Path resolution
// ============================================================================

function isInMemoryDb(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

function findNearestMementosDb(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".mementos", "mementos.db");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function migrateGlobalDir(): void {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const newDir = join(home, ".hasna", "mementos");
  const oldDir = join(home, ".mementos");

  if (!existsSync(newDir) && existsSync(oldDir)) {
    mkdirSync(join(home, ".hasna"), { recursive: true });
    cpSync(oldDir, newDir, { recursive: true });
  }
}

export function getDbPath(): string {
  const envPath = process.env["HASNA_MEMENTOS_DB_PATH"] ?? process.env["MEMENTOS_DB_PATH"];
  if (envPath) {
    return envPath;
  }

  const cwd = process.cwd();
  const nearest = findNearestMementosDb(cwd);
  if (nearest) return nearest;

  if (process.env["MEMENTOS_DB_SCOPE"] === "project") {
    const gitRoot = findGitRoot(cwd);
    if (gitRoot) {
      return join(gitRoot, ".mementos", "mementos.db");
    }
  }

  migrateGlobalDir();
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  return join(home, ".hasna", "mementos", "mementos.db");
}

function ensureDir(filePath: string): void {
  if (isInMemoryDb(filePath)) return;
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Database singleton
// ============================================================================

let _db: Database | null = null;
let _dbPath: string | null = null;

export function getDatabase(dbPath?: string): Database {
  const path = dbPath || getDbPath();

  if (_db) {
    if (_dbPath === path) return _db;
    // Path changed — close old instance and reopen
    _db.close();
    _db = null;
  }

  _dbPath = path;
  ensureDir(path);

  _db = new Database(path, { create: true });

  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 5000");
  _db.run("PRAGMA foreign_keys = ON");
  _db.run("PRAGMA wal_autocheckpoint = 100"); // checkpoint every 100 pages (~400KB)

  runMigrations(_db);

  _db.run(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  return _db;
}

function runMigrations(db: Database): void {
  try {
    const result = db
      .query("SELECT MAX(id) as max_id FROM _migrations")
      .get() as { max_id: number | null } | null;
    const currentLevel = result?.max_id ?? 0;

    for (let i = currentLevel; i < MIGRATIONS.length; i++) {
      try {
        db.exec(MIGRATIONS[i]!);
      } catch (e) {
        console.warn(`[mementos] Migration ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch {
    for (let i = 0; i < MIGRATIONS.length; i++) {
      try {
        db.exec(MIGRATIONS[i]!);
      } catch (e) {
        console.warn(`[mementos] Migration ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

// ============================================================================
// Utilities
// ============================================================================

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function resetDatabase(): void {
  _db = null;
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function shortUuid(): string {
  return crypto.randomUUID().slice(0, 8);
}

const ALLOWED_TABLES = new Set([
  "memories", "agents", "entities", "projects", "relations",
  "memory_audit_log", "locks", "sessions", "session_memory_jobs",
  "synthesis_runs", "synthesis_proposals", "tool_events",
  "webhook_hooks",
]);

export function resolvePartialId(
  db: Database,
  table: string,
  partialId: string
): string | null {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  if (partialId.length >= 36) {
    const row = db
      .query(`SELECT id FROM ${table} WHERE id = ?`)
      .get(partialId) as { id: string } | null;
    return row?.id ?? null;
  }

  const rows = db
    .query(`SELECT id FROM ${table} WHERE id LIKE ?`)
    .all(`${partialId}%`) as { id: string }[];
  if (rows.length === 1) {
    return rows[0]!.id;
  }
  return null;
}
