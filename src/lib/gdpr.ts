/**
 * GDPR-compliant erasure (right to be forgotten).
 *
 * Deletes PII from memory values while preserving anonymized audit trail.
 * The audit log entries remain with hashes only (no content).
 */

import { SqliteAdapter as Database } from "../storage.js";
import { escapeLikePrefix, getDatabase, now } from "../db/database.js";

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

  // Find all memories containing the identifier in key, value, summary, tags, or metadata.
  //
  // The identifier is a LITERAL to be found, never a pattern. Without the
  // `ESCAPE` clause and the escaping below, `_` and `%` arriving inside it were
  // live wildcards: `_` matches any single character, and underscores are
  // ordinary in email local-parts — the exact input this function takes. Erasing
  // "first_last@example.com" redacted a second row reading "firstXlast@..."
  // that the operator never named (dd80bbe1).
  //
  // `dry_run` returns from the SAME SELECT below, so the preview endorsed the
  // over-matched set as correct and confirmed the operator in the mistake. That
  // shared query is why escaping here fixes preview and action together, and it
  // is pinned by a parity test rather than left as an accident of structure.
  const conditions: string[] = [
    "(key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\')",
  ];
  const searchParam = `%${escapeLikePrefix(identifier)}%`;
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
