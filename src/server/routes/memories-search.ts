import { searchMemories, hybridSearch, searchWithBm25 } from "../../lib/search.js";
import type { MemoryCategory, MemoryScope, MemoryFilter } from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson } from "../helpers.js";

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
  if (body["session_id"]) filter.session_id = body["session_id"] as string;
  if (body["namespace"]) filter.namespace = body["namespace"] as string;
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
  if (body["session_id"]) filter.session_id = body["session_id"] as string;
  if (body["namespace"]) filter.namespace = body["namespace"] as string;

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
  if (body["session_id"]) filter.session_id = body["session_id"] as string;
  if (body["namespace"]) filter.namespace = body["namespace"] as string;
  if (body["limit"]) filter.limit = body["limit"] as number;

  const results = searchWithBm25(body["query"] as string, filter);
  return json({ results, count: results.length });
});
