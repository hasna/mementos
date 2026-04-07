import type { Command } from "commander";
import { resolve } from "node:path";
import { getProject } from "../../db/projects.js";
import { listMemories } from "../../db/memories.js";
import type { MemoryCategory, MemoryScope, MemoryFilter } from "../../types/index.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerExportCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("export")
    .description("Export memories as JSON")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-c, --category <cat>", "Category filter")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath =
          (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const filter: MemoryFilter = {
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as MemoryCategory | undefined,
          agent_id: agentId,
          project_id: projectId,
          limit: 10000,
        };

        const memories = listMemories(filter);

        // Export always outputs JSON
        outputJson(memories);
      } catch (e) {
        handleError(e);
      }
    });
}
