import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getMemoryReport } from "../../db/analytics.js";
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

        // Route through the Store (api mode → GET /api/report; local → sqlite).
        const report = getMemoryReport({ days, project_id: projectId });
        const { total, pinned } = report;
        const activityRows = report.recent.activity;
        const recentTotal = report.recent.total;
        const avgPerDay = activityRows.length > 0 ? (recentTotal / activityRows.length).toFixed(1) : "0";
        const byScope = report.by_scope;
        const byCat = report.by_category;
        const topMems = report.top_memories;
        const topAgents = report.top_agents;

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
          const maxC = Math.max(...activityRows.map(x => x.memories_created), 1);
          return bars[Math.round((r.memories_created / maxC) * 7)] || "▁";
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
