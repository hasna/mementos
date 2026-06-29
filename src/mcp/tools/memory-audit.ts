import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compactPageHint, compactText, formatError, positiveLimit, resolveId } from "./memory-utils.js";

export function registerMemoryAuditTools(server: McpServer): void {
  server.tool(
    "memory_audit_trail",
    "Get the immutable audit trail for a specific memory. Shows all create/update/delete operations with timestamps and agent IDs.",
    {
      memory_id: z.string().describe("Memory ID to get audit trail for"),
      limit: z.coerce.number().optional().describe("Max entries (default: 50)"),
      verbose: z.boolean().optional().describe("Include wider change snippets."),
    },
    async (args) => {
      try {
        const { getMemoryAuditTrail } = await import("../../db/audit.js");
        const id = resolveId(args.memory_id);
        const limit = positiveLimit(args.limit, 50);
        const entries = getMemoryAuditTrail(id, limit);
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: `No audit entries for memory ${args.memory_id}` }] };
        }
        const lines = entries.map((e) =>
          `[${e.created_at}] ${e.operation} by ${e.agent_id || "system"} - ${compactText(JSON.stringify(e.changes), args.verbose ? 240 : 120)}`
        );
        return { content: [{ type: "text" as const, text: `Audit trail (${entries.length} entries):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_audit_export",
    "Export the full immutable audit log for compliance reporting. Supports date range and operation type filtering.",
    {
      since: z.string().optional().describe("Start date (ISO8601)"),
      until: z.string().optional().describe("End date (ISO8601)"),
      operation: z.enum(["create", "update", "delete", "archive", "restore"]).optional(),
      agent_id: z.string().optional(),
      limit: z.coerce.number().optional().describe("Max entries (compact default: 50)"),
      offset: z.coerce.number().optional().describe("Cursor offset for the next page"),
      format: z.enum(["compact", "json"]).optional().describe("Output format. Defaults to compact."),
      full: z.boolean().optional().describe("Alias for format=json."),
    },
    async (args) => {
      try {
        const { exportAuditLog } = await import("../../db/audit.js");
        const limit = positiveLimit(args.limit, 50);
        const offset = args.offset ?? 0;
        const entries = exportAuditLog({
          since: args.since,
          until: args.until,
          operation: args.operation,
          agent_id: args.agent_id,
          limit: offset + limit + 1,
        });
        if (args.full || args.format === "json") {
          return { content: [{ type: "text" as const, text: JSON.stringify(entries.slice(offset, offset + limit), null, 2) }] };
        }
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: "No audit entries found." }] };
        }
        const page = entries.slice(offset, offset + limit + 1);
        const hasMore = page.length > limit;
        const visible = hasMore ? page.slice(0, limit) : page;
        const lines = visible.map((e, index) =>
          `${index + 1}. [${e.created_at}] ${e.operation} memory=${e.memory_id?.slice(0, 8) ?? "-"} by ${e.agent_id || "system"} - ${compactText(JSON.stringify(e.changes), 120)}`
        );
        const hint = compactPageHint({
          shown: visible.length,
          limit,
          offset,
          hasMore,
          moreCall: "memory_audit_export",
          detailHint: "use format=\"json\" or full=true for complete audit entry objects",
        });
        return { content: [{ type: "text" as const, text: `${visible.length}${hasMore ? "+" : ""} audit entries:\n${lines.join("\n")}${hint}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
