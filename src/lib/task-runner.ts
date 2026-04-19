/**
 * Background task processor — polls for pending tasks every minute,
 * executes them via registered handlers, and updates status.
 *
 * Handlers can be registered for specific task types (identified by tags or metadata.type).
 * A default handler logs and marks failed if no specific handler matches.
 */

import { getDatabase } from "../db/database.js";
import { getTask, updateTask, listTasks, addTaskComment } from "../db/tasks.js";
import type { Task } from "../db/tasks.js";

// ============================================================================
// Types
// ============================================================================

export interface TaskHandlerContext {
  task: Task;
  updateProgress: (progress: number) => void;
  addComment: (body: string, agentId?: string) => void;
}

export type TaskHandler = (ctx: TaskHandlerContext) => Promise<void>;

export interface TaskRunnerStats {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
  totalProcessed: number;
}

// ============================================================================
// Handler registry
// ============================================================================

const _handlers = new Map<string, TaskHandler>();
let _defaultHandler: TaskHandler | null = null;

/** Register a handler for tasks matching a specific tag or metadata.type. */
export function registerTaskHandler(type: string, handler: TaskHandler): void {
  _handlers.set(type, handler);
}

/** Set the fallback handler for tasks with no matching handler. */
export function setDefaultTaskHandler(handler: TaskHandler): void {
  _defaultHandler = handler;
}

/** Resolve the handler for a task by tags first, then metadata.type. */
function resolveHandler(task: Task): TaskHandler | null {
  // Check tags
  for (const tag of task.tags) {
    const h = _handlers.get(tag);
    if (h) return h;
  }
  // Check metadata.type
  const metaType = task.metadata?.["type"] as string | undefined;
  if (metaType) {
    const h = _handlers.get(metaType);
    if (h) return h;
  }
  return _defaultHandler;
}

// ============================================================================
// Internal state
// ============================================================================

let _workerStarted = false;
let _processing = false;
let _totalProcessed = 0;
let _pollIntervalMs = 60_000; // default: every minute

// ============================================================================
// Exported API
// ============================================================================

/**
 * Start the task runner polling loop.
 * Idempotent — safe to call multiple times.
 * @param intervalMs Poll interval in milliseconds (default: 60000 = 1 minute)
 */
export function startTaskRunner(intervalMs?: number): void {
  if (_workerStarted) return;
  _workerStarted = true;
  if (intervalMs) _pollIntervalMs = intervalMs;

  console.log(`[task-runner] Started, polling every ${_pollIntervalMs / 1000}s`);

  // Initial immediate poll
  void _tick();

  // Then poll on interval
  setInterval(() => {
    void _tick();
  }, _pollIntervalMs);
}

/** Process one tick — claim and execute the highest priority pending task. */
export async function _tick(): Promise<void> {
  if (_processing) return;

  let task: Task | null = null;
  try {
    const db = getDatabase();
    const result = listTasks(db, { status: "pending", limit: 1 });
    if (result.tasks.length === 0) return;
    task = result.tasks[0] ?? null;
  } catch (e) {
    console.error("[task-runner] Failed to list pending tasks:", e);
    return;
  }

  if (!task) return;

  _processing = true;

  // Claim the task
  try {
    const db = getDatabase();
    updateTask(db, task.id, { status: "in_progress" });
    // Re-read to get updated timestamps
    task = getTask(db, task.id);
  } catch (e) {
    console.error("[task-runner] Failed to claim task:", e);
    _processing = false;
    return;
  }

  const handler = resolveHandler(task!);

  if (!handler) {
    // No handler — mark failed
    console.warn(
      `[task-runner] No handler for task: ${task!.subject} (tags: ${JSON.stringify(task!.tags)}, meta.type: ${task!.metadata?.["type"]})`
    );
    try {
      const db = getDatabase();
      updateTask(db, task!.id, {
        status: "failed",
        error: "No handler registered for this task type",
      });
    } catch { /* ignore */ }
    _processing = false;
    _totalProcessed++;
    return;
  }

  // Execute
  const taskId = task!.id;
  let progress = 0;

  const ctx: TaskHandlerContext = {
    task: task!,
    updateProgress: (p: number) => {
      progress = Math.min(1, Math.max(0, p));
      try {
        const db = getDatabase();
        updateTask(db, taskId, { progress });
      } catch { /* ignore */ }
    },
    addComment: (body: string, agentId?: string) => {
      try {
        const db = getDatabase();
        addTaskComment(db, taskId, body, agentId);
      } catch { /* ignore */ }
    },
  };

  try {
    await handler(ctx);

    // Success
    const db = getDatabase();
    updateTask(db, taskId, { status: "completed", progress: 1 });
    console.log(`[task-runner] Completed: ${task!.subject}`);
  } catch (e) {
    // Failure
    const errorMsg = e instanceof Error ? e.message : String(e);
    try {
      const db = getDatabase();
      updateTask(db, taskId, { status: "failed", error: errorMsg });
    } catch { /* ignore */ }
    console.error(`[task-runner] Failed: ${task!.subject} — ${errorMsg}`);
  } finally {
    _processing = false;
    _totalProcessed++;
  }
}

/** Get runtime stats. */
export function getTaskRunnerStats(): TaskRunnerStats {
  try {
    const db = getDatabase();
    const rows = db
      .query("SELECT status, COUNT(*) as c FROM tasks GROUP BY status")
      .all() as { status: string; c: number }[];

    const stats: TaskRunnerStats = {
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      totalProcessed: _totalProcessed,
    };
    for (const row of rows) {
      switch (row.status) {
        case "pending": stats.pending = row.c; break;
        case "in_progress": stats.inProgress = row.c; break;
        case "completed": stats.completed = row.c; break;
        case "failed": stats.failed = row.c; break;
        case "cancelled": stats.cancelled = row.c; break;
      }
    }
    return stats;
  } catch {
    return {
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      totalProcessed: _totalProcessed,
    };
  }
}
