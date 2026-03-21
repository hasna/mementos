import type { Database } from "bun:sqlite";
import type { MementosConfig, MemoryScope } from "../types/index.js";
import { getDatabase, now } from "../db/database.js";
import { cleanExpiredMemories } from "../db/memories.js";
import { loadConfig } from "./config.js";
import { computeDecayScore } from "./decay.js";

// ============================================================================
// enforceQuotas — evict oldest/lowest-importance memories when over limit
// ============================================================================

export function enforceQuotas(config: MementosConfig, db?: Database): number {
  const d = db || getDatabase();
  let totalEvicted = 0;

  const scopes: MemoryScope[] = ["global", "shared", "private", "working"];

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
    const subquery = `SELECT id FROM memories
        WHERE scope = ? AND status = 'active' AND pinned = 0
        ORDER BY importance ASC, created_at ASC
        LIMIT ?`;
    // Count actual deletable rows — result.changes includes FTS5 trigger operations
    const delCount = (d
      .query(`SELECT COUNT(*) as c FROM (${subquery})`)
      .get(scope, excess) as { c: number }).c;
    d.run(
      `DELETE FROM memories WHERE id IN (${subquery})`,
      [scope, excess]
    );

    totalEvicted += delCount;
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
  const archiveWhere = `status = 'active' AND pinned = 0 AND COALESCE(accessed_at, created_at) < ?`;
  // Count first — result.changes includes FTS5 trigger operations
  const count = (d
    .query(`SELECT COUNT(*) as c FROM memories WHERE ${archiveWhere}`)
    .get(cutoff) as { c: number }).c;
  if (count > 0) {
    d.run(
      `UPDATE memories SET status = 'archived', updated_at = ? WHERE ${archiveWhere}`,
      [timestamp, cutoff]
    );
  }
  return count;
}

// ============================================================================
// archiveUnused — archive memories with access_count=0 older than `days` days
// ============================================================================

export function archiveUnused(days: number, db?: Database): number {
  const d = db || getDatabase();
  const timestamp = now();

  const cutoff = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();

  const unusedWhere = `status = 'active' AND pinned = 0 AND access_count = 0 AND created_at < ?`;
  // Count first — result.changes includes FTS5 trigger operations
  const count = (d
    .query(`SELECT COUNT(*) as c FROM memories WHERE ${unusedWhere}`)
    .get(cutoff) as { c: number }).c;
  if (count > 0) {
    d.run(
      `UPDATE memories SET status = 'archived', updated_at = ? WHERE ${unusedWhere}`,
      [timestamp, cutoff]
    );
  }
  return count;
}

// ============================================================================
// deprioritizeStale — lower importance of memories not accessed in `days` days
// ============================================================================

export function deprioritizeStale(days: number, db?: Database): number {
  const d = db || getDatabase();
  const timestamp = now();

  const cutoff = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();

  // Find active memories not accessed in `days` days.
  // Use accessed_at if available, otherwise fall back to updated_at.
  // Skip pinned memories. Lower importance by 1 (floor at 1) and bump version.
  const deprioWhere = `status = 'active' AND pinned = 0 AND importance > 1 AND COALESCE(accessed_at, updated_at) < ?`;
  // Count first — result.changes includes FTS5 trigger operations
  const count = (d
    .query(`SELECT COUNT(*) as c FROM memories WHERE ${deprioWhere}`)
    .get(cutoff) as { c: number }).c;
  if (count > 0) {
    d.run(
      `UPDATE memories
       SET importance = MAX(importance - 1, 1),
           version = version + 1,
           updated_at = ?
       WHERE ${deprioWhere}`,
      [timestamp, cutoff]
    );
  }
  return count;
}

// ============================================================================
// runCleanup — orchestrate all cleanup steps
// ============================================================================

export function runCleanup(
  config: MementosConfig,
  db?: Database
): { expired: number; evicted: number; archived: number; unused_archived: number; deprioritized: number } {
  const d = db || getDatabase();

  const expired = cleanExpiredMemories(d);
  const evicted = enforceQuotas(config, d);
  const archived = archiveStale(90, d);
  const unused_archived = archiveUnused(
    config.auto_cleanup.unused_archive_days ?? 7,
    d
  );
  const deprioritized = deprioritizeStale(
    config.auto_cleanup.stale_deprioritize_days ?? 14,
    d
  );

  return { expired, evicted, archived, unused_archived, deprioritized };
}

// ============================================================================
// enforceMemoryBounds — archive lowest utility memories when any scope exceeds limit
// Uses decay score (importance * time_decay * access_boost) for ordering.
// ============================================================================

export function enforceMemoryBounds(
  projectId?: string,
  db?: Database
): { archived: number } {
  const d = db || getDatabase();
  const config = loadConfig();
  const timestamp = now();
  let totalArchived = 0;

  const scopes: MemoryScope[] = ["global", "shared", "private", "working"];

  for (const scope of scopes) {
    const limit = config.max_entries_per_scope[scope];
    if (!limit || limit <= 0) continue;

    // Build project filter
    const projectFilter = projectId ? " AND project_id = ?" : "";
    const projectParams = projectId ? [projectId] : [];

    // Count active memories in this scope
    const countRow = d
      .query(
        `SELECT COUNT(*) as cnt FROM memories WHERE scope = ? AND status = 'active'${projectFilter}`
      )
      .get(scope, ...projectParams) as { cnt: number };

    const count = countRow.cnt;
    if (count <= limit) continue;

    const excess = count - limit;

    // Fetch candidates for eviction (non-pinned, active)
    const candidates = d
      .query(
        `SELECT id, importance, access_count, accessed_at, created_at, pinned FROM memories
         WHERE scope = ? AND status = 'active' AND pinned = 0${projectFilter}
         ORDER BY importance ASC, created_at ASC`
      )
      .all(scope, ...projectParams) as Array<{
        id: string;
        importance: number;
        access_count: number;
        accessed_at: string | null;
        created_at: string;
        pinned: number;
      }>;

    // Sort by decay score ascending (lowest utility first)
    const scored = candidates.map((c) => ({
      id: c.id,
      decayScore: computeDecayScore({
        importance: c.importance,
        access_count: c.access_count,
        accessed_at: c.accessed_at,
        created_at: c.created_at,
        pinned: !!c.pinned,
      }),
    }));
    scored.sort((a, b) => a.decayScore - b.decayScore);

    // Archive the lowest-utility memories
    const toArchive = scored.slice(0, excess);
    if (toArchive.length > 0) {
      const placeholders = toArchive.map(() => "?").join(",");
      const ids = toArchive.map((m) => m.id);
      d.run(
        `UPDATE memories SET status = 'archived', updated_at = ? WHERE id IN (${placeholders})`,
        [timestamp, ...ids]
      );
      totalArchived += toArchive.length;
    }
  }

  return { archived: totalArchived };
}
