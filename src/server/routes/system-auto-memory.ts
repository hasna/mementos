import {
  processConversationTurn,
  getAutoMemoryStats,
  configureAutoMemory,
} from "../../lib/auto-memory.js";
import { providerRegistry } from "../../lib/providers/registry.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson } from "../helpers.js";

export function registerSystemAutoMemoryRoutes(): void {
  addRoute("POST", "/api/auto-memory/process", async (req) => {
    const body = (await readJson(req)) as Record<string, string> | null;
    const turn = body?.turn;
    if (!turn) return errorResponse("turn is required", 400);
    processConversationTurn(turn, { agentId: body?.agent_id, projectId: body?.project_id, sessionId: body?.session_id });
    const stats = getAutoMemoryStats();
    return json({ queued: true, queue: stats }, 202);
  });

  addRoute("GET", "/api/auto-memory/status", () => {
    return json({
      queue: getAutoMemoryStats(),
      config: providerRegistry.getConfig(),
      providers: providerRegistry.health(),
    });
  });

  addRoute("GET", "/api/auto-memory/config", () => {
    return json(providerRegistry.getConfig());
  });

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

  addRoute("POST", "/api/auto-memory/test", async (req) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, string>;
    const { turn, provider: providerName, agent_id, project_id } = body;
    if (!turn) return errorResponse("turn is required", 400);

    const provider = providerName
      ? providerRegistry.getProvider(providerName as "anthropic" | "openai" | "cerebras" | "grok")
      : providerRegistry.getAvailable();

    if (!provider) return errorResponse("No LLM provider configured. Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, CEREBRAS_API_KEY, or XAI_API_KEY).", 503);

    try {
      const memories = await provider.extractMemories(turn, { agentId: agent_id, projectId: project_id });
      return json({
        provider: provider.name,
        model: provider.config.model,
        extracted: memories,
        count: memories.length,
        note: "DRY RUN — nothing was saved",
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
