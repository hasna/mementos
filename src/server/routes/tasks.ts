// ============================================================================
// Task routes — CRUD + comments + stats
// ============================================================================

import { getDatabase } from "../../db/database.js";
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
} from "../../db/tasks.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson, getSearchParams } from "../helpers.js";

// ============================================================================
// Task CRUD
// ============================================================================

addRoute("POST", "/api/tasks", async (req, _url) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  if (!body.subject) return errorResponse("subject is required", 400);
  const task = createTask(getDatabase(), body as any);
  return json(task, 201);
});

addRoute("GET", "/api/tasks", async (_req, url) => {
  const q = getSearchParams(url);
  const filter: Record<string, unknown> = {};
  for (const key of ["status", "priority", "assigned_agent_id", "project_id", "session_id", "parent_task_id"]) {
    if (q[key]) filter[key] = q[key];
  }
  if (q["tags"]) filter.tags = (q["tags"] as string).split(",");
  if (q["limit"]) filter.limit = parseInt(q["limit"] as string);
  if (q["offset"]) filter.offset = parseInt(q["offset"] as string);

  return json(listTasks(getDatabase(), filter as Parameters<typeof listTasks>[1]));
});

addRoute("GET", "/api/tasks/stats", async (_req, url) => {
  const q = getSearchParams(url);
  const filter: { project_id?: string; agent_id?: string } = {};
  if (q["project_id"]) filter.project_id = q["project_id"] as string;
  if (q["agent_id"]) filter.agent_id = q["agent_id"] as string;
  return json(getTaskStats(getDatabase(), filter));
});

addRoute("GET", "/api/tasks/:id", async (_req, _url, params) => {
  const task = getTask(getDatabase(), params.id!);
  if (!task) return errorResponse("Task not found", 404);
  return json(task);
});

addRoute("PATCH", "/api/tasks/:id", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  const task = updateTask(getDatabase(), params.id!, body);
  if (!task) return errorResponse("Task not found", 404);
  return json(task);
});

addRoute("DELETE", "/api/tasks/:id", async (_req, _url, params) => {
  const deleted = deleteTask(getDatabase(), params.id!);
  if (!deleted) return errorResponse("Task not found", 404);
  return json({ deleted: true });
});

// ============================================================================
// Task comments
// ============================================================================

addRoute("GET", "/api/tasks/:id/comments", async (_req, _url, params) => {
  return json(listTaskComments(getDatabase(), params.id!));
});

addRoute("POST", "/api/tasks/:id/comments", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  if (!body.body) return errorResponse("body is required", 400);
  const comment = addTaskComment(getDatabase(), params.id!, body.body as string, body.agent_id as string | undefined);
  return json(comment, 201);
});

addRoute("DELETE", "/api/tasks/:id/comments/:commentId", async (_req, _url, params) => {
  const deleted = deleteTaskComment(getDatabase(), params.commentId!);
  if (!deleted) return errorResponse("Comment not found", 404);
  return json({ deleted: true });
});
