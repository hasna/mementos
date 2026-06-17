import { runConsolidation } from "../../lib/consolidation.js";
import { reflectOnTrajectory } from "../../lib/reflection.js";
import type { MemoryScope } from "../../types/index.js";
import { addRoute } from "../router.js";
import { errorResponse, json, readJson } from "../helpers.js";

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function registerSystemConsolidationRoutes(): void {
  addRoute("POST", "/api/consolidate", async (req) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    try {
      const result = await runConsolidation({
        dryRun: Boolean(body["dry_run"] ?? body["dryRun"] ?? false),
        scope: body["scope"] as MemoryScope | undefined,
        projectId: body["project_id"] as string | undefined,
        agentId: body["agent_id"] as string | undefined,
        duplicateThreshold: numberOption(body["duplicate_threshold"] ?? body["duplicateThreshold"]),
        staleDays: numberOption(body["stale_days"] ?? body["staleDays"]),
        decayThreshold: numberOption(body["decay_threshold"] ?? body["decayThreshold"]),
        limit: numberOption(body["limit"]),
      });
      return json(result, result.dryRun ? 200 : 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 500);
    }
  });

  addRoute("POST", "/api/reflect", async (req) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    if (!body["on"]) {
      return errorResponse("Missing required field: on", 400);
    }
    if (!["session", "task", "range"].includes(String(body["on"]))) {
      return errorResponse("Field 'on' must be one of: session, task, range", 400);
    }

    try {
      const result = await reflectOnTrajectory({
        on: body["on"] as "session" | "task" | "range",
        source: body["source"] as string | undefined,
        dryRun: Boolean(body["dry_run"] ?? body["dryRun"] ?? false),
        projectId: body["project_id"] as string | undefined,
        agentId: body["agent_id"] as string | undefined,
        since: body["since"] as string | undefined,
        until: body["until"] as string | undefined,
        provider: body["provider"] as string | undefined,
        model: body["model"] as string | undefined,
        maxTokens: numberOption(body["max_tokens"] ?? body["maxTokens"]),
      });
      return json(result, result.dryRun ? 200 : 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 500);
    }
  });
}
