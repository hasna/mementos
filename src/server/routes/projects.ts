import { registerProject, listProjects, getProject } from "../../db/projects.js";
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

// GET /api/projects/:id/agents — list agents active on a project
addRoute("GET", "/api/projects/:id/agents", (_req, _url, params) => {
  const project = getProject(params["id"]!);
  if (!project) return errorResponse("Project not found", 404);
  const agents = listAgentsByProject(project.id);
  return json({ agents, count: agents.length });
});
