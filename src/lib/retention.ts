import type { Database } from "bun:sqlite";
import type { MementosConfig, MemoryScope } from "../types/index.js";
import { getDatabase, now } from "../db/database.js";
import { cleanExpiredMemories } from "../db/memories.js";

// ============================================================================
// enforceQuotas — evict oldest/lowest-importance memories when over limit
// ============================================================================

export function enforceQuotas(config: MementosConfig, db?: Database): number {
  const d = db || getDatabase();
  let totalEvicted = 0;

  const scopes: MemoryScope[] = ["global", "shared", "private"];

  for (const scope of scopes) {
    const limit = config.max_entries_per_scope[scope];
    if (!limit || limit <= 0) continue;

    // Count active memories in this scope
    const countRow = d
      .query(
        "SELECT COUNT(*) as cnt FROM memories WHERE scope = ? AND status = 'active'"
      )
      .get(scope) as { cnt: number };

    const count = countRow.cnt;
    if (count <= limit) continue;

    const excess = count - limit;

    // Delete the oldest and lowest-importance memories first.
    // Order by importance ASC (lowest first), then created_at ASC (oldest first).
    // Skip pinned memories — they should not be evicted.
    const result = d.run(
      `DELETE FROM memories WHERE id IN (
        SELECT id FROM memories
        WHERE scope = ? AND status = 'active' AND pinned = 0
        ORDER BY importance ASC, created_at ASC
        LIMIT ?
      )`,
      [scope, excess]
    );

    totalEvicted += result.changes;
  }

  return totalEvicted;
}

// ============================================================================
// archiveStale — archive memories not accessed in staleDays days
// ============================================================================

export function archiveStale(staleDays: number, db?: Database): number {
  const d = db || getDatabase();
  const timestamp = now();

  // Calculate the cutoff date
  const cutoff = new Date(
    Date.now() - staleDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // Archive active memories that haven't been accessed since the cutoff.
  // Use accessed_at if available, otherwise fall back to created_at.
  // Skip pinned memories.
  const result = d.run(
    `UPDATE memories
     SET status = 'archived', updated_at = ?
     WHERE status = 'active'
       AND pinned = 0
       AND COALESCE(accessed_at, created_at) < ?`,
    [timestamp, cutoff]
  );

  return result.changes;
}

// ============================================================================
// runCleanup — orchestrate all cleanup steps
// ============================================================================

export function runCleanup(
  config: MementosConfig,
  db?: Database
): { expired: number; evicted: number; archived: number } {
  const d = db || getDatabase();

  const expired = cleanExpiredMemories(d);
  const evicted = enforceQuotas(config, d);
  const archived = archiveStale(90, d);

  return { expired, evicted, archived };
}
