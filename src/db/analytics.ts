// ============================================================================
// Analytics / aggregate read domain.
//
// Single source of truth for the read-only aggregate operations that back the
// `stats`, `activity`, `report`, `stale` and `health` surfaces (CLI commands +
// MCP tools). Like every domain module here, each function is transport-aware:
//   - API mode (client): route to the self-hosted HTTP API (ApiStore).
//   - Local mode (this machine / server): run SQL against SQLite (LocalStore).
// No CLI command or MCP tool may run this SQL directly — that is the split-brain
// bug this mission eliminates. The server routes call these same functions with
// an explicit `db`, so the SQL lives here exactly once.
// ============================================================================

import { SqliteAdapter as Database } from "../storage.js";
import { getDatabase } from "./database.js";
import { isApiMode, apiJson, toQuery } from "./api-mode.js";
import type {
  MemoryCategory,
  MemoryScope,
  MemoryStats,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getMemoryStats(db?: Database): MemoryStats {
  if (!db && isApiMode()) {
    const { data } = apiJson<MemoryStats>("GET", "/memories/stats");
    return normalizeStats(data);
  }
  const d = db || getDatabase();
  const total = (
    d.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get() as { c: number }
  ).c;
  const byScope = d
    .query("SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope")
    .all() as { scope: MemoryScope; c: number }[];
  const byCategory = d
    .query("SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category")
    .all() as { category: MemoryCategory; c: number }[];
  // Restrict to active so the by_status buckets partition `total` exactly,
  // matching the by_scope/by_category groupings. Without the status filter,
  // GROUP BY status also tallies archived and expired rows, so the buckets
  // summed to more than `total` and the active bucket alone equalled the full
  // active total (see #stats-status-buckets, originally fixed in #12 and
  // re-applied here in the shared getMemoryStats source after the cloud-line
  // refactor consolidated the three stats surfaces into this function).
  const byStatus = d
    .query("SELECT status, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY status")
    .all() as { status: string; c: number }[];
  const pinnedCount = (
    d.query("SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'").get() as { c: number }
  ).c;
  const expiredCount = (
    d
      .query(
        "SELECT COUNT(*) as c FROM memories WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < datetime('now'))"
      )
      .get() as { c: number }
  ).c;

  const stats: MemoryStats = {
    total,
    by_scope: { global: 0, shared: 0, private: 0, working: 0 },
    by_category: { preference: 0, fact: 0, knowledge: 0, history: 0, procedural: 0, resource: 0 },
    by_status: { active: 0, archived: 0, expired: 0 },
    by_agent: {},
    pinned_count: pinnedCount,
    expired_count: expiredCount,
  };
  for (const row of byScope) if (row.scope in stats.by_scope) stats.by_scope[row.scope] = row.c;
  for (const row of byCategory) if (row.category in stats.by_category) stats.by_category[row.category] = row.c;
  for (const row of byStatus) {
    if (row.status in stats.by_status) {
      stats.by_status[row.status as keyof typeof stats.by_status] = row.c;
    }
  }

  const byAgent = d
    .query(
      "SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL GROUP BY agent_id"
    )
    .all() as { agent_id: string; c: number }[];
  for (const row of byAgent) stats.by_agent[row.agent_id] = row.c;

  return stats;
}

/** Defensively fill in any missing buckets from a server response. */
function normalizeStats(data: Partial<MemoryStats> | undefined): MemoryStats {
  return {
    total: data?.total ?? 0,
    by_scope: { global: 0, shared: 0, private: 0, working: 0, ...(data?.by_scope ?? {}) },
    by_category: {
      preference: 0, fact: 0, knowledge: 0, history: 0, procedural: 0, resource: 0,
      ...(data?.by_category ?? {}),
    },
    by_status: { active: 0, archived: 0, expired: 0, ...(data?.by_status ?? {}) },
    by_agent: data?.by_agent ?? {},
    pinned_count: data?.pinned_count ?? 0,
    expired_count: data?.expired_count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityFilter {
  days?: number;
  scope?: MemoryScope;
  agent_id?: string;
  project_id?: string;
}

export interface ActivityRow {
  date: string;
  memories_created: number;
  global_count?: number;
  shared_count?: number;
  private_count?: number;
  avg_importance?: number;
}

export interface ActivityResult {
  activity: ActivityRow[];
  days: number;
  total: number;
}

export function getMemoryActivity(filter: ActivityFilter = {}, db?: Database): ActivityResult {
  const days = Math.min(filter.days || 30, 365);
  if (!db && isApiMode()) {
    const q = toQuery({ days, scope: filter.scope, agent_id: filter.agent_id, project_id: filter.project_id });
    const { data } = apiJson<ActivityResult>("GET", `/activity${q}`);
    return { activity: data?.activity ?? [], days: data?.days ?? days, total: data?.total ?? 0 };
  }
  const d = db || getDatabase();
  const conditions: string[] = ["status = 'active'"];
  const params: string[] = [];
  if (filter.scope) { conditions.push("scope = ?"); params.push(filter.scope); }
  if (filter.agent_id) { conditions.push("agent_id = ?"); params.push(filter.agent_id); }
  if (filter.project_id) { conditions.push("project_id = ?"); params.push(filter.project_id); }
  const where = conditions.map((c) => `AND ${c}`).join(" ");
  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  params.push(cutoffDate);

  const rows = d.query(`
    SELECT
      date(created_at) AS date,
      COUNT(*) AS memories_created,
      SUM(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) AS global_count,
      SUM(CASE WHEN scope = 'shared' THEN 1 ELSE 0 END) AS shared_count,
      SUM(CASE WHEN scope = 'private' THEN 1 ELSE 0 END) AS private_count,
      AVG(importance) AS avg_importance
    FROM memories
    WHERE date(created_at) >= ? ${where}
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(...params) as ActivityRow[];

  return { activity: rows, days, total: rows.reduce((s, r) => s + r.memories_created, 0) };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReportFilter {
  days?: number;
  project_id?: string;
  agent_id?: string;
}

export interface MemoryReport {
  total: number;
  pinned: number;
  days: number;
  recent: { total: number; activity: { date: string; memories_created: number }[] };
  by_scope: Record<string, number>;
  by_category: Record<string, number>;
  top_memories: { id: string; key: string; value: string; importance: number; scope: string; category: string }[];
  top_agents: { agent_id: string; c: number }[];
}

export function getMemoryReport(filter: ReportFilter = {}, db?: Database): MemoryReport {
  const days = Math.min(filter.days || 7, 365);
  if (!db && isApiMode()) {
    const q = toQuery({ days, project_id: filter.project_id, agent_id: filter.agent_id });
    const { data } = apiJson<MemoryReport>("GET", `/report${q}`);
    return {
      total: data?.total ?? 0,
      pinned: data?.pinned ?? 0,
      days: data?.days ?? days,
      recent: data?.recent ?? { total: 0, activity: [] },
      by_scope: data?.by_scope ?? {},
      by_category: data?.by_category ?? {},
      top_memories: data?.top_memories ?? [],
      top_agents: data?.top_agents ?? [],
    };
  }
  const d = db || getDatabase();
  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const scopedCond = [
    filter.project_id ? "AND project_id = ?" : "",
    filter.agent_id ? "AND agent_id = ?" : "",
  ].filter(Boolean).join(" ");
  const scopedParams: (string | number)[] = [
    ...(filter.project_id ? [filter.project_id] : []),
    ...(filter.agent_id ? [filter.agent_id] : []),
  ];
  const recentParams: (string | number)[] = [cutoffDate, ...scopedParams];

  const total = (d.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' ${scopedCond}`).get(...scopedParams) as { c: number }).c;
  const pinned = (d.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1 ${scopedCond}`).get(...scopedParams) as { c: number }).c;

  const actRows = d.query(`
    SELECT date(created_at) AS date, COUNT(*) AS memories_created
    FROM memories WHERE status = 'active' AND date(created_at) >= ? ${scopedCond}
    GROUP BY date(created_at) ORDER BY date(created_at) ASC
  `).all(...recentParams) as { date: string; memories_created: number }[];
  const recentTotal = actRows.reduce((s, r) => s + r.memories_created, 0);

  const byScopeRows = d.query(`SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' ${scopedCond} GROUP BY scope`).all(...scopedParams) as { scope: string; c: number }[];
  const byCatRows = d.query(`SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' ${scopedCond} GROUP BY category`).all(...scopedParams) as { category: string; c: number }[];
  const topMems = d.query(`SELECT id, key, value, importance, scope, category FROM memories WHERE status = 'active' ${scopedCond} ORDER BY importance DESC, access_count DESC LIMIT 5`).all(...scopedParams) as MemoryReport["top_memories"];
  const topAgents = d.query(`SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL ${scopedCond} GROUP BY agent_id ORDER BY c DESC LIMIT 5`).all(...scopedParams) as { agent_id: string; c: number }[];

  return {
    total,
    pinned,
    days,
    recent: { total: recentTotal, activity: actRows },
    by_scope: Object.fromEntries(byScopeRows.map((r) => [r.scope, r.c])),
    by_category: Object.fromEntries(byCatRows.map((r) => [r.category, r.c])),
    top_memories: topMems,
    top_agents: topAgents,
  };
}

// ---------------------------------------------------------------------------
// Stale
// ---------------------------------------------------------------------------

export interface StaleFilter {
  days?: number;
  project_id?: string;
  agent_id?: string;
  limit?: number;
  offset?: number;
}

export interface StaleMemory {
  id: string;
  key: string;
  value: string;
  importance: number;
  scope: string;
  category: string;
  accessed_at: string | null;
  access_count: number;
  created_at?: string;
}

export function getStaleMemories(filter: StaleFilter = {}, db?: Database): StaleMemory[] {
  const days = Math.min(filter.days || 30, 365);
  const limit = filter.limit ?? 20;
  const offset = filter.offset ?? 0;
  if (!db && isApiMode()) {
    const q = toQuery({ days, project_id: filter.project_id, agent_id: filter.agent_id, limit, offset });
    const { data } = apiJson<{ memories: StaleMemory[] }>("GET", `/memories/stale${q}`);
    return data?.memories ?? [];
  }
  const d = db || getDatabase();
  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString();
  const conds = ["status = 'active'", "(accessed_at IS NULL OR accessed_at < ?)", "pinned = 0"];
  const params: (string | number)[] = [cutoffDate];
  if (filter.project_id) { conds.push("project_id = ?"); params.push(filter.project_id); }
  if (filter.agent_id) { conds.push("agent_id = ?"); params.push(filter.agent_id); }

  let sql = `SELECT id, key, value, importance, scope, category, accessed_at, access_count, created_at FROM memories WHERE ${conds.join(" AND ")} ORDER BY COALESCE(accessed_at, created_at) ASC LIMIT ?`;
  params.push(limit);
  if (offset) { sql += " OFFSET ?"; params.push(offset); }

  return d.query(sql).all(...params) as StaleMemory[];
}

// ---------------------------------------------------------------------------
// Health report
// ---------------------------------------------------------------------------

export interface HealthFilter {
  stale_days?: number;
  forgotten_days?: number;
  project_id?: string;
  agent_id?: string;
  limit?: number;
}

export interface MemoryHealth {
  stale: { id: string; key: string; value: string; importance: number; scope: string; created_at: string }[];
  forgotten: { id: string; key: string; value: string; importance: number; scope: string; accessed_at: string | null }[];
  dupes: { key: string; cnt: number; latest: string; oldest: string }[];
}

export function getMemoryHealth(filter: HealthFilter = {}, db?: Database): MemoryHealth {
  const staleDays = filter.stale_days ?? 30;
  const forgottenDays = filter.forgotten_days ?? 60;
  const limit = filter.limit ?? 10;
  if (!db && isApiMode()) {
    const q = toQuery({
      stale_days: staleDays,
      forgotten_days: forgottenDays,
      project_id: filter.project_id,
      agent_id: filter.agent_id,
      limit,
    });
    const { data } = apiJson<MemoryHealth>("GET", `/memories/health${q}`);
    return { stale: data?.stale ?? [], forgotten: data?.forgotten ?? [], dupes: data?.dupes ?? [] };
  }
  const d = db || getDatabase();
  const extraWhere = [
    ...(filter.project_id ? ["project_id = ?"] : []),
    ...(filter.agent_id ? ["agent_id = ?"] : []),
  ].join(" AND ");
  const scopeParams: string[] = [
    ...(filter.project_id ? [filter.project_id] : []),
    ...(filter.agent_id ? [filter.agent_id] : []),
  ];
  const staleCutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
  const forgottenCutoff = new Date(Date.now() - forgottenDays * 86400000).toISOString();
  const base = `status = 'active' AND pinned = 0${extraWhere ? " AND " + extraWhere : ""}`;

  // Binding order matches placeholder order: `base` (extraWhere) placeholders
  // come first, then the trailing cutoff placeholder, then LIMIT.
  const stale = d.prepare(
    `SELECT id, key, value, importance, scope, created_at FROM memories
     WHERE ${base} AND access_count = 0 AND created_at < ?
     ORDER BY created_at ASC LIMIT ?`
  ).all(...scopeParams, staleCutoff, limit) as MemoryHealth["stale"];

  const forgotten = d.prepare(
    `SELECT id, key, value, importance, scope, accessed_at FROM memories
     WHERE ${base} AND importance >= 7
       AND (accessed_at IS NULL OR accessed_at < ?)
     ORDER BY importance DESC, COALESCE(accessed_at, created_at) ASC LIMIT ?`
  ).all(...scopeParams, forgottenCutoff, limit) as MemoryHealth["forgotten"];

  const dupes = d.prepare(
    `SELECT key, COUNT(*) as cnt, MAX(updated_at) as latest, MIN(created_at) as oldest
     FROM memories WHERE ${base}
     GROUP BY key HAVING COUNT(*) > 1
     ORDER BY cnt DESC LIMIT ?`
  ).all(...scopeParams, limit) as MemoryHealth["dupes"];

  return { stale, forgotten, dupes };
}
