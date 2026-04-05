import {
  createMemory,
  getMemory,
  listMemories,
  updateMemory,
  deleteMemory,
  cleanExpiredMemories,
  touchMemory,
  getMemoryVersions,
} from "../../db/memories.js";
import { getDatabase } from "../../db/database.js";
import { searchMemories, hybridSearch, searchWithBm25 } from "../../lib/search.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
  DuplicateMemoryError,
} from "../../types/index.js";
import { parseDuration } from "../../lib/duration.js";
import { getDbPath } from "../../lib/config.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryStats,
  MemoryFilter,
  CreateMemoryInput,
} from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson, getSearchParams } from "../helpers.js";

// GET /api/health — simple health (addRoute version, for route-matched requests)
addRoute("GET", "/api/health", () => {
  return json({ ok: true, version: "1", db: getDbPath() });
});

// GET /api/memories — list memories
addRoute("GET", "/api/memories", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const filter: MemoryFilter = {};

  if (q["scope"]) filter.scope = q["scope"] as MemoryScope;
  if (q["category"]) filter.category = q["category"] as MemoryCategory;
  if (q["tags"]) filter.tags = q["tags"].split(",");
  if (q["min_importance"])
    filter.min_importance = parseInt(q["min_importance"], 10);
  if (q["pinned"] !== undefined && q["pinned"] !== "")
    filter.pinned = q["pinned"] === "true";
  if (q["agent_id"]) filter.agent_id = q["agent_id"];
  if (q["project_id"]) filter.project_id = q["project_id"];
  if (q["session_id"]) filter.session_id = q["session_id"];
  if (q["status"]) filter.status = q["status"] as import("../../types/index.js").MemoryStatus;
  if (q["limit"]) filter.limit = parseInt(q["limit"], 10);
  if (q["offset"]) filter.offset = parseInt(q["offset"], 10);

  const memories = listMemories(filter);

  // ?fields=key,value,importance — field filtering (60-80% smaller responses)
  if (q["fields"]) {
    const fields = q["fields"].split(",").map((f: string) => f.trim());
    const filtered = memories.map(m =>
      Object.fromEntries(fields.map((f: string) => [f, (m as unknown as Record<string, unknown>)[f]]).filter(([, v]) => v !== undefined))
    );
    return json({ memories: filtered, count: filtered.length });
  }

  return json({ memories, count: memories.length });
});

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
  const cond = [
    projectId ? "AND project_id = ?" : "",
    agentId ? "AND agent_id = ?" : "",
  ].filter(Boolean).join(" ");
  const params: (string | number)[] = [cutoffDate, ...(projectId ? [projectId] : []), ...(agentId ? [agentId] : [])];

  const total = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' ${cond}`).get(...params.slice(1)) as { c: number }).c;
  const pinned = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1 ${cond}`).get(...params.slice(1)) as { c: number }).c;

  const actRows = db.query(`
    SELECT date(created_at) AS date, COUNT(*) AS memories_created
    FROM memories WHERE status = 'active' AND date(created_at) >= ? ${cond}
    GROUP BY date(created_at) ORDER BY date(created_at) ASC
  `).all(...params) as { date: string; memories_created: number }[];
  const recentTotal = actRows.reduce((s, r) => s + r.memories_created, 0);

  const byScopeRows = db.query(`SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' ${cond} GROUP BY scope`).all(...params) as { scope: string; c: number }[];
  const byCatRows = db.query(`SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' ${cond} GROUP BY category`).all(...params) as { category: string; c: number }[];
  const topMems = db.query(`SELECT id, key, value, importance, scope, category FROM memories WHERE status = 'active' ${cond} ORDER BY importance DESC, access_count DESC LIMIT 5`).all(...params) as { id: string; key: string; value: string; importance: number; scope: string; category: string }[];
  const topAgents = db.query(`SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL ${cond} GROUP BY agent_id ORDER BY c DESC LIMIT 5`).all(...params) as { agent_id: string; c: number }[];

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

// POST /api/memories/search — search
addRoute("POST", "/api/memories/search", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || typeof body["query"] !== "string") {
    return errorResponse("Missing required field: query", 400);
  }

  const filter: MemoryFilter = {};
  if (body["scope"]) filter.scope = body["scope"] as MemoryScope;
  if (body["category"]) filter.category = body["category"] as MemoryCategory;
  if (body["tags"]) filter.tags = body["tags"] as string[];
  if (body["limit"]) filter.limit = body["limit"] as number;

  const results = searchMemories(body["query"] as string, filter);
  return json({ results, count: results.length });
});

// POST /api/memories/search/hybrid — hybrid search (keyword + semantic via RRF)
addRoute("POST", "/api/memories/search/hybrid", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || typeof body["query"] !== "string") {
    return errorResponse("Missing required field: query", 400);
  }

  const filter: MemoryFilter = {};
  if (body["scope"]) filter.scope = body["scope"] as MemoryScope;
  if (body["category"]) filter.category = body["category"] as MemoryCategory;
  if (body["tags"]) filter.tags = body["tags"] as string[];
  if (body["agent_id"]) filter.agent_id = body["agent_id"] as string;
  if (body["project_id"]) filter.project_id = body["project_id"] as string;

  const results = await hybridSearch(body["query"] as string, {
    filter,
    semantic_threshold: (body["semantic_threshold"] as number) ?? undefined,
    limit: (body["limit"] as number) ?? undefined,
  });
  return json({ results, count: results.length });
});

// POST /api/memories/search/bm25 — BM25-ranked search
addRoute("POST", "/api/memories/search/bm25", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || typeof body["query"] !== "string") {
    return errorResponse("Missing required field: query", 400);
  }

  const filter: MemoryFilter = {};
  if (body["scope"]) filter.scope = body["scope"] as MemoryScope;
  if (body["category"]) filter.category = body["category"] as MemoryCategory;
  if (body["tags"]) filter.tags = body["tags"] as string[];
  if (body["agent_id"]) filter.agent_id = body["agent_id"] as string;
  if (body["project_id"]) filter.project_id = body["project_id"] as string;
  if (body["limit"]) filter.limit = body["limit"] as number;

  const results = searchWithBm25(body["query"] as string, filter);
  return json({ results, count: results.length });
});

// POST /api/memories/export — export memories
addRoute("POST", "/api/memories/export", async (req) => {
  const body = ((await readJson(req)) as Record<string, unknown>) || {};
  const filter: MemoryFilter = {};

  if (body["scope"]) filter.scope = body["scope"] as MemoryScope;
  if (body["category"]) filter.category = body["category"] as MemoryCategory;
  if (body["agent_id"]) filter.agent_id = body["agent_id"] as string;
  if (body["project_id"]) filter.project_id = body["project_id"] as string;
  if (body["tags"]) filter.tags = body["tags"] as string[];
  filter.limit = (body["limit"] as number) || 10000;

  const memories = listMemories(filter);
  return json({ memories, count: memories.length });
});

// POST /api/memories/import — import memories
addRoute("POST", "/api/memories/import", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body["memories"])) {
    return errorResponse("Missing required field: memories (array)", 400);
  }

  const overwrite = body["overwrite"] !== false;
  const dedupeMode = overwrite ? ("merge" as const) : ("create" as const);
  const memoriesArr = body["memories"] as Record<string, unknown>[];
  let imported = 0;
  const errors: string[] = [];

  for (const mem of memoriesArr) {
    try {
      createMemory(
        {
          ...mem,
          source: (mem["source"] as string) || "imported",
        } as CreateMemoryInput,
        dedupeMode
      );
      imported++;
    } catch (e) {
      errors.push(
        `Failed to import "${mem["key"]}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return json({ imported, errors, total: memoriesArr.length }, 201);
});

// POST /api/memories/bulk-forget — delete multiple memories
addRoute("POST", "/api/memories/bulk-forget", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body["ids"])) {
    return errorResponse("Missing required field: ids (array)", 400);
  }
  const ids = body["ids"] as string[];
  let deleted = 0;
  for (const id of ids) {
    try {
      if (deleteMemory(id)) deleted++;
    } catch { /* skip not found */ }
  }
  return json({ deleted, total: ids.length });
});

// POST /api/memories/bulk-update — update multiple memories with same changes
addRoute("POST", "/api/memories/bulk-update", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body["ids"])) {
    return errorResponse("Missing required fields: ids (array)", 400);
  }
  const ids = body["ids"] as string[];
  const { ids: _ids, ...fields } = body as Record<string, unknown>;

  let updated = 0;
  const errors: string[] = [];
  for (const id of ids) {
    try {
      const memory = getMemory(id);
      if (memory) {
        updateMemory(id, { ...(fields as Record<string, unknown>), version: memory.version } as Parameters<typeof updateMemory>[1]);
        updated++;
      } else {
        errors.push(`Memory not found: ${id}`);
      }
    } catch (e) {
      errors.push(`Failed ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return json({ updated, errors, total: ids.length });
});

// POST /api/memories/extract — extract memories from a session summary
addRoute("POST", "/api/memories/extract", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return errorResponse("Invalid JSON body", 400);

  const sessionId = body["session_id"] as string | undefined;
  const agentId = body["agent_id"] as string | undefined;
  const projectId = body["project_id"] as string | undefined;
  const title = body["title"] as string | undefined;
  const project = body["project"] as string | undefined;
  const model = body["model"] as string | undefined;
  const messages = body["messages"] as number | undefined;
  const keyTopics = Array.isArray(body["key_topics"]) ? (body["key_topics"] as string[]) : [];
  const summary = body["summary"] as string | undefined;
  const extraMemories = Array.isArray(body["memories"]) ? (body["memories"] as Record<string, unknown>[]) : [];

  const created: string[] = [];
  const errors: string[] = [];

  function saveExtracted(key: string, value: string, category: MemoryCategory, importance: number): void {
    try {
      const mem = createMemory({
        key,
        value,
        category,
        scope: "shared",
        importance,
        source: "auto",
        agent_id: agentId,
        project_id: projectId,
        session_id: sessionId,
      });
      created.push(mem.id);
    } catch (e) {
      errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Extract session title as a history memory
  if (title && sessionId) {
    const meta = [
      `title: ${title}`,
      project ? `project: ${project}` : null,
      model ? `model: ${model}` : null,
      messages ? `messages: ${messages}` : null,
    ].filter(Boolean).join(", ");
    saveExtracted(`session-${sessionId}-summary`, `${title} (${meta})`, "history", 6);
  }

  // Extract key topics as knowledge memories
  if (keyTopics.length > 0 && sessionId) {
    saveExtracted(
      `session-${sessionId}-topics`,
      `Key topics: ${keyTopics.join(", ")}`,
      "knowledge",
      5
    );
  }

  // Extract free-form summary text
  if (summary && sessionId) {
    saveExtracted(`session-${sessionId}-notes`, summary, "knowledge", 7);
  }

  // Extract any additional memories passed explicitly
  for (const mem of extraMemories) {
    if (!mem["key"] || !mem["value"]) continue;
    try {
      const created_mem = createMemory({
        ...(mem as Record<string, unknown>),
        source: "auto",
        agent_id: agentId,
        project_id: projectId,
        session_id: sessionId,
      } as CreateMemoryInput);
      created.push(created_mem.id);
    } catch (e) {
      errors.push(`${String(mem["key"])}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return json({ created: created.length, memory_ids: created, errors, session_id: sessionId }, 201);
});

// POST /api/memories/clean — cleanup expired
addRoute("POST", "/api/memories/clean", () => {
  const cleaned = cleanExpiredMemories();
  return json({ cleaned });
});

// POST /api/memories — create memory
addRoute("POST", "/api/memories", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) {
    return errorResponse("Invalid JSON body", 400);
  }
  if (!body["key"] || !body["value"]) {
    return errorResponse("Missing required fields: key, value", 400);
  }

  try {
    // Parse human-readable TTL if provided as string (e.g. "1d", "2h30m")
    if (body["ttl_ms"] !== undefined && typeof body["ttl_ms"] === "string") {
      body["ttl_ms"] = parseDuration(body["ttl_ms"] as string);
    }
    const memory = createMemory(body as unknown as CreateMemoryInput);
    return json(memory, 201);
  } catch (e) {
    if (e instanceof DuplicateMemoryError) {
      return errorResponse(e.message, 409);
    }
    throw e;
  }
});

// GET /api/memories/:id — get single memory
addRoute("GET", "/api/memories/:id", (_req, _url, params) => {
  const memory = getMemory(params["id"]!);
  if (!memory) {
    return errorResponse("Memory not found", 404);
  }
  touchMemory(memory.id);
  return json(memory);
});

// PATCH /api/memories/:id — update memory (version optional — auto-fetched if omitted)
addRoute("PATCH", "/api/memories/:id", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) {
    return errorResponse("Invalid JSON body", 400);
  }

  // Auto-fetch version if not provided (eliminates 2-round-trip read-then-update pattern)
  const updateBody = { ...body };
  if (updateBody["version"] === undefined) {
    const existing = getMemory(params["id"]!);
    if (!existing) return errorResponse("Memory not found", 404);
    updateBody["version"] = existing.version;
  }

  try {
    const memory = updateMemory(params["id"]!, updateBody as any);
    return json(memory);
  } catch (e) {
    if (e instanceof MemoryNotFoundError) {
      return errorResponse(e.message, 404);
    }
    if (e instanceof VersionConflictError) {
      return errorResponse(e.message, 409, {
        expected: e.expected,
        actual: e.actual,
      });
    }
    throw e;
  }
});

// GET /api/memories/:id/versions — version history for a memory
addRoute("GET", "/api/memories/:id/versions", (_req, _url, params) => {
  const memory = getMemory(params["id"]!);
  if (!memory) return errorResponse("Memory not found", 404);
  const versions = getMemoryVersions(memory.id);
  return json({ versions, count: versions.length, current_version: memory.version });
});

// DELETE /api/memories/:id — delete memory
addRoute("DELETE", "/api/memories/:id", (_req, _url, params) => {
  const deleted = deleteMemory(params["id"]!);
  if (!deleted) {
    return errorResponse("Memory not found", 404);
  }
  return json({ deleted: true });
});

// GET /api/inject — get injection context
addRoute("GET", "/api/inject", (_req, url) => {
  const q = getSearchParams(url);
  const maxTokens = q["max_tokens"] ? parseInt(q["max_tokens"], 10) : 500;
  const minImportance = 3;
  const categories: MemoryCategory[] = [
    "preference",
    "fact",
    "knowledge",
  ];

  // Collect memories from all visible scopes
  const allMemories: Memory[] = [];

  // Global memories
  const globalMems = listMemories({
    scope: "global",
    category: categories,
    min_importance: minImportance,
    status: "active",
    project_id: q["project_id"],
    limit: 50,
  });
  allMemories.push(...globalMems);

  // Shared memories (project-scoped)
  if (q["project_id"]) {
    const sharedMems = listMemories({
      scope: "shared",
      category: categories,
      min_importance: minImportance,
      status: "active",
      project_id: q["project_id"],
      limit: 50,
    });
    allMemories.push(...sharedMems);
  }

  // Private memories (agent-scoped)
  if (q["agent_id"]) {
    const privateMems = listMemories({
      scope: "private",
      category: categories,
      min_importance: minImportance,
      status: "active",
      agent_id: q["agent_id"],
      limit: 50,
    });
    allMemories.push(...privateMems);
  }

  // Deduplicate by ID
  const seen = new Set<string>();
  const unique = allMemories.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Sort by importance DESC, then recency
  unique.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return (
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  });

  // Build context within token budget (~4 chars per token estimate)
  const charBudget = maxTokens * 4;
  const lines: string[] = [];
  let totalChars = 0;

  const format = q["format"] || "xml"; // xml | markdown | compact | json

  for (const m of unique) {
    let line: string;
    if (format === "compact") {
      line = `${m.key}: ${m.value}`;
    } else if (format === "json") {
      line = JSON.stringify({ key: m.key, value: m.value, scope: m.scope, category: m.category, importance: m.importance });
    } else {
      // xml (default) and markdown use same line format
      line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
    }
    if (totalChars + line.length > charBudget) break;
    lines.push(line);
    totalChars += line.length;
    touchMemory(m.id);
  }

  if (lines.length === 0) {
    return json({ context: "", memories_count: 0 });
  }

  let context: string;
  if (format === "compact") {
    context = lines.join("\n");
  } else if (format === "json") {
    context = `[${lines.join(",")}]`;
  } else if (format === "markdown") {
    context = `## Agent Memories\n\n${lines.join("\n")}`;
  } else {
    context = `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;
  }
  return json({ context, memories_count: lines.length });
});
