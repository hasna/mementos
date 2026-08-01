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
 *
 * Replaces `value` with "[REDACTED]", clears `summary`, `tags` and `metadata`,
 * and rewrites `key` to `[REDACTED]:<memory id>` — per-row, for the reason given
 * at the UPDATE below. Nothing derived from the original key is retained.
 *
 * Preserves the audit trail (audit_log entries have hashes, not content).
 *
 * NOTE: an erased memory is no longer reachable by its original key, so a later
 * `save` under that key creates a NEW record rather than merging into the
 * tombstone. That is deliberate: silently resurrecting an erased row and
 * re-associating it with the data subject is precisely what erasure must
 * prevent. Every foreign key into `memories` references `memories(id)` — no
 * relational integrity depends on `key`, which is a human lookup handle only.
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

  // An absent identifier must never erase. `%${identifier}%` collapses to `%%`
  // on an empty string, which matches EVERY row — so `gdprErase("")` redacted
  // the whole store, and a single space (`% %`) reached every row containing
  // one. Escaping cannot reach this: there is nothing to escape (80b3c695).
  //
  // This mirrors `resolvePartialId` in `db/database.ts`, which already carries
  // `if (partialId === "") return null;` against the identical `LIKE '%'`
  // hazard — the NON-destructive lookup had the guard and the IRREVERSIBLE
  // erase did not.
  //
  // The check is placed BEFORE the SELECT, so it covers `dry_run` and the erase
  // together. That matters: the two share one query, so a preview of an empty
  // identifier reported "would erase <the entire store>" as a correct answer and
  // CONFIRMED the operator in the mistake instead of warning them. Both paths
  // are pinned by tests rather than left as an accident of ordering.
  //
  // `trim()` decides emptiness only. The identifier itself is matched
  // UNTRIMMED — trimming the matched value would silently change which rows a
  // legitimate identifier reaches.
  if (identifier.trim() === "") {
    throw new Error(
      "GDPR erase requires a non-empty identifier: an empty or whitespace-only " +
        "identifier matches every memory and would redact the entire store"
    );
  }

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

  // Redact each memory.
  //
  // `key` is written HERE and was not before: the SELECT above matches on five
  // columns and this UPDATE wrote only four, so a row matched BECAUSE its key
  // held the identifier was reported erased with that identifier still in place
  // — and still full-text searchable, since `memories_fts` indexes `key`. The
  // receipt said erased while the subject remained identifiable, which is the
  // one failure mode an erasure API must not have (0a68d690).
  //
  // The redacted key is PER-ROW, not a bare '[REDACTED]'. The schema carries
  //   CREATE UNIQUE INDEX idx_memories_unique_key
  //     ON memories(key, scope, COALESCE(agent_id,''), COALESCE(project_id,''),
  //                 COALESCE(session_id,''))
  // so a constant would throw `UNIQUE constraint failed` the moment a second row
  // in the same scope is erased — measured, not inferred. This loop is not
  // transactional, so that throw aborts a multi-row erase PART-WAY THROUGH,
  // leaving some rows scrubbed and some not. One data subject spread across
  // several memories is the ordinary case here, so the constant form fails on
  // the common path.
  //
  // Suffixing the primary key makes it unique by construction and discloses
  // nothing new — the same ids are returned to the caller in `memory_ids`. A
  // HASH of the original key was rejected: the identifiers this function takes
  // are enumerable (email addresses), so a hash is brute-forceable and remains
  // personal data under GDPR — it would leave the subject recoverable while the
  // receipt claims erasure, which is this very defect wearing a different form.
  const memoryIds: string[] = [];
  for (const row of rows) {
    d.run(
      `UPDATE memories SET
        key = '[REDACTED]:' || id,
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
