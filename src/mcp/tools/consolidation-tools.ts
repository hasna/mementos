import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runConsolidation } from "../../lib/consolidation.js";
import { reflectOnTrajectory } from "../../lib/reflection.js";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerConsolidationTools(server: McpServer): void {
  server.tool(
    "memory_consolidate",
    "Consolidate memories: deduplicate/merge near duplicates, promote repeated episodic observations into semantic facts, summarize clusters, and soft-delete stale low-value memories with audit reasons. Use dry_run=true first.",
    {
      dry_run: z.boolean().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      duplicate_threshold: z.coerce.number().min(0).max(1).optional(),
      stale_days: z.coerce.number().min(1).optional(),
      decay_threshold: z.coerce.number().min(0).optional(),
      limit: z.coerce.number().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await runConsolidation({
          dryRun: args.dry_run ?? false,
          scope: args.scope,
          projectId: args.project_id,
          agentId: args.agent_id,
          duplicateThreshold: args.duplicate_threshold,
          staleDays: args.stale_days,
          decayThreshold: args.decay_threshold,
          limit: args.limit,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "memory_reflect",
    "Reflect on a session, task, or range with an LLM-judge critic and write structured lessons back as linked memories. Use dry_run=true to preview.",
    {
      on: z.enum(["session", "task", "range"]),
      source: z.string().optional(),
      dry_run: z.boolean().optional(),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      max_tokens: z.coerce.number().min(1).optional(),
    },
    async (args) => {
      try {
        const result = await reflectOnTrajectory({
          on: args.on,
          source: args.source,
          dryRun: args.dry_run ?? false,
          projectId: args.project_id,
          agentId: args.agent_id,
          since: args.since,
          until: args.until,
          provider: args.provider,
          model: args.model,
          maxTokens: args.max_tokens,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );
}
