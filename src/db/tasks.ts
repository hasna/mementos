// ============================================================================
// Tasks — granular task management for agent coordination
// ============================================================================

import { SqliteAdapter as Database } from "@hasna/cloud";
import { now, uuid } from "./database.js";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type TaskPriority = "critical" | "high" | "medium" | "low";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  assigned_agent_id: string | null;
  project_id: string | null;
  session_id: string | null;
  parent_task_id: string | null;
  metadata: Record<string, unknown>;
  progress: number;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
  agent_id: string | null;
  body: string;
  created_at: string;
}

export interface CreateTaskInput {
  subject: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  assigned_agent_id?: string;
  project_id?: string;
  session_id?: string;
  parent_task_id?: string;
  metadata?: Record<string, unknown>;
  due_at?: string;
}

export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  assigned_agent_id?: string | null;
  metadata?: Record<string, unknown>;
  progress?: number;
  due_at?: string | null;
  error?: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

function parseTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    subject: row.subject as string,
    description: (row.description as string) ?? "",
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    tags: JSON.parse((row.tags as string) ?? "[]"),
    assigned_agent_id: (row.assigned_agent_id as string) ?? null,
    project_id: (row.project_id as string) ?? null,
    session_id: (row.session_id as string) ?? null,
    parent_task_id: (row.parent_task_id as string) ?? null,
    metadata: JSON.parse((row.metadata as string) ?? "{}"),
    progress: row.progress as number,
    due_at: (row.due_at as string) ?? null,
    started_at: (row.started_at as string) ?? null,
    completed_at: (row.completed_at as string) ?? null,
    failed_at: (row.failed_at as string) ?? null,
    error: (row.error as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ============================================================================
// CRUD
// ============================================================================

export function createTask(db: Database, input: CreateTaskInput): Task {
  const id = uuid();
  const ts = now();
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, tags, assigned_agent_id, project_id, session_id, parent_task_id, metadata, due_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.subject,
      input.description ?? "",
      input.priority ?? "medium",
      JSON.stringify(input.tags ?? []),
      input.assigned_agent_id ?? null,
      input.project_id ?? null,
      input.session_id ?? null,
      input.parent_task_id ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.due_at ?? null,
      ts,
      ts,
    ]
  );
  return db.query("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task;
}

export function getTask(db: Database, id: string): Task | null {
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? parseTask(row as Record<string, unknown>) : null;
}

export function listTasks(db: Database, filter?: {
  status?: TaskStatus;
  priority?: TaskPriority;
  assigned_agent_id?: string;
  project_id?: string;
  session_id?: string;
  parent_task_id?: string | null;
  tags?: string[];
  limit?: number;
  offset?: number;
}): { tasks: Task[]; count: number } {
  let sql = "SELECT * FROM tasks WHERE 1=1";
  let countSql = "SELECT COUNT(*) as c FROM tasks WHERE 1=1";
  const params: (string | number | null)[] = [];
  const countParams: (string | number | null)[] = [];

  if (filter?.status) {
    sql += " AND status = ?";
    countSql += " AND status = ?";
    params.push(filter.status);
    countParams.push(filter.status);
  }
  if (filter?.priority) {
    sql += " AND priority = ?";
    countSql += " AND priority = ?";
    params.push(filter.priority);
    countParams.push(filter.priority);
  }
  if (filter?.assigned_agent_id) {
    sql += " AND assigned_agent_id = ?";
    countSql += " AND assigned_agent_id = ?";
    params.push(filter.assigned_agent_id);
    countParams.push(filter.assigned_agent_id);
  }
  if (filter?.project_id) {
    sql += " AND project_id = ?";
    countSql += " AND project_id = ?";
    params.push(filter.project_id);
    countParams.push(filter.project_id);
  }
  if (filter?.session_id) {
    sql += " AND session_id = ?";
    countSql += " AND session_id = ?";
    params.push(filter.session_id);
    countParams.push(filter.session_id);
  }
  if (filter?.parent_task_id !== undefined) {
    if (filter.parent_task_id === null) {
      sql += " AND parent_task_id IS NULL";
      countSql += " AND parent_task_id IS NULL";
    } else {
      sql += " AND parent_task_id = ?";
      countSql += " AND parent_task_id = ?";
      params.push(filter.parent_task_id);
      countParams.push(filter.parent_task_id);
    }
  }
  if (filter?.tags?.length) {
    sql += " AND json_overlap(tags, ?)";
    countSql += " AND json_overlap(tags, ?)";
    params.push(JSON.stringify(filter.tags));
    countParams.push(JSON.stringify(filter.tags));
  }

  sql += " ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, created_at ASC";

  if (filter?.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }
  if (filter?.offset !== undefined) {
    sql += " OFFSET ?";
    params.push(filter.offset);
  }

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  const countRow = db.query(countSql).get(...countParams) as { c: number };

  return { tasks: rows.map(parseTask), count: countRow.c };
}

export function updateTask(db: Database, id: string, input: UpdateTaskInput): Task | null {
  const existing = getTask(db, id);
  if (!existing) return null;

  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  const ts = now();

  if (input.subject !== undefined) { updates.push("subject = ?"); params.push(input.subject); }
  if (input.description !== undefined) { updates.push("description = ?"); params.push(input.description); }
  if (input.status !== undefined) {
    updates.push("status = ?");
    params.push(input.status);
    if (input.status === "in_progress" && !existing.started_at) {
      updates.push("started_at = ?");
      params.push(ts);
    }
    if (input.status === "completed") {
      updates.push("completed_at = ?");
      params.push(ts);
      updates.push("progress = ?");
      params.push(1);
    }
    if (input.status === "failed") {
      updates.push("failed_at = ?");
      params.push(ts);
    }
  }
  if (input.priority !== undefined) { updates.push("priority = ?"); params.push(input.priority); }
  if (input.tags !== undefined) { updates.push("tags = ?"); params.push(JSON.stringify(input.tags)); }
  if (input.assigned_agent_id !== undefined) { updates.push("assigned_agent_id = ?"); params.push(input.assigned_agent_id); }
  if (input.metadata !== undefined) { updates.push("metadata = ?"); params.push(JSON.stringify(input.metadata)); }
  if (input.progress !== undefined) { updates.push("progress = ?"); params.push(input.progress); }
  if (input.due_at !== undefined) { updates.push("due_at = ?"); params.push(input.due_at); }
  if (input.error !== undefined) { updates.push("error = ?"); params.push(input.error); }

  if (updates.length === 0) return existing;

  updates.push("updated_at = ?");
  params.push(ts);
  params.push(id);

  db.run(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`, ...params);
  return getTask(db, id);
}

export function deleteTask(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM tasks WHERE id = ?", id);
  return result.changes > 0;
}

// ============================================================================
// Comments
// ============================================================================

export function addTaskComment(db: Database, taskId: string, body: string, agentId?: string): TaskComment {
  const id = uuid();
  db.run(
    "INSERT INTO task_comments (id, task_id, agent_id, body) VALUES (?, ?, ?, ?)",
    [id, taskId, agentId ?? null, body]
  );
  const row = db.query("SELECT * FROM task_comments WHERE id = ?").get(id);
  return row as unknown as TaskComment;
}

export function listTaskComments(db: Database, taskId: string): { comments: TaskComment[]; count: number } {
  const rows = db.query(
    "SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC"
  ).all(taskId) as Record<string, unknown>[];
  return { comments: rows as unknown as TaskComment[], count: rows.length };
}

export function deleteTaskComment(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM task_comments WHERE id = ?", id);
  return result.changes > 0;
}

// ============================================================================
// Stats
// ============================================================================

export function getTaskStats(db: Database, filter?: { project_id?: string; agent_id?: string }): {
  total: number;
  by_status: Record<TaskStatus, number>;
  by_priority: Record<TaskPriority, number>;
  overdue: number;
} {
  let where = "WHERE 1=1";
  const params: (string | null)[] = [];

  if (filter?.project_id) {
    where += " AND project_id = ?";
    params.push(filter.project_id);
  }
  if (filter?.agent_id) {
    where += " AND assigned_agent_id = ?";
    params.push(filter.agent_id);
  }

  const total = (db.query(`SELECT COUNT(*) as c FROM tasks ${where}`).get(...params) as { c: number }).c;

  const byStatus: Partial<Record<TaskStatus, number>> = {};
  const statusRows = db.query(`SELECT status, COUNT(*) as c FROM tasks ${where} GROUP BY status`).all(...params) as { status: TaskStatus; c: number }[];
  for (const row of statusRows) byStatus[row.status] = row.c;

  const byPriority: Partial<Record<TaskPriority, number>> = {};
  const priorityRows = db.query(`SELECT priority, COUNT(*) as c FROM tasks ${where} GROUP BY priority`).all(...params) as { priority: TaskPriority; c: number }[];
  for (const row of priorityRows) byPriority[row.priority] = row.c;

  const overdue = (db.query(
    `SELECT COUNT(*) as c FROM tasks ${where} AND status != 'completed' AND status != 'cancelled' AND due_at IS NOT NULL AND due_at < datetime('now')`
  ).get(...params) as { c: number }).c;

  return {
    total,
    by_status: {
      pending: byStatus["pending"] ?? 0,
      in_progress: byStatus["in_progress"] ?? 0,
      completed: byStatus["completed"] ?? 0,
      failed: byStatus["failed"] ?? 0,
      cancelled: byStatus["cancelled"] ?? 0,
    },
    by_priority: {
      critical: byPriority["critical"] ?? 0,
      high: byPriority["high"] ?? 0,
      medium: byPriority["medium"] ?? 0,
      low: byPriority["low"] ?? 0,
    },
    overdue,
  };
}
