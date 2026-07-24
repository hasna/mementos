import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMemory, getMemoryByKey, updateMemory, deleteMemory } from "../../db/memories.js";
import { getStaleMemories } from "../../db/analytics.js";
import { resolveId, formatError } from "./memory-utils.js";

export function registerMemoryLifecycleTools(server: McpServer): void {
  server.tool(
    "memory_pin",
    "Pin or unpin a memory by ID or key. No version needed.",
    {
      id: z.string().optional(),
      key: z.string().optional(),
      pinned: z.boolean().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const memory = args.id ? getMemory(resolveId(args.id)) : getMemoryByKey(args.key!, args.scope, args.agent_id, args.project_id);
        if (!memory) return { content: [{ type: "text" as const, text: `Memory not found.` }] };
        const pinned = args.pinned !== false; // default to pin=true
        updateMemory(memory.id, { pinned, version: memory.version });
        return { content: [{ type: "text" as const, text: `Memory "${memory.key}" ${pinned ? "pinned" : "unpinned"}.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_archive",
    "Archive a memory by ID or key (hides from lists, keeps history). No version needed.",
    {
      id: z.string().optional(),
      key: z.string().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const memory = args.id ? getMemory(resolveId(args.id)) : getMemoryByKey(args.key!, args.scope, args.agent_id, args.project_id);
        if (!memory) return { content: [{ type: "text" as const, text: `Memory not found.` }] };
        updateMemory(memory.id, { status: "archived", version: memory.version });
        return { content: [{ type: "text" as const, text: `Memory "${memory.key}" archived.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_forget",
    "Delete a memory by ID or key",
    {
      id: z.string().optional(),
      key: z.string().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        if (args.id) {
          const id = resolveId(args.id);
          const deleted = deleteMemory(id);
          return { content: [{ type: "text" as const, text: deleted ? `Memory ${id} deleted.` : `Memory not found.` }] };
        }
        if (args.key) {
          const memory = getMemoryByKey(args.key, args.scope, args.agent_id, args.project_id);
          if (!memory) {
            return { content: [{ type: "text" as const, text: `No memory found for key: ${args.key}` }] };
          }
          deleteMemory(memory.id);
          return { content: [{ type: "text" as const, text: `Memory "${args.key}" (${memory.id}) deleted.` }] };
        }
        return { content: [{ type: "text" as const, text: "Either id or key must be provided." }], isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_stale",
    "Find memories not accessed recently. Useful for cleanup or review.",
    {
      days: z.coerce.number().optional(),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      limit: z.coerce.number().optional(),
    },
    async (args) => {
      try {
        const days = args.days || 30;
        const rows = getStaleMemories({
          days,
          project_id: args.project_id,
          agent_id: args.agent_id,
          limit: args.limit || 20,
        });

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `No stale memories found (last accessed > ${days} days ago).` }] };
        }
        const lines = rows.map((m) =>
          `[${m.importance}] ${m.key} (${m.scope}/${m.category}) — last accessed: ${m.accessed_at?.slice(0, 10) || "never"}, ${m.access_count} reads`
        );
        return { content: [{ type: "text" as const, text: `${rows.length} stale memor${rows.length === 1 ? "y" : "ies"} (not accessed in ${days}+ days):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_flag",
    "Flag a memory for attention: needs-review, outdated, verify, or any custom flag. Flagged memories surface at the top of memory_context. Pass flag=null to clear.",
    {
      id: z.string().optional().describe("Memory ID or partial ID"),
      key: z.string().optional().describe("Memory key"),
      flag: z.string().nullable().optional().describe("Flag value: needs-review | outdated | verify | important | null (to clear)"),
      agent_id: z.string().optional(),
    },
    async (args) => {
      try {
        const memory = args.id
          ? getMemory(resolveId(args.id))
          : args.key
            ? getMemoryByKey(args.key, undefined, args.agent_id)
            : null;
        if (!memory) return { content: [{ type: "text" as const, text: `Memory not found: ${args.id || args.key}` }], isError: true };
        const flagVal = args.flag ?? null;
        updateMemory(memory.id, { flag: flagVal, version: memory.version });
        return { content: [{ type: "text" as const, text: flagVal ? `Flagged "${memory.key}" as: ${flagVal}` : `Cleared flag on "${memory.key}"` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
