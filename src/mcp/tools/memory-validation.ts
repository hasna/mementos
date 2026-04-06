import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMemory } from "../../db/memories.js";
import { resolveId, formatError } from "./memory-utils.js";

export function registerMemoryValidationTools(server: McpServer): void {
  server.tool(
    "memory_check_contradiction",
    "Check if a new memory would contradict existing high-importance facts. Call before saving to detect conflicts. Returns contradiction details if found.",
    {
      key: z.string().describe("Memory key to check"),
      value: z.string().describe("New value to check for contradictions"),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      project_id: z.string().optional(),
      min_importance: z.coerce.number().optional().describe("Only check against memories with importance >= this (default: 7)"),
    },
    async (args) => {
      try {
        const { detectContradiction } = await import("../../lib/contradiction.js");
        const result = await detectContradiction(args.key, args.value, {
          scope: args.scope,
          project_id: args.project_id,
          min_importance: args.min_importance,
        });
        if (result.contradicts) {
          const mem = result.conflicting_memory;
          return { content: [{ type: "text" as const, text: `⚠ CONTRADICTION DETECTED (confidence: ${(result.confidence * 100).toFixed(0)}%)\n${result.reasoning}\n\nExisting memory: [${mem?.scope}/${mem?.category}] ${mem?.key} = ${mem?.value?.slice(0, 200)}\nImportance: ${mem?.importance}\nID: ${mem?.id?.slice(0, 8)}` }] };
        }
        return { content: [{ type: "text" as const, text: `No contradiction detected for key "${args.key}". ${result.reasoning}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_invalidate",
    "Invalidate an existing fact by setting valid_until to now. Use when a contradiction is confirmed and the old fact should be superseded. Optionally link to the new superseding memory.",
    {
      old_memory_id: z.string().describe("ID of the memory to invalidate"),
      new_memory_id: z.string().optional().describe("ID of the new memory that supersedes the old one"),
    },
    async (args) => {
      try {
        const { invalidateFact } = await import("../../lib/contradiction.js");
        const oldId = resolveId(args.old_memory_id);
        const existing = getMemory(oldId);
        if (!existing) {
          return { content: [{ type: "text" as const, text: `Memory not found: ${args.old_memory_id}` }] };
        }
        const result = invalidateFact(oldId, args.new_memory_id);
        return { content: [{ type: "text" as const, text: `Invalidated "${existing.key}" (valid_until: ${result.valid_until})${result.new_memory_id ? ` — superseded by ${result.new_memory_id.slice(0, 8)}` : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
