import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSynthesis, rollbackSynthesis, getSynthesisStatus } from "../../lib/synthesis/index.js";
import { listSynthesisRuns } from "../../db/synthesis.js";
import { compactPageHint, positiveLimit } from "./memory-utils.js";

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
    {
      project_id: z.string().optional(),
      run_id: z.string().optional(),
      full: z.boolean().optional().describe("Return complete status JSON. Defaults to compact summary."),
    },
    async (args) => {
      try {
        const status = getSynthesisStatus(args.run_id, args.project_id);
        if (args.full) {
          return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
        }
        const run = status.lastRun;
        if (!run) {
          return { content: [{ type: "text" as const, text: "No synthesis run found." }] };
        }
        return { content: [{ type: "text" as const, text: `Synthesis ${run.id.slice(0, 8)}: ${run.status} | corpus=${run.corpus_size} | accepted=${run.proposals_accepted}/${run.proposals_generated}\nHint: call memory_synthesis_status(full=true) for complete status JSON.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_synthesis_history",
    "List past synthesis runs.",
    {
      project_id: z.string().optional(),
      limit: z.coerce.number().optional(),
      offset: z.coerce.number().optional(),
      full: z.boolean().optional().describe("Return complete run JSON objects. Defaults to compact lines."),
    },
    async (args) => {
      try {
        const limit = positiveLimit(args.limit, 10);
        const offset = args.offset ?? 0;
        const runs = listSynthesisRuns({ project_id: args.project_id, limit: offset + limit + 1 });
        if (args.full) {
          return { content: [{ type: "text" as const, text: JSON.stringify(runs.slice(offset, offset + limit), null, 2) }] };
        }
        if (runs.length === 0) {
          return { content: [{ type: "text" as const, text: "No synthesis runs found." }] };
        }
        const page = runs.slice(offset, offset + limit + 1);
        const hasMore = page.length > limit;
        const visible = hasMore ? page.slice(0, limit) : page;
        const lines = visible.map((run, index) =>
          `${index + 1}. ${run.id.slice(0, 8)} ${run.status} | corpus=${run.corpus_size} | accepted=${run.proposals_accepted}/${run.proposals_generated} | started=${run.started_at}`
        );
        const hint = compactPageHint({
          shown: visible.length,
          limit,
          offset,
          hasMore,
          moreCall: "memory_synthesis_history",
          detailHint: "use full=true for complete run objects",
        });
        return { content: [{ type: "text" as const, text: `${visible.length}${hasMore ? "+" : ""} synthesis run(s):\n${lines.join("\n")}${hint}` }] };
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
