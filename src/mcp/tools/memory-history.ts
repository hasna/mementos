import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMemory, getMemoryVersions, parseMemoryRow } from "../../db/memories.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { resolveId, formatError } from "./memory-utils.js";

export function registerMemoryHistoryTools(server: McpServer): void {
  server.tool(
    "memory_versions",
    "Get version history for a memory. Shows what changed across updates.",
    {
      id: z.string(),
    },
    async (args) => {
      try {
        const id = resolveId(args.id);
        const memory = getMemory(id);
        if (!memory) {
          return { content: [{ type: "text" as const, text: `Memory not found: ${args.id}` }] };
        }
        const versions = getMemoryVersions(id);
        if (versions.length === 0) {
          return { content: [{ type: "text" as const, text: `No version history for "${memory.key}" (current: v${memory.version})` }] };
        }
        const lines = versions.map(v =>
          `v${v.version} [${v.created_at.slice(0, 16)}] scope=${v.scope} importance=${v.importance} status=${v.status}\n  value: ${v.value.slice(0, 120)}${v.value.length > 120 ? "..." : ""}`
        );
        return {
          content: [{
            type: "text" as const,
            text: `Version history for "${memory.key}" (${versions.length} version${versions.length === 1 ? "" : "s"}, current: v${memory.version}):\n\n${lines.join("\n\n")}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_diff",
    "Show what changed between two versions of a memory. Compares value, importance, scope. Omit v1/v2 to diff the two most recent versions.",
    {
      id: z.string().optional().describe("Memory ID or partial ID"),
      key: z.string().optional().describe("Memory key (alternative to id)"),
      v1: z.coerce.number().optional().describe("First version number (default: second-to-last)"),
      v2: z.coerce.number().optional().describe("Second version number (default: current/latest)"),
    },
    async (args) => {
      try {
        let memId: string | undefined;
        if (args.id) {
          memId = resolvePartialId(getDatabase(), "memories", args.id) ?? args.id;
        } else if (args.key) {
          const row = getDatabase().query("SELECT id FROM memories WHERE key = ? LIMIT 1").get(args.key) as { id: string } | null;
          memId = row?.id;
        }
        if (!memId) return { content: [{ type: "text" as const, text: `Memory not found: ${args.id || args.key}` }], isError: true };

        const memory = getMemory(memId);
        if (!memory) return { content: [{ type: "text" as const, text: `Memory not found: ${memId}` }], isError: true };

        const versions = getMemoryVersions(memId);
        // Add current version as a pseudo-version
        const allVersions = [
          ...versions,
          { version: memory.version, value: memory.value, importance: memory.importance, scope: memory.scope, created_at: memory.updated_at, summary: memory.summary },
        ].sort((a, b) => a.version - b.version);

        if (allVersions.length < 2) {
          return { content: [{ type: "text" as const, text: `Only 1 version exists for "${memory.key}". No diff available.` }] };
        }

        const v1Num = args.v1 ?? allVersions[allVersions.length - 2]?.version ?? 1;
        const v2Num = args.v2 ?? allVersions[allVersions.length - 1]?.version ?? memory.version;

        const ver1 = allVersions.find(v => v.version === v1Num);
        const ver2 = allVersions.find(v => v.version === v2Num);

        if (!ver1 || !ver2) {
          return { content: [{ type: "text" as const, text: `Versions not found: v${v1Num}, v${v2Num}. Available: ${allVersions.map(v => `v${v.version}`).join(", ")}` }], isError: true };
        }

        const parts = [`Diff for "${memory.key}" (v${v1Num} → v${v2Num})`];
        parts.push(`Time: ${ver1.created_at?.slice(0, 16)} → ${ver2.created_at?.slice(0, 16)}`);

        if (ver1.value !== ver2.value) {
          parts.push(`\n--- v${v1Num} value ---`);
          parts.push(ver1.value.slice(0, 500) + (ver1.value.length > 500 ? "..." : ""));
          parts.push(`\n+++ v${v2Num} value +++`);
          parts.push(ver2.value.slice(0, 500) + (ver2.value.length > 500 ? "..." : ""));
        } else {
          parts.push("value: unchanged");
        }
        if (ver1.importance !== ver2.importance) parts.push(`importance: ${ver1.importance} → ${ver2.importance}`);
        if (ver1.scope !== ver2.scope) parts.push(`scope: ${ver1.scope} → ${ver2.scope}`);

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_chain_get",
    "Retrieve an ordered memory chain/sequence by group ID. Returns all steps in order.",
    {
      sequence_group: z.string().describe("The chain/sequence group ID to retrieve"),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const db = getDatabase();
        const effectiveProjectId = args.project_id;

        const conditions = ["sequence_group = ?", "status = 'active'"];
        const params: (string | number)[] = [args.sequence_group];

        if (effectiveProjectId) {
          conditions.push("project_id = ?");
          params.push(effectiveProjectId);
        }

        const rows = db.prepare(
          `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY sequence_order ASC`
        ).all(...params) as Record<string, unknown>[];

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `No chain found for sequence_group: "${args.sequence_group}"` }] };
        }

        const memories = rows.map(parseMemoryRow);
        const chainSteps = memories.map((m, i) =>
          `[Step ${m.sequence_order ?? i + 1}] ${m.key}: ${m.value}`
        ).join("\n");

        const header = `Chain "${args.sequence_group}" (${memories.length} steps):\n`;
        return { content: [{ type: "text" as const, text: header + chainSteps }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
