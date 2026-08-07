import {
  applyProjectUpdate,
  getProjectUpdateReceipt,
  previewProjectUpdate,
  registerProject,
  listProjects,
  getProject,
  rollbackProjectUpdate,
  ProjectGuardedUpdateError,
} from "../../db/projects.js";
import type {
  ProjectAuthorityIdentity,
  ProjectGuardedRollbackRequest,
  ProjectGuardedUpdateRequest,
} from "../../types/index.js";
import { listAgentsByProject } from "../../db/agents.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson, getSearchParams } from "../helpers.js";

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

function guardedUpdateError(error: ProjectGuardedUpdateError): Response {
  const status = error.code === "PROJECT_UPDATE_AUTHORITY_MISMATCH"
    ? 403
    : error.code === "PROJECT_UPDATE_NOT_FOUND"
      || error.code === "PROJECT_UPDATE_RECEIPT_NOT_FOUND"
      ? 404
      : error.code === "PROJECT_UPDATE_INVALID_INPUT"
        ? 400
        : 409;
  return errorResponse(error.message, status, { code: error.code, ...error.details });
}

// Direct writes are deliberately disabled. The guarded route below binds the
// exact stable ID, expected revision, caller idempotency key, and receipt.
addRoute("PATCH", "/api/projects/:id", () => errorResponse(
  "Unguarded project updates are disabled; use POST /projects/:id/guarded-update",
  428,
));

addRoute("POST", "/api/projects/:id/guarded-update", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return errorResponse("Invalid JSON body", 400);
  try {
    const request = body as unknown as ProjectGuardedUpdateRequest & { dry_run?: boolean };
    return json(request.dry_run
      ? previewProjectUpdate(params["id"]!, request)
      : applyProjectUpdate(params["id"]!, request));
  } catch (error) {
    if (error instanceof ProjectGuardedUpdateError) return guardedUpdateError(error);
    throw error;
  }
});

addRoute("POST", "/api/projects/:id/guarded-rollback", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return errorResponse("Invalid JSON body", 400);
  try {
    return json(rollbackProjectUpdate(
      params["id"]!,
      body as unknown as ProjectGuardedRollbackRequest,
    ));
  } catch (error) {
    if (error instanceof ProjectGuardedUpdateError) return guardedUpdateError(error);
    throw error;
  }
});

addRoute("POST", "/api/projects/:id/update-receipts/lookup", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || typeof body["receipt_id"] !== "string") {
    return errorResponse("receipt_id is required", 400);
  }
  try {
    const identity: ProjectAuthorityIdentity = {
      authority_id: String(body["authority_id"] ?? ""),
      tenant_id: String(body["tenant_id"] ?? ""),
      corpus_id: String(body["corpus_id"] ?? ""),
    };
    return json(getProjectUpdateReceipt(
      params["id"]!,
      body["receipt_id"],
      identity,
    ));
  } catch (error) {
    if (error instanceof ProjectGuardedUpdateError) return guardedUpdateError(error);
    throw error;
  }
});

// GET /api/projects/:id/agents — list agents active on a project
addRoute("GET", "/api/projects/:id/agents", (_req, _url, params) => {
  const project = getProject(params["id"]!);
  if (!project) return errorResponse("Project not found", 404);
  const agents = listAgentsByProject(project.id);
  return json({ agents, count: agents.length });
});
