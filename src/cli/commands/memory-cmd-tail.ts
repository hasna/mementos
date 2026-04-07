import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getProject } from "../../db/projects.js";
import type { Memory, MemoryScope, MemoryCategory } from "../../types/index.js";
import {
  colorScope,
  colorCategory,
  formatWatchLine,
  makeHandleError,
  sendNotification,
  type GlobalOpts,
} from "../helpers.js";

export function registerTailCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("tail")
    .description("Watch for new/updated memories in real-time (like tail -f)")
    .option("-s, --scope <scope>", "Scope filter: global, shared, private")
    .option("-c, --category <cat>", "Category filter: preference, fact, knowledge, history")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .option("--interval <ms>", "Poll interval in milliseconds (default: 2000)", parseInt)
    .option("--notify", "Send macOS notifications for each change")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const jsonMode = !!globalOpts.json;
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const intervalMs = (opts.interval as number | undefined) || 2000;
        const notifyEnabled = !!opts.notify;
        const startTime = new Date().toISOString();

        if (!jsonMode) {
          console.log(chalk.bold.cyan("Watching for memory changes...") + chalk.dim(" (Ctrl+C to stop)"));

          const filters: string[] = [];
          if (opts.scope) filters.push(`scope=${colorScope(opts.scope as MemoryScope)}`);
          if (opts.category) filters.push(`category=${colorCategory(opts.category as MemoryCategory)}`);
          if (agentId) filters.push(`agent=${chalk.dim(agentId)}`);
          if (projectId) filters.push(`project=${chalk.dim(projectId)}`);
          if (filters.length > 0) {
            console.log(chalk.dim("Filters: ") + filters.join(chalk.dim(" | ")));
          }
          console.log(chalk.dim(`Poll interval: ${intervalMs}ms`));
          console.log();
        }

        const { startPolling } = require("../../lib/poll.js") as typeof import("../../lib/poll.js");

        const handle = startPolling({
          interval_ms: intervalMs,
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as MemoryCategory | undefined,
          agent_id: agentId,
          project_id: projectId,
          on_memories: (memories: Memory[]) => {
            for (const m of memories) {
              const isNew = m.created_at === m.updated_at && m.created_at >= startTime;
              if (jsonMode) {
                console.log(JSON.stringify({ event: isNew ? "new" : "updated", memory: m }));
              } else {
                const prefix = isNew ? chalk.green.bold("+ ") : chalk.yellow.bold("~ ");
                console.log(prefix + formatWatchLine(m));
              }
              if (notifyEnabled) sendNotification(m);
            }
          },
          on_error: (err: Error) => {
            if (jsonMode) {
              console.error(JSON.stringify({ event: "error", message: err.message }));
            } else {
              console.error(chalk.red(`Poll error: ${err.message}`));
            }
          },
        });

        const cleanup = () => {
          handle.stop();
          if (!jsonMode) {
            console.log();
            console.log(chalk.dim("Stopped watching."));
          }
          process.exit(0);
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
      } catch (e) {
        handleError(e);
      }
    });
}
