import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSynthesis, rollbackSynthesis, getSynthesisStatus } from "../../lib/synthesis/index.js";
import { listSynthesisRuns } from "../../db/synthesis.js";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerSynthesisTools(server: McpServer): void {
  server.tool(
    "memory_synthesize",
    "Run ALMA synthesis: analyze memory corpus, find redundancies, propose and apply consolidations.",
    {
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      dry_run: z.boolean().optional(),
      max_proposals: z.coerce.number().optional(),
      provider: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await runSynthesis({
          projectId: args.project_id,
          agentId: args.agent_id,
          dryRun: args.dry_run ?? false,
          maxProposals: args.max_proposals,
          provider: args.provider,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({
          run_id: result.run.id,
          status: result.run.status,
          corpus_size: result.run.corpus_size,
          proposals_generated: result.run.proposals_generated,
          proposals_accepted: result.run.proposals_accepted,
          dry_run: result.dryRun,
          metrics: result.metrics ? { corpus_reduction: result.metrics.corpusReduction, deduplication_rate: result.metrics.deduplicationRate } : null,
        }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_synthesis_status",
    "Get the status of synthesis runs.",
    { project_id: z.string().optional(), run_id: z.string().optional() },
    async (args) => {
      try {
        const status = getSynthesisStatus(args.run_id, args.project_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_synthesis_history",
    "List past synthesis runs.",
    { project_id: z.string().optional(), limit: z.coerce.number().optional() },
    async (args) => {
      try {
        const runs = listSynthesisRuns({ project_id: args.project_id, limit: args.limit ?? 20 });
        return { content: [{ type: "text" as const, text: JSON.stringify(runs, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_synthesis_rollback",
    "Roll back a synthesis run, reversing all applied proposals.",
    { run_id: z.string() },
    async (args) => {
      try {
        const result = await rollbackSynthesis(args.run_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
