import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Memory, MemoryFilter, MemorySearchResult } from "../types/index.js";
import { getDatabase } from "../db/database.js";

// ============================================================================
// Helpers
// ============================================================================

function parseMemoryRow(row: Record<string, unknown>): Memory {
  return {
    id: row["id"] as string,
    key: row["key"] as string,
    value: row["value"] as string,
    category: row["category"] as Memory["category"],
    scope: row["scope"] as Memory["scope"],
    summary: (row["summary"] as string) || null,
    tags: JSON.parse((row["tags"] as string) || "[]") as string[],
    importance: row["importance"] as number,
    source: row["source"] as Memory["source"],
    status: row["status"] as Memory["status"],
    pinned: !!(row["pinned"] as number),
    agent_id: (row["agent_id"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    session_id: (row["session_id"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<
      string,
      unknown
    >,
    access_count: row["access_count"] as number,
    version: row["version"] as number,
    expires_at: (row["expires_at"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    accessed_at: (row["accessed_at"] as string) || null,
  };
}

/**
 * Determine the best match_type for a memory given the query and its score breakdown.
 */
function determineMatchType(
  memory: Memory,
  queryLower: string
): MemorySearchResult["match_type"] {
  if (memory.key.toLowerCase() === queryLower) return "exact";
  if (memory.tags.some((t) => t.toLowerCase() === queryLower)) return "tag";
  return "fuzzy";
}

/**
 * Compute the raw search score for a memory against a query string.
 * Scoring rules:
 *   - Exact key match: 10
 *   - Key contains query: 7
 *   - Tag exact match: 6
 *   - Summary contains query: 4
 *   - Value contains query: 3
 * Scores are additive (a memory can match in multiple fields).
 */
function computeScore(memory: Memory, queryLower: string): number {
  let score = 0;

  const keyLower = memory.key.toLowerCase();
  if (keyLower === queryLower) {
    score += 10;
  } else if (keyLower.includes(queryLower)) {
    score += 7;
  }

  if (memory.tags.some((t) => t.toLowerCase() === queryLower)) {
    score += 6;
  }

  if (memory.summary && memory.summary.toLowerCase().includes(queryLower)) {
    score += 4;
  }

  if (memory.value.toLowerCase().includes(queryLower)) {
    score += 3;
  }

  return score;
}

// ============================================================================
// Search
// ============================================================================

/**
 * Search memories by query string with relevance scoring.
 *
 * Searches across key, value, summary, and tags. Results are scored,
 * weighted by importance, filtered, and sorted by score DESC then
 * importance DESC.
 */
export function searchMemories(
  query: string,
  filter?: MemoryFilter,
  db?: Database
): MemorySearchResult[] {
  const d = db || getDatabase();
  const queryLower = query.toLowerCase();
  const queryParam = `%${query}%`;

  // Build the SQL query to fetch candidate rows that match the query
  // in at least one searchable field (key, value, summary, tags via memory_tags).
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  // Must be active and not expired
  conditions.push("m.status = 'active'");
  conditions.push(
    "(m.expires_at IS NULL OR m.expires_at >= datetime('now'))"
  );

  // Must match query in at least one field
  conditions.push(
    `(m.key LIKE ? OR m.value LIKE ? OR m.summary LIKE ? OR m.id IN (SELECT memory_id FROM memory_tags WHERE tag LIKE ?))`
  );
  params.push(queryParam, queryParam, queryParam, queryParam);

  // Apply MemoryFilter conditions
  if (filter) {
    if (filter.scope) {
      if (Array.isArray(filter.scope)) {
        conditions.push(
          `m.scope IN (${filter.scope.map(() => "?").join(",")})`
        );
        params.push(...filter.scope);
      } else {
        conditions.push("m.scope = ?");
        params.push(filter.scope);
      }
    }
    if (filter.category) {
      if (Array.isArray(filter.category)) {
        conditions.push(
          `m.category IN (${filter.category.map(() => "?").join(",")})`
        );
        params.push(...filter.category);
      } else {
        conditions.push("m.category = ?");
        params.push(filter.category);
      }
    }
    if (filter.source) {
      if (Array.isArray(filter.source)) {
        conditions.push(
          `m.source IN (${filter.source.map(() => "?").join(",")})`
        );
        params.push(...filter.source);
      } else {
        conditions.push("m.source = ?");
        params.push(filter.source);
      }
    }
    if (filter.status) {
      // Override the default active-only filter if explicitly specified
      // Remove the first condition we added
      conditions.shift(); // remove "m.status = 'active'"
      if (Array.isArray(filter.status)) {
        conditions.push(
          `m.status IN (${filter.status.map(() => "?").join(",")})`
        );
        params.push(...filter.status);
      } else {
        conditions.push("m.status = ?");
        params.push(filter.status);
      }
    }
    if (filter.project_id) {
      conditions.push("m.project_id = ?");
      params.push(filter.project_id);
    }
    if (filter.agent_id) {
      conditions.push("m.agent_id = ?");
      params.push(filter.agent_id);
    }
    if (filter.session_id) {
      conditions.push("m.session_id = ?");
      params.push(filter.session_id);
    }
    if (filter.min_importance) {
      conditions.push("m.importance >= ?");
      params.push(filter.min_importance);
    }
    if (filter.pinned !== undefined) {
      conditions.push("m.pinned = ?");
      params.push(filter.pinned ? 1 : 0);
    }
    if (filter.tags && filter.tags.length > 0) {
      for (const tag of filter.tags) {
        conditions.push(
          "m.id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)"
        );
        params.push(tag);
      }
    }
  }

  const sql = `SELECT m.* FROM memories m WHERE ${conditions.join(" AND ")}`;
  const rows = d.query(sql).all(...params) as Record<string, unknown>[];

  // Score each result
  const scored: MemorySearchResult[] = [];
  for (const row of rows) {
    const memory = parseMemoryRow(row);
    const rawScore = computeScore(memory, queryLower);
    if (rawScore === 0) continue; // safety: skip if no actual match

    // Weight by importance: score * importance / 10
    const weightedScore = (rawScore * memory.importance) / 10;
    const matchType = determineMatchType(memory, queryLower);

    scored.push({
      memory,
      score: weightedScore,
      match_type: matchType,
    });
  }

  // Sort by score DESC, then importance DESC
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.memory.importance - a.memory.importance;
  });

  // Apply limit/offset
  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? scored.length;

  return scored.slice(offset, offset + limit);
}
