import { createSessionJob, getSessionJob, listSessionJobs } from "../../db/session-jobs.js";
import { enqueueSessionJob, getSessionQueueStats } from "../../lib/session-queue.js";
import { autoResolveAgentProject } from "../../lib/session-auto-resolve.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson } from "../helpers.js";

export function registerSystemSessionRoutes(): void {
  addRoute("POST", "/api/sessions/ingest", async (req) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    const { transcript, session_id, agent_id, project_id, source, metadata } = body;
    if (!transcript || typeof transcript !== "string") return errorResponse("transcript is required", 400);
    if (!session_id || typeof session_id !== "string") return errorResponse("session_id is required", 400);

    let resolvedAgentId = agent_id as string | undefined;
    let resolvedProjectId = project_id as string | undefined;
    if (!resolvedAgentId || !resolvedProjectId) {
      const resolved = autoResolveAgentProject((metadata ?? {}) as Record<string, string>);
      if (!resolvedAgentId && resolved.agentId) resolvedAgentId = resolved.agentId;
      if (!resolvedProjectId && resolved.projectId) resolvedProjectId = resolved.projectId;
    }

    const job = createSessionJob({
      session_id: session_id as string,
      transcript: transcript as string,
      source: (source as "claude-code" | "codex" | "manual" | "open-sessions") ?? "manual",
      agent_id: resolvedAgentId,
      project_id: resolvedProjectId,
      metadata: (metadata as Record<string, unknown>) ?? {},
    });
    enqueueSessionJob(job.id);
    return json({ job_id: job.id, status: "queued", message: "Session queued for memory extraction" }, 202);
  });

  addRoute("GET", "/api/sessions/jobs", (_req, url) => {
    const agentId = url.searchParams.get("agent_id") ?? undefined;
    const projectId = url.searchParams.get("project_id") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 20;
    const jobs = listSessionJobs({ agent_id: agentId, project_id: projectId, status: status as "pending" | "processing" | "completed" | "failed" | undefined, limit });
    return json({ jobs, count: jobs.length });
  });

  addRoute("GET", "/api/sessions/jobs/:id", (_req, _url, params) => {
    const job = getSessionJob(params["id"]!);
    if (!job) return errorResponse("Session job not found", 404);
    return json(job);
  });

  addRoute("GET", "/api/sessions/queue/stats", () => json(getSessionQueueStats()));
}
