// SQLite migration SQL strings — extracted from database.ts for readability.
// Each entry is executed in order; the _migrations table tracks which have run.

export const MIGRATIONS: string[] = [
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

  // Migration 14: add 'file' as first-class resource_type for resource_locks
  // SQLite can't ALTER CHECK constraints; rebuild the table.
  `
ALTER TABLE resource_locks RENAME TO resource_locks_old;
CREATE TABLE resource_locks (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('project', 'memory', 'entity', 'agent', 'connector', 'file')),
  resource_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  lock_type TEXT NOT NULL DEFAULT 'exclusive' CHECK(lock_type IN ('advisory', 'exclusive')),
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
INSERT INTO resource_locks SELECT * FROM resource_locks_old;
DROP TABLE resource_locks_old;
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_locks_exclusive
  ON resource_locks(resource_type, resource_id)
  WHERE lock_type = 'exclusive';
CREATE INDEX IF NOT EXISTS idx_resource_locks_agent ON resource_locks(agent_id);
CREATE INDEX IF NOT EXISTS idx_resource_locks_expires ON resource_locks(expires_at);
INSERT OR IGNORE INTO _migrations (id) VALUES (14);
`,

  // Migration 15: machine registry
  `
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_machines_hostname ON machines(hostname);
ALTER TABLE memories ADD COLUMN machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_memories_machine ON memories(machine_id);
INSERT OR IGNORE INTO _migrations (id) VALUES (15);
`,

  // Migration 16: memory flag column for needs-review/outdated/verify annotations
  `
ALTER TABLE memories ADD COLUMN flag TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_flag ON memories(flag);
INSERT OR IGNORE INTO _migrations (id) VALUES (16);
`,

  // Migration 17: memory_embeddings table for semantic search
  `
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'tfidf-512',
  dimensions INTEGER NOT NULL DEFAULT 512,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model);
INSERT OR IGNORE INTO _migrations (id) VALUES (17);
`,

  // Migration 18: bi-temporal columns for fact evolution tracking
  // valid_from: when this fact became true in reality
  // valid_until: when this fact stopped being true (null = still valid)
  // ingested_at: when this fact was recorded in the system
  `
ALTER TABLE memories ADD COLUMN valid_from TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN valid_until TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN ingested_at TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(valid_from);
CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories(valid_until);
UPDATE memories SET valid_from = created_at, ingested_at = created_at WHERE valid_from IS NULL;
INSERT OR IGNORE INTO _migrations (id) VALUES (18);
`,

  // Migration 19: add 'working' scope for transient session-scoped memories.
  // SQLite can't ALTER CHECK constraints; rebuild the table.
  // Must disable FKs during table rebuild to avoid constraint violations.
  `
PRAGMA foreign_keys = OFF;
ALTER TABLE memories RENAME TO memories_old;
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'knowledge' CHECK(category IN ('preference', 'fact', 'knowledge', 'history')),
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
  machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
  flag TEXT,
  metadata TEXT DEFAULT '{}',
  access_count INTEGER NOT NULL DEFAULT 0,
  recall_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  valid_from TEXT DEFAULT NULL,
  valid_until TEXT DEFAULT NULL,
  ingested_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  accessed_at TEXT
);
INSERT INTO memories SELECT * FROM memories_old;
DROP TABLE memories_old;

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
CREATE INDEX IF NOT EXISTS idx_memories_machine ON memories(machine_id);
CREATE INDEX IF NOT EXISTS idx_memories_flag ON memories(flag);
CREATE INDEX IF NOT EXISTS idx_memories_recall_count ON memories(recall_count DESC);
CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(valid_from);
CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories(valid_until);

INSERT INTO memories_fts(memories_fts) VALUES('rebuild');

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

PRAGMA foreign_keys = ON;
INSERT OR IGNORE INTO _migrations (id) VALUES (19);
`,

  // Migration 20: add 'procedural' and 'resource' categories + 'code' content_type column.
  // Rebuild table again (only way to change CHECK constraints in SQLite).
  `
PRAGMA foreign_keys = OFF;
ALTER TABLE memories RENAME TO memories_old;
CREATE TABLE memories (
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
  machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
  flag TEXT,
  content_type TEXT NOT NULL DEFAULT 'text' CHECK(content_type IN ('text', 'code', 'image', 'resource')),
  metadata TEXT DEFAULT '{}',
  access_count INTEGER NOT NULL DEFAULT 0,
  recall_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  valid_from TEXT DEFAULT NULL,
  valid_until TEXT DEFAULT NULL,
  ingested_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  accessed_at TEXT
);
INSERT INTO memories (id, key, value, category, scope, summary, tags, importance, source, status, pinned, agent_id, project_id, session_id, machine_id, flag, metadata, access_count, recall_count, version, expires_at, valid_from, valid_until, ingested_at, created_at, updated_at, accessed_at)
  SELECT id, key, value, category, scope, summary, tags, importance, source, status, pinned, agent_id, project_id, session_id, machine_id, flag, metadata, access_count, recall_count, version, expires_at, valid_from, valid_until, ingested_at, created_at, updated_at, accessed_at FROM memories_old;
DROP TABLE memories_old;

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
CREATE INDEX IF NOT EXISTS idx_memories_machine ON memories(machine_id);
CREATE INDEX IF NOT EXISTS idx_memories_flag ON memories(flag);
CREATE INDEX IF NOT EXISTS idx_memories_recall_count ON memories(recall_count DESC);
CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(valid_from);
CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories(valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_content_type ON memories(content_type);

INSERT INTO memories_fts(memories_fts) VALUES('rebuild');

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

PRAGMA foreign_keys = ON;
INSERT OR IGNORE INTO _migrations (id) VALUES (20);
`,

  // Migration 21: extend relation_type CHECK with temporal and causal types
  `
PRAGMA foreign_keys = OFF;
ALTER TABLE relations RENAME TO relations_old;
CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('uses','knows','depends_on','created_by','related_to','contradicts','part_of','implements','happened_before','happened_after','caused_by','resulted_in','supersedes','version_of')),
  weight REAL NOT NULL DEFAULT 1.0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_entity_id, target_entity_id, relation_type),
  FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
INSERT INTO relations SELECT * FROM relations_old;
DROP TABLE relations_old;
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
PRAGMA foreign_keys = ON;
INSERT OR IGNORE INTO _migrations (id) VALUES (21);
`,

  // Migration 22: immutable audit log for all memory operations
  `
CREATE TABLE IF NOT EXISTS memory_audit_log (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  memory_key TEXT,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete','archive','restore','read')),
  agent_id TEXT,
  old_value_hash TEXT,
  new_value_hash TEXT,
  changes TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_memory ON memory_audit_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_operation ON memory_audit_log(operation);
CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON memory_audit_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON memory_audit_log(created_at);

CREATE TRIGGER IF NOT EXISTS audit_memory_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_audit_log (id, memory_id, memory_key, operation, agent_id, new_value_hash, created_at)
  VALUES (hex(randomblob(4)), new.id, new.key, 'create', new.agent_id, hex(randomblob(16)), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS audit_memory_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_audit_log (id, memory_id, memory_key, operation, agent_id, old_value_hash, new_value_hash, changes, created_at)
  VALUES (hex(randomblob(4)), new.id, new.key, 'update', new.agent_id, hex(randomblob(16)), hex(randomblob(16)),
    json_object('version_from', old.version, 'version_to', new.version, 'importance_from', old.importance, 'importance_to', new.importance),
    datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS audit_memory_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memory_audit_log (id, memory_id, memory_key, operation, agent_id, old_value_hash, created_at)
  VALUES (hex(randomblob(4)), old.id, old.key, 'delete', old.agent_id, hex(randomblob(16)), datetime('now'));
END;

INSERT OR IGNORE INTO _migrations (id) VALUES (22);
`,

  // Migration 23: namespace column for fine-grained scoping + provenance columns
  `
ALTER TABLE memories ADD COLUMN namespace TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN created_by_agent TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN updated_by_agent TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_created_by ON memories(created_by_agent);
INSERT OR IGNORE INTO _migrations (id) VALUES (23);
`,

  // Migration 24: trust_score column for memory poisoning detection
  `
ALTER TABLE memories ADD COLUMN trust_score REAL NOT NULL DEFAULT 1.0;
CREATE INDEX IF NOT EXISTS idx_memories_trust_score ON memories(trust_score);
INSERT OR IGNORE INTO _migrations (id) VALUES (24);
`,

  // Migration 25: memory_ratings table for usefulness feedback
  `
CREATE TABLE IF NOT EXISTS memory_ratings (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  agent_id TEXT,
  useful INTEGER NOT NULL DEFAULT 1,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_ratings_memory ON memory_ratings(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_ratings_agent ON memory_ratings(agent_id);
INSERT OR IGNORE INTO _migrations (id) VALUES (25);
`,

  // Migration 26: memory ACLs for fine-grained access control
  `
CREATE TABLE IF NOT EXISTS memory_acl (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  key_pattern TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'readwrite' CHECK(permission IN ('read', 'readwrite', 'admin')),
  project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_acl_agent ON memory_acl(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_acl_project ON memory_acl(project_id);
INSERT OR IGNORE INTO _migrations (id) VALUES (26);
`,

  // Migration 27: vector_clock column for multi-agent consistency (version vectors)
  `
ALTER TABLE memories ADD COLUMN vector_clock TEXT DEFAULT '{}';
INSERT OR IGNORE INTO _migrations (id) VALUES (27);
`,

  // Migration 28: memory_subscriptions table for agent notifications
  `
CREATE TABLE IF NOT EXISTS memory_subscriptions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  key_pattern TEXT,
  tag_pattern TEXT,
  scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_subs_agent ON memory_subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_subs_key ON memory_subscriptions(key_pattern);
INSERT OR IGNORE INTO _migrations (id) VALUES (28);
`,

  // Migration 29: fix FK references broken by table rename in migrations 19/20.
  // When memories was renamed to memories_old and back, SQLite rewrote FKs in
  // memory_tags, entity_memories, and memory_embeddings to point to memories_old.
  `
PRAGMA foreign_keys = OFF;

-- Fix memory_tags FK if broken
CREATE TABLE IF NOT EXISTS _mt_fix AS SELECT * FROM memory_tags;
DROP TABLE IF EXISTS memory_tags;
CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
INSERT OR IGNORE INTO memory_tags SELECT * FROM _mt_fix;
DROP TABLE _mt_fix;
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);

-- Fix entity_memories FK if broken
CREATE TABLE IF NOT EXISTS _em_fix AS SELECT * FROM entity_memories;
DROP TABLE IF EXISTS entity_memories;
CREATE TABLE entity_memories (
  entity_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'context' CHECK (role IN ('subject','object','context')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_id, memory_id),
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO entity_memories SELECT * FROM _em_fix;
DROP TABLE _em_fix;
CREATE INDEX IF NOT EXISTS idx_entity_memories_memory ON entity_memories(memory_id);

-- Fix memory_embeddings FK if broken
CREATE TABLE IF NOT EXISTS _me_fix AS SELECT * FROM memory_embeddings;
DROP TABLE IF EXISTS memory_embeddings;
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'tfidf-512',
  dimensions INTEGER NOT NULL DEFAULT 512,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO memory_embeddings SELECT * FROM _me_fix;
DROP TABLE _me_fix;
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model);

PRAGMA foreign_keys = ON;
INSERT OR IGNORE INTO _migrations (id) VALUES (29);
`,
  // Migration 30: Add when_to_use column to memories and memory_versions
  `
ALTER TABLE memories ADD COLUMN when_to_use TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_when_to_use ON memories(when_to_use) WHERE when_to_use IS NOT NULL;
ALTER TABLE memory_versions ADD COLUMN when_to_use TEXT;
INSERT OR IGNORE INTO _migrations (id) VALUES (30);
`,
  // Migration 31: Add tool_events table for structured tool call tracking
  `
CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  action TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  error_type TEXT CHECK(error_type IS NULL OR error_type IN ('timeout', 'permission', 'not_found', 'syntax', 'rate_limit', 'other')),
  error_message TEXT,
  tokens_used INTEGER,
  latency_ms INTEGER,
  context TEXT,
  lesson TEXT,
  when_to_use TEXT,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  session_id TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_events_tool_name ON tool_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_events_agent ON tool_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_project ON tool_events(project_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_success ON tool_events(success);
CREATE INDEX IF NOT EXISTS idx_tool_events_created ON tool_events(created_at);
INSERT OR IGNORE INTO _migrations (id) VALUES (31);
`,
  // Migration 32: Memory chains / procedural sequences
  `
ALTER TABLE memories ADD COLUMN sequence_group TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN sequence_order INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_sequence_group ON memories(sequence_group) WHERE sequence_group IS NOT NULL;
INSERT OR IGNORE INTO _migrations (id) VALUES (32);
`,
  // Migration 34: tasks — granular task management for agent coordination.
  `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical', 'high', 'medium', 'low')),
  tags TEXT NOT NULL DEFAULT '[]',
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  session_id TEXT,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
  due_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_agent ON task_comments(agent_id);
INSERT OR IGNORE INTO _migrations (id) VALUES (34);
`,
];
