import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMemoryStats, getMemoryActivity, getMemoryReport } from "../../db/analytics.js";
import { formatError } from "./memory-utils.js";

export function registerMemoryStatsTools(server: McpServer): void {
  server.tool(
    "memory_stats",
    "Get aggregate statistics about stored memories",
    {},
    async () => {
      try {
        const stats = getMemoryStats();

        const lines = [
          `Total active: ${stats.total}`,
          `By scope: global=${stats.by_scope.global}, shared=${stats.by_scope.shared}, private=${stats.by_scope.private}, working=${stats.by_scope.working}`,
          `By category: preference=${stats.by_category.preference}, fact=${stats.by_category.fact}, knowledge=${stats.by_category.knowledge}, history=${stats.by_category.history}`,
          `Pinned: ${stats.pinned_count}`,
          `Expired: ${stats.expired_count}`,
        ];
        if (Object.keys(stats.by_agent).length > 0) {
          lines.push(`By agent: ${Object.entries(stats.by_agent).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_activity",
    "Get daily memory creation activity over N days.",
    {
      days: z.coerce.number().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const { activity: rows, days, total } = getMemoryActivity({
          days: args.days,
          scope: args.scope,
          agent_id: args.agent_id,
          project_id: args.project_id,
        });

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `No memory activity in last ${days} days.` }] };
        }
        const lines = rows.map(r => `${r.date}: ${r.memories_created} memor${r.memories_created === 1 ? "y" : "ies"}`);
        return { content: [{ type: "text" as const, text: `Memory activity (last ${days} days — ${total} total):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_report",
    "Get a rich summary report: totals, activity trend, top memories, scope/category breakdown.",
    {
      days: z.coerce.number().optional(),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
    },
    async (args) => {
      try {
        const report = getMemoryReport({ days: args.days, project_id: args.project_id, agent_id: args.agent_id });
        const actRows = report.recent.activity;
        const sparkline = actRows.length > 0 ? actRows.map(r => { const bars = "▁▂▃▄▅▆▇█"; const max = Math.max(...actRows.map(x => x.memories_created), 1); return bars[Math.round((r.memories_created / max) * 7)] || "▁"; }).join("") : "—";

        const lines = [
          `Memory Report (last ${report.days} days)`,
          `Total: ${report.total} (${report.pinned} pinned) | Recent: +${report.recent.total} | Activity: ${sparkline}`,
          `Scopes: ${Object.entries(report.by_scope).map(([k, v]) => `${k}=${v}`).join(" ")}`,
          `Categories: ${Object.entries(report.by_category).map(([k, v]) => `${k}=${v}`).join(" ")}`,
          report.top_memories.length > 0 ? `\nTop memories:\n${report.top_memories.map(m => `  [${m.importance}] ${m.key}: ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`).join("\n")}` : "",
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
