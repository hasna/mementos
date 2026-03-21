/**
 * Memory ratings — usefulness feedback for memories.
 */

import { Database } from "bun:sqlite";
import { getDatabase, uuid, now } from "./database.js";

// ============================================================================
// Types
// ============================================================================

export interface MemoryRating {
  id: string;
  memory_id: string;
  agent_id: string | null;
  useful: boolean;
  context: string | null;
  created_at: string;
}

export interface RatingsSummary {
  memory_id: string;
  total: number;
  useful_count: number;
  not_useful_count: number;
  usefulness_ratio: number;
}

// ============================================================================
// Create
// ============================================================================

export function rateMemory(
  memoryId: string,
  useful: boolean,
  agentId?: string,
  context?: string,
  db?: Database
): MemoryRating {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO memory_ratings (id, memory_id, agent_id, useful, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, memoryId, agentId || null, useful ? 1 : 0, context || null, timestamp]
  );

  return {
    id,
    memory_id: memoryId,
    agent_id: agentId || null,
    useful,
    context: context || null,
    created_at: timestamp,
  };
}

// ============================================================================
// Read
// ============================================================================

export function listRatingsForMemory(
  memoryId: string,
  db?: Database
): MemoryRating[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM memory_ratings WHERE memory_id = ? ORDER BY created_at DESC")
    .all(memoryId) as Record<string, unknown>[];

  return rows.map(parseRatingRow);
}

export function getRatingsSummary(
  memoryId: string,
  db?: Database
): RatingsSummary {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT useful, COUNT(*) as cnt FROM memory_ratings WHERE memory_id = ? GROUP BY useful")
    .all(memoryId) as { useful: number; cnt: number }[];

  let usefulCount = 0;
  let notUsefulCount = 0;
  for (const row of rows) {
    if (row.useful) usefulCount = row.cnt;
    else notUsefulCount = row.cnt;
  }
  const total = usefulCount + notUsefulCount;

  return {
    memory_id: memoryId,
    total,
    useful_count: usefulCount,
    not_useful_count: notUsefulCount,
    usefulness_ratio: total > 0 ? usefulCount / total : 0,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function parseRatingRow(row: Record<string, unknown>): MemoryRating {
  return {
    id: row["id"] as string,
    memory_id: row["memory_id"] as string,
    agent_id: (row["agent_id"] as string) || null,
    useful: !!(row["useful"] as number),
    context: (row["context"] as string) || null,
    created_at: row["created_at"] as string,
  };
}
