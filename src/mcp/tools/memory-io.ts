import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createMemory, listMemories } from "../../db/memories.js";
import { formatError } from "./memory-utils.js";
import type { CreateMemoryInput } from "../../types/index.js";

export function registerMemoryIoTools(server: McpServer): void {
  server.tool(
    "memory_export",
    "Export memories. format='json' (default) returns JSON array. format='v1' returns mementos-export-v1 JSONL with entity links.",
    {
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      format: z.enum(["json", "v1"]).optional().describe("Export format: json (default) or v1 (JSONL with entity links)"),
    },
    async (args) => {
      try {
        if (args.format === "v1") {
          const { exportV1, toJsonl } = await import("../../lib/export-v1.js");
          const entries = exportV1({ ...args });
          return { content: [{ type: "text" as const, text: toJsonl(entries) }] };
        }
        const memories = listMemories({ ...args, limit: 10000 });
        return { content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_import",
    "Import memories from JSON array",
    {
      memories: z.array(z.object({
        key: z.string(),
        value: z.string(),
        scope: z.enum(["global", "shared", "private", "working"]).optional(),
        category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
        importance: z.coerce.number().optional(),
        tags: z.array(z.string()).optional(),
        summary: z.string().optional(),
        source: z.enum(["user", "agent", "system", "auto", "imported"]).optional(),
        agent_id: z.string().optional(),
        project_id: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      })),
      overwrite: z.boolean().optional(),
    },
    async (args) => {
      try {
        let imported = 0;
        const dedupeMode = args.overwrite === false ? "create" as const : "merge" as const;
        for (const mem of args.memories) {
          createMemory({ ...mem, source: mem.source || "imported" } as CreateMemoryInput, dedupeMode);
          imported++;
        }
        return { content: [{ type: "text" as const, text: `Imported ${imported} memor${imported === 1 ? "y" : "ies"}.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
