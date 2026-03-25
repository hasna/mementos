// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { resetDatabase, getDatabase } from "../../db/database.js";
import { createMemory } from "../../db/memories.js";
import { registerProject } from "../../db/projects.js";
import {
  createSynthesisRun,
  recordSynthesisEvent,
} from "../../db/synthesis.js";
import { checkShouldTrigger, triggerIfReady } from "./scheduler.js";

// ============================================================================
// Helpers
// ============================================================================

function freshDb(): Database {
  resetDatabase();
  return getDatabase(":memory:");
}

function seedMemory(
  db: Database,
  overrides: Partial<{
    key: string;
    value: string;
    project_id: string;
  }> = {}
) {
  return createMemory(
    {
      key: overrides.key ?? `mem-${Math.random().toString(36).slice(2)}`,
      value: overrides.value ?? "some value",
      importance: 5,
      scope: "private",
      category: "knowledge",
      pinned: false,
      status: "active",
      project_id: overrides.project_id,
      tags: [],
    },
    "insert",
    db
  );
}

function seedMemories(db: Database, count: number, projectId?: string) {
  for (let i = 0; i < count; i++) {
    seedMemory(db, { key: `mem-${i}`, project_id: projectId });
  }
}

function seedEvents(db: Database, count: number, projectId?: string) {
  for (let i = 0; i < count; i++) {
    recordSynthesisEvent(
      { event_type: "saved", project_id: projectId },
      db
    );
  }
}

// ============================================================================
// checkShouldTrigger — maxRunIntervalHours exceeded (lines 97-102)
// ============================================================================

describe("checkShouldTrigger — maxRunIntervalHours exceeded", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("force triggers when maxRunIntervalHours is exceeded", () => {
    // Seed enough memories to pass the minimum threshold
    seedMemories(db, 60);

    // Create a run with a timestamp far in the past (48h ago)
    const run = createSynthesisRun({ triggered_by: "manual" }, db);
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE synthesis_runs SET started_at = ? WHERE id = ?", pastDate, run.id);

    const state = checkShouldTrigger(
      null,
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 9999, // would normally block
        maxRunIntervalHours: 24,
        minRunIntervalHours: 0,
      },
      db
    );

    expect(state.shouldTrigger).toBe(true);
    expect(state.reason).toContain("Max run interval");
    expect(state.reason).toContain("exceeded");
    expect(state.lastRunAt).toBe(pastDate);
  });

  test("does not force trigger when maxRunIntervalHours is not exceeded", () => {
    seedMemories(db, 60);

    // Create a run 2h ago, maxRunIntervalHours = 24
    const run = createSynthesisRun({ triggered_by: "manual" }, db);
    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE synthesis_runs SET started_at = ? WHERE id = ?", pastDate, run.id);

    const state = checkShouldTrigger(
      null,
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 9999,
        maxRunIntervalHours: 24,
        minRunIntervalHours: 0,
      },
      db
    );

    // Should NOT force trigger (only 2h passed, need 24h)
    // But also not enough events → shouldTrigger = false
    expect(state.shouldTrigger).toBe(false);
    expect(state.reason).toContain("events");
  });

  test("includes eventsSinceLastRun count when force triggering", () => {
    seedMemories(db, 60);

    const run = createSynthesisRun({ triggered_by: "manual" }, db);
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE synthesis_runs SET started_at = ? WHERE id = ?", pastDate, run.id);

    // Add some events
    seedEvents(db, 5);

    const state = checkShouldTrigger(
      null,
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 9999,
        maxRunIntervalHours: 24,
        minRunIntervalHours: 0,
      },
      db
    );

    expect(state.shouldTrigger).toBe(true);
    expect(state.eventsSinceLastRun).toBe(5);
  });
});

// ============================================================================
// triggerIfReady (lines 139-164)
// ============================================================================

describe("triggerIfReady", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns null when shouldTrigger is false", async () => {
    // No memories, no events → should not trigger
    const result = await triggerIfReady(null, null, {}, db);
    expect(result).toBeNull();
  });

  test("returns null when scheduler is disabled", async () => {
    const result = await triggerIfReady(null, null, { enabled: false }, db);
    expect(result).toBeNull();
  });

  test("creates a synthesis run when trigger conditions are met", async () => {
    seedMemories(db, 60);
    seedEvents(db, 110);

    const run = await triggerIfReady(
      null,
      "agent-1",
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 100,
        minRunIntervalHours: 0,
      },
      db
    );

    expect(run).not.toBeNull();
    expect(run!.triggered_by).toBe("scheduler");
    expect(run!.agent_id).toBe("agent-1");
    expect(run!.corpus_size).toBe(60);
    expect(run!.status).toBe("pending");
  });

  test("creates a run with project_id", async () => {
    const proj = registerProject("proj-1", "/tmp/proj-1", undefined, undefined, db);
    seedMemories(db, 60, proj.id);
    seedEvents(db, 110, proj.id);

    const run = await triggerIfReady(
      proj.id,
      "agent-1",
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 100,
        minRunIntervalHours: 0,
      },
      db
    );

    expect(run).not.toBeNull();
    expect(run!.project_id).toBe(proj.id);
    expect(run!.agent_id).toBe("agent-1");
  });

  test("creates a run with null agent_id", async () => {
    seedMemories(db, 60);
    seedEvents(db, 110);

    const run = await triggerIfReady(
      null,
      null,
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 100,
        minRunIntervalHours: 0,
      },
      db
    );

    expect(run).not.toBeNull();
    expect(run!.agent_id).toBeNull();
    expect(run!.project_id).toBeNull();
  });

  test("triggers via maxRunIntervalHours exceeded path", async () => {
    seedMemories(db, 60);

    // Create a past run
    const existingRun = createSynthesisRun({ triggered_by: "manual" }, db);
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE synthesis_runs SET started_at = ? WHERE id = ?", pastDate, existingRun.id);

    const run = await triggerIfReady(
      null,
      "agent-1",
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 9999,
        maxRunIntervalHours: 24,
        minRunIntervalHours: 0,
      },
      db
    );

    expect(run).not.toBeNull();
    expect(run!.triggered_by).toBe("scheduler");
    expect(run!.corpus_size).toBe(60);
  });
});

// ============================================================================
// getMemoryCount error handling (lines 185-186)
// ============================================================================

describe("getMemoryCount error handling", () => {
  test("returns shouldTrigger false when memory table is broken", () => {
    // Create a DB without the memories table to trigger the catch block
    const brokenDb = new Database(":memory:");

    // Only create synthesis tables, not the memories table
    brokenDb.run(`CREATE TABLE IF NOT EXISTS synthesis_runs (
      id TEXT PRIMARY KEY,
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      project_id TEXT,
      agent_id TEXT,
      corpus_size INTEGER NOT NULL DEFAULT 0,
      proposals_generated INTEGER NOT NULL DEFAULT 0,
      proposals_accepted INTEGER NOT NULL DEFAULT 0,
      proposals_rejected INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )`);
    brokenDb.run(`CREATE TABLE IF NOT EXISTS synthesis_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      memory_id TEXT,
      agent_id TEXT,
      project_id TEXT,
      session_id TEXT,
      query TEXT,
      importance_at_time REAL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // checkShouldTrigger calls getMemoryCount internally
    // Since there's no memories table, the query will fail and catch returns 0
    const state = checkShouldTrigger(
      null,
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 1,
        minRunIntervalHours: 0,
      },
      brokenDb
    );

    // getMemoryCount catches the error and returns 0 → not enough memories
    expect(state.shouldTrigger).toBe(false);
    expect(state.reason).toContain("memories");
  });

  test("returns shouldTrigger false for project-scoped query on broken db", () => {
    const brokenDb = new Database(":memory:");

    brokenDb.run(`CREATE TABLE IF NOT EXISTS synthesis_runs (
      id TEXT PRIMARY KEY,
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      project_id TEXT,
      agent_id TEXT,
      corpus_size INTEGER NOT NULL DEFAULT 0,
      proposals_generated INTEGER NOT NULL DEFAULT 0,
      proposals_accepted INTEGER NOT NULL DEFAULT 0,
      proposals_rejected INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )`);
    brokenDb.run(`CREATE TABLE IF NOT EXISTS synthesis_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      memory_id TEXT,
      agent_id TEXT,
      project_id TEXT,
      session_id TEXT,
      query TEXT,
      importance_at_time REAL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // This tests the project-scoped branch (line 174-178) hitting the catch
    const state = checkShouldTrigger(
      "proj-1",
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 1,
        minRunIntervalHours: 0,
      },
      brokenDb
    );

    expect(state.shouldTrigger).toBe(false);
    expect(state.reason).toContain("memories");
  });
});
