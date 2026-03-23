// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  saveToolEvent,
  getToolEvent,
  getToolEvents,
  getToolStats,
  getToolLessons,
  deleteToolEvents,
} from "./tool-events.js";

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
  `);

  return db;
}

/** Insert a project row and return its id */
function seedProject(db: Database, id = "proj-1", name = "test-project"): string {
  db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", [id, name, `/tmp/${name}`]);
  return id;
}

/** Insert an agent row and return its id */
function seedAgent(db: Database, id = "agent-1", name = "maximus"): string {
  db.run("INSERT INTO agents (id, name) VALUES (?, ?)", [id, name]);
  return id;
}

// ============================================================================
// Tests
// ============================================================================

describe("tool_events", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  // --------------------------------------------------------------------------
  // saveToolEvent
  // --------------------------------------------------------------------------
  describe("saveToolEvent", () => {
    it("saves a successful tool event", () => {
      const event = saveToolEvent({ tool_name: "memory_save", success: true }, db);
      expect(event.id).toBeDefined();
      expect(event.tool_name).toBe("memory_save");
      expect(event.success).toBe(true);
      expect(event.error_type).toBeNull();
      expect(event.error_message).toBeNull();
      expect(event.created_at).toBeDefined();
    });

    it("saves a failed tool event with error details", () => {
      const event = saveToolEvent(
        {
          tool_name: "memory_get",
          success: false,
          error_type: "not_found",
          error_message: "Memory with id abc not found",
        },
        db
      );
      expect(event.success).toBe(false);
      expect(event.error_type).toBe("not_found");
      expect(event.error_message).toBe("Memory with id abc not found");
    });

    it("saves event with all fields populated", () => {
      const agentId = seedAgent(db);
      const projectId = seedProject(db);

      const event = saveToolEvent(
        {
          tool_name: "memory_search",
          action: "hybrid",
          success: true,
          tokens_used: 1500,
          latency_ms: 230,
          context: "Searching for deployment patterns",
          lesson: "Hybrid search is faster than BM25 for short queries",
          when_to_use: "Use when query is fewer than 5 words",
          agent_id: agentId,
          project_id: projectId,
          session_id: "sess-abc",
          metadata: { query_length: 3, result_count: 12 },
        },
        db
      );

      expect(event.tool_name).toBe("memory_search");
      expect(event.action).toBe("hybrid");
      expect(event.success).toBe(true);
      expect(event.tokens_used).toBe(1500);
      expect(event.latency_ms).toBe(230);
      expect(event.context).toBe("Searching for deployment patterns");
      expect(event.lesson).toBe("Hybrid search is faster than BM25 for short queries");
      expect(event.when_to_use).toBe("Use when query is fewer than 5 words");
      expect(event.agent_id).toBe(agentId);
      expect(event.project_id).toBe(projectId);
      expect(event.session_id).toBe("sess-abc");
      expect(event.metadata).toEqual({ query_length: 3, result_count: 12 });
    });

    it("saves event with minimal fields (tool_name + success only)", () => {
      const event = saveToolEvent({ tool_name: "memory_list", success: true }, db);
      expect(event.tool_name).toBe("memory_list");
      expect(event.success).toBe(true);
      expect(event.action).toBeNull();
      expect(event.tokens_used).toBeNull();
      expect(event.latency_ms).toBeNull();
      expect(event.context).toBeNull();
      expect(event.lesson).toBeNull();
      expect(event.when_to_use).toBeNull();
      expect(event.agent_id).toBeNull();
      expect(event.project_id).toBeNull();
      expect(event.session_id).toBeNull();
      expect(event.metadata).toEqual({});
    });
  });

  // --------------------------------------------------------------------------
  // getToolEvents
  // --------------------------------------------------------------------------
  describe("getToolEvents", () => {
    it("returns events filtered by tool_name", () => {
      saveToolEvent({ tool_name: "memory_save", success: true }, db);
      saveToolEvent({ tool_name: "memory_get", success: true }, db);
      saveToolEvent({ tool_name: "memory_save", success: false, error_type: "other" }, db);

      const events = getToolEvents({ tool_name: "memory_save" }, db);
      expect(events.length).toBe(2);
      for (const e of events) {
        expect(e.tool_name).toBe("memory_save");
      }
    });

    it("returns events filtered by success/failure", () => {
      saveToolEvent({ tool_name: "tool_a", success: true }, db);
      saveToolEvent({ tool_name: "tool_b", success: false, error_type: "timeout" }, db);
      saveToolEvent({ tool_name: "tool_c", success: true }, db);

      const successes = getToolEvents({ success: true }, db);
      expect(successes.length).toBe(2);
      for (const e of successes) {
        expect(e.success).toBe(true);
      }

      const failures = getToolEvents({ success: false }, db);
      expect(failures.length).toBe(1);
      expect(failures[0]!.success).toBe(false);
    });

    it("returns events ordered by created_at DESC", () => {
      // Insert with explicit timestamps via raw SQL to control ordering
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();
      const id3 = crypto.randomUUID();
      db.run(
        "INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id1, "tool_x", "2026-01-01T00:00:00.000Z"]
      );
      db.run(
        "INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id2, "tool_x", "2026-03-01T00:00:00.000Z"]
      );
      db.run(
        "INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id3, "tool_x", "2026-02-01T00:00:00.000Z"]
      );

      const events = getToolEvents({ tool_name: "tool_x" }, db);
      expect(events.length).toBe(3);
      expect(events[0]!.id).toBe(id2); // March — newest
      expect(events[1]!.id).toBe(id3); // February
      expect(events[2]!.id).toBe(id1); // January — oldest
    });

    it("supports pagination with limit and offset", () => {
      for (let i = 0; i < 10; i++) {
        saveToolEvent({ tool_name: "paginated", success: true }, db);
      }

      const page1 = getToolEvents({ tool_name: "paginated", limit: 3, offset: 0 }, db);
      expect(page1.length).toBe(3);

      const page2 = getToolEvents({ tool_name: "paginated", limit: 3, offset: 3 }, db);
      expect(page2.length).toBe(3);

      // No overlap between pages
      const ids1 = new Set(page1.map((e) => e.id));
      for (const e of page2) {
        expect(ids1.has(e.id)).toBe(false);
      }

      // Past the end
      const pastEnd = getToolEvents({ tool_name: "paginated", limit: 3, offset: 30 }, db);
      expect(pastEnd.length).toBe(0);
    });

    it("filters by project_id", () => {
      const p1 = seedProject(db, "p1", "project-alpha");
      const p2 = seedProject(db, "p2", "project-beta");

      saveToolEvent({ tool_name: "tool_a", success: true, project_id: p1 }, db);
      saveToolEvent({ tool_name: "tool_a", success: true, project_id: p2 }, db);
      saveToolEvent({ tool_name: "tool_a", success: true, project_id: p1 }, db);

      const events = getToolEvents({ project_id: p1 }, db);
      expect(events.length).toBe(2);
      for (const e of events) {
        expect(e.project_id).toBe(p1);
      }
    });
  });

  // --------------------------------------------------------------------------
  // getToolStats
  // --------------------------------------------------------------------------
  describe("getToolStats", () => {
    it("returns correct success rate", () => {
      saveToolEvent({ tool_name: "stat_tool", success: true }, db);
      saveToolEvent({ tool_name: "stat_tool", success: true }, db);
      saveToolEvent({ tool_name: "stat_tool", success: true }, db);
      saveToolEvent({ tool_name: "stat_tool", success: false, error_type: "timeout" }, db);

      const stats = getToolStats("stat_tool", undefined, db);
      expect(stats.tool_name).toBe("stat_tool");
      expect(stats.total_calls).toBe(4);
      expect(stats.success_count).toBe(3);
      expect(stats.failure_count).toBe(1);
      expect(stats.success_rate).toBe(0.75);
    });

    it("calculates average tokens and latency", () => {
      saveToolEvent({ tool_name: "avg_tool", success: true, tokens_used: 100, latency_ms: 200 }, db);
      saveToolEvent({ tool_name: "avg_tool", success: true, tokens_used: 300, latency_ms: 400 }, db);
      // One event without tokens/latency — should be excluded from avg
      saveToolEvent({ tool_name: "avg_tool", success: true }, db);

      const stats = getToolStats("avg_tool", undefined, db);
      expect(stats.total_calls).toBe(3);
      expect(stats.avg_tokens).toBe(200); // (100 + 300) / 2
      expect(stats.avg_latency_ms).toBe(300); // (200 + 400) / 2
    });

    it("lists common error types", () => {
      saveToolEvent({ tool_name: "err_tool", success: false, error_type: "timeout" }, db);
      saveToolEvent({ tool_name: "err_tool", success: false, error_type: "timeout" }, db);
      saveToolEvent({ tool_name: "err_tool", success: false, error_type: "timeout" }, db);
      saveToolEvent({ tool_name: "err_tool", success: false, error_type: "not_found" }, db);
      saveToolEvent({ tool_name: "err_tool", success: false, error_type: "permission" }, db);
      saveToolEvent({ tool_name: "err_tool", success: true }, db);

      const stats = getToolStats("err_tool", undefined, db);
      expect(stats.common_errors.length).toBeGreaterThanOrEqual(2);
      // Most common error should be timeout
      expect(stats.common_errors[0]!.error_type).toBe("timeout");
      expect(stats.common_errors[0]!.count).toBe(3);
    });

    it("returns zero stats for unknown tool", () => {
      const stats = getToolStats("nonexistent_tool", undefined, db);
      expect(stats.tool_name).toBe("nonexistent_tool");
      expect(stats.total_calls).toBe(0);
      expect(stats.success_count).toBe(0);
      expect(stats.failure_count).toBe(0);
      expect(stats.success_rate).toBe(0);
      expect(stats.avg_tokens).toBeNull();
      expect(stats.avg_latency_ms).toBeNull();
      expect(stats.common_errors).toEqual([]);
      expect(stats.last_used).toBe("");
    });
  });

  // --------------------------------------------------------------------------
  // getToolLessons
  // --------------------------------------------------------------------------
  describe("getToolLessons", () => {
    it("returns lessons for a tool", () => {
      saveToolEvent({
        tool_name: "lesson_tool",
        success: true,
        lesson: "Always pass project_id for scoped queries",
      }, db);

      const lessons = getToolLessons("lesson_tool", undefined, undefined, db);
      expect(lessons.length).toBe(1);
      expect(lessons[0]!.lesson).toBe("Always pass project_id for scoped queries");
    });

    it("only returns events that have lessons", () => {
      saveToolEvent({ tool_name: "mixed_tool", success: true, lesson: "Lesson A" }, db);
      saveToolEvent({ tool_name: "mixed_tool", success: true }, db); // no lesson
      saveToolEvent({ tool_name: "mixed_tool", success: false, error_type: "other" }, db); // no lesson
      saveToolEvent({ tool_name: "mixed_tool", success: true, lesson: "Lesson B" }, db);

      const lessons = getToolLessons("mixed_tool", undefined, undefined, db);
      expect(lessons.length).toBe(2);
      const texts = lessons.map((l) => l.lesson);
      expect(texts).toContain("Lesson A");
      expect(texts).toContain("Lesson B");
    });

    it("orders by newest first", () => {
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();
      db.run(
        "INSERT INTO tool_events (id, tool_name, success, lesson, created_at) VALUES (?, ?, 1, ?, ?)",
        [id1, "order_tool", "Old lesson", "2026-01-01T00:00:00.000Z"]
      );
      db.run(
        "INSERT INTO tool_events (id, tool_name, success, lesson, created_at) VALUES (?, ?, 1, ?, ?)",
        [id2, "order_tool", "New lesson", "2026-03-01T00:00:00.000Z"]
      );

      const lessons = getToolLessons("order_tool", undefined, undefined, db);
      expect(lessons.length).toBe(2);
      expect(lessons[0]!.lesson).toBe("New lesson");
      expect(lessons[1]!.lesson).toBe("Old lesson");
    });

    it("includes when_to_use with lessons", () => {
      saveToolEvent({
        tool_name: "wtu_tool",
        success: true,
        lesson: "Use semantic search for broad queries",
        when_to_use: "When the user query has more than 10 words",
      }, db);
      saveToolEvent({
        tool_name: "wtu_tool",
        success: true,
        lesson: "Use BM25 for exact matches",
      }, db);

      const lessons = getToolLessons("wtu_tool", undefined, undefined, db);
      expect(lessons.length).toBe(2);

      const withWtu = lessons.find((l) => l.when_to_use !== null);
      expect(withWtu).toBeDefined();
      expect(withWtu!.when_to_use).toBe("When the user query has more than 10 words");

      const withoutWtu = lessons.find((l) => l.when_to_use === null);
      expect(withoutWtu).toBeDefined();
      expect(withoutWtu!.lesson).toBe("Use BM25 for exact matches");
    });
  });

  // --------------------------------------------------------------------------
  // deleteToolEvents
  // --------------------------------------------------------------------------
  describe("deleteToolEvents", () => {
    it("deletes by tool_name", () => {
      saveToolEvent({ tool_name: "del_a", success: true }, db);
      saveToolEvent({ tool_name: "del_a", success: true }, db);
      saveToolEvent({ tool_name: "del_b", success: true }, db);

      const deleted = deleteToolEvents({ tool_name: "del_a" }, db);
      expect(deleted).toBe(2);

      const remaining = getToolEvents({}, db);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.tool_name).toBe("del_b");
    });

    it("deletes by before_date", () => {
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();
      const id3 = crypto.randomUUID();
      db.run(
        "INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id1, "date_tool", "2025-01-01T00:00:00.000Z"]
      );
      db.run(
        "INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id2, "date_tool", "2025-06-01T00:00:00.000Z"]
      );
      db.run(
        "INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id3, "date_tool", "2026-01-01T00:00:00.000Z"]
      );

      const deleted = deleteToolEvents({ before_date: "2025-07-01T00:00:00.000Z" }, db);
      expect(deleted).toBe(2);

      const remaining = getToolEvents({}, db);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.id).toBe(id3);
    });

    it("refuses to delete without filters (returns 0)", () => {
      saveToolEvent({ tool_name: "safe_tool", success: true }, db);
      saveToolEvent({ tool_name: "safe_tool", success: true }, db);

      const deleted = deleteToolEvents({}, db);
      expect(deleted).toBe(0);

      // All events still present
      const remaining = getToolEvents({}, db);
      expect(remaining.length).toBe(2);
    });
  });
});
