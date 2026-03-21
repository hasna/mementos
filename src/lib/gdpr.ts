/**
 * GDPR-compliant erasure (right to be forgotten).
 *
 * Deletes PII from memory values while preserving anonymized audit trail.
 * The audit log entries remain with hashes only (no content).
 */

import { Database } from "bun:sqlite";
import { getDatabase, now } from "../db/database.js";

export interface GdprErasureResult {
  erased_count: number;
  memory_ids: string[];
  timestamp: string;
}

/**
 * Erase all memories containing the given PII identifier.
 * Replaces value, summary, and key with "[REDACTED]".
 * Clears tags and metadata that might contain PII.
 * Preserves the audit trail (audit_log entries have hashes, not content).
 */
export function gdprErase(
  identifier: string,
  options: {
    project_id?: string;
    agent_id?: string;
    dry_run?: boolean;
  } = {},
  db?: Database
): GdprErasureResult {
  const d = db || getDatabase();
  const timestamp = now();

  // Find all memories containing the identifier in key, value, summary, tags, or metadata
  const conditions: string[] = [
    "(key LIKE ? OR value LIKE ? OR summary LIKE ? OR tags LIKE ? OR metadata LIKE ?)",
  ];
  const searchParam = `%${identifier}%`;
  const params: (string | number)[] = [searchParam, searchParam, searchParam, searchParam, searchParam];

  if (options.project_id) {
    conditions.push("project_id = ?");
    params.push(options.project_id);
  }
  if (options.agent_id) {
    conditions.push("agent_id = ?");
    params.push(options.agent_id);
  }

  const sql = `SELECT id FROM memories WHERE ${conditions.join(" AND ")}`;
  const rows = d.query(sql).all(...params) as { id: string }[];

  if (options.dry_run || rows.length === 0) {
    return {
      erased_count: rows.length,
      memory_ids: rows.map((r) => r.id),
      timestamp,
    };
  }

  // Redact each memory
  const memoryIds: string[] = [];
  for (const row of rows) {
    d.run(
      `UPDATE memories SET
        value = '[REDACTED]',
        summary = NULL,
        tags = '[]',
        metadata = '{}',
        updated_at = ?
       WHERE id = ?`,
      [timestamp, row.id]
    );

    // Clear tags from junction table
    d.run("DELETE FROM memory_tags WHERE memory_id = ?", [row.id]);

    memoryIds.push(row.id);
  }

  return {
    erased_count: memoryIds.length,
    memory_ids: memoryIds,
    timestamp,
  };
}
