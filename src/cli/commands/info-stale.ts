import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getDatabase } from "../../db/database.js";
import { getProject } from "../../db/projects.js";
import { getAgent } from "../../db/agents.js";
import {
  DEFAULT_COMPACT_LIMIT,
  outputJson,
  getOutputFormat,
  colorScope,
  colorCategory,
  makeHandleError,
  cursorOrOffset,
  positiveIntOrDefault,
  printPageHint,
  truncateText,
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
    .option("--offset <n>", "Offset for pagination", parseInt)
    .option("--cursor <n>", "Cursor offset for the next page", parseInt)
    .option("--format <fmt>", "Output format: compact (default), json")
    .option("--verbose", "Show wider memory snippets")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const days = (opts.days as number | undefined) || 30;
        const fmt = getOutputFormat(program, opts.format as string | undefined);
        const isJson = fmt === "json";
        const limit = positiveIntOrDefault(opts.limit, isJson ? 20 : DEFAULT_COMPACT_LIMIT);
        const offset = cursorOrOffset(opts.cursor, opts.offset);
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
          `SELECT id, key, value, importance, scope, category, accessed_at, access_count FROM memories WHERE ${conds.join(" AND ")} ORDER BY COALESCE(accessed_at, created_at) ASC LIMIT ?${offset ? " OFFSET ?" : ""}`
        ).all(...params, isJson ? limit : limit + 1, ...(offset ? [offset] : [])) as { id: string; key: string; value: string; importance: number; scope: string; category: string; accessed_at: string | null; access_count: number }[];
        const hasMore = !isJson && rows.length > limit;
        const displayRows = hasMore ? rows.slice(0, limit) : rows;

        if (fmt === "json") {
          outputJson({ stale_count: rows.length, threshold_days: days, memories: rows });
          return;
        }

        if (displayRows.length === 0) {
          console.log(chalk.yellow(`No stale memories found (threshold: ${days} days).`));
          return;
        }

        console.log(chalk.bold(`\n  ${displayRows.length}${hasMore ? "+" : ""} stale memor${displayRows.length === 1 ? "y" : "ies"} (not accessed in ${days}+ days):`));
        for (const row of displayRows) {
          const accessed = row.accessed_at
            ? chalk.dim(row.accessed_at.split("T")[0])
            : chalk.red("never");
          const value = truncateText(row.value, opts.verbose ? 120 : 64);
          console.log(`  ${chalk.red(String(row.importance))} ${colorScope(row.scope as never)}/${colorCategory(row.category as never)} ${chalk.bold(row.key)} = ${value} ${chalk.dim(`(${accessed}, ${row.access_count} accesses)`)}`);
        }
        printPageHint({
          shown: displayRows.length,
          limit,
          offset,
          hasMore,
          command: "mementos stale",
          detailHint: "use mementos show <id> for full details or --json for full objects",
        });
        console.log();
      } catch (e) {
        handleError(e);
      }
    });
}
