import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDatabase } from "../../db/database.js";
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
        const db = getDatabase();
        const staleDays = args.stale_days ?? 30;
        const forgottenDays = args.forgotten_days ?? 60;
        const limit = args.limit ?? 10;
        const extraWhere = [
          ...(args.project_id ? ["project_id = ?"] : []),
          ...(args.agent_id ? ["agent_id = ?"] : []),
        ].join(" AND ");
        const staleCutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
        const forgottenCutoff = new Date(Date.now() - forgottenDays * 86400000).toISOString();
        const extraParams: (string | number)[] = [
          staleCutoff,
          ...(args.project_id ? [args.project_id] : []),
          ...(args.agent_id ? [args.agent_id] : []),
        ];
        const base = `status = 'active' AND pinned = 0${extraWhere ? " AND " + extraWhere : ""}`;

        // 1. Stale: never accessed or not accessed in staleDays, access_count == 0
        const stale = db.prepare(
          `SELECT id, key, value, importance, scope, created_at FROM memories
           WHERE ${base} AND access_count = 0 AND created_at < ?
           ORDER BY created_at ASC LIMIT ?`
        ).all(...extraParams, limit) as Array<{id: string; key: string; value: string; importance: number; scope: string; created_at: string}>;

        const forgottenParams: (string | number)[] = [
          forgottenCutoff,
          ...(args.project_id ? [args.project_id] : []),
          ...(args.agent_id ? [args.agent_id] : []),
        ];
        // 2. High-importance forgotten: importance >= 7, not accessed in forgottenDays
        const forgotten = db.prepare(
          `SELECT id, key, value, importance, scope, accessed_at FROM memories
           WHERE ${base} AND importance >= 7
             AND (accessed_at IS NULL OR accessed_at < ?)
           ORDER BY importance DESC, COALESCE(accessed_at, created_at) ASC LIMIT ?`
        ).all(...forgottenParams, limit) as Array<{id: string; key: string; value: string; importance: number; scope: string; accessed_at: string|null}>;

        // 3. Possibly superseded: multiple active memories with same key prefix (similar key)
        const dupes = db.prepare(
          `SELECT key, COUNT(*) as cnt, MAX(updated_at) as latest, MIN(created_at) as oldest
           FROM memories WHERE ${base}
           GROUP BY key HAVING cnt > 1
           ORDER BY cnt DESC LIMIT ?`
        ).all(...extraParams, limit) as Array<{key: string; cnt: number; latest: string; oldest: string}>;

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
