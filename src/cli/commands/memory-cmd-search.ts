import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getProject } from "../../db/projects.js";
import { searchMemories, getSearchHistory, getPopularSearches } from "../../lib/search.js";
import type { MemoryScope, MemoryCategory, MemoryFilter } from "../../types/index.js";
import {
  DEFAULT_SEARCH_LIMIT,
  outputJson,
  outputYaml,
  getOutputFormat,
  formatMemoryLine,
  makeHandleError,
  cursorOrOffset,
  positiveIntOrDefault,
  printPageHint,
  truncateText,
  type GlobalOpts,
} from "../helpers.js";

export function registerSearchCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("search <query>")
    .description("Full-text search across memories")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-c, --category <cat>", "Category filter")
    .option("--tags <tags>", "Comma-separated tags filter")
    .option("--project <path>", "Project filter (path or name)")
    .option("--agent <name>", "Agent filter")
    .option("--session <id>", "Session ID filter")
    .option("--limit <n>", "Max results", parseInt)
    .option("--offset <n>", "Offset for pagination", parseInt)
    .option("--cursor <n>", "Cursor offset for the next page", parseInt)
    .option("--format <fmt>", "Output format: compact (default), json, csv, yaml")
    .option("--verbose", "Show match highlights and wider snippets")
    .option("--history", "Show recent search queries instead of searching")
    .option("--popular", "Show most popular search queries")
    .action((query: string, opts) => {
      try {
        const fmt = getOutputFormat(program, opts.format as string | undefined);
        const isStructured = fmt === "json" || fmt === "csv" || fmt === "yaml";
        const limit = positiveIntOrDefault(
          opts.limit,
          isStructured ? 20 : DEFAULT_SEARCH_LIMIT
        );
        const offset = cursorOrOffset(opts.cursor, opts.offset);

        if (opts.history) {
          const history = getSearchHistory(limit);
          if (fmt === "json") {
            outputJson(history);
            return;
          }
          if (history.length === 0) {
            console.log(chalk.yellow("No search history."));
            return;
          }
          console.log(chalk.bold("Recent searches:"));
          for (const h of history) {
            console.log(`  ${chalk.cyan(h.query)} ${chalk.dim(`(${h.result_count} results, ${h.created_at})`)}`);
          }
          return;
        }

        if (opts.popular) {
          const popular = getPopularSearches(limit);
          if (fmt === "json") {
            outputJson(popular);
            return;
          }
          if (popular.length === 0) {
            console.log(chalk.yellow("No search history."));
            return;
          }
          console.log(chalk.bold("Popular searches:"));
          for (const p of popular) {
            console.log(`  ${chalk.cyan(p.query)} ${chalk.dim(`(${p.count} times)`)}`);
          }
          return;
        }

        const globalOpts = program.opts<GlobalOpts>();
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }
        const agentName = (opts.agent as string | undefined) || globalOpts.agent;
        let agentId: string | undefined;
        if (agentName) {
          const { getAgent } = require("../../db/agents.js") as typeof import("../../db/agents.js");
          const agent = getAgent(agentName);
          if (agent) agentId = agent.id;
        }

        const filter: MemoryFilter = {
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as MemoryCategory | undefined,
          tags: opts.tags
            ? (opts.tags as string).split(",").map((t: string) => t.trim())
            : undefined,
          project_id: projectId,
          agent_id: agentId,
          session_id: (opts.session as string | undefined) || globalOpts.session,
          limit: isStructured ? limit : limit + 1,
          offset,
        };

        const fetched = searchMemories(query, filter);
        const hasMore = !isStructured && fetched.length > limit;
        const results = hasMore ? fetched.slice(0, limit) : fetched;

        if (fmt === "json") {
          outputJson(fetched);
          return;
        }

        if (fmt === "csv") {
          console.log("key,value,scope,category,importance,score,id");
          for (const r of results) {
            const v = r.memory.value.replace(/"/g, '""');
            console.log(`"${r.memory.key}","${v}",${r.memory.scope},${r.memory.category},${r.memory.importance},${r.score.toFixed(1)},${r.memory.id.slice(0, 8)}`);
          }
          return;
        }

        if (fmt === "yaml") {
          outputYaml(results);
          return;
        }

        if (results.length === 0) {
          console.log(chalk.yellow(`No memories found matching "${query}".`));
          return;
        }

        console.log(chalk.bold(`${results.length}${hasMore ? "+" : ""} result${results.length === 1 ? "" : "s"} for "${query}":`));
        for (const r of results) {
          const score = chalk.dim(`(score: ${r.score.toFixed(1)})`);
          console.log(`${formatMemoryLine(r.memory, {
            valueLength: opts.verbose ? 120 : 64,
            preferSummary: !opts.verbose,
          })} ${score}`);
          if (opts.verbose && r.highlights && r.highlights.length > 0) {
            for (const h of r.highlights) {
              console.log(chalk.dim(`    ${h.field}: ${truncateText(h.snippet, 120)}`));
            }
          }
        }
        printPageHint({
          shown: results.length,
          limit,
          offset,
          hasMore,
          command: `mementos search "${query.replace(/"/g, '\\"')}"`,
          detailHint: "add --verbose for highlights, use mementos show <id> for full details, or --json for full objects",
        });
      } catch (e) {
        handleError(e);
      }
    });
}
