#!/usr/bin/env bun
/**
 * Mementos REST API server.
 * Usage: mementos-serve [--port 19428]
 */

import { existsSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMemory,
  getMemory,
  listMemories,
  updateMemory,
  deleteMemory,
  cleanExpiredMemories,
  touchMemory,
} from "../db/memories.js";
import { registerAgent, getAgent, listAgents, listAgentsByProject, updateAgent } from "../db/agents.js";
import { registerProject, listProjects, getProject } from "../db/projects.js";
import { getActiveProfile, listProfiles, getDbPath } from "../lib/config.js";
import { getDatabase } from "../db/database.js";
import { searchMemories } from "../lib/search.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
  DuplicateMemoryError,
  EntityNotFoundError,
} from "../types/index.js";
import { createEntity, getEntity, listEntities, updateEntity, deleteEntity, mergeEntities } from "../db/entities.js";
import { createRelation, getRelation, listRelations, deleteRelation, getEntityGraph, findPath } from "../db/relations.js";
import { linkEntityToMemory, unlinkEntityFromMemory, getMemoriesForEntity } from "../db/entity-memories.js";
import { parseDuration } from "../lib/duration.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryStats,
  MemoryFilter,
  CreateMemoryInput,
  CreateEntityInput,
  UpdateEntityInput,
  EntityType,
  CreateRelationInput,
  RelationType,
  EntityRole,
} from "../types/index.js";

// ============================================================================
// Config
// ============================================================================

const DEFAULT_PORT = 19428;

function parsePort(): number {
  const envPort = process.env["PORT"];
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (!Number.isNaN(p)) return p;
  }

  const portArg = process.argv.find(
    (a) => a === "--port" || a.startsWith("--port=")
  );
  if (portArg) {
    if (portArg.includes("=")) {
      return parseInt(portArg.split("=")[1]!, 10) || DEFAULT_PORT;
    }
    const idx = process.argv.indexOf(portArg);
    return parseInt(process.argv[idx + 1]!, 10) || DEFAULT_PORT;
  }

  return DEFAULT_PORT;
}

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Dashboard static files
// ============================================================================

function resolveDashboardDir(): string {
  const candidates: string[] = [];
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(scriptDir, "..", "dashboard", "dist"));
    candidates.push(join(scriptDir, "..", "..", "dashboard", "dist"));
  } catch { /* ignore */ }
  if (process.argv[1]) {
    const mainDir = dirname(process.argv[1]);
    candidates.push(join(mainDir, "..", "dashboard", "dist"));
    candidates.push(join(mainDir, "..", "..", "dashboard", "dist"));
  }
  candidates.push(join(process.cwd(), "dashboard", "dist"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(process.cwd(), "dashboard", "dist");
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStaticFile(filePath: string): Response | null {
  if (!existsSync(filePath)) return null;
  const ct = MIME_TYPES[extname(filePath)] || "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": ct },
  });
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function errorResponse(
  message: string,
  status: number,
  details?: unknown
): Response {
  const body: Record<string, unknown> = { error: message };
  if (details !== undefined) body["details"] = details;
  return json(body, status);
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function getSearchParams(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    params[k] = v;
  });
  return params;
}

// ============================================================================
// Route matching
// ============================================================================

type RouteHandler = (
  req: Request,
  url: URL,
  params: Record<string, string>
) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function addRoute(
  method: string,
  path: string,
  handler: RouteHandler
): void {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method,
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    handler,
  });
}

function matchRoute(
  method: string,
  pathname: string
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1]!;
      });
      return { handler: route.handler, params };
    }
  }
  return null;
}

// ============================================================================
// Memory endpoints
// ============================================================================

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
  if (q["status"]) filter.status = q["status"] as import("../types/index.js").MemoryStatus;
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
    by_scope: { global: 0, shared: 0, private: 0 },
    by_category: { preference: 0, fact: 0, knowledge: 0, history: 0 },
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

  const rows = db.query(`
    SELECT
      date(created_at) AS date,
      COUNT(*) AS memories_created,
      SUM(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) AS global_count,
      SUM(CASE WHEN scope = 'shared' THEN 1 ELSE 0 END) AS shared_count,
      SUM(CASE WHEN scope = 'private' THEN 1 ELSE 0 END) AS private_count,
      AVG(importance) AS avg_importance
    FROM memories
    WHERE date(created_at) >= date('now', '-${days} days') ${where}
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(...params) as { date: string; memories_created: number; global_count: number; shared_count: number; private_count: number; avg_importance: number }[];

  return json({ activity: rows, days, total: rows.reduce((s, r) => s + r.memories_created, 0) });
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
// Accepts a structured session summary and auto-creates memories from it.
// Designed for sessions ↔ mementos integration (open-sessions can call this after ingest).
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

// DELETE /api/memories/:id — delete memory
addRoute("DELETE", "/api/memories/:id", (_req, _url, params) => {
  const deleted = deleteMemory(params["id"]!);
  if (!deleted) {
    return errorResponse("Memory not found", 404);
  }
  return json({ deleted: true });
});

// ============================================================================
// Agent endpoints
// ============================================================================

// GET /api/agents — list agents
addRoute("GET", "/api/agents", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const agents = q["project_id"]
    ? listAgentsByProject(q["project_id"])
    : listAgents();
  if (q["fields"]) {
    const fields = q["fields"].split(",").map((f: string) => f.trim());
    const filtered = agents.map(a => Object.fromEntries(fields.map((f: string) => [f, (a as unknown as Record<string, unknown>)[f]]).filter(([, v]) => v !== undefined)));
    return json({ agents: filtered, count: filtered.length });
  }
  return json({ agents, count: agents.length });
});

// POST /api/agents — register agent
addRoute("POST", "/api/agents", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["name"]) {
    return errorResponse("Missing required field: name", 400);
  }

  const agent = registerAgent(
    body["name"] as string,
    body["description"] as string | undefined,
    body["role"] as string | undefined
  );
  return json(agent, 201);
});

// GET /api/agents/:id — get agent
addRoute("GET", "/api/agents/:id", (_req, _url, params) => {
  const agent = getAgent(params["id"]!);
  if (!agent) {
    return errorResponse("Agent not found", 404);
  }
  return json(agent);
});

// PATCH /api/agents/:id — update agent
addRoute("PATCH", "/api/agents/:id", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) {
    return errorResponse("Invalid JSON body", 400);
  }
  const updates: { name?: string; description?: string; role?: string; metadata?: Record<string, unknown>; active_project_id?: string | null } = {};
  if (body["name"] !== undefined) updates.name = body["name"] as string;
  if (body["description"] !== undefined) updates.description = body["description"] as string;
  if (body["role"] !== undefined) updates.role = body["role"] as string;
  if (body["metadata"] !== undefined) updates.metadata = body["metadata"] as Record<string, unknown>;
  if ("active_project_id" in body) updates.active_project_id = (body["active_project_id"] as string | null) ?? null;

  try {
    const agent = updateAgent(params["id"]!, updates);
    if (!agent) return errorResponse("Agent not found", 404);
    return json(agent);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Update failed", 400);
  }
});

// ============================================================================
// Project endpoints
// ============================================================================

// GET /api/projects — list projects
addRoute("GET", "/api/projects", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const projects = listProjects();
  if (q["fields"]) {
    const fields = q["fields"].split(",").map((f: string) => f.trim());
    const filtered = projects.map(p => Object.fromEntries(fields.map((f: string) => [f, (p as unknown as Record<string, unknown>)[f]]).filter(([, v]) => v !== undefined)));
    return json({ projects: filtered, count: filtered.length });
  }
  return json({ projects, count: projects.length });
});

// POST /api/projects — register project
addRoute("POST", "/api/projects", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["name"] || !body["path"]) {
    return errorResponse("Missing required fields: name, path", 400);
  }

  const project = registerProject(
    body["name"] as string,
    body["path"] as string,
    body["description"] as string | undefined,
    body["memory_prefix"] as string | undefined
  );
  return json(project, 201);
});

// GET /api/projects/:id — get project by ID or name
addRoute("GET", "/api/projects/:id", (_req, _url, params) => {
  const project = getProject(params["id"]!);
  if (!project) return errorResponse("Project not found", 404);
  return json(project);
});

// GET /api/projects/:id/agents — list agents active on a project
addRoute("GET", "/api/projects/:id/agents", (_req, _url, params) => {
  const project = getProject(params["id"]!);
  if (!project) return errorResponse("Project not found", 404);
  const agents = listAgentsByProject(project.id);
  return json({ agents, count: agents.length });
});

// ============================================================================
// Injection endpoint
// ============================================================================

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

// ============================================================================
// Entity endpoints
// ============================================================================

// GET /api/entities — list entities
addRoute("GET", "/api/entities", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const filter: { type?: EntityType; project_id?: string; search?: string; limit?: number; offset?: number } = {};

  if (q["type"]) filter.type = q["type"] as EntityType;
  if (q["project_id"]) filter.project_id = q["project_id"];
  if (q["search"]) filter.search = q["search"];
  if (q["limit"]) filter.limit = parseInt(q["limit"], 10);
  if (q["offset"]) filter.offset = parseInt(q["offset"], 10);

  const entities = listEntities(filter);
  if (q["fields"]) {
    const fields = q["fields"].split(",").map((f: string) => f.trim());
    const filtered = entities.map(e => Object.fromEntries(fields.map((f: string) => [f, (e as unknown as Record<string, unknown>)[f]]).filter(([, v]) => v !== undefined)));
    return json({ entities: filtered, count: filtered.length });
  }
  return json({ entities, count: entities.length });
});

// POST /api/entities/merge — merge entities (must be before :id routes)
addRoute("POST", "/api/entities/merge", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["source_id"] || !body["target_id"]) {
    return errorResponse("Missing required fields: source_id, target_id", 400);
  }

  try {
    const merged = mergeEntities(body["source_id"] as string, body["target_id"] as string);
    return json(merged);
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// POST /api/entities — create entity
addRoute("POST", "/api/entities", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["name"] || !body["type"]) {
    return errorResponse("Missing required fields: name, type", 400);
  }

  try {
    const entity = createEntity(body as unknown as CreateEntityInput);
    return json(entity, 201);
  } catch (e) {
    throw e;
  }
});

// GET /api/entities/:id/memories — get memories linked to entity
addRoute("GET", "/api/entities/:id/memories", (_req, _url, params) => {
  try {
    getEntity(params["id"]!); // verify entity exists
    const memories = getMemoriesForEntity(params["id"]!);
    return json({ memories, count: memories.length });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// POST /api/entities/:id/memories — link memory to entity
addRoute("POST", "/api/entities/:id/memories", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["memory_id"]) {
    return errorResponse("Missing required field: memory_id", 400);
  }

  try {
    const link = linkEntityToMemory(
      params["id"]!,
      body["memory_id"] as string,
      (body["role"] as EntityRole | undefined) || undefined
    );
    return json(link, 201);
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// GET /api/entities/:id/relations — list relations for entity
addRoute("GET", "/api/entities/:id/relations", (_req, url, params) => {
  const q = getSearchParams(url);
  try {
    getEntity(params["id"]!); // verify entity exists
    const relations = listRelations({
      entity_id: params["id"]!,
      relation_type: q["type"] as RelationType | undefined,
      direction: q["direction"] as "outgoing" | "incoming" | "both" | undefined,
    });
    return json({ relations, count: relations.length });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// DELETE /api/entities/:entityId/memories/:memoryId — unlink memory from entity
addRoute("DELETE", "/api/entities/:entityId/memories/:memoryId", (_req, _url, params) => {
  unlinkEntityFromMemory(params["entityId"]!, params["memoryId"]!);
  return json({ deleted: true });
});

// GET /api/entities/:id — get entity with relations + memories
addRoute("GET", "/api/entities/:id", (_req, _url, params) => {
  try {
    const entity = getEntity(params["id"]!);
    const relations = listRelations({ entity_id: params["id"]! });
    const memories = getMemoriesForEntity(params["id"]!);
    return json({ ...entity, relations, memories });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// PATCH /api/entities/:id — update entity
addRoute("PATCH", "/api/entities/:id", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) {
    return errorResponse("Invalid JSON body", 400);
  }

  try {
    const entity = updateEntity(params["id"]!, body as unknown as UpdateEntityInput);
    return json(entity);
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// DELETE /api/entities/:id — delete entity (cascade)
addRoute("DELETE", "/api/entities/:id", (_req, _url, params) => {
  try {
    deleteEntity(params["id"]!);
    return json({ deleted: true });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// ============================================================================
// Relation endpoints
// ============================================================================

// POST /api/relations — create relation
addRoute("POST", "/api/relations", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["source_entity_id"] || !body["target_entity_id"] || !body["relation_type"]) {
    return errorResponse("Missing required fields: source_entity_id, target_entity_id, relation_type", 400);
  }

  try {
    const relation = createRelation(body as unknown as CreateRelationInput);
    return json(relation, 201);
  } catch (e) {
    throw e;
  }
});

// GET /api/relations/:id — get relation
addRoute("GET", "/api/relations/:id", (_req, _url, params) => {
  try {
    const relation = getRelation(params["id"]!);
    return json(relation);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Relation not found")) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// DELETE /api/relations/:id — delete relation
addRoute("DELETE", "/api/relations/:id", (_req, _url, params) => {
  try {
    deleteRelation(params["id"]!);
    return json({ deleted: true });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Relation not found")) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// ============================================================================
// Graph endpoints
// ============================================================================

// GET /api/graph/path — find path between entities
addRoute("GET", "/api/graph/path", (_req, url) => {
  const q = getSearchParams(url);
  if (!q["from"] || !q["to"]) {
    return errorResponse("Missing required query params: from, to", 400);
  }

  const maxDepth = q["max_depth"] ? parseInt(q["max_depth"], 10) : 5;

  try {
    const path = findPath(q["from"], q["to"], maxDepth);
    if (!path) {
      return json({ path: null, found: false });
    }
    return json({ path, found: true, length: path.length });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// GET /api/graph/stats — entity/relation counts by type
addRoute("GET", "/api/graph/stats", () => {
  const db = getDatabase();

  const entityCount = (
    db.query("SELECT COUNT(*) as c FROM entities").get() as { c: number }
  ).c;
  const relationCount = (
    db.query("SELECT COUNT(*) as c FROM relations").get() as { c: number }
  ).c;
  const entitiesByType = db
    .query("SELECT type, COUNT(*) as c FROM entities GROUP BY type")
    .all() as { type: string; c: number }[];
  const relationsByType = db
    .query("SELECT relation_type, COUNT(*) as c FROM relations GROUP BY relation_type")
    .all() as { relation_type: string; c: number }[];

  return json({
    entities: {
      total: entityCount,
      by_type: Object.fromEntries(entitiesByType.map((r) => [r.type, r.c])),
    },
    relations: {
      total: relationCount,
      by_type: Object.fromEntries(relationsByType.map((r) => [r.relation_type, r.c])),
    },
  });
});

// GET /api/graph/:entityId — get connected graph
addRoute("GET", "/api/graph/:entityId", (_req, url, params) => {
  const q = getSearchParams(url);
  const depth = q["depth"] ? parseInt(q["depth"], 10) : 2;

  try {
    const graph = getEntityGraph(params["entityId"]!, depth);
    return json(graph);
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// ============================================================================
// Server
// ============================================================================

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    try {
      const server = Bun.serve({ port, fetch: () => new Response("") });
      server.stop(true);
      return port;
    } catch {
      // Port in use, try next
    }
  }
  return start;
}

export function startServer(port: number): void {
  const hostname = process.env["MEMENTOS_HOST"] ?? "127.0.0.1";
  Bun.serve({
    port,
    hostname,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { pathname } = url;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Health check
      if (pathname === "/api/health" || pathname === "/health") {
        const profile = getActiveProfile();
        return json({ status: "ok", version: "0.1.0", profile: profile ?? "default", db_path: getDbPath(), hostname });
      }

      // Profile info
      if (pathname === "/api/profile" && req.method === "GET") {
        const profile = getActiveProfile();
        return json({ active: profile ?? null, profiles: listProfiles(), db_path: getDbPath() });
      }

      // SSE stream for live memory updates
      if (pathname === "/api/memories/stream" && req.method === "GET") {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            let lastSeen = new Date().toISOString();

            const send = (data: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            };

            // Send initial ping
            send({ type: "connected", timestamp: lastSeen });

            const interval = setInterval(() => {
              try {
                const db = getDatabase();
                const rows = db
                  .query(
                    "SELECT * FROM memories WHERE updated_at > ? OR created_at > ? ORDER BY updated_at DESC LIMIT 50"
                  )
                  .all(lastSeen, lastSeen) as Record<string, unknown>[];

                if (rows.length > 0) {
                  lastSeen = new Date().toISOString();
                  send({ type: "memories", data: rows, count: rows.length });
                }
              } catch {
                // ignore polling errors
              }
            }, 1000);

            // Cleanup on close
            req.signal.addEventListener("abort", () => {
              clearInterval(interval);
              controller.close();
            });
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...CORS_HEADERS,
          },
        });
      }

      // Route matching
      const matched = matchRoute(req.method, pathname);
      if (!matched) {
        // API routes always return JSON 404
        if (pathname.startsWith("/api/")) {
          return errorResponse("Not found", 404);
        }
        // Serve dashboard static files for non-API routes
        const dashDir = resolveDashboardDir();
        if (existsSync(dashDir) && (req.method === "GET" || req.method === "HEAD")) {
          if (pathname !== "/") {
            // Path traversal guard: resolved path must stay within dashDir
            const resolvedDash = resolve(dashDir) + sep;
            const requestedPath = resolve(join(dashDir, pathname));
            if (requestedPath.startsWith(resolvedDash)) {
              const staticRes = serveStaticFile(requestedPath);
              if (staticRes) return staticRes;
            }
          }
          // SPA fallback — serve index.html
          const indexRes = serveStaticFile(join(dashDir, "index.html"));
          if (indexRes) return indexRes;
        }
        return errorResponse("Not found", 404);
      }

      try {
        return await matched.handler(req, url, matched.params);
      } catch (e) {
        console.error(`[mementos-serve] ${req.method} ${pathname}:`, e);
        const message =
          e instanceof Error ? e.message : "Internal server error";
        return errorResponse(message, 500);
      }
    },
  });

  console.log(`Mementos server listening on http://${hostname}:${port}`);
}

async function main(): Promise<void> {
  const requestedPort = parsePort();
  const port = await findFreePort(requestedPort);
  if (port !== requestedPort) {
    console.log(`Port ${requestedPort} in use, using ${port}`);
  }
  startServer(port);
}

main();
