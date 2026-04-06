import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDatabase } from "../../db/database.js";
import { formatError } from "./memory-utils.js";
import type { MemoryScope, MemoryCategory, MemoryStats } from "../../types/index.js";

export function registerMemoryStatsTools(server: McpServer): void {
  server.tool(
    "memory_stats",
    "Get aggregate statistics about stored memories",
    {},
    async () => {
      try {
        const db = getDatabase();
        const total = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get() as { c: number }).c;
        const byScope = db.query("SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope").all() as { scope: MemoryScope; c: number }[];
        const byCategory = db.query("SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category").all() as { category: MemoryCategory; c: number }[];
        const byStatus = db.query("SELECT status, COUNT(*) as c FROM memories GROUP BY status").all() as { status: string; c: number }[];
        const pinnedCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'").get() as { c: number }).c;
        const expiredCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < datetime('now'))").get() as { c: number }).c;

        const stats: MemoryStats = {
          total,
          by_scope: { global: 0, shared: 0, private: 0, working: 0 },
          by_category: { preference: 0, fact: 0, knowledge: 0, history: 0, procedural: 0, resource: 0 },
          by_status: { active: 0, archived: 0, expired: 0 },
          by_agent: {},
          pinned_count: pinnedCount,
          expired_count: expiredCount,
        };
        for (const row of byScope) stats.by_scope[row.scope] = row.c;
        for (const row of byCategory) stats.by_category[row.category] = row.c;
        for (const row of byStatus) {
          if (row.status in stats.by_status) {
            stats.by_status[row.status as keyof typeof stats.by_status] = row.c;
          }
        }

        const byAgent = db.query("SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL GROUP BY agent_id").all() as { agent_id: string; c: number }[];
        for (const row of byAgent) stats.by_agent[row.agent_id] = row.c;

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
        const days = Math.min(args.days || 30, 365);
        const db = getDatabase();
        const conditions: string[] = ["status = 'active'"];
        const params: string[] = [];
        if (args.scope) { conditions.push("scope = ?"); params.push(args.scope); }
        if (args.agent_id) { conditions.push("agent_id = ?"); params.push(args.agent_id); }
        if (args.project_id) { conditions.push("project_id = ?"); params.push(args.project_id); }
        const where = conditions.slice(1).map(c => `AND ${c}`).join(" ");

        const rows = db.query(`
          SELECT date(created_at) AS date, COUNT(*) AS memories_created
          FROM memories
          WHERE status = 'active' AND date(created_at) >= date('now', '-${days} days') ${where}
          GROUP BY date(created_at)
          ORDER BY date ASC
        `).all(...params) as { date: string; memories_created: number }[];

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `No memory activity in last ${days} days.` }] };
        }
        const total = rows.reduce((s, r) => s + r.memories_created, 0);
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
        const days = Math.min(args.days || 7, 365);
        const db = getDatabase();
        const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const cond = [args.project_id ? "AND project_id = ?" : "", args.agent_id ? "AND agent_id = ?" : ""].filter(Boolean).join(" ");
        const params: (string | number)[] = [cutoffDate, ...(args.project_id ? [args.project_id] : []), ...(args.agent_id ? [args.agent_id] : [])];

        const total = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' ${cond}`).get(...params.slice(1)) as { c: number }).c;
        const pinned = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1 ${cond}`).get(...params.slice(1)) as { c: number }).c;

        const actRows = db.query(`SELECT date(created_at) AS d, COUNT(*) AS cnt FROM memories WHERE status = 'active' AND date(created_at) >= ? ${cond} GROUP BY d ORDER BY d`).all(...params) as { d: string; cnt: number }[];
        const recentTotal = actRows.reduce((s, r) => s + r.cnt, 0);
        const sparkline = actRows.length > 0 ? actRows.map(r => { const bars = "▁▂▃▄▅▆▇█"; const max = Math.max(...actRows.map(x => x.cnt), 1); return bars[Math.round((r.cnt / max) * 7)] || "▁"; }).join("") : "—";

        const byScopeRows = db.query(`SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' ${cond} GROUP BY scope`).all(...params) as { scope: string; c: number }[];
        const byCatRows = db.query(`SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' ${cond} GROUP BY category`).all(...params) as { category: string; c: number }[];
        const topMems = db.query(`SELECT key, value, importance FROM memories WHERE status = 'active' ${cond} ORDER BY importance DESC, access_count DESC LIMIT 5`).all(...params) as { key: string; value: string; importance: number }[];

        const lines = [
          `Memory Report (last ${days} days)`,
          `Total: ${total} (${pinned} pinned) | Recent: +${recentTotal} | Activity: ${sparkline}`,
          `Scopes: ${byScopeRows.map(r => `${r.scope}=${r.c}`).join(" ")}`,
          `Categories: ${byCatRows.map(r => `${r.category}=${r.c}`).join(" ")}`,
          topMems.length > 0 ? `\nTop memories:\n${topMems.map(m => `  [${m.importance}] ${m.key}: ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`).join("\n")}` : "",
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
