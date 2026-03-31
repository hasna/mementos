import { registerAgent, getAgent, listAgents, listAgentsByProject, updateAgent } from "../../db/agents.js";
import {
  acquireLock,
  releaseLock,
  releaseAllAgentLocks,
  checkLock,
  listAgentLocks,
  cleanExpiredLocks,
  type ResourceType,
  type LockType,
} from "../../db/locks.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson, getSearchParams } from "../helpers.js";

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
    body["session_id"] as string | undefined,
    body["description"] as string | undefined,
    body["role"] as string | undefined,
    body["project_id"] as string | undefined
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

// POST /api/locks — acquire a lock
addRoute("POST", "/api/locks", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body?.agent_id || !body?.resource_type || !body?.resource_id) {
    return errorResponse("Missing required fields: agent_id, resource_type, resource_id", 400);
  }
  const lock = acquireLock(
    body["agent_id"] as string,
    body["resource_type"] as ResourceType,
    body["resource_id"] as string,
    (body["lock_type"] as LockType) || "exclusive",
    (body["ttl_seconds"] as number) || 300
  );
  if (!lock) {
    const existing = checkLock(body["resource_type"] as ResourceType, body["resource_id"] as string, "exclusive");
    return errorResponse(
      `Lock conflict: resource ${body["resource_type"]}:${body["resource_id"]} is held by agent ${existing[0]?.agent_id ?? "unknown"}`,
      409
    );
  }
  return json(lock, 201);
});

// GET /api/locks — check locks on a resource
addRoute("GET", "/api/locks", (_req, url) => {
  const resourceType = url.searchParams.get("resource_type") as ResourceType | null;
  const resourceId = url.searchParams.get("resource_id");
  const lockType = url.searchParams.get("lock_type") as LockType | undefined;
  if (!resourceType || !resourceId) {
    return errorResponse("Missing required query params: resource_type, resource_id", 400);
  }
  return json(checkLock(resourceType, resourceId, lockType));
});

// DELETE /api/locks/:id — release a lock
addRoute("DELETE", "/api/locks/:id", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body?.agent_id) return errorResponse("Missing required field: agent_id", 400);
  const released = releaseLock(params["id"]!, body["agent_id"] as string);
  if (!released) return errorResponse("Lock not found or not owned by this agent", 404);
  return json({ released: true });
});

// GET /api/agents/:id/locks — list all locks held by an agent
addRoute("GET", "/api/agents/:id/locks", (_req, _url, params) => {
  return json(listAgentLocks(params["id"]!));
});

// DELETE /api/agents/:id/locks — release all locks for an agent
addRoute("DELETE", "/api/agents/:id/locks", (_req, _url, params) => {
  const count = releaseAllAgentLocks(params["id"]!);
  return json({ released: count });
});

// POST /api/locks/clean — clean expired locks
addRoute("POST", "/api/locks/clean", () => {
  const count = cleanExpiredLocks();
  return json({ cleaned: count });
});
