import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getProject } from "../../db/projects.js";
import { getMemoryByKey, touchMemory } from "../../db/memories.js";
import { searchMemories } from "../../lib/search.js";
import type { MemoryScope } from "../../types/index.js";
import { outputJson, formatMemoryDetail, makeHandleError, type GlobalOpts } from "../helpers.js";

export function registerRecallCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("recall <key>")
    .description("Recall a memory by key")
    .option("-s, --scope <scope>", "Scope filter")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .action((key: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const memory = getMemoryByKey(key, opts.scope as string | undefined, agentId, projectId);

        if (memory) {
          touchMemory(memory.id);
          if (globalOpts.json) {
            outputJson(memory);
          } else {
            console.log(formatMemoryDetail(memory));
          }
          return;
        }

        const results = searchMemories(key, {
          scope: opts.scope as MemoryScope | undefined,
          agent_id: agentId,
          project_id: projectId,
          limit: 1,
        });

        if (results.length > 0) {
          const best = results[0]!;
          touchMemory(best.memory.id);
          if (globalOpts.json) {
            outputJson({ fuzzy_match: true, score: best.score, match_type: best.match_type, memory: best.memory });
          } else {
            console.log(chalk.yellow(`No exact match, showing best result (score: ${best.score.toFixed(2)}, match: ${best.match_type}):`));
            console.log(formatMemoryDetail(best.memory));
          }
          return;
        }

        if (globalOpts.json) {
          outputJson({ error: `No memory found for key: ${key}` });
        } else {
          console.error(chalk.yellow(`No memory found for key: ${key}`));
        }
        process.exit(1);
      } catch (e) {
        handleError(e);
      }
    });
}
