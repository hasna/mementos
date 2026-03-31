// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import {
  saveToolEvent,
  getToolEvents,
  getToolStats,
  getToolLessons,
  deleteToolEvents,
} from "./tool-events.js";

// ============================================================================
// Helpers — same minimal DB as in tool-events.test.ts
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
  `);

  return db;
}

function seedProject(db: Database, id = "proj-1", name = "test-project"): string {
  db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", [id, name, `/tmp/${name}`]);
  return id;
}

function seedAgent(db: Database, id = "agent-1", name = "maximus"): string {
  db.run("INSERT INTO agents (id, name) VALUES (?, ?)", [id, name]);
  return id;
}

// ============================================================================
// Tests for uncovered lines
// ============================================================================

describe("tool-events extra coverage", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  // ---------------------------
  // getToolEvents: agent_id filter (lines 99-100)
  // ---------------------------
  describe("getToolEvents - agent_id filter (lines 99-100)", () => {
    it("filters by agent_id", () => {
      const a1 = seedAgent(db, "agent-1", "agt-one");
      const a2 = seedAgent(db, "agent-2", "agt-two");

      saveToolEvent({ tool_name: "t", success: true, agent_id: a1 }, db);
      saveToolEvent({ tool_name: "t", success: true, agent_id: a1 }, db);
      saveToolEvent({ tool_name: "t", success: true, agent_id: a2 }, db);

      const results = getToolEvents({ agent_id: a1 }, db);
      expect(results.length).toBe(2);
      for (const e of results) {
        expect(e.agent_id).toBe(a1);
      }
    });
  });

  // ---------------------------
  // getToolEvents: from_date filter (lines 111-112)
  // ---------------------------
  describe("getToolEvents - from_date filter (lines 111-112)", () => {
    it("filters events from a start date", () => {
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();
      const id3 = crypto.randomUUID();

      db.run("INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id1, "dt", "2025-01-01T00:00:00.000Z"]);
      db.run("INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id2, "dt", "2025-06-15T00:00:00.000Z"]);
      db.run("INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id3, "dt", "2026-01-01T00:00:00.000Z"]);

      const results = getToolEvents({ tool_name: "dt", from_date: "2025-06-01T00:00:00.000Z" }, db);
      expect(results.length).toBe(2);
      const ids = results.map(e => e.id);
      expect(ids).toContain(id2);
      expect(ids).toContain(id3);
      expect(ids).not.toContain(id1);
    });
  });

  // ---------------------------
  // getToolEvents: to_date filter (lines 115-116)
  // ---------------------------
  describe("getToolEvents - to_date filter (lines 115-116)", () => {
    it("filters events up to an end date", () => {
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();
      const id3 = crypto.randomUUID();

      db.run("INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id1, "td", "2025-01-01T00:00:00.000Z"]);
      db.run("INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id2, "td", "2025-06-15T00:00:00.000Z"]);
      db.run("INSERT INTO tool_events (id, tool_name, success, created_at) VALUES (?, ?, 1, ?)",
        [id3, "td", "2026-01-01T00:00:00.000Z"]);

      const results = getToolEvents({ tool_name: "td", to_date: "2025-07-01T00:00:00.000Z" }, db);
      expect(results.length).toBe(2);
      const ids = results.map(e => e.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).not.toContain(id3);
    });
  });

  // ---------------------------
  // getToolStats: project_id filter (lines 144-145)
  // ---------------------------
  describe("getToolStats - project_id filter (lines 144-145)", () => {
    it("filters stats by project_id", () => {
      const p1 = seedProject(db, "sp1", "proj-stats-1");
      const p2 = seedProject(db, "sp2", "proj-stats-2");

      saveToolEvent({ tool_name: "ps_tool", success: true, project_id: p1 }, db);
      saveToolEvent({ tool_name: "ps_tool", success: true, project_id: p1 }, db);
      saveToolEvent({ tool_name: "ps_tool", success: false, error_type: "timeout", project_id: p2 }, db);

      const statsP1 = getToolStats("ps_tool", p1, db);
      expect(statsP1.total_calls).toBe(2);
      expect(statsP1.success_count).toBe(2);
      expect(statsP1.failure_count).toBe(0);

      const statsP2 = getToolStats("ps_tool", p2, db);
      expect(statsP2.total_calls).toBe(1);
      expect(statsP2.failure_count).toBe(1);
    });
  });

  // ---------------------------
  // getToolLessons: project_id filter (lines 197-198)
  // ---------------------------
  describe("getToolLessons - project_id filter (lines 197-198)", () => {
    it("filters lessons by project_id", () => {
      const p1 = seedProject(db, "lp1", "proj-lessons-1");
      const p2 = seedProject(db, "lp2", "proj-lessons-2");

      saveToolEvent({ tool_name: "lt", success: true, lesson: "Lesson for p1", project_id: p1 }, db);
      saveToolEvent({ tool_name: "lt", success: true, lesson: "Lesson for p2", project_id: p2 }, db);
      saveToolEvent({ tool_name: "lt", success: true, lesson: "Another p1", project_id: p1 }, db);

      const lessonsP1 = getToolLessons("lt", p1, undefined, db);
      expect(lessonsP1.length).toBe(2);
      const texts = lessonsP1.map(l => l.lesson);
      expect(texts).toContain("Lesson for p1");
      expect(texts).toContain("Another p1");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        saveToolEvent({ tool_name: "lt_limit", success: true, lesson: `Lesson ${i}` }, db);
      }
      const lessons = getToolLessons("lt_limit", undefined, 3, db);
      expect(lessons.length).toBe(3);
    });
  });

  // ---------------------------
  // deleteToolEvents: agent_id filter (lines 230-231)
  // ---------------------------
  describe("deleteToolEvents - agent_id filter (lines 230-231)", () => {
    it("deletes events by agent_id", () => {
      const a1 = seedAgent(db, "da1", "del-agent-1");
      const a2 = seedAgent(db, "da2", "del-agent-2");

      saveToolEvent({ tool_name: "t", success: true, agent_id: a1 }, db);
      saveToolEvent({ tool_name: "t", success: true, agent_id: a1 }, db);
      saveToolEvent({ tool_name: "t", success: true, agent_id: a2 }, db);

      const deleted = deleteToolEvents({ agent_id: a1 }, db);
      expect(deleted).toBe(2);

      const remaining = getToolEvents({}, db);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.agent_id).toBe(a2);
    });
  });

  // ---------------------------
  // deleteToolEvents: project_id filter (lines 234-235)
  // ---------------------------
  describe("deleteToolEvents - project_id filter (lines 234-235)", () => {
    it("deletes events by project_id", () => {
      const p1 = seedProject(db, "dp1", "del-proj-1");
      const p2 = seedProject(db, "dp2", "del-proj-2");

      saveToolEvent({ tool_name: "t", success: true, project_id: p1 }, db);
      saveToolEvent({ tool_name: "t", success: true, project_id: p1 }, db);
      saveToolEvent({ tool_name: "t", success: true, project_id: p2 }, db);

      const deleted = deleteToolEvents({ project_id: p1 }, db);
      expect(deleted).toBe(2);

      const remaining = getToolEvents({}, db);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.project_id).toBe(p2);
    });
  });
});
