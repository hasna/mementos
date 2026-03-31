import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getMemory,
  updateMemory,
  bulkDeleteMemories,
} from "../../db/memories.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveId(partialId: string, table = "memories"): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) throw new Error(`Could not resolve ID: ${partialId}`);
  return id;
}

export function registerBulkTools(server: McpServer): void {
  server.tool(
    "bulk_forget",
    "Delete multiple memories by IDs",
    {
      ids: z.array(z.string()),
    },
    async (args) => {
      try {
        const resolvedIds = args.ids.map((id) => resolveId(id));
        const deleted = bulkDeleteMemories(resolvedIds);
        return { content: [{ type: "text" as const, text: `Deleted ${deleted} memor${deleted === 1 ? "y" : "ies"}.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "bulk_update",
    "Update multiple memories with the same changes",
    {
      ids: z.array(z.string()),
      importance: z.coerce.number().min(1).max(10).optional(),
      tags: z.array(z.string()).optional(),
      pinned: z.boolean().optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      status: z.enum(["active", "archived", "expired"]).optional(),
    },
    async (args) => {
      try {
        let updated = 0;
        const { ids, ...fields } = args;
        for (const partialId of ids) {
          const id = resolveId(partialId);
          const memory = getMemory(id);
          if (memory) {
            updateMemory(id, { ...fields, version: memory.version });
            updated++;
          }
        }
        return { content: [{ type: "text" as const, text: `Updated ${updated} memor${updated === 1 ? "y" : "ies"}.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
