import {
  getMemory,
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  touchMemory,
  getMemoryVersions,
} from "../../db/memories.js";
import { parseDuration } from "../../lib/duration.js";
import type {
  MemoryCategory,
  MemoryScope,
  MemoryFilter,
  CreateMemoryInput,
} from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson, getSearchParams } from "../helpers.js";
import { MemoryNotFoundError, VersionConflictError, DuplicateMemoryError } from "../../types/index.js";

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
  if (q["namespace"]) filter.namespace = q["namespace"];
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
