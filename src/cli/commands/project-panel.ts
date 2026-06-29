import type { Command } from "commander";
import { createMementosProjectPanel, formatMementosProjectPanel } from "../../lib/project-panel.js";
import {
  makeHandleError,
  outputJson,
  type GlobalOpts,
} from "../helpers.js";

export function registerProjectPanelCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("project-panel")
    .description("Emit a Projects dashboard project-panel contract for project memories")
    .option("--project <id>", "Project id, path, name, or slug")
    .option("--limit <n>", "Maximum panel items", (value) => Number(value), 20)
    .option("--contract", "Emit contract JSON")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const projectRef = (opts.project as string | undefined) || globalOpts.project;
        if (!projectRef) {
          throw new Error("Usage: mementos project-panel --project <id|path|name|slug> [--contract]");
        }
        const panel = createMementosProjectPanel(projectRef, {
          limit: opts.limit as number | undefined,
        });

        if (globalOpts.json || opts.contract) {
          outputJson(panel);
          return;
        }

        console.log(formatMementosProjectPanel(panel));
      } catch (error) {
        handleError(error);
      }
    });
}
