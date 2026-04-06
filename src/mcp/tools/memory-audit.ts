import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveId, formatError } from "./memory-utils.js";

export function registerMemoryAuditTools(server: McpServer): void {
  server.tool(
    "memory_audit_trail",
    "Get the immutable audit trail for a specific memory. Shows all create/update/delete operations with timestamps and agent IDs.",
    {
      memory_id: z.string().describe("Memory ID to get audit trail for"),
      limit: z.coerce.number().optional().describe("Max entries (default: 50)"),
    },
    async (args) => {
      try {
        const { getMemoryAuditTrail } = await import("../../db/audit.js");
        const id = resolveId(args.memory_id);
        const entries = getMemoryAuditTrail(id, args.limit);
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: `No audit entries for memory ${args.memory_id}` }] };
        }
        const lines = entries.map((e) =>
          `[${e.created_at}] ${e.operation} by ${e.agent_id || "system"} — ${JSON.stringify(e.changes)}`
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
      limit: z.coerce.number().optional().describe("Max entries (default: 1000)"),
    },
    async (args) => {
      try {
        const { exportAuditLog } = await import("../../db/audit.js");
        const entries = exportAuditLog(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
