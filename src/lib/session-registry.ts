/**
 * Session Registry — shared registry of active Claude Code sessions.
 * Designed to be reusable across the open-* ecosystem (mementos, todos, conversations).
 *
 * Uses a shared SQLite DB at ~/.open-sessions-registry.db.
 * Each MCP server registers on connect, heartbeats, and can query peers.
 * PID identifies the Claude Code process — all MCPs in same session share a PID.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface SessionInfo {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  agent_name: string | null;
  project_name: string | null;
  tty: string | null;
  mcp_server: string;
  metadata: Record<string, unknown>;
  registered_at: string;
  last_seen_at: string;
}

export interface SessionFilter {
  project_name?: string;
  git_root?: string;
  mcp_server?: string;
  agent_name?: string;
  exclude_pid?: number;
}

// ============================================================================
// Database
// ============================================================================

const DB_PATH = join(
  process.env["HOME"] || process.env["USERPROFILE"] || "~",
  ".open-sessions-registry.db"
);

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH, { create: true });
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 3000");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      agent_name TEXT,
      project_name TEXT,
      tty TEXT,
      mcp_server TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_pid_mcp
      ON sessions(pid, mcp_server);
    CREATE INDEX IF NOT EXISTS idx_sessions_project
      ON sessions(project_name);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent
      ON sessions(agent_name);
    CREATE INDEX IF NOT EXISTS idx_sessions_git_root
      ON sessions(git_root);
  `);

  return _db;
}

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function now(): string {
  return new Date().toISOString();
}

function parseRow(row: Record<string, unknown>): SessionInfo {
  return {
    id: row["id"] as string,
    pid: row["pid"] as number,
    cwd: row["cwd"] as string,
    git_root: (row["git_root"] as string) || null,
    agent_name: (row["agent_name"] as string) || null,
    project_name: (row["project_name"] as string) || null,
    tty: (row["tty"] as string) || null,
    mcp_server: row["mcp_server"] as string,
    metadata: JSON.parse((row["metadata"] as string) || "{}"),
    registered_at: row["registered_at"] as string,
    last_seen_at: row["last_seen_at"] as string,
  };
}

// Check if a process is alive (signal 0 doesn't kill, just checks)
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Registry API
// ============================================================================

export function registerSession(opts: {
  mcp_server: string;
  agent_name?: string;
  project_name?: string;
  cwd?: string;
  git_root?: string;
  tty?: string;
  metadata?: Record<string, unknown>;
}): SessionInfo {
  const db = getDb();
  const pid = process.pid;
  const cwd = opts.cwd || process.cwd();
  const id = generateId();
  const timestamp = now();

  // Upsert — same PID + MCP server = same session
  const existing = db.query(
    "SELECT id FROM sessions WHERE pid = ? AND mcp_server = ?"
  ).get(pid, opts.mcp_server) as { id: string } | null;

  if (existing) {
    db.run(
      `UPDATE sessions SET agent_name = ?, project_name = ?, cwd = ?,
       git_root = ?, tty = ?, metadata = ?, last_seen_at = ? WHERE id = ?`,
      [
        opts.agent_name || null,
        opts.project_name || null,
        cwd,
        opts.git_root || null,
        opts.tty || null,
        JSON.stringify(opts.metadata || {}),
        timestamp,
        existing.id,
      ]
    );
    return getSession(existing.id)!;
  }

  db.run(
    `INSERT INTO sessions (id, pid, cwd, git_root, agent_name, project_name, tty, mcp_server, metadata, registered_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, pid, cwd,
      opts.git_root || null,
      opts.agent_name || null,
      opts.project_name || null,
      opts.tty || null,
      opts.mcp_server,
      JSON.stringify(opts.metadata || {}),
      timestamp, timestamp,
    ]
  );

  return getSession(id)!;
}

export function heartbeatSession(id: string): void {
  const db = getDb();
  db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [now(), id]);
}

export function unregisterSession(id: string): void {
  const db = getDb();
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
}

export function getSession(id: string): SessionInfo | null {
  const db = getDb();
  const row = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? parseRow(row) : null;
}

export function listSessions(filter?: SessionFilter): SessionInfo[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter?.project_name) {
    conditions.push("project_name = ?");
    params.push(filter.project_name);
  }
  if (filter?.git_root) {
    conditions.push("git_root = ?");
    params.push(filter.git_root);
  }
  if (filter?.mcp_server) {
    conditions.push("mcp_server = ?");
    params.push(filter.mcp_server);
  }
  if (filter?.agent_name) {
    conditions.push("agent_name = ?");
    params.push(filter.agent_name);
  }
  if (filter?.exclude_pid) {
    conditions.push("pid != ?");
    params.push(filter.exclude_pid);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.query(
    `SELECT * FROM sessions ${where} ORDER BY last_seen_at DESC`
  ).all(...params) as Record<string, unknown>[];

  // Filter out dead sessions
  return rows.map(parseRow).filter(s => {
    if (isProcessAlive(s.pid)) return true;
    // Clean up dead session
    db.run("DELETE FROM sessions WHERE id = ?", [s.id]);
    return false;
  });
}

export function getSessionByAgent(agentName: string): SessionInfo | null {
  const sessions = listSessions({ agent_name: agentName });
  return sessions[0] || null;
}

export function getSessionsByProject(projectName: string): SessionInfo[] {
  return listSessions({ project_name: projectName });
}

export function cleanStaleSessions(): number {
  const db = getDb();
  const rows = db.query("SELECT id, pid FROM sessions").all() as { id: string; pid: number }[];
  let cleaned = 0;
  for (const row of rows) {
    if (!isProcessAlive(row.pid)) {
      db.run("DELETE FROM sessions WHERE id = ?", [row.id]);
      cleaned++;
    }
  }
  return cleaned;
}

export function updateSessionAgent(mcpServer: string, agentName: string): void {
  const db = getDb();
  const pid = process.pid;
  db.run(
    "UPDATE sessions SET agent_name = ?, last_seen_at = ? WHERE pid = ? AND mcp_server = ?",
    [agentName, now(), pid, mcpServer]
  );
}

// ============================================================================
// Cleanup
// ============================================================================

export function closeRegistry(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
