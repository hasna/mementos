// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemory } from "../db/memories.js";
import { smartInject } from "./injector.js";

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
      when_to_use TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(memory_id, version)
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);
    CREATE INDEX IF NOT EXISTS idx_tool_events_tool_name ON tool_events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_events_agent ON tool_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_tool_events_project ON tool_events(project_id);
  `);

  return db;
}

/**
 * Seed a project row so that project_id FK constraints are satisfied.
 */
function seedProject(db: Database, id: string, name: string): void {
  db.run(
    "INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)",
    [id, name, `/tmp/test-${name}`]
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("smartInject", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  // --------------------------------------------------------------------------
  // Basic output structure
  // --------------------------------------------------------------------------

  it("returns layered output with section headers", async () => {
    // Seed memories of different categories so multiple sections appear
    createMemory(
      { key: "arch-decision", value: "We use PostgreSQL for persistence", category: "fact", scope: "global", importance: 8 },
      "merge",
      db
    );
    createMemory(
      { key: "deploy-steps", value: "Run bun build then docker push", category: "procedural", scope: "global", importance: 7 },
      "merge",
      db
    );
    createMemory(
      { key: "prefer-tabs", value: "Always use tabs for indentation", category: "preference", scope: "global", importance: 6 },
      "merge",
      db
    );

    const result = await smartInject({ task_context: "Setting up the project", db });

    expect(result.output).toContain("<agent-memories>");
    expect(result.output).toContain("</agent-memories>");
    // Should have at least one section header
    expect(result.output).toMatch(/## (Core Facts|Procedures|Preferences|Recent History)/);
    expect(result.memory_count).toBeGreaterThan(0);
    expect(result.token_estimate).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Core Facts section
  // --------------------------------------------------------------------------

  it("includes Core Facts section for fact-category memories", async () => {
    createMemory(
      { key: "db-engine", value: "SQLite with WAL mode for all local storage", category: "fact", scope: "global", importance: 9 },
      "merge",
      db
    );
    createMemory(
      { key: "api-version", value: "REST API is versioned at /v1/", category: "fact", scope: "global", importance: 8 },
      "merge",
      db
    );

    const result = await smartInject({ task_context: "Building the API layer", db });

    expect(result.output).toContain("## Core Facts");
    expect(result.output).toContain("db-engine");
    expect(result.output).toContain("api-version");
  });

  // --------------------------------------------------------------------------
  // Procedures section
  // --------------------------------------------------------------------------

  it("includes Procedures section for procedural-category memories", async () => {
    createMemory(
      { key: "release-process", value: "1. Tag release 2. Run CI 3. Publish to npm", category: "procedural", scope: "global", importance: 8 },
      "merge",
      db
    );

    const result = await smartInject({ task_context: "Preparing the next release", db });

    expect(result.output).toContain("## Procedures");
    expect(result.output).toContain("release-process");
  });

  // --------------------------------------------------------------------------
  // Preferences section
  // --------------------------------------------------------------------------

  it("includes Preferences section for preference-category memories", async () => {
    createMemory(
      { key: "code-style", value: "Use single quotes and 2-space indent", category: "preference", scope: "global", importance: 7 },
      "merge",
      db
    );

    const result = await smartInject({ task_context: "Writing new code", db });

    // Note: when profile synthesis succeeds, preferences may be excluded to avoid
    // redundancy with the profile. When it fails (no API key in tests), preferences appear.
    // We check that the memory content appears somewhere in the output.
    expect(result.output).toContain("code-style");
  });

  // --------------------------------------------------------------------------
  // Token budget
  // --------------------------------------------------------------------------

  it("respects max_tokens budget", async () => {
    // Seed many memories to exceed a small budget
    for (let i = 0; i < 50; i++) {
      createMemory(
        {
          key: `fact-${i}`,
          value: `This is a moderately long fact number ${i} that takes up token space in the output buffer`,
          category: "fact",
          scope: "global",
          importance: 5,
        },
        "merge",
        db
      );
    }

    const smallBudget = 100; // ~400 chars total
    const result = await smartInject({ task_context: "General work", max_tokens: smallBudget, db });

    // Token estimate should not wildly exceed the budget
    // (some overhead for headers is expected, but it should be in the right ballpark)
    expect(result.token_estimate).toBeLessThanOrEqual(smallBudget * 2); // generous margin for headers
    // Should not include all 50 memories
    expect(result.memory_count).toBeLessThan(50);
  });

  // --------------------------------------------------------------------------
  // Empty DB
  // --------------------------------------------------------------------------

  it("returns empty output when no memories exist", async () => {
    const result = await smartInject({ task_context: "Starting fresh", db });

    expect(result.output).toBe("");
    expect(result.memory_count).toBe(0);
    expect(result.token_estimate).toBe(0);
  });

  // --------------------------------------------------------------------------
  // No task_context (falls back to decay-only scoring)
  // --------------------------------------------------------------------------

  it("works without task_context (falls back to decay-only scoring)", async () => {
    createMemory(
      { key: "fallback-fact", value: "This memory should still appear", category: "fact", scope: "global", importance: 8 },
      "merge",
      db
    );

    // Empty task_context — activation matching will find nothing, but decay + importance still score
    const result = await smartInject({ task_context: "", db });

    expect(result.output).toContain("fallback-fact");
    expect(result.memory_count).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Tool detection in task_context
  // --------------------------------------------------------------------------

  it("detects tool mentions in task_context", async () => {
    createMemory(
      { key: "save-tip", value: "Always set importance for memory_save calls", category: "knowledge", scope: "global", importance: 7 },
      "merge",
      db
    );

    const result = await smartInject({
      task_context: "I need to use memory_save and memory_search to persist agent state, also running git commit",
      db,
    });

    // The pipeline should detect MCP tool names and CLI tools
    expect(result.detected_tools).toContain("memory_save");
    expect(result.detected_tools).toContain("memory_search");
    expect(result.detected_tools).toContain("git");
  });

  // --------------------------------------------------------------------------
  // Project scoping
  // --------------------------------------------------------------------------

  it("filters by project_id", async () => {
    const projectId = "proj-alpha";
    const otherProjectId = "proj-beta";

    seedProject(db, projectId, "alpha");
    seedProject(db, otherProjectId, "beta");

    // Memory scoped to project alpha (shared scope requires project_id)
    createMemory(
      {
        key: "alpha-config",
        value: "Alpha uses port 3000",
        category: "fact",
        scope: "shared",
        importance: 8,
        project_id: projectId,
      },
      "merge",
      db
    );

    // Memory scoped to project beta
    createMemory(
      {
        key: "beta-config",
        value: "Beta uses port 4000",
        category: "fact",
        scope: "shared",
        importance: 8,
        project_id: otherProjectId,
      },
      "merge",
      db
    );

    // Also add a global memory (should appear regardless of project filter)
    createMemory(
      { key: "global-fact", value: "All projects use TypeScript", category: "fact", scope: "global", importance: 7 },
      "merge",
      db
    );

    const result = await smartInject({
      task_context: "Working on alpha project",
      project_id: projectId,
      db,
    });

    // Should include alpha's shared memory and the global memory
    expect(result.output).toContain("alpha-config");
    expect(result.output).toContain("global-fact");
    // Should NOT include beta's shared memory
    expect(result.output).not.toContain("beta-config");
  });

  // --------------------------------------------------------------------------
  // Result structure fields
  // --------------------------------------------------------------------------

  it("returns correct result structure fields", async () => {
    createMemory(
      { key: "struct-test", value: "Testing result shape", category: "fact", scope: "global", importance: 5 },
      "merge",
      db
    );

    const result = await smartInject({ task_context: "Checking structure", db });

    // Validate all fields of SmartInjectionResult exist and have correct types
    expect(typeof result.output).toBe("string");
    expect(typeof result.token_estimate).toBe("number");
    expect(typeof result.memory_count).toBe("number");
    expect(typeof result.profile_from_cache).toBe("boolean");
    expect(Array.isArray(result.detected_tools)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // History section
  // --------------------------------------------------------------------------

  it("includes Recent History section for history-category memories", async () => {
    createMemory(
      { key: "session-2026-03-20", value: "Refactored the injection pipeline", category: "history", scope: "global", importance: 5 },
      "merge",
      db
    );

    const result = await smartInject({ task_context: "Continuing yesterday's work", db });

    expect(result.output).toContain("## Recent History");
    expect(result.output).toContain("session-2026-03-20");
  });

  // --------------------------------------------------------------------------
  // Multiple categories produce multiple sections
  // --------------------------------------------------------------------------

  it("produces distinct sections for different categories", async () => {
    createMemory(
      { key: "fact-1", value: "Architecture uses event sourcing", category: "fact", scope: "global", importance: 9 },
      "merge",
      db
    );
    createMemory(
      { key: "proc-1", value: "Step 1: init, Step 2: migrate, Step 3: seed", category: "procedural", scope: "global", importance: 8 },
      "merge",
      db
    );
    createMemory(
      { key: "hist-1", value: "Yesterday deployed v2.0", category: "history", scope: "global", importance: 5 },
      "merge",
      db
    );

    const result = await smartInject({ task_context: "General development work", db });

    expect(result.output).toContain("## Core Facts");
    expect(result.output).toContain("## Procedures");
    expect(result.output).toContain("## Recent History");
    expect(result.memory_count).toBe(3);
  });

  // --------------------------------------------------------------------------
  // Pinned memories get a boost
  // --------------------------------------------------------------------------

  it("includes pinned memories even at low importance", async () => {
    // Lower importance but pinned
    createMemory(
      { key: "pinned-note", value: "Critical: never delete prod data", category: "fact", scope: "global", importance: 5, pinned: true },
      "merge",
      db
    );
    // Higher importance but not pinned
    createMemory(
      { key: "normal-note", value: "Use bun for builds", category: "fact", scope: "global", importance: 9 },
      "merge",
      db
    );

    const result = await smartInject({ task_context: "Working on data layer", db });

    // Both should appear (pinned gets a score bonus)
    expect(result.output).toContain("pinned-note");
    expect(result.output).toContain("normal-note");
  });

  // --------------------------------------------------------------------------
  // Tool detection edge cases
  // --------------------------------------------------------------------------

  it("detects various tool patterns in task_context", async () => {
    const result = await smartInject({
      task_context: "Using entity_create and graph_traverse, also need docker and kubectl for deployment",
      db,
    });

    expect(result.detected_tools).toContain("entity_create");
    expect(result.detected_tools).toContain("graph_traverse");
    expect(result.detected_tools).toContain("docker");
    expect(result.detected_tools).toContain("kubectl");
  });

  it("returns empty detected_tools when no tools mentioned", async () => {
    const result = await smartInject({
      task_context: "Writing documentation about the project architecture",
      db,
    });

    expect(result.detected_tools).toEqual([]);
  });
});
