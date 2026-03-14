#!/usr/bin/env bun
/**
 * Mementos REST API server.
 * Usage: mementos-serve [--port 19428]
 */

import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
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
import { registerAgent, getAgent, listAgents } from "../db/agents.js";
import { registerProject, listProjects } from "../db/projects.js";
import { getDatabase } from "../db/database.js";
import { searchMemories } from "../lib/search.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
  DuplicateMemoryError,
  EntityNotFoundError,
} from "../types/index.js";
import { createEntity, getEntity, getEntityByName, listEntities, updateEntity, deleteEntity, mergeEntities } from "../db/entities.js";
import { createRelation, getRelation, listRelations, deleteRelation, getRelatedEntities, getEntityGraph, findPath } from "../db/relations.js";
import { linkEntityToMemory, unlinkEntityFromMemory, getMemoriesForEntity, getEntitiesForMemory } from "../db/entity-memories.js";
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

// PATCH /api/memories/:id — update memory
addRoute("PATCH", "/api/memories/:id", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) {
    return errorResponse("Invalid JSON body", 400);
  }
  if (body["version"] === undefined) {
    return errorResponse("Missing required field: version", 400);
  }

  try {
    const memory = updateMemory(params["id"]!, body as any);
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
addRoute("GET", "/api/agents", () => {
  const agents = listAgents();
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

// ============================================================================
// Project endpoints
// ============================================================================

// GET /api/projects — list projects
addRoute("GET", "/api/projects", () => {
  const projects = listProjects();
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

  for (const m of unique) {
    const line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
    if (totalChars + line.length > charBudget) break;
    lines.push(line);
    totalChars += line.length;
    touchMemory(m.id);
  }

  if (lines.length === 0) {
    return json({ context: "", memories_count: 0 });
  }

  const context = `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;
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
      (body["role"] as string) || undefined
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
  Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { pathname } = url;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Health check
      if (pathname === "/api/health" || pathname === "/health") {
        return json({ status: "ok", version: "0.1.0" });
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
            const staticRes = serveStaticFile(join(dashDir, pathname));
            if (staticRes) return staticRes;
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

  console.log(`Mementos server listening on http://localhost:${port}`);
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
