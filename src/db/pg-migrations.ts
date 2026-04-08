/**
 * PostgreSQL migrations for open-mementos cloud sync.
 *
 * Equivalent of the SQLite migrations in database.ts, translated for PostgreSQL.
 * Each element is a standalone SQL string that must be executed in order.
 */
export const PG_MIGRATIONS: string[] = [
  // Migration 1: Core schema
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT UNIQUE NOT NULL,
    description TEXT,
    memory_prefix TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    role TEXT DEFAULT 'agent',
    metadata TEXT DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    hostname TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_machines_hostname ON machines(hostname);

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
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    session_id TEXT,
    machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
    flag TEXT,
    content_type TEXT NOT NULL DEFAULT 'text' CHECK(content_type IN ('text', 'code', 'image', 'resource')),
    namespace TEXT DEFAULT NULL,
    created_by_agent TEXT DEFAULT NULL,
    updated_by_agent TEXT DEFAULT NULL,
    trust_score DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    vector_clock TEXT DEFAULT '{}',
    when_to_use TEXT DEFAULT NULL,
    sequence_group TEXT DEFAULT NULL,
    sequence_order INTEGER DEFAULT NULL,
    metadata TEXT DEFAULT '{}',
    access_count INTEGER NOT NULL DEFAULT 0,
    recall_count INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    valid_from TEXT DEFAULT NULL,
    valid_until TEXT DEFAULT NULL,
    ingested_at TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accessed_at TEXT
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
  CREATE INDEX IF NOT EXISTS idx_memories_machine ON memories(machine_id);
  CREATE INDEX IF NOT EXISTS idx_memories_flag ON memories(flag);
  CREATE INDEX IF NOT EXISTS idx_memories_recall_count ON memories(recall_count DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(valid_from);
  CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories(valid_until);
  CREATE INDEX IF NOT EXISTS idx_memories_content_type ON memories(content_type);
  CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
  CREATE INDEX IF NOT EXISTS idx_memories_created_by ON memories(created_by_agent);
  CREATE INDEX IF NOT EXISTS idx_memories_trust_score ON memories(trust_score);
  CREATE INDEX IF NOT EXISTS idx_memories_when_to_use ON memories(when_to_use) WHERE when_to_use IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_memories_sequence_group ON memories(sequence_group) WHERE sequence_group IS NOT NULL;

  CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  INSERT INTO _migrations (id) VALUES (1) ON CONFLICT DO NOTHING;
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
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'active',
    when_to_use TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(memory_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id);
  CREATE INDEX IF NOT EXISTS idx_memory_versions_version ON memory_versions(memory_id, version);

  INSERT INTO _migrations (id) VALUES (2) ON CONFLICT DO NOTHING;
  `,

  // Migration 3: Full-text search (PostgreSQL tsvector approach)
  `
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector;

  CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN(search_vector);

  CREATE OR REPLACE FUNCTION memories_search_vector_update() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('english', COALESCE(NEW.key, '')), 'A') ||
      setweight(to_tsvector('english', COALESCE(NEW.value, '')), 'B') ||
      setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'C');
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS memories_search_vector_trigger ON memories;
  CREATE TRIGGER memories_search_vector_trigger
    BEFORE INSERT OR UPDATE OF key, value, summary ON memories
    FOR EACH ROW EXECUTE FUNCTION memories_search_vector_update();

  -- Backfill existing rows
  UPDATE memories SET search_vector =
    setweight(to_tsvector('english', COALESCE(key, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(value, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(summary, '')), 'C')
  WHERE search_vector IS NULL;

  INSERT INTO _migrations (id) VALUES (3) ON CONFLICT DO NOTHING;
  `,

  // Migration 4: Search history table
  `
  CREATE TABLE IF NOT EXISTS search_history (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT,
    project_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_search_history_query ON search_history(query);
  CREATE INDEX IF NOT EXISTS idx_search_history_created ON search_history(created_at);

  INSERT INTO _migrations (id) VALUES (4) ON CONFLICT DO NOTHING;
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    relation_type TEXT NOT NULL CHECK (relation_type IN ('uses','knows','depends_on','created_by','related_to','contradicts','part_of','implements','happened_before','happened_after','caused_by','resulted_in','supersedes','version_of')),
    weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entity_id, memory_id),
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_entity_memories_memory ON entity_memories(memory_id);

  INSERT INTO _migrations (id) VALUES (5) ON CONFLICT DO NOTHING;
  `,

  // Migration 6: active_project_id on agents
  `
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_agents_active_project ON agents(active_project_id);
  INSERT INTO _migrations (id) VALUES (6) ON CONFLICT DO NOTHING;
  `,

  // Migration 7: session_id on agents
  `
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS session_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
  INSERT INTO _migrations (id) VALUES (7) ON CONFLICT DO NOTHING;
  `,

  // Migration 8: Resource locks table
  `
  CREATE TABLE IF NOT EXISTS resource_locks (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('project', 'memory', 'entity', 'agent', 'connector', 'file')),
    resource_id TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    lock_type TEXT NOT NULL DEFAULT 'exclusive' CHECK(lock_type IN ('advisory', 'exclusive')),
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_locks_exclusive
    ON resource_locks(resource_type, resource_id)
    WHERE lock_type = 'exclusive';
  CREATE INDEX IF NOT EXISTS idx_resource_locks_agent ON resource_locks(agent_id);
  CREATE INDEX IF NOT EXISTS idx_resource_locks_expires ON resource_locks(expires_at);
  INSERT INTO _migrations (id) VALUES (8) ON CONFLICT DO NOTHING;
  `,

  // Migration 9: recall_count (already on main table in migration 1)
  `
  INSERT INTO _migrations (id) VALUES (9) ON CONFLICT DO NOTHING;
  `,

  // Migration 10: webhook_hooks
  `
  CREATE TABLE IF NOT EXISTS webhook_hooks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    handler_url TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 50,
    blocking BOOLEAN NOT NULL DEFAULT FALSE,
    agent_id TEXT,
    project_id TEXT,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invocation_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_hooks_type ON webhook_hooks(type);
  CREATE INDEX IF NOT EXISTS idx_webhook_hooks_enabled ON webhook_hooks(enabled);
  INSERT INTO _migrations (id) VALUES (10) ON CONFLICT DO NOTHING;
  `,

  // Migration 11: synthesis_events
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_synthesis_events_memory ON synthesis_events(memory_id);
  CREATE INDEX IF NOT EXISTS idx_synthesis_events_project ON synthesis_events(project_id);
  CREATE INDEX IF NOT EXISTS idx_synthesis_events_type ON synthesis_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_synthesis_events_created ON synthesis_events(created_at);
  INSERT INTO _migrations (id) VALUES (11) ON CONFLICT DO NOTHING;
  `,

  // Migration 12: synthesis_runs, synthesis_proposals, synthesis_metrics
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
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','rolled_back')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    value DOUBLE PRECISION NOT NULL,
    baseline DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_synthesis_metrics_run ON synthesis_metrics(run_id);
  CREATE INDEX IF NOT EXISTS idx_synthesis_metrics_type ON synthesis_metrics(metric_type);

  INSERT INTO _migrations (id) VALUES (12) ON CONFLICT DO NOTHING;
  `,

  // Migration 13: session_memory_jobs
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_status ON session_memory_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_agent ON session_memory_jobs(agent_id);
  CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_project ON session_memory_jobs(project_id);
  CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_session ON session_memory_jobs(session_id);
  INSERT INTO _migrations (id) VALUES (13) ON CONFLICT DO NOTHING;
  `,

  // Migrations 14-20: Already folded into the consolidated schema in migration 1
  // (resource_locks with 'file' type, machines table, memories with all columns)
  `INSERT INTO _migrations (id) VALUES (14) ON CONFLICT DO NOTHING;`,
  `INSERT INTO _migrations (id) VALUES (15) ON CONFLICT DO NOTHING;`,
  `INSERT INTO _migrations (id) VALUES (16) ON CONFLICT DO NOTHING;`,

  // Migration 17: memory_embeddings
  `
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    embedding TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'tfidf-512',
    dimensions INTEGER NOT NULL DEFAULT 512,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model);
  INSERT INTO _migrations (id) VALUES (17) ON CONFLICT DO NOTHING;
  `,

  // Migrations 18-21: Already folded into consolidated schema
  `INSERT INTO _migrations (id) VALUES (18) ON CONFLICT DO NOTHING;`,
  `INSERT INTO _migrations (id) VALUES (19) ON CONFLICT DO NOTHING;`,
  `INSERT INTO _migrations (id) VALUES (20) ON CONFLICT DO NOTHING;`,
  `INSERT INTO _migrations (id) VALUES (21) ON CONFLICT DO NOTHING;`,

  // Migration 22: Immutable audit log for all memory operations
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_memory ON memory_audit_log(memory_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_operation ON memory_audit_log(operation);
  CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON memory_audit_log(agent_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_created ON memory_audit_log(created_at);

  -- Audit triggers using PostgreSQL functions
  CREATE OR REPLACE FUNCTION audit_memory_insert() RETURNS trigger AS $$
  BEGIN
    INSERT INTO memory_audit_log (id, memory_id, memory_key, operation, agent_id, new_value_hash, created_at)
    VALUES (gen_random_uuid()::text, NEW.id, NEW.key, 'create', NEW.agent_id, md5(COALESCE(NEW.value, '')), NOW());
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION audit_memory_update() RETURNS trigger AS $$
  BEGIN
    INSERT INTO memory_audit_log (id, memory_id, memory_key, operation, agent_id, old_value_hash, new_value_hash, changes, created_at)
    VALUES (gen_random_uuid()::text, NEW.id, NEW.key, 'update', NEW.agent_id, md5(COALESCE(OLD.value, '')), md5(COALESCE(NEW.value, '')),
      json_build_object('version_from', OLD.version, 'version_to', NEW.version, 'importance_from', OLD.importance, 'importance_to', NEW.importance)::text,
      NOW());
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION audit_memory_delete() RETURNS trigger AS $$
  BEGIN
    INSERT INTO memory_audit_log (id, memory_id, memory_key, operation, agent_id, old_value_hash, created_at)
    VALUES (gen_random_uuid()::text, OLD.id, OLD.key, 'delete', OLD.agent_id, md5(COALESCE(OLD.value, '')), NOW());
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS audit_memory_insert ON memories;
  CREATE TRIGGER audit_memory_insert AFTER INSERT ON memories
    FOR EACH ROW EXECUTE FUNCTION audit_memory_insert();

  DROP TRIGGER IF EXISTS audit_memory_update ON memories;
  CREATE TRIGGER audit_memory_update AFTER UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION audit_memory_update();

  DROP TRIGGER IF EXISTS audit_memory_delete ON memories;
  CREATE TRIGGER audit_memory_delete AFTER DELETE ON memories
    FOR EACH ROW EXECUTE FUNCTION audit_memory_delete();

  INSERT INTO _migrations (id) VALUES (22) ON CONFLICT DO NOTHING;
  `,

  // Migrations 23-24: Already folded into consolidated schema
  `INSERT INTO _migrations (id) VALUES (23) ON CONFLICT DO NOTHING;`,
  `INSERT INTO _migrations (id) VALUES (24) ON CONFLICT DO NOTHING;`,

  // Migration 25: memory_ratings table
  `
  CREATE TABLE IF NOT EXISTS memory_ratings (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    agent_id TEXT,
    useful BOOLEAN NOT NULL DEFAULT TRUE,
    context TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_memory_ratings_memory ON memory_ratings(memory_id);
  CREATE INDEX IF NOT EXISTS idx_memory_ratings_agent ON memory_ratings(agent_id);
  INSERT INTO _migrations (id) VALUES (25) ON CONFLICT DO NOTHING;
  `,

  // Migration 26: memory ACLs
  `
  CREATE TABLE IF NOT EXISTS memory_acl (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    key_pattern TEXT NOT NULL,
    permission TEXT NOT NULL DEFAULT 'readwrite' CHECK(permission IN ('read', 'readwrite', 'admin')),
    project_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_memory_acl_agent ON memory_acl(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memory_acl_project ON memory_acl(project_id);
  INSERT INTO _migrations (id) VALUES (26) ON CONFLICT DO NOTHING;
  `,

  // Migration 27: vector_clock (already on main table)
  `INSERT INTO _migrations (id) VALUES (27) ON CONFLICT DO NOTHING;`,

  // Migration 28: memory_subscriptions
  `
  CREATE TABLE IF NOT EXISTS memory_subscriptions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    key_pattern TEXT,
    tag_pattern TEXT,
    scope TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_memory_subs_agent ON memory_subscriptions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memory_subs_key ON memory_subscriptions(key_pattern);
  INSERT INTO _migrations (id) VALUES (28) ON CONFLICT DO NOTHING;
  `,

  // Migration 29: FK fixes (not needed in PG — PG handles renames correctly)
  `INSERT INTO _migrations (id) VALUES (29) ON CONFLICT DO NOTHING;`,

  // Migration 30: when_to_use (already on main table)
  `INSERT INTO _migrations (id) VALUES (30) ON CONFLICT DO NOTHING;`,

  // Migration 31: tool_events table
  `
  CREATE TABLE IF NOT EXISTS tool_events (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    action TEXT,
    success BOOLEAN NOT NULL DEFAULT TRUE,
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_tool_events_tool_name ON tool_events(tool_name);
  CREATE INDEX IF NOT EXISTS idx_tool_events_agent ON tool_events(agent_id);
  CREATE INDEX IF NOT EXISTS idx_tool_events_project ON tool_events(project_id);
  CREATE INDEX IF NOT EXISTS idx_tool_events_success ON tool_events(success);
  CREATE INDEX IF NOT EXISTS idx_tool_events_created ON tool_events(created_at);
  INSERT INTO _migrations (id) VALUES (31) ON CONFLICT DO NOTHING;
  `,

  // Migration 32: sequence columns (already on main table)
  `INSERT INTO _migrations (id) VALUES (32) ON CONFLICT DO NOTHING;`,

  // Migration 33: primary machine designation and delete protection
  `
  ALTER TABLE machines ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE INDEX IF NOT EXISTS idx_machines_primary ON machines(is_primary);

  CREATE OR REPLACE FUNCTION enforce_single_primary_machine() RETURNS trigger AS $$
  BEGIN
    IF NEW.is_primary THEN
      UPDATE machines
      SET is_primary = FALSE,
          last_seen_at = COALESCE(NEW.last_seen_at, NOW())
      WHERE id <> NEW.id AND is_primary = TRUE;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS machines_single_primary_insert ON machines;
  CREATE TRIGGER machines_single_primary_insert
    AFTER INSERT ON machines
    FOR EACH ROW
    WHEN (NEW.is_primary = TRUE)
    EXECUTE FUNCTION enforce_single_primary_machine();

  DROP TRIGGER IF EXISTS machines_single_primary_update ON machines;
  CREATE TRIGGER machines_single_primary_update
    AFTER UPDATE OF is_primary ON machines
    FOR EACH ROW
    WHEN (NEW.is_primary = TRUE)
    EXECUTE FUNCTION enforce_single_primary_machine();

  CREATE OR REPLACE FUNCTION prevent_delete_primary_machine() RETURNS trigger AS $$
  BEGIN
    IF OLD.is_primary THEN
      RAISE EXCEPTION 'Primary machine cannot be deleted';
    END IF;
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS machines_prevent_delete_primary ON machines;
  CREATE TRIGGER machines_prevent_delete_primary
    BEFORE DELETE ON machines
    FOR EACH ROW
    EXECUTE FUNCTION prevent_delete_primary_machine();

  INSERT INTO _migrations (id) VALUES (33) ON CONFLICT DO NOTHING;
  `,

  // Feedback table (created outside migrations in SQLite, included here)
  `
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `,
];
