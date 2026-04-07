import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getDatabase } from "../../db/database.js";
import { getProject } from "../../db/projects.js";

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Rich summary of memory activity and top memories")
    .option("--days <n>", "Activity window in days (default: 7)", "7")
    .option("--project <path>", "Filter by project path")
    .option("--markdown", "Output as Markdown (for PRs, docs, etc.)")
    .option("--json", "Output as JSON")
    .action((opts) => {
      try {
        const globalOpts = program.opts<{ project?: string; json?: boolean }>();
        const days = parseInt(opts.days as string, 10) || 7;
        const isJson = (opts.json as boolean | undefined) || globalOpts.json;
        const isMarkdown = opts.markdown as boolean | undefined;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const db = getDatabase();

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
}
