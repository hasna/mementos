import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getDatabase } from "../../db/database.js";
import { getProject } from "../../db/projects.js";
import { getAgent } from "../../db/agents.js";
import {
  outputJson,
  getOutputFormat,
  colorScope,
  colorCategory,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerStaleCommand(program: Command): void {
  const handleError = makeHandleError(program);

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
          outputJson({ stale_count: rows.length, threshold_days: days, memories: rows });
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.yellow(`No stale memories found (threshold: ${days} days).`));
          return;
        }

        console.log(chalk.bold(`\n  ${rows.length} stale memor${rows.length === 1 ? "y" : "ies"} (not accessed in ${days}+ days):`));
        for (const row of rows) {
          const accessed = row.accessed_at
            ? chalk.dim(row.accessed_at.split("T")[0])
            : chalk.red("never");
          const value = row.value.length > 60 ? row.value.slice(0, 60) + "..." : row.value;
          console.log(`  ${chalk.red(String(row.importance))} ${colorScope(row.scope as never)}/${colorCategory(row.category as never)} ${chalk.bold(row.key)} = ${value} ${chalk.dim(`(${accessed}, ${row.access_count} accesses)`)}`);
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });
}
