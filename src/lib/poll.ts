import type { SqliteAdapter as Database } from "../storage.js";
import type { Memory, MemoryScope, MemoryCategory } from "../types/index.js";
import { listMemories } from "../db/memories.js";
import { getDatabase } from "../db/database.js";
import { isApiMode } from "../db/api-mode.js";

// ============================================================================
// Poll options & handle
// ============================================================================

export interface PollOptions {
  interval_ms?: number;
  scope?: MemoryScope;
  category?: MemoryCategory;
  agent_id?: string;
  project_id?: string;
  on_memories: (memories: Memory[]) => void;
  on_error?: (error: Error) => void;
  db?: Database;
}

export interface PollHandle {
  stop: () => void;
}

// ============================================================================
// Polling implementation
// ============================================================================

export function startPolling(opts: PollOptions): PollHandle {
  const interval = opts.interval_ms ?? 500;
  // API mode: no local SQLite handle — poll the shared cloud store through the
  // Store (listMemories → GET /memories) and diff by timestamp client-side, so
  // `tail`/`watch` stream cloud memories instead of fail-closing on the
  // split-brain guard. Local mode keeps the raw-SQL incremental path unchanged.
  const apiMode = !opts.db && isApiMode();
  const db: Database | null = apiMode ? null : (opts.db ?? getDatabase());
  let stopped = false;
  let inFlight = false;
  let lastSeen: string | null = null;

  // How far back the cloud poll window reaches each tick. New memories created
  // between ticks land in this window and are surfaced by the timestamp diff.
  const API_POLL_WINDOW = 200;

  const maxTimestamp = (memories: Memory[], seed: string | null): string | null => {
    let mx = seed;
    for (const m of memories) {
      const ts = m.updated_at > m.created_at ? m.updated_at : m.created_at;
      if (!mx || ts > mx) mx = ts;
    }
    return mx;
  };

  const listRecentViaApi = (limit: number): Memory[] =>
    listMemories({
      scope: opts.scope,
      category: opts.category,
      agent_id: opts.agent_id,
      project_id: opts.project_id,
      status: "active",
      limit,
    });

  // Seed lastSeen from the most recent memory matching the filters
  const seedLastSeen = () => {
    try {
      if (apiMode) {
        lastSeen = maxTimestamp(listRecentViaApi(API_POLL_WINDOW), null);
        return;
      }
      const latest = listMemories(
        {
          scope: opts.scope,
          category: opts.category,
          agent_id: opts.agent_id,
          project_id: opts.project_id,
          limit: 1,
        },
        db!
      );
      if (latest.length > 0 && latest[0]) {
        lastSeen = latest[0].updated_at;
      }
    } catch (err) {
      opts.on_error?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const pollViaApi = () => {
    try {
      const recent = listRecentViaApi(API_POLL_WINDOW);
      const fresh = recent
        .filter((m) => !lastSeen || m.updated_at > lastSeen || m.created_at > lastSeen)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0));
      if (fresh.length > 0) {
        lastSeen = maxTimestamp(fresh, lastSeen);
        try {
          opts.on_memories(fresh);
        } catch (err) {
          opts.on_error?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } catch (err) {
      opts.on_error?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const poll = () => {
    if (stopped || inFlight) return;
    inFlight = true;

    if (apiMode) {
      try {
        pollViaApi();
      } finally {
        inFlight = false;
      }
      return;
    }

    try {
      // Query memories updated after lastSeen
      // We use a raw query to filter by updated_at > lastSeen
      const conditions: string[] = ["status = 'active'"];
      const params: (string | number)[] = [];

      if (lastSeen) {
        conditions.push("(updated_at > ? OR created_at > ?)");
        params.push(lastSeen, lastSeen);
      }
      if (opts.scope) {
        conditions.push("scope = ?");
        params.push(opts.scope);
      }
      if (opts.category) {
        conditions.push("category = ?");
        params.push(opts.category);
      }
      if (opts.agent_id) {
        conditions.push("agent_id = ?");
        params.push(opts.agent_id);
      }
      if (opts.project_id) {
        conditions.push("project_id = ?");
        params.push(opts.project_id);
      }

      const sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY updated_at ASC`;
      const rows = db!.query(sql).all(...params) as Record<string, unknown>[];

      if (rows.length > 0) {
        const memories: Memory[] = rows.map(parseMemoryRow);
        const lastRow = memories[memories.length - 1];
        if (lastRow) {
          lastSeen = lastRow.updated_at;
        }
        try {
          opts.on_memories(memories);
        } catch (err) {
          opts.on_error?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } catch (err) {
      opts.on_error?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight = false;
    }
  };

  seedLastSeen();
  const timer = setInterval(poll, interval);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ============================================================================
// Row parser (mirrors db/memories.ts)
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
    valid_from: (row["valid_from"] as string) || null,
    valid_until: (row["valid_until"] as string) || null,
    ingested_at: (row["ingested_at"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    accessed_at: (row["accessed_at"] as string) || null,
  };
}
