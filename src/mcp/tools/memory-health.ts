import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMemoryHealth } from "../../db/analytics.js";
import { formatError } from "./memory-utils.js";

export function registerMemoryHealthTools(server: McpServer): void {
  server.tool(
    "memory_health",
    "Comprehensive health check for memories. Detects: stale (old + 0 access), high-importance-forgotten (importance>=7 + not accessed in 60d), and possibly-superseded (newer memory with similar key). Returns actionable summary.",
    {
      stale_days: z.coerce.number().optional().describe("Days with no access to consider a memory stale (default: 30)"),
      forgotten_days: z.coerce.number().optional().describe("Days since access for high-importance memories (default: 60)"),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      limit: z.coerce.number().optional().describe("Max per category (default: 10)"),
    },
    async (args) => {
      try {
        const staleDays = args.stale_days ?? 30;
        const forgottenDays = args.forgotten_days ?? 60;
        const { stale, forgotten, dupes } = getMemoryHealth({
          stale_days: staleDays,
          forgotten_days: forgottenDays,
          project_id: args.project_id,
          agent_id: args.agent_id,
          limit: args.limit ?? 10,
        });

        const parts: string[] = ["Memory Health Report\n"];

        if (stale.length > 0) {
          parts.push(`⚠️  STALE (${stale.length}) — created ${staleDays}d+ ago, never accessed:`);
          for (const m of stale) {
            parts.push(`  • [${m.importance}] ${m.key} (${m.scope}) — created ${m.created_at.slice(0, 10)}`);
          }
          parts.push("");
        }

        if (forgotten.length > 0) {
          parts.push(`🔔  HIGH-IMPORTANCE FORGOTTEN (${forgotten.length}) — importance≥7, not accessed in ${forgottenDays}d+:`);
          for (const m of forgotten) {
            parts.push(`  • [${m.importance}] ${m.key} (${m.scope}) — last: ${m.accessed_at?.slice(0, 10) || "never"}`);
          }
          parts.push("");
        }

        if (dupes.length > 0) {
          parts.push(`🔄  POSSIBLY SUPERSEDED (${dupes.length}) — same key with multiple versions:`);
          for (const d of dupes) {
            parts.push(`  • ${d.key} × ${d.cnt} copies — newest: ${d.latest.slice(0, 10)}`);
          }
          parts.push("");
        }

        if (stale.length === 0 && forgotten.length === 0 && dupes.length === 0) {
          parts.push("✓ No health issues found. All memories look fresh.");
        } else {
          parts.push(`Summary: ${stale.length} stale, ${forgotten.length} forgotten, ${dupes.length} possibly-superseded.`);
          parts.push("Suggested actions: archive stale memories, review forgotten ones, merge duplicates.");
        }

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
