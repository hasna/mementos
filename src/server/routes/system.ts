import {
  processConversationTurn,
  getAutoMemoryStats,
  configureAutoMemory,
} from "../../lib/auto-memory.js";
import { providerRegistry } from "../../lib/providers/registry.js";
import { hookRegistry } from "../../lib/hooks.js";
import { reloadWebhooks } from "../../lib/built-in-hooks.js";
import { runSynthesis, rollbackSynthesis, getSynthesisStatus } from "../../lib/synthesis/index.js";
import { listSynthesisRuns } from "../../db/synthesis.js";
import { createSessionJob, getSessionJob, listSessionJobs } from "../../db/session-jobs.js";
import { saveToolEvent, getToolEvents, getToolStats, getToolLessons } from "../../db/tool-events.js";
import { synthesizeProfile } from "../../lib/profile-synthesizer.js";
import { enqueueSessionJob, getSessionQueueStats } from "../../lib/session-queue.js";
import { autoResolveAgentProject } from "../../lib/session-auto-resolve.js";
import {
  createWebhookHook,
  listWebhookHooks,
  getWebhookHook,
  updateWebhookHook,
  deleteWebhookHook,
} from "../../db/webhook_hooks.js";
import { getDatabase } from "../../db/database.js";
import type { CreateToolEventInput } from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson, getSearchParams } from "../helpers.js";

// POST /api/auto-memory/process — enqueue turn for async extraction
addRoute("POST", "/api/auto-memory/process", async (req) => {
  const body = (await readJson(req)) as Record<string, string> | null;
  const turn = body?.turn;
  if (!turn) return errorResponse("turn is required", 400);
  processConversationTurn(turn, { agentId: body?.agent_id, projectId: body?.project_id, sessionId: body?.session_id });
  const stats = getAutoMemoryStats();
  return json({ queued: true, queue: stats }, 202);
});

// GET /api/auto-memory/status — queue stats + provider health
addRoute("GET", "/api/auto-memory/status", () => {
  return json({
    queue: getAutoMemoryStats(),
    config: providerRegistry.getConfig(),
    providers: providerRegistry.health(),
  });
});

// GET /api/auto-memory/config — current provider config
addRoute("GET", "/api/auto-memory/config", () => {
  return json(providerRegistry.getConfig());
});

// PATCH /api/auto-memory/config — update provider/model/enabled at runtime
addRoute("PATCH", "/api/auto-memory/config", async (req) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof configureAutoMemory>[0] = {};
  if (body.provider) patch.provider = body.provider as "anthropic" | "openai" | "cerebras" | "grok";
  if (body.model) patch.model = body.model as string;
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.min_importance !== undefined) patch.minImportance = Number(body.min_importance);
  if (body.auto_entity_link !== undefined) patch.autoEntityLink = Boolean(body.auto_entity_link);
  configureAutoMemory(patch);
  return json({ updated: true, config: providerRegistry.getConfig() });
});

// POST /api/auto-memory/test — dry run extraction (nothing saved)
addRoute("POST", "/api/auto-memory/test", async (req) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, string>;
  const { turn, provider: providerName, agent_id, project_id } = body;
  if (!turn) return errorResponse("turn is required", 400);

  const provider = providerName
    ? providerRegistry.getProvider(providerName as "anthropic" | "openai" | "cerebras" | "grok")
    : providerRegistry.getAvailable();

  if (!provider) return errorResponse("No LLM provider configured. Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, CEREBRAS_API_KEY, or XAI_API_KEY).", 503);

  const memories = await provider.extractMemories(turn, { agentId: agent_id, projectId: project_id });
  return json({
    provider: provider.name,
    model: provider.config.model,
    extracted: memories,
    count: memories.length,
    note: "DRY RUN — nothing was saved",
  });
});

// GET /api/hooks — list in-memory registered hooks
addRoute("GET", "/api/hooks", (_req, url) => {
  const type = url.searchParams.get("type") ?? undefined;
  const hooks = hookRegistry.list(type as Parameters<typeof hookRegistry.list>[0]);
  return json(hooks.map((h) => ({
    id: h.id,
    type: h.type,
    blocking: h.blocking,
    priority: h.priority,
    builtin: h.builtin ?? false,
    agentId: h.agentId,
    projectId: h.projectId,
    description: h.description,
  })));
});

// GET /api/hooks/stats — hook registry stats
addRoute("GET", "/api/hooks/stats", () => json(hookRegistry.stats()));

// GET /api/webhooks — list persisted webhook hooks
addRoute("GET", "/api/webhooks", (_req, url) => {
  const type = url.searchParams.get("type") ?? undefined;
  const enabledParam = url.searchParams.get("enabled");
  const enabled = enabledParam !== null ? enabledParam === "true" : undefined;
  return json(listWebhookHooks({
    type: type as import("../../types/hooks.js").HookType | undefined,
    enabled,
  }));
});

// POST /api/webhooks — create a webhook
addRoute("POST", "/api/webhooks", async (req) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  if (!body.type || !body.handler_url) {
    return errorResponse("type and handler_url are required", 400);
  }
  const wh = createWebhookHook({
    type: body.type as import("../../types/hooks.js").HookType,
    handlerUrl: body.handler_url as string,
    priority: body.priority as number | undefined,
    blocking: body.blocking as boolean | undefined,
    agentId: body.agent_id as string | undefined,
    projectId: body.project_id as string | undefined,
    description: body.description as string | undefined,
  });
  reloadWebhooks();
  return json(wh, 201);
});

// GET /api/webhooks/:id — get a webhook
addRoute("GET", "/api/webhooks/:id", (_req, _url, params) => {
  const wh = getWebhookHook(params["id"]!);
  if (!wh) return errorResponse("Webhook not found", 404);
  return json(wh);
});

// PATCH /api/webhooks/:id — update a webhook
addRoute("PATCH", "/api/webhooks/:id", async (req, _url, params) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  const updated = updateWebhookHook(params["id"]!, {
    enabled: body.enabled as boolean | undefined,
    priority: body.priority as number | undefined,
    description: body.description as string | undefined,
  });
  if (!updated) return errorResponse("Webhook not found", 404);
  reloadWebhooks();
  return json(updated);
});

// DELETE /api/webhooks/:id — delete a webhook
addRoute("DELETE", "/api/webhooks/:id", (_req, _url, params) => {
  const deleted = deleteWebhookHook(params["id"]!);
  if (!deleted) return errorResponse("Webhook not found", 404);
  return new Response(null, { status: 204 });
});

// POST /api/synthesis/run — trigger a synthesis run
addRoute("POST", "/api/synthesis/run", async (req) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  const result = await runSynthesis({
    projectId: body.project_id as string | undefined,
    agentId: body.agent_id as string | undefined,
    dryRun: body.dry_run as boolean | undefined,
    maxProposals: body.max_proposals as number | undefined,
    provider: body.provider as string | undefined,
  });
  return json(result, result.dryRun ? 200 : 201);
});

// GET /api/synthesis/runs — list synthesis runs
addRoute("GET", "/api/synthesis/runs", (_req, url) => {
  const projectId = url.searchParams.get("project_id") ?? undefined;
  const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 20;
  const runs = listSynthesisRuns({ project_id: projectId, limit });
  return json({ runs, count: runs.length });
});

// GET /api/synthesis/status — current synthesis status
addRoute("GET", "/api/synthesis/status", (_req, url) => {
  const projectId = url.searchParams.get("project_id") ?? undefined;
  const runId = url.searchParams.get("run_id") ?? undefined;
  return json(getSynthesisStatus(runId, projectId));
});

// POST /api/synthesis/rollback/:run_id — roll back a run
addRoute("POST", "/api/synthesis/rollback/:run_id", async (_req, _url, params) => {
  const result = await rollbackSynthesis(params["run_id"]!);
  return json(result);
});

// POST /api/sessions/ingest — submit a session transcript for async memory extraction
addRoute("POST", "/api/sessions/ingest", async (req) => {
  const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  const { transcript, session_id, agent_id, project_id, source, metadata } = body;
  if (!transcript || typeof transcript !== "string") return errorResponse("transcript is required", 400);
  if (!session_id || typeof session_id !== "string") return errorResponse("session_id is required", 400);

  // Auto-resolve if no agent/project provided
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

// GET /api/sessions/jobs — list session jobs
addRoute("GET", "/api/sessions/jobs", (_req, url) => {
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const projectId = url.searchParams.get("project_id") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 20;
  const jobs = listSessionJobs({ agent_id: agentId, project_id: projectId, status: status as "pending" | "processing" | "completed" | "failed" | undefined, limit });
  return json({ jobs, count: jobs.length });
});

// GET /api/sessions/jobs/:id — get a specific job
addRoute("GET", "/api/sessions/jobs/:id", (_req, _url, params) => {
  const job = getSessionJob(params["id"]!);
  if (!job) return errorResponse("Session job not found", 404);
  return json(job);
});

// GET /api/sessions/queue/stats — queue statistics
addRoute("GET", "/api/sessions/queue/stats", () => json(getSessionQueueStats()));

// POST /api/tool-events — save a tool event
addRoute("POST", "/api/tool-events", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["tool_name"]) {
    return errorResponse("Missing required field: tool_name", 400);
  }

  const event = saveToolEvent(body as unknown as CreateToolEventInput);
  return json(event, 201);
});

// GET /api/tool-events — list tool events
addRoute("GET", "/api/tool-events", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const filters: {
    tool_name?: string;
    agent_id?: string;
    project_id?: string;
    success?: boolean;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  } = {};

  if (q["tool_name"]) filters.tool_name = q["tool_name"];
  if (q["agent_id"]) filters.agent_id = q["agent_id"];
  if (q["project_id"]) filters.project_id = q["project_id"];
  if (q["success"] !== undefined && q["success"] !== "") filters.success = q["success"] === "true";
  if (q["from_date"]) filters.from_date = q["from_date"];
  if (q["to_date"]) filters.to_date = q["to_date"];
  if (q["limit"]) filters.limit = parseInt(q["limit"], 10);
  if (q["offset"]) filters.offset = parseInt(q["offset"], 10);

  const events = getToolEvents(filters);
  return json({ events, count: events.length });
});

// GET /api/tool-insights/:tool_name — tool stats + lessons
addRoute("GET", "/api/tool-insights/:tool_name", (_req: Request, url: URL, params) => {
  const q = getSearchParams(url);
  const toolName = decodeURIComponent(params["tool_name"]!);
  const projectId = q["project_id"];
  const lessonsLimit = q["limit"] ? parseInt(q["limit"], 10) : 20;

  const stats = getToolStats(toolName, projectId || undefined);
  const lessons = getToolLessons(toolName, projectId || undefined, lessonsLimit);

  return json({ stats, lessons });
});

// GET /api/profile/synthesize — get/refresh synthesized profile
addRoute("GET", "/api/profile/synthesize", async (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const result = await synthesizeProfile({
    project_id: q["project_id"] || undefined,
    agent_id: q["agent_id"] || undefined,
    force_refresh: q["force_refresh"] === "true",
  });

  if (!result) {
    return json({ profile: null, message: "No preference/fact memories found to synthesize" });
  }

  return json(result);
});

// GET /api/chains/:sequence_group — get memory chain ordered by sequence_order
addRoute("GET", "/api/chains/:sequence_group", (_req: Request, _url: URL, params) => {
  const db = getDatabase();
  const sequenceGroup = decodeURIComponent(params["sequence_group"]!);

  const rows = db.query(
    `SELECT * FROM memories WHERE sequence_group = ? AND status = 'active' ORDER BY sequence_order ASC`
  ).all(sequenceGroup) as Record<string, unknown>[];

  if (rows.length === 0) {
    return json({ chain: [], count: 0, sequence_group: sequenceGroup });
  }

  return json({ chain: rows, count: rows.length, sequence_group: sequenceGroup });
});
