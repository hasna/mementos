import { getDatabase } from "../../db/database.js";
import type { MemoryCategory, MemoryScope, MemoryStats } from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, getSearchParams } from "../helpers.js";

// GET /api/memories/stats — statistics
addRoute("GET", "/api/memories/stats", (_req) => {
  const db = getDatabase();

  const total = (
    db
      .query("SELECT COUNT(*) as c FROM memories WHERE status = 'active'")
      .get() as { c: number }
  ).c;
  const byScope = db
    .query(
      "SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope"
    )
    .all() as { scope: MemoryScope; c: number }[];
  const byCategory = db
    .query(
      "SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category"
    )
    .all() as { category: MemoryCategory; c: number }[];
  const byStatus = db
    .query("SELECT status, COUNT(*) as c FROM memories GROUP BY status")
    .all() as { status: string; c: number }[];
  const pinnedCount = (
    db
      .query(
        "SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'"
      )
      .get() as { c: number }
  ).c;
  const expiredCount = (
    db
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
  for (const row of byScope) stats.by_scope[row.scope] = row.c;
  for (const row of byCategory) stats.by_category[row.category] = row.c;
  for (const row of byStatus) {
    if (row.status in stats.by_status) {
      stats.by_status[row.status as keyof typeof stats.by_status] = row.c;
    }
  }

  const byAgent = db
    .query(
      "SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL GROUP BY agent_id"
    )
    .all() as { agent_id: string; c: number }[];
  for (const row of byAgent) stats.by_agent[row.agent_id] = row.c;

  return json(stats);
});

// GET /api/metrics — comprehensive memory health metrics
addRoute("GET", "/api/metrics", (_req: Request) => {
  const db = getDatabase();

  const total = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get() as { c: number }).c;

  const byScope = db.query("SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope").all() as { scope: string; c: number }[];
  const byCategory = db.query("SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category").all() as { category: string; c: number }[];

  // Growth rate (last 7 days vs prior 7 days)
  const last7 = (db.query("SELECT COUNT(*) as c FROM memories WHERE created_at >= datetime('now', '-7 days')").get() as { c: number }).c;
  const prior7 = (db.query("SELECT COUNT(*) as c FROM memories WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')").get() as { c: number }).c;
  const growthRate = prior7 > 0 ? ((last7 - prior7) / prior7 * 100) : 0;

  // Stale percentage (not accessed in 30 days)
  const staleCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 0 AND (accessed_at IS NULL OR accessed_at < datetime('now', '-30 days'))").get() as { c: number }).c;
  const stalePercentage = total > 0 ? (staleCount / total * 100) : 0;

  // Top accessed memories
  const topAccessed = db.query("SELECT id, key, access_count, importance FROM memories WHERE status = 'active' ORDER BY access_count DESC LIMIT 10").all() as { id: string; key: string; access_count: number; importance: number }[];

  return json({
    total_memories: total,
    by_scope: Object.fromEntries(byScope.map(r => [r.scope, r.c])),
    by_category: Object.fromEntries(byCategory.map(r => [r.category, r.c])),
    growth_rate_7d: Math.round(growthRate * 10) / 10,
    new_last_7d: last7,
    stale_percentage: Math.round(stalePercentage * 10) / 10,
    stale_count: staleCount,
    top_accessed: topAccessed,
  });
});

// GET /api/activity — daily memory activity over N days
addRoute("GET", "/api/activity", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const days = Math.min(parseInt(q["days"] || "30", 10), 365);
  const scope = q["scope"] as MemoryScope | undefined;
  const agentId = q["agent_id"];
  const projectId = q["project_id"];
  const db = getDatabase();

  // Build optional filter clauses
  const conditions: string[] = ["status = 'active'"];
  const params: string[] = [];
  if (scope) { conditions.push("scope = ?"); params.push(scope); }
  if (agentId) { conditions.push("agent_id = ?"); params.push(agentId); }
  if (projectId) { conditions.push("project_id = ?"); params.push(projectId); }
  const where = conditions.map(c => `AND ${c}`).join(" ");

  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  params.push(cutoffDate);

  const rows = db.query(`
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
  `).all(...params) as { date: string; memories_created: number; global_count: number; shared_count: number; private_count: number; avg_importance: number }[];

  return json({ activity: rows, days, total: rows.reduce((s, r) => s + r.memories_created, 0) });
});

// GET /api/memories/stale — memories not accessed recently
addRoute("GET", "/api/memories/stale", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const days = Math.min(parseInt(q["days"] || "30", 10), 365);
  const projectId = q["project_id"];
  const agentId = q["agent_id"];
  const limit = Math.min(parseInt(q["limit"] || "20", 10), 100);
  const db = getDatabase();

  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString();
  const conds = [
    "status = 'active'",
    "(accessed_at IS NULL OR accessed_at < ?)",
    "pinned = 0",
  ];
  const params: string[] = [cutoffDate];
  if (projectId) { conds.push("project_id = ?"); params.push(projectId); }
  if (agentId) { conds.push("agent_id = ?"); params.push(agentId); }

  const rows = db.query(
    `SELECT id, key, value, importance, scope, category, accessed_at, access_count, created_at FROM memories WHERE ${conds.join(" AND ")} ORDER BY COALESCE(accessed_at, created_at) ASC LIMIT ?`
  ).all(...params, limit) as Record<string, unknown>[];

  return json({ memories: rows, count: rows.length, days });
});

// GET /api/report — rich activity summary
addRoute("GET", "/api/report", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const days = Math.min(parseInt(q["days"] || "7", 10), 365);
  const projectId = q["project_id"];
  const agentId = q["agent_id"];
  const db = getDatabase();

  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const scopedCond = [
    projectId ? "AND project_id = ?" : "",
    agentId ? "AND agent_id = ?" : "",
  ].filter(Boolean).join(" ");
  const scopedParams: (string | number)[] = [
    ...(projectId ? [projectId] : []),
    ...(agentId ? [agentId] : []),
  ];
  const recentParams: (string | number)[] = [cutoffDate, ...scopedParams];

  const total = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' ${scopedCond}`).get(...scopedParams) as { c: number }).c;
  const pinned = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1 ${scopedCond}`).get(...scopedParams) as { c: number }).c;

  const actRows = db.query(`
    SELECT date(created_at) AS date, COUNT(*) AS memories_created
    FROM memories WHERE status = 'active' AND date(created_at) >= ? ${scopedCond}
    GROUP BY date(created_at) ORDER BY date(created_at) ASC
  `).all(...recentParams) as { date: string; memories_created: number }[];
  const recentTotal = actRows.reduce((s, r) => s + r.memories_created, 0);

  const byScopeRows = db.query(`SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' ${scopedCond} GROUP BY scope`).all(...scopedParams) as { scope: string; c: number }[];
  const byCatRows = db.query(`SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' ${scopedCond} GROUP BY category`).all(...scopedParams) as { category: string; c: number }[];
  const topMems = db.query(`SELECT id, key, value, importance, scope, category FROM memories WHERE status = 'active' ${scopedCond} ORDER BY importance DESC, access_count DESC LIMIT 5`).all(...scopedParams) as { id: string; key: string; value: string; importance: number; scope: string; category: string }[];
  const topAgents = db.query(`SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL ${scopedCond} GROUP BY agent_id ORDER BY c DESC LIMIT 5`).all(...scopedParams) as { agent_id: string; c: number }[];

  return json({
    total,
    pinned,
    days,
    recent: { total: recentTotal, activity: actRows },
    by_scope: Object.fromEntries(byScopeRows.map(r => [r.scope, r.c])),
    by_category: Object.fromEntries(byCatRows.map(r => [r.category, r.c])),
    top_memories: topMems,
    top_agents: topAgents,
  });
});
