import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getProject } from "../../db/projects.js";
import { listMemories } from "../../db/memories.js";
import type { MemoryScope, MemoryCategory, MemoryStatus, MemoryFilter } from "../../types/index.js";
import {
  outputJson,
  outputYaml,
  getOutputFormat,
  formatMemoryLine,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerListCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("list")
    .description("List memories with optional filters")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-c, --category <cat>", "Category filter")
    .option("--tags <tags>", "Comma-separated tags filter")
    .option("--importance-min <n>", "Minimum importance", parseInt)
    .option("--pinned", "Show only pinned")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .option("--session <id>", "Session ID filter")
    .option("--limit <n>", "Max results", parseInt)
    .option("--offset <n>", "Offset for pagination", parseInt)
    .option("--status <status>", "Status filter: active, archived, expired")
    .option("--format <fmt>", "Output format: compact (default), json, csv, yaml")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const filter: MemoryFilter = {
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as MemoryCategory | undefined,
          tags: opts.tags
            ? (opts.tags as string).split(",").map((t: string) => t.trim())
            : undefined,
          min_importance: opts.importanceMin as number | undefined,
          pinned: opts.pinned ? true : undefined,
          agent_id: agentId,
          project_id: projectId,
          limit: (opts.limit as number | undefined) || 50,
          offset: opts.offset as number | undefined,
          status: opts.status as MemoryStatus | undefined,
          session_id: (opts.session as string | undefined) || globalOpts.session,
        };

        const memories = listMemories(filter);
        const fmt = getOutputFormat(program, opts.format as string | undefined);

        if (fmt === "json") {
          outputJson(memories);
          return;
        }

        if (fmt === "csv") {
          console.log("key,value,scope,category,importance,id");
          for (const m of memories) {
            const v = m.value.replace(/"/g, '""');
            console.log(`"${m.key}","${v}",${m.scope},${m.category},${m.importance},${m.id.slice(0, 8)}`);
          }
          return;
        }

        if (fmt === "yaml") {
          outputYaml(memories);
          return;
        }

        if (memories.length === 0) {
          console.log(chalk.yellow("No memories found."));
          return;
        }

        console.log(chalk.bold(`${memories.length} memor${memories.length === 1 ? "y" : "ies"}:`));
        for (const m of memories) {
          console.log(formatMemoryLine(m));
        }
      } catch (e) {
        handleError(e);
      }
    });
}
