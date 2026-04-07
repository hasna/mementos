import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { listMemories } from "../../db/memories.js";
import type { MemoryScope, MemoryFilter } from "../../types/index.js";
import { colorScope, colorCategory, makeHandleError, type GlobalOpts } from "../helpers.js";

export function registerWatchCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("watch")
    .description("Watch for new and changed memories in real-time")
    .option("-s, --scope <scope>", "Scope filter: global, shared, private")
    .option("-c, --category <cat>", "Category filter: preference, fact, knowledge, history")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .option("--interval <ms>", "Poll interval in milliseconds", parseInt)
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const { getProject } = require("../../db/projects.js") as typeof import("../../db/projects.js");
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const intervalMs = (opts.interval as number | undefined) || 500;

        console.log(chalk.bold.cyan("Watching memories...") + chalk.dim(" (Ctrl+C to stop)"));

        const filters: string[] = [];
        if (opts.scope) filters.push(`scope=${colorScope(opts.scope as MemoryScope)}`);
        if (opts.category) filters.push(`category=${colorCategory(opts.category as any)}`);
        if (agentId) filters.push(`agent=${chalk.dim(agentId)}`);
        if (projectId) filters.push(`project=${chalk.dim(projectId)}`);
        if (filters.length > 0) {
          console.log(chalk.dim("Filters: ") + filters.join(chalk.dim(" | ")));
        }
        console.log(chalk.dim(`Poll interval: ${intervalMs}ms`));
        console.log();

        const filter: MemoryFilter = {
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as any,
          agent_id: agentId,
          project_id: projectId,
          limit: 20,
        };

        const { formatWatchLine, sendNotification } = require("../helpers.js") as typeof import("../helpers.js");
        const recent = listMemories(filter);
        if (recent.length > 0) {
          console.log(chalk.bold.dim(`Recent (${recent.length}):`));
          for (const m of recent.reverse()) {
            console.log(formatWatchLine(m));
          }
        } else {
          console.log(chalk.dim("No recent memories."));
        }

        console.log(chalk.dim("──────────── Live ────────────"));
        console.log();

        const { startPolling } = require("../../lib/poll.js") as typeof import("../../lib/poll.js");

        const handle = startPolling({
          interval_ms: intervalMs,
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as any,
          agent_id: agentId,
          project_id: projectId,
          on_memories: (memories: any[]) => {
            for (const m of memories) {
              console.log(formatWatchLine(m));
              sendNotification(m);
            }
          },
          on_error: (err: Error) => {
            console.error(chalk.red(`Poll error: ${err.message}`));
          },
        });

        const cleanup = () => {
          handle.stop();
          console.log();
          console.log(chalk.dim("Stopped watching."));
          process.exit(0);
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
      } catch (e) {
        handleError(e);
      }
    });
}
