import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export function getDbPath(): string {
  if (process.env["MEMENTOS_DB_PATH"]) {
    return process.env["MEMENTOS_DB_PATH"];
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

  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  return join(home, ".mementos", "mementos.db");
}

function ensureDir(filePath: string): void {
  if (isInMemoryDb(filePath)) return;
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Migrations
// ============================================================================

const MIGRATIONS = [
  // Migration 1: Core schema
  `
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
    category TEXT NOT NULL DEFAULT 'knowledge' CHECK(category IN ('preference', 'fact', 'knowledge', 'history')),
    scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('global', 'shared', 'private')),
    summary TEXT,
    tags TEXT DEFAULT '[]',
    importance INTEGER NOT NULL DEFAULT 5 CHECK(importance >= 1 AND importance <= 10),
    source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('user', 'agent', 'system', 'auto', 'imported')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'expired')),
    pinned INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    session_id TEXT,
    metadata TEXT DEFAULT '{}',
    access_count INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
  CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
  CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
  CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
  CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);
  CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO _migrations (id) VALUES (1);
  `,

  // Migration 2: Memory versions table for diff tracking
  `
  CREATE TABLE IF NOT EXISTS memory_versions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    value TEXT NOT NULL,
    importance INTEGER NOT NULL,
    scope TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(memory_id, version)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id);
  CREATE INDEX IF NOT EXISTS idx_memory_versions_version ON memory_versions(memory_id, version);

  INSERT OR IGNORE INTO _migrations (id) VALUES (2);
  `,

  // Migration 3: FTS5 full-text search index on memories
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    key, value, summary,
    content='memories',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, key, value, summary) VALUES (new.rowid, new.key, new.value, new.summary);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, key, value, summary) VALUES('delete', old.rowid, old.key, old.value, old.summary);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, key, value, summary) VALUES('delete', old.rowid, old.key, old.value, old.summary);
    INSERT INTO memories_fts(rowid, key, value, summary) VALUES (new.rowid, new.key, new.value, new.summary);
  END;

  INSERT INTO memories_fts(memories_fts) VALUES('rebuild');

  INSERT OR IGNORE INTO _migrations (id) VALUES (3);
  `,

  // Migration 4: Search history table
  `
  CREATE TABLE IF NOT EXISTS search_history (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT,
    project_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_search_history_query ON search_history(query);
  CREATE INDEX IF NOT EXISTS idx_search_history_created ON search_history(created_at);

  INSERT OR IGNORE INTO _migrations (id) VALUES (4);
  `,

  // Migration 5: Knowledge graph tables (entities, relations, entity_memories)
  `
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('person','project','tool','concept','file','api','pattern','organization')),
    description TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    project_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_unique_name_type_project
    ON entities(name, type, COALESCE(project_id, ''));
  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
  CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id);

  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('uses','knows','depends_on','created_by','related_to','contradicts','part_of','implements')),
    weight REAL NOT NULL DEFAULT 1.0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_entity_id, target_entity_id, relation_type),
    FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);

  CREATE TABLE IF NOT EXISTS entity_memories (
    entity_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'context' CHECK (role IN ('subject','object','context')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (entity_id, memory_id),
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_entity_memories_memory ON entity_memories(memory_id);

  INSERT OR IGNORE INTO _migrations (id) VALUES (5);
  `,

  // Migration 6: active_project_id on agents for agent→project binding (Option D)
  `
  ALTER TABLE agents ADD COLUMN active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_agents_active_project ON agents(active_project_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (6);
  `,

  // Migration 7: session_id on agents for conflict detection (brutus standardization)
  `
  ALTER TABLE agents ADD COLUMN session_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (7);
  `,

  // Migration 8: resource_locks table for concurrent multi-agent coordination
  `
  CREATE TABLE IF NOT EXISTS resource_locks (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('project', 'memory', 'entity', 'agent', 'connector')),
    resource_id TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    lock_type TEXT NOT NULL DEFAULT 'exclusive' CHECK(lock_type IN ('advisory', 'exclusive')),
    locked_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_locks_exclusive
    ON resource_locks(resource_type, resource_id)
    WHERE lock_type = 'exclusive';
  CREATE INDEX IF NOT EXISTS idx_resource_locks_agent ON resource_locks(agent_id);
  CREATE INDEX IF NOT EXISTS idx_resource_locks_expires ON resource_locks(expires_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (8);
  `,

  // Migration 9: recall_count — track how many times each memory is retrieved.
  // Auto-promotes importance when a memory is recalled frequently (borrowed from nuggets).
  `
  ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_memories_recall_count ON memories(recall_count DESC);
  INSERT OR IGNORE INTO _migrations (id) VALUES (9);
  `,

  // Migration 11: synthesis_events — analytics table for memory access patterns.
  // Used by ALMA synthesizer to understand which memories are useful vs stale.
  `
  CREATE TABLE IF NOT EXISTS synthesis_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK(event_type IN ('recalled','searched','saved','updated','deleted','injected')),
    memory_id TEXT,
    agent_id TEXT,
    project_id TEXT,
    session_id TEXT,
    query TEXT,
    importance_at_time INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_synthesis_events_memory ON synthesis_events(memory_id);
  CREATE INDEX IF NOT EXISTS idx_synthesis_events_project ON synthesis_events(project_id);
  CREATE INDEX IF NOT EXISTS idx_synthesis_events_type ON synthesis_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_synthesis_events_created ON synthesis_events(created_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (11);
  `,

  // Migration 12: synthesis_proposals, synthesis_history, synthesis_metrics.
  // The full ALMA meta-agent persistence layer.
  `
  CREATE TABLE IF NOT EXISTS synthesis_runs (
    id TEXT PRIMARY KEY,
    triggered_by TEXT NOT NULL DEFAULT 'manual' CHECK(triggered_by IN ('scheduler','manual','threshold','hook')),
    project_id TEXT,
    agent_id TEXT,
    corpus_size INTEGER NOT NULL DEFAULT 0,
    proposals_generated INTEGER NOT NULL DEFAULT 0,
    proposals_accepted INTEGER NOT NULL DEFAULT 0,
    proposals_rejected INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','rolled_back')),
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_synthesis_runs_project ON synthesis_runs(project_id);
  CREATE INDEX IF NOT EXISTS idx_synthesis_runs_status ON synthesis_runs(status);
  CREATE INDEX IF NOT EXISTS idx_synthesis_runs_started ON synthesis_runs(started_at);

  CREATE TABLE IF NOT EXISTS synthesis_proposals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES synthesis_runs(id) ON DELETE CASCADE,
    proposal_type TEXT NOT NULL CHECK(proposal_type IN ('merge','archive','promote','update_value','add_tag','remove_duplicate')),
    memory_ids TEXT NOT NULL DEFAULT '[]',
    target_memory_id TEXT,
    proposed_changes TEXT NOT NULL DEFAULT '{}',
    reasoning TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','rolled_back')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    executed_at TEXT,
    rollback_data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_synthesis_proposals_run ON synthesis_proposals(run_id);
  CREATE INDEX IF NOT EXISTS idx_synthesis_proposals_status ON synthesis_proposals(status);
  CREATE INDEX IF NOT EXISTS idx_synthesis_proposals_type ON synthesis_proposals(proposal_type);

  CREATE TABLE IF NOT EXISTS synthesis_metrics (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES synthesis_runs(id) ON DELETE CASCADE,
    metric_type TEXT NOT NULL,
    value REAL NOT NULL,
    baseline REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_synthesis_metrics_run ON synthesis_metrics(run_id);
  CREATE INDEX IF NOT EXISTS idx_synthesis_metrics_type ON synthesis_metrics(metric_type);

  INSERT OR IGNORE INTO _migrations (id) VALUES (12);
  `,

  // Migration 10: webhook_hooks — persist HTTP-based hook registrations across restarts.
  // Loaded at server/MCP startup and registered in the in-memory HookRegistry.
  `
  CREATE TABLE IF NOT EXISTS webhook_hooks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    handler_url TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 50,
    blocking INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT,
    project_id TEXT,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    invocation_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_hooks_type ON webhook_hooks(type);
  CREATE INDEX IF NOT EXISTS idx_webhook_hooks_enabled ON webhook_hooks(enabled);
  INSERT OR IGNORE INTO _migrations (id) VALUES (10);
  `,

  // Migration 13: session_memory_jobs — async queue for session transcript ingestion.
  // When a session ends, post the transcript here. Background processor extracts memories.
  `
CREATE TABLE IF NOT EXISTS session_memory_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  project_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('claude-code','codex','manual','open-sessions')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  transcript TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  memories_extracted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_status ON session_memory_jobs(status);
CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_agent ON session_memory_jobs(agent_id);
CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_project ON session_memory_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_session ON session_memory_jobs(session_id);
INSERT OR IGNORE INTO _migrations (id) VALUES (13);
`,
];

// ============================================================================
// Database singleton
// ============================================================================

let _db: Database | null = null;

export function getDatabase(dbPath?: string): Database {
  if (_db) return _db;

  const path = dbPath || getDbPath();
  ensureDir(path);

  _db = new Database(path, { create: true });

  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 5000");
  _db.run("PRAGMA foreign_keys = ON");

  runMigrations(_db);

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
      } catch {
        // Partial failure handled gracefully
      }
    }
  } catch {
    for (const migration of MIGRATIONS) {
      try {
        db.exec(migration);
      } catch {
        // Partial failure handled gracefully
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

export function resolvePartialId(
  db: Database,
  table: string,
  partialId: string
): string | null {
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
