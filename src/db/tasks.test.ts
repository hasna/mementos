process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  addTaskComment,
  listTaskComments,
  deleteTaskComment,
  getTaskStats,
} from "./tasks.js";

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed','cancelled')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
      tags TEXT NOT NULL DEFAULT '[]',
      assigned_agent_id TEXT,
      project_id TEXT,
      session_id TEXT,
      parent_task_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      progress REAL NOT NULL DEFAULT 0,
      due_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ============================================================================
// createTask
// ============================================================================

describe("createTask", () => {
  it("creates a task with defaults", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Test task" });
    expect(task.subject).toBe("Test task");
    expect(task.status).toBe("pending");
    expect(task.priority).toBe("medium");
    expect(task.description).toBe("");
    expect(task.tags).toEqual([]);
    expect(task.metadata).toEqual({});
    expect(task.progress).toBe(0);
    expect(task.due_at).toBeNull();
    expect(task.started_at).toBeNull();
    expect(task.completed_at).toBeNull();
    expect(task.failed_at).toBeNull();
    expect(task.error).toBeNull();
    expect(task.assigned_agent_id).toBeNull();
    expect(task.project_id).toBeNull();
    expect(task.session_id).toBeNull();
    expect(task.parent_task_id).toBeNull();
    db.close();
  });

  it("creates a task with all fields", () => {
    const db = freshDb();
    const task = createTask(db, {
      subject: "Full task",
      description: "Do something",
      priority: "critical",
      tags: ["bug", "urgent"],
      assigned_agent_id: "agent-1",
      project_id: "proj-1",
      session_id: "sess-1",
      parent_task_id: "parent-1",
      metadata: { key: "value" },
      due_at: "2026-05-01T00:00:00Z",
    });
    expect(task.subject).toBe("Full task");
    expect(task.description).toBe("Do something");
    expect(task.priority).toBe("critical");
    expect(task.tags).toEqual(["bug", "urgent"]);
    expect(task.assigned_agent_id).toBe("agent-1");
    expect(task.project_id).toBe("proj-1");
    expect(task.session_id).toBe("sess-1");
    expect(task.parent_task_id).toBe("parent-1");
    expect(task.metadata).toEqual({ key: "value" });
    expect(task.due_at).toBe("2026-05-01T00:00:00Z");
    db.close();
  });
});

// ============================================================================
// getTask
// ============================================================================

describe("getTask", () => {
  it("returns null for nonexistent task", () => {
    const db = freshDb();
    expect(getTask(db, "nope")).toBeNull();
    db.close();
  });

  it("returns task by id", () => {
    const db = freshDb();
    const created = createTask(db, { subject: "Lookup me" });
    const found = getTask(db, created.id);
    expect(found).not.toBeNull();
    expect(found!.subject).toBe("Lookup me");
    db.close();
  });
});

// ============================================================================
// listTasks
// ============================================================================

describe("listTasks", () => {
  it("returns empty list when no tasks", () => {
    const db = freshDb();
    const result = listTasks(db);
    expect(result.tasks).toEqual([]);
    expect(result.count).toBe(0);
    db.close();
  });

  it("returns tasks ordered by priority then created_at", () => {
    const db = freshDb();
    createTask(db, { subject: "Low", priority: "low" });
    createTask(db, { subject: "High", priority: "high" });
    createTask(db, { subject: "Critical", priority: "critical" });
    createTask(db, { subject: "Medium", priority: "medium" });

    const result = listTasks(db);
    expect(result.tasks.map((t) => t.subject)).toEqual([
      "Critical", "High", "Medium", "Low",
    ]);
    expect(result.count).toBe(4);
    db.close();
  });

  it("filters by status", () => {
    const db = freshDb();
    createTask(db, { subject: "Pending" });
    createTask(db, { subject: "Done" });
    updateTask(db, listTasks(db, { status: "pending" }).tasks[1].id, { status: "completed" });

    const pending = listTasks(db, { status: "pending" });
    expect(pending.tasks.map((t) => t.subject)).toEqual(["Pending"]);
    db.close();
  });

  it("filters by tags", () => {
    const db = freshDb();
    createTask(db, { subject: "Bug", tags: ["bug"] });
    createTask(db, { subject: "Feature", tags: ["feature"] });

    const bugs = listTasks(db, { tags: ["bug"] });
    expect(bugs.tasks.map((t) => t.subject)).toEqual(["Bug"]);
    db.close();
  });

  it("filters by parent_task_id null", () => {
    const db = freshDb();
    const parent = createTask(db, { subject: "Parent" });
    createTask(db, { subject: "Child", parent_task_id: parent.id });

    const roots = listTasks(db, { parent_task_id: null });
    expect(roots.tasks.map((t) => t.subject)).toEqual(["Parent"]);
    db.close();
  });

  it("filters by parent_task_id value", () => {
    const db = freshDb();
    const parent = createTask(db, { subject: "Parent" });
    createTask(db, { subject: "Child", parent_task_id: parent.id });

    const children = listTasks(db, { parent_task_id: parent.id });
    expect(children.tasks.map((t) => t.subject)).toEqual(["Child"]);
    db.close();
  });

  it("applies limit and offset", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      createTask(db, { subject: `Task ${i}` });
    }

    const page = listTasks(db, { limit: 2, offset: 1 });
    expect(page.tasks).toHaveLength(2);
    expect(page.count).toBe(5);
    db.close();
  });
});

// ============================================================================
// updateTask
// ============================================================================

describe("updateTask", () => {
  it("returns null for nonexistent task", () => {
    const db = freshDb();
    expect(updateTask(db, "nope", { subject: "New" })).toBeNull();
    db.close();
  });

  it("returns unchanged task when no fields provided", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Test" });
    const updated = updateTask(db, task.id, {});
    expect(updated!.subject).toBe("Test");
    db.close();
  });

  it("updates subject and description", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Old" });
    const updated = updateTask(db, task.id, { subject: "New", description: "Desc" });
    expect(updated!.subject).toBe("New");
    expect(updated!.description).toBe("Desc");
    db.close();
  });

  it("sets started_at when transitioning to in_progress", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Work" });
    expect(task.started_at).toBeNull();

    const updated = updateTask(db, task.id, { status: "in_progress" });
    expect(updated!.started_at).not.toBeNull();
    expect(updated!.status).toBe("in_progress");
    db.close();
  });

  it("sets completed_at and progress when completing", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Work" });
    const updated = updateTask(db, task.id, { status: "completed" });
    expect(updated!.completed_at).not.toBeNull();
    expect(updated!.progress).toBe(1);
    db.close();
  });

  it("sets failed_at when failing", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Work" });
    const updated = updateTask(db, task.id, { status: "failed" });
    expect(updated!.failed_at).not.toBeNull();
    db.close();
  });

  it("updates tags and metadata", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Work" });
    const updated = updateTask(db, task.id, {
      tags: ["new-tag"],
      metadata: { foo: "bar" },
    });
    expect(updated!.tags).toEqual(["new-tag"]);
    expect(updated!.metadata).toEqual({ foo: "bar" });
    db.close();
  });

  it("updates due_at", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Work", due_at: "2026-01-01" });
    const updated = updateTask(db, task.id, { due_at: null });
    expect(updated!.due_at).toBeNull();
    db.close();
  });

  it("updates progress independently", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Work" });
    const updated = updateTask(db, task.id, { progress: 0.5 });
    expect(updated!.progress).toBe(0.5);
    db.close();
  });

  it("updates error field", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Work" });
    const updated = updateTask(db, task.id, { error: "Something went wrong" });
    expect(updated!.error).toBe("Something went wrong");
    db.close();
  });

  it("can assign to null agent", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Work", assigned_agent_id: "agent-1" });
    const updated = updateTask(db, task.id, { assigned_agent_id: null });
    expect(updated!.assigned_agent_id).toBeNull();
    db.close();
  });
});

// ============================================================================
// deleteTask
// ============================================================================

describe("deleteTask", () => {
  it("returns true when task deleted", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Delete me" });
    expect(deleteTask(db, task.id)).toBe(true);
    expect(getTask(db, task.id)).toBeNull();
    db.close();
  });

  it("returns false when task not found", () => {
    const db = freshDb();
    expect(deleteTask(db, "nope")).toBe(false);
    db.close();
  });
});

// ============================================================================
// Comments
// ============================================================================

describe("task comments", () => {
  it("adds a comment", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Commented task" });
    const comment = addTaskComment(db, task.id, "Good job", "agent-1");
    expect(comment.body).toBe("Good job");
    expect(comment.agent_id).toBe("agent-1");
    expect(comment.task_id).toBe(task.id);
    db.close();
  });

  it("adds a comment without agent", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Anonymous comment" });
    const comment = addTaskComment(db, task.id, "No agent");
    expect(comment.agent_id).toBeNull();
    db.close();
  });

  it("lists comments in order", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Multi-comment" });
    addTaskComment(db, task.id, "First");
    addTaskComment(db, task.id, "Second");
    addTaskComment(db, task.id, "Third");

    const result = listTaskComments(db, task.id);
    expect(result.count).toBe(3);
    expect(result.comments.map((c) => c.body)).toEqual(["First", "Second", "Third"]);
    db.close();
  });

  it("returns empty list for no comments", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "No comments" });
    const result = listTaskComments(db, task.id);
    expect(result.comments).toEqual([]);
    expect(result.count).toBe(0);
    db.close();
  });

  it("deletes a comment", () => {
    const db = freshDb();
    const task = createTask(db, { subject: "Delete comment test" });
    const comment = addTaskComment(db, task.id, "Temp");
    expect(deleteTaskComment(db, comment.id)).toBe(true);
    expect(deleteTaskComment(db, "nope")).toBe(false);
    db.close();
  });
});

// ============================================================================
// Stats
// ============================================================================

describe("getTaskStats", () => {
  it("returns zero stats for empty db", () => {
    const db = freshDb();
    const stats = getTaskStats(db);
    expect(stats.total).toBe(0);
    expect(stats.overdue).toBe(0);
    expect(stats.by_status.pending).toBe(0);
    expect(stats.by_priority.medium).toBe(0);
    db.close();
  });

  it("returns stats by status and priority", () => {
    const db = freshDb();
    createTask(db, { subject: "A", priority: "critical" });
    createTask(db, { subject: "B", priority: "high" });
    createTask(db, { subject: "C", priority: "low" });
    const t4 = createTask(db, { subject: "D", priority: "medium" });
    updateTask(db, t4.id, { status: "completed" });

    const stats = getTaskStats(db);
    expect(stats.total).toBe(4);
    expect(stats.by_status.pending).toBe(3);
    expect(stats.by_status.completed).toBe(1);
    expect(stats.by_priority.critical).toBe(1);
    expect(stats.by_priority.high).toBe(1);
    db.close();
  });

  it("counts overdue tasks", () => {
    const db = freshDb();
    createTask(db, { subject: "Overdue", due_at: "2020-01-01T00:00:00Z" });
    createTask(db, { subject: "Future", due_at: "2030-01-01T00:00:00Z" });

    const stats = getTaskStats(db);
    expect(stats.overdue).toBe(1);
    db.close();
  });

  it("filters stats by project_id", () => {
    const db = freshDb();
    createTask(db, { subject: "Proj A", project_id: "proj-a" });
    createTask(db, { subject: "Proj B", project_id: "proj-b" });

    const statsA = getTaskStats(db, { project_id: "proj-a" });
    expect(statsA.total).toBe(1);
    db.close();
  });

  it("filters stats by agent_id", () => {
    const db = freshDb();
    createTask(db, { subject: "Agent 1", assigned_agent_id: "agent-1" });
    createTask(db, { subject: "Agent 2", assigned_agent_id: "agent-2" });

    const stats = getTaskStats(db, { agent_id: "agent-1" });
    expect(stats.total).toBe(1);
    db.close();
  });
});
