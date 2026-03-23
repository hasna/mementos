import { Database } from "bun:sqlite";
import type { ToolEvent, CreateToolEventInput, ToolStats } from "../types/index.js";
import { getDatabase, uuid, now } from "./database.js";

// ============================================================================
// Helpers
// ============================================================================

function parseToolEventRow(row: Record<string, unknown>): ToolEvent {
  return {
    id: row["id"] as string,
    tool_name: row["tool_name"] as string,
    action: (row["action"] as string) || null,
    success: !!(row["success"] as number),
    error_type: (row["error_type"] as ToolEvent["error_type"]) || null,
    error_message: (row["error_message"] as string) || null,
    tokens_used: (row["tokens_used"] as number) ?? null,
    latency_ms: (row["latency_ms"] as number) ?? null,
    context: (row["context"] as string) || null,
    lesson: (row["lesson"] as string) || null,
    when_to_use: (row["when_to_use"] as string) || null,
    agent_id: (row["agent_id"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    session_id: (row["session_id"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    created_at: row["created_at"] as string,
  };
}

// ============================================================================
// Create
// ============================================================================

export function saveToolEvent(input: CreateToolEventInput, db?: Database): ToolEvent {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  const metadataJson = JSON.stringify(input.metadata || {});

  d.run(
    `INSERT INTO tool_events (id, tool_name, action, success, error_type, error_message, tokens_used, latency_ms, context, lesson, when_to_use, agent_id, project_id, session_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.tool_name,
      input.action || null,
      input.success ? 1 : 0,
      input.error_type || null,
      input.error_message || null,
      input.tokens_used ?? null,
      input.latency_ms ?? null,
      input.context || null,
      input.lesson || null,
      input.when_to_use || null,
      input.agent_id || null,
      input.project_id || null,
      input.session_id || null,
      metadataJson,
      timestamp,
    ]
  );

  return getToolEvent(id, d)!;
}

// ============================================================================
// Read
// ============================================================================

export function getToolEvent(id: string, db?: Database): ToolEvent | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM tool_events WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return parseToolEventRow(row);
}

export function getToolEvents(
  filters: {
    tool_name?: string;
    agent_id?: string;
    project_id?: string;
    success?: boolean;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  },
  db?: Database
): ToolEvent[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filters.tool_name) {
    conditions.push("tool_name = ?");
    params.push(filters.tool_name);
  }
  if (filters.agent_id) {
    conditions.push("agent_id = ?");
    params.push(filters.agent_id);
  }
  if (filters.project_id) {
    conditions.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters.success !== undefined) {
    conditions.push("success = ?");
    params.push(filters.success ? 1 : 0);
  }
  if (filters.from_date) {
    conditions.push("created_at >= ?");
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push("created_at <= ?");
    params.push(filters.to_date);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const rows = d
    .query(`SELECT * FROM tool_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(parseToolEventRow);
}

// ============================================================================
// Stats
// ============================================================================

export function getToolStats(
  tool_name: string,
  project_id?: string,
  db?: Database
): ToolStats {
  const d = db || getDatabase();

  let where = "WHERE tool_name = ?";
  const params: (string | number)[] = [tool_name];
  if (project_id) {
    where += " AND project_id = ?";
    params.push(project_id);
  }

  const stats = d.query(
    `SELECT
      COUNT(*) as total_calls,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failure_count,
      AVG(CASE WHEN tokens_used IS NOT NULL THEN tokens_used END) as avg_tokens,
      AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) as avg_latency_ms,
      MAX(created_at) as last_used
    FROM tool_events ${where}`
  ).get(...params) as Record<string, unknown>;

  const total = (stats["total_calls"] as number) || 0;
  const successCount = (stats["success_count"] as number) || 0;

  // Common errors
  const errorRows = d.query(
    `SELECT error_type, COUNT(*) as count
     FROM tool_events ${where} AND error_type IS NOT NULL
     GROUP BY error_type ORDER BY count DESC LIMIT 5`
  ).all(...params) as { error_type: string; count: number }[];

  return {
    tool_name,
    total_calls: total,
    success_count: successCount,
    failure_count: (stats["failure_count"] as number) || 0,
    success_rate: total > 0 ? successCount / total : 0,
    avg_tokens: (stats["avg_tokens"] as number) ?? null,
    avg_latency_ms: (stats["avg_latency_ms"] as number) ?? null,
    common_errors: errorRows,
    last_used: (stats["last_used"] as string) || "",
  };
}

// ============================================================================
// Lessons
// ============================================================================

export function getToolLessons(
  tool_name: string,
  project_id?: string,
  limit?: number,
  db?: Database
): { lesson: string; when_to_use: string | null; created_at: string }[] {
  const d = db || getDatabase();

  let where = "WHERE tool_name = ? AND lesson IS NOT NULL";
  const params: (string | number)[] = [tool_name];
  if (project_id) {
    where += " AND project_id = ?";
    params.push(project_id);
  }

  const rows = d.query(
    `SELECT lesson, when_to_use, created_at FROM tool_events ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit || 20) as { lesson: string; when_to_use: string | null; created_at: string }[];

  return rows;
}

// ============================================================================
// Delete
// ============================================================================

export function deleteToolEvents(
  filters: {
    tool_name?: string;
    agent_id?: string;
    project_id?: string;
    before_date?: string;
  },
  db?: Database
): number {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters.tool_name) {
    conditions.push("tool_name = ?");
    params.push(filters.tool_name);
  }
  if (filters.agent_id) {
    conditions.push("agent_id = ?");
    params.push(filters.agent_id);
  }
  if (filters.project_id) {
    conditions.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters.before_date) {
    conditions.push("created_at < ?");
    params.push(filters.before_date);
  }

  if (conditions.length === 0) return 0; // Safety: never delete everything without a filter

  const result = d.run(
    `DELETE FROM tool_events WHERE ${conditions.join(" AND ")}`,
    params
  );

  return result.changes;
}
