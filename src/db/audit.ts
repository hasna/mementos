/**
 * Immutable audit log queries.
 * The audit_log table is append-only — never UPDATE or DELETE from it.
 */

import { Database } from "bun:sqlite";
import { getDatabase } from "./database.js";

export interface AuditEntry {
  id: string;
  memory_id: string;
  memory_key: string | null;
  operation: "create" | "update" | "delete" | "archive" | "restore" | "read";
  agent_id: string | null;
  old_value_hash: string | null;
  new_value_hash: string | null;
  changes: Record<string, unknown>;
  created_at: string;
}

function parseAuditRow(row: Record<string, unknown>): AuditEntry {
  return {
    id: row["id"] as string,
    memory_id: row["memory_id"] as string,
    memory_key: (row["memory_key"] as string) || null,
    operation: row["operation"] as AuditEntry["operation"],
    agent_id: (row["agent_id"] as string) || null,
    old_value_hash: (row["old_value_hash"] as string) || null,
    new_value_hash: (row["new_value_hash"] as string) || null,
    changes: JSON.parse((row["changes"] as string) || "{}"),
    created_at: row["created_at"] as string,
  };
}

/**
 * Get audit trail for a specific memory.
 */
export function getMemoryAuditTrail(
  memoryId: string,
  limit: number = 50,
  db?: Database
): AuditEntry[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM memory_audit_log WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(memoryId, limit) as Record<string, unknown>[];
  return rows.map(parseAuditRow);
}

/**
 * Export full audit log for compliance reporting.
 */
export function exportAuditLog(
  options: {
    since?: string;
    until?: string;
    operation?: string;
    agent_id?: string;
    limit?: number;
  } = {},
  db?: Database
): AuditEntry[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options.since) {
    conditions.push("created_at >= ?");
    params.push(options.since);
  }
  if (options.until) {
    conditions.push("created_at <= ?");
    params.push(options.until);
  }
  if (options.operation) {
    conditions.push("operation = ?");
    params.push(options.operation);
  }
  if (options.agent_id) {
    conditions.push("agent_id = ?");
    params.push(options.agent_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit || 1000;

  const rows = d
    .query(`SELECT * FROM memory_audit_log ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(parseAuditRow);
}

/**
 * Get audit stats — operation counts, most active agents, etc.
 */
export function getAuditStats(db?: Database): {
  total_entries: number;
  by_operation: Record<string, number>;
  recent_24h: number;
} {
  const d = db || getDatabase();

  const total = (d.query("SELECT COUNT(*) as c FROM memory_audit_log").get() as { c: number }).c;

  const byOp = d
    .query("SELECT operation, COUNT(*) as c FROM memory_audit_log GROUP BY operation")
    .all() as { operation: string; c: number }[];

  const recent = (d
    .query("SELECT COUNT(*) as c FROM memory_audit_log WHERE created_at >= datetime('now', '-1 day')")
    .get() as { c: number }).c;

  return {
    total_entries: total,
    by_operation: Object.fromEntries(byOp.map((r) => [r.operation, r.c])),
    recent_24h: recent,
  };
}
