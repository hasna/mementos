import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getDatabase } from "../../db/database.js";
import { listMemories, parseMemoryRow } from "../../db/memories.js";
import { getProject } from "../../db/projects.js";
import { getAgent } from "../../db/agents.js";
import { touchMemory } from "../../db/memories.js";
import { searchMemories } from "../../lib/search.js";
import type {
  MemoryCategory,
  MemoryScope,
  MemoryFilter,
  MemoryStats,
} from "../../types/index.js";
import {
  outputJson,
  outputYaml,
  getOutputFormat,
  makeHandleError,
  colorScope,
  colorCategory,
  colorImportance,
  type GlobalOpts,
} from "../helpers.js";

export function registerInfoCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // stats
  // ============================================================================

  program
    .command("stats")
    .description("Show memory statistics")
    .option("--format <fmt>", "Output format: compact (default), json, csv, yaml")
    .action((opts) => {
      try {
        const db = getDatabase();

        const total = (
          db
            .query(
              "SELECT COUNT(*) as c FROM memories WHERE status = 'active'"
            )
            .get() as { c: number }
        ).c;

        const byScope = db
          .query(
            "SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope"
          )
          .all() as { scope: MemoryScope; c: number }[];

        const byCategory = db
          .query(
            "SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category"
          )
          .all() as { category: MemoryCategory; c: number }[];

        const byStatus = db
          .query(
            "SELECT status, COUNT(*) as c FROM memories GROUP BY status"
          )
          .all() as { status: string; c: number }[];

        const pinnedCount = (
          db
            .query(
              "SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'"
            )
            .get() as { c: number }
        ).c;

        const expiredCount = (
          db
            .query(
              "SELECT COUNT(*) as c FROM memories WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < datetime('now'))"
            )
            .get() as { c: number }
        ).c;

        const byAgent = db
          .query(
            "SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL GROUP BY agent_id"
          )
          .all() as { agent_id: string; c: number }[];

        const stats: MemoryStats = {
          total,
          by_scope: { global: 0, shared: 0, private: 0, working: 0 },
          by_category: {
            preference: 0,
            fact: 0,
            knowledge: 0,
            history: 0,
            procedural: 0,
            resource: 0,
          },
          by_status: { active: 0, archived: 0, expired: 0 },
          by_agent: {},
          pinned_count: pinnedCount,
          expired_count: expiredCount,
        };

        for (const row of byScope) stats.by_scope[row.scope] = row.c;
        for (const row of byCategory)
          stats.by_category[row.category] = row.c;
        for (const row of byStatus) {
          if (row.status in stats.by_status) {
            stats.by_status[
              row.status as keyof typeof stats.by_status
            ] = row.c;
          }
        }
        for (const row of byAgent)
          stats.by_agent[row.agent_id] = row.c;

        const fmt = getOutputFormat(program, opts.format as string | undefined);

        if (fmt === "json") {
          outputJson(stats);
          return;
        }

        if (fmt === "yaml") {
          outputYaml(stats);
          return;
        }

        if (fmt === "csv") {
          console.log("metric,key,value");
          console.log(`total,active,${stats.total}`);
          for (const [k, v] of Object.entries(stats.by_scope)) console.log(`by_scope,${k},${v}`);
          for (const [k, v] of Object.entries(stats.by_category)) console.log(`by_category,${k},${v}`);
          for (const [k, v] of Object.entries(stats.by_status)) console.log(`by_status,${k},${v}`);
          console.log(`pinned,count,${stats.pinned_count}`);
          console.log(`expired,count,${stats.expired_count}`);
          for (const [k, v] of Object.entries(stats.by_agent)) console.log(`by_agent,${k},${v}`);
          return;
        }

        console.log(chalk.bold("Memory Statistics"));
        console.log(
          `${chalk.bold("Total active:")}  ${chalk.white(String(total))}`
        );
        console.log(
          `${chalk.bold("By scope:")}      ${chalk.cyan("global")}=${stats.by_scope.global}  ${chalk.yellow("shared")}=${stats.by_scope.shared}  ${chalk.magenta("private")}=${stats.by_scope.private}  ${chalk.dim("working")}=${stats.by_scope.working}`
        );
        console.log(
          `${chalk.bold("By category:")}   ${chalk.blue("preference")}=${stats.by_category.preference}  ${chalk.green("fact")}=${stats.by_category.fact}  ${chalk.yellow("knowledge")}=${stats.by_category.knowledge}  ${chalk.gray("history")}=${stats.by_category.history}`
        );
        console.log(
          `${chalk.bold("By status:")}     active=${stats.by_status.active}  archived=${stats.by_status.archived}  expired=${stats.by_status.expired}`
        );
        console.log(
          `${chalk.bold("Pinned:")}        ${stats.pinned_count}`
        );
        console.log(
          `${chalk.bold("Expired:")}       ${stats.expired_count}`
        );
        if (Object.keys(stats.by_agent).length > 0) {
          const agentParts = Object.entries(stats.by_agent)
            .map(([k, v]) => `${k}=${v}`)
            .join("  ");
          console.log(`${chalk.bold("By agent:")}      ${agentParts}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // report
  // ============================================================================

  program
    .command("report")
    .description("Rich summary of memory activity and top memories")
    .option("--days <n>", "Activity window in days (default: 7)", "7")
    .option("--project <path>", "Filter by project path")
    .option("--markdown", "Output as Markdown (for PRs, docs, etc.)")
    .option("--json", "Output as JSON")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const days = parseInt(opts.days as string, 10) || 7;
        // --json and --markdown may be consumed by global opts — check both
        const isJson = (opts.json as boolean | undefined) || globalOpts.json;
        const isMarkdown = opts.markdown as boolean | undefined;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const db = getDatabase();

        // Total counts
        const conditions = projectId ? "AND project_id = ?" : "";
        const params = projectId ? [projectId] : [];
        const total = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' ${conditions}`).get(...params) as { c: number }).c;
        const pinned = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1 ${conditions}`).get(...params) as { c: number }).c;

        // Activity trend (last N days)
        const activityRows = db.query(`
          SELECT date(created_at) AS d, COUNT(*) AS cnt
          FROM memories WHERE status = 'active' AND date(created_at) >= date('now', '-${days} days') ${conditions}
          GROUP BY d ORDER BY d ASC
        `).all(...params) as { d: string; cnt: number }[];
        const recentTotal = activityRows.reduce((s, r) => s + r.cnt, 0);
        const avgPerDay = activityRows.length > 0 ? (recentTotal / activityRows.length).toFixed(1) : "0";

        // By scope
        const byScopeRows = db.query(`SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' ${conditions} GROUP BY scope`).all(...params) as { scope: string; c: number }[];
        const byScope = Object.fromEntries(byScopeRows.map(r => [r.scope, r.c]));

        // By category
        const byCatRows = db.query(`SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' ${conditions} GROUP BY category`).all(...params) as { category: string; c: number }[];
        const byCat = Object.fromEntries(byCatRows.map(r => [r.category, r.c]));

        // Top memories by importance
        const topMems = db.query(`SELECT key, value, importance, scope, category FROM memories WHERE status = 'active' ${conditions} ORDER BY importance DESC, access_count DESC LIMIT 5`).all(...params) as { key: string; value: string; importance: number; scope: string; category: string }[];

        // Top agents by memory count
        const topAgents = db.query(`SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL ${conditions} GROUP BY agent_id ORDER BY c DESC LIMIT 5`).all(...params) as { agent_id: string; c: number }[];

        if (isJson) {
          console.log(JSON.stringify({ total, pinned, recent: { days, total: recentTotal, avg_per_day: parseFloat(avgPerDay) }, by_scope: byScope, by_category: byCat, top_memories: topMems, top_agents: topAgents }, null, 2));
          return;
        }

        if (isMarkdown) {
          const lines = [
            `## Mementos Report (last ${days} days)`,
            "",
            `- **Total memories:** ${total} (${pinned} pinned)`,
            `- **Recent activity:** ${recentTotal} new in ${days} days (~${avgPerDay}/day)`,
            `- **Scopes:** global=${byScope["global"] || 0} shared=${byScope["shared"] || 0} private=${byScope["private"] || 0}`,
            `- **Categories:** knowledge=${byCat["knowledge"] || 0} fact=${byCat["fact"] || 0} preference=${byCat["preference"] || 0} history=${byCat["history"] || 0}`,
            "",
            "### Top Memories",
            ...topMems.map(m => `- **${m.key}** (${m.scope}/${m.category}, imp:${m.importance}): ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`),
          ];
          if (topAgents.length > 0) {
            lines.push("", "### Top Agents", ...topAgents.map(a => `- ${a.agent_id}: ${a.c} memories`));
          }
          console.log(lines.join("\n"));
          return;
        }

        // Default human-readable output
        const sparkline = activityRows.map(r => {
          const bars = "▁▂▃▄▅▆▇█";
          const maxC = Math.max(...activityRows.map(x => x.cnt), 1);
          return bars[Math.round((r.cnt / maxC) * 7)] || "▁";
        }).join("");

        console.log(chalk.bold(`\nmementos report — last ${days} days\n`));
        console.log(`  ${chalk.cyan("Total:")}     ${total} memories (${chalk.yellow(String(pinned))} pinned)`);
        console.log(`  ${chalk.cyan("Recent:")}    ${recentTotal} new · ${chalk.dim(`~${avgPerDay}/day`)}`);
        console.log(`  ${chalk.cyan("Activity:")}  ${sparkline || chalk.dim("no activity")}`);
        console.log(`  ${chalk.cyan("Scopes:")}    global=${byScope["global"] || 0} shared=${byScope["shared"] || 0} private=${byScope["private"] || 0}`);
        console.log(`  ${chalk.cyan("Categories:")} knowledge=${byCat["knowledge"] || 0} fact=${byCat["fact"] || 0} preference=${byCat["preference"] || 0} history=${byCat["history"] || 0}`);

        if (topMems.length > 0) {
          console.log(`\n  ${chalk.bold("Top memories by importance:")}`);
          topMems.forEach(m => {
            console.log(`    ${chalk.green(`[${m.importance}]`)} ${chalk.bold(m.key)} ${chalk.dim(`(${m.scope}/${m.category})`)}`);
            console.log(`       ${m.value.slice(0, 90)}${m.value.length > 90 ? "..." : ""}`);
          });
        }

        if (topAgents.length > 0) {
          console.log(`\n  ${chalk.bold("Top agents:")}`);
          topAgents.forEach(a => console.log(`    ${a.agent_id}: ${a.c} memories`));
        }
        console.log("");
      } catch (e) {
        console.error(chalk.red(`report failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  // ============================================================================
  // stale
  // ============================================================================

  program
    .command("stale")
    .description("Find memories not accessed recently (for cleanup/review)")
    .option("--days <n>", "Stale threshold in days (default: 30)", parseInt)
    .option("--project <path>", "Project filter")
    .option("--agent <name>", "Agent filter")
    .option("--limit <n>", "Max results (default: 20)", parseInt)
    .option("--format <fmt>", "Output format: compact (default), json")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const days = (opts.days as number | undefined) || 30;
        const limit = (opts.limit as number | undefined) || 20;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }
        const agentName = (opts.agent as string | undefined) || globalOpts.agent;
        let agentId: string | undefined;
        if (agentName) {
          const agent = getAgent(agentName);
          if (agent) agentId = agent.id;
        }

        const db = getDatabase();
        const conds = [
          "status = 'active'",
          `(accessed_at IS NULL OR accessed_at < datetime('now', '-${days} days'))`,
          "pinned = 0",
        ];
        const params: string[] = [];
        if (projectId) { conds.push("project_id = ?"); params.push(projectId); }
        if (agentId) { conds.push("agent_id = ?"); params.push(agentId); }

        const rows = db.query(
          `SELECT id, key, value, importance, scope, category, accessed_at, access_count FROM memories WHERE ${conds.join(" AND ")} ORDER BY COALESCE(accessed_at, created_at) ASC LIMIT ?`
        ).all(...params, limit) as { id: string; key: string; value: string; importance: number; scope: string; category: string; accessed_at: string | null; access_count: number }[];

        const fmt = getOutputFormat(program, opts.format as string | undefined);
        if (fmt === "json") {
          outputJson({ memories: rows, count: rows.length, days });
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.green(`No stale memories (not accessed in ${days}+ days).`));
          return;
        }
        console.log(chalk.bold(`\nStale memories (not accessed in ${days}+ days):\n`));
        for (const m of rows) {
          const lastAccess = m.accessed_at ? m.accessed_at.slice(0, 10) : chalk.dim("never");
          console.log(`  ${chalk.dim(`[${m.importance}]`)} ${chalk.bold(m.key)} ${chalk.dim(`(${m.scope}/${m.category})`)}`);
          console.log(`    Last accessed: ${lastAccess} · ${m.access_count} reads · ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`);
        }
        console.log(`\n${chalk.dim(`${rows.length} result(s). Run 'mementos archive <key>' or 'mementos forget <key>' to clean up.`)}`);
      } catch (e) {
        console.error(chalk.red(`stale failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  // ============================================================================
  // history
  // ============================================================================

  program
    .command("history")
    .description("List memories sorted by most recently accessed")
    .option("--limit <n>", "Max results (default: 20)", parseInt)
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const limit = (opts.limit as number | undefined) || 20;
        const db = getDatabase();

        const rows = db
          .query(
            "SELECT * FROM memories WHERE status = 'active' AND accessed_at IS NOT NULL ORDER BY accessed_at DESC LIMIT ?"
          )
          .all(limit) as Record<string, unknown>[];

        const memories = rows.map(parseMemoryRow);

        if (globalOpts.json) {
          outputJson(memories);
          return;
        }

        if (memories.length === 0) {
          console.log(chalk.yellow("No recently accessed memories."));
          return;
        }

        console.log(
          chalk.bold(
            `${memories.length} recently accessed memor${memories.length === 1 ? "y" : "ies"}:`
          )
        );
        for (const m of memories) {
          const id = chalk.dim(m.id.slice(0, 8));
          const scope = colorScope(m.scope);
          const cat = colorCategory(m.category);
          const value =
            m.value.length > 60 ? m.value.slice(0, 60) + "..." : m.value;
          const accessed = m.accessed_at
            ? chalk.dim(m.accessed_at)
            : chalk.dim("never");
          console.log(
            `${id} [${scope}/${cat}] ${chalk.bold(m.key)} = ${value}  ${accessed}`
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // context [query]
  // ============================================================================

  program
    .command("context [query]")
    .description(
      "Get formatted, prompt-ready block of relevant memories"
    )
    .option("--max-tokens <n>", "Max approximate token budget", parseInt)
    .option("--min-importance <n>", "Minimum importance threshold", parseInt)
    .option("--scope <scope>", "Filter by scope (global, shared, private)")
    .option("--categories <cats>", "Comma-separated categories to include")
    .option("--agent <name>", "Agent ID for scope filtering")
    .option("--project <path>", "Project path for scope filtering")
    .action((query: string | undefined, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const maxTokens = (opts.maxTokens as number | undefined) || 500;
        const minImportance = (opts.minImportance as number | undefined) || 1;
        const scope = opts.scope as MemoryScope | undefined;
        const categoriesRaw = opts.categories as string | undefined;
        const categories = categoriesRaw
          ? (categoriesRaw.split(",").map((c: string) => c.trim()) as MemoryCategory[])
          : undefined;
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;

        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        let memories: import("../../types/index.js").Memory[];

        if (query) {
          // Use search for relevance-ranked results
          const filter: MemoryFilter = {
            min_importance: minImportance,
            status: "active",
          };
          if (scope) filter.scope = scope;
          if (categories) filter.category = categories;
          if (agentId) filter.agent_id = agentId;
          if (projectId) filter.project_id = projectId;

          const results = searchMemories(query, filter);
          memories = results.map((r) => r.memory);
        } else {
          // No query — gather all relevant memories like inject
          memories = [];
          const baseFilter = {
            min_importance: minImportance,
            status: "active" as const,
            category: categories,
            limit: 100,
          };

          if (!scope || scope === "global") {
            memories.push(
              ...listMemories({ ...baseFilter, scope: "global", project_id: projectId })
            );
          }
          if ((!scope || scope === "shared") && projectId) {
            memories.push(
              ...listMemories({ ...baseFilter, scope: "shared", project_id: projectId })
            );
          }
          if ((!scope || scope === "private") && agentId) {
            memories.push(
              ...listMemories({ ...baseFilter, scope: "private", agent_id: agentId })
            );
          }

          // Deduplicate
          const seen = new Set<string>();
          memories = memories.filter((m) => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
          });

          // Sort by importance DESC, then recency
          memories.sort((a, b) => {
            if (b.importance !== a.importance) return b.importance - a.importance;
            return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
          });
        }

        // Trim to token budget (~4 chars per token)
        const charBudget = maxTokens * 4;
        const lines: string[] = [];
        let totalChars = 0;

        for (const m of memories) {
          const line = `- [${m.category}] ${m.key}: ${m.value} (importance: ${m.importance})`;
          if (totalChars + line.length > charBudget) break;
          lines.push(line);
          totalChars += line.length;
          touchMemory(m.id);
        }

        if (globalOpts.json) {
          outputJson({ context: lines.length > 0 ? `## Memories\n\n${lines.join("\n")}` : "", count: lines.length });
          return;
        }

        if (lines.length === 0) {
          // Pipe-friendly: output nothing if no memories
          if (process.stdout.isTTY) {
            console.log(chalk.yellow("No relevant memories found."));
          }
          return;
        }

        console.log(`## Memories\n\n${lines.join("\n")}`);
      } catch (e) {
        handleError(e);
      }
    });
}
