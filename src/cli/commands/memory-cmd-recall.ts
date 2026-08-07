import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getProject } from "../../db/projects.js";
import { getMemoryByKey, touchMemory } from "../../db/memories.js";
import { searchMemories } from "../../lib/search.js";
import type { MemoryScope } from "../../types/index.js";
import {
  resolveAgentFilter, outputJson, formatMemoryDetail, makeHandleError, type GlobalOpts } from "../helpers.js";
import { RECALL_EXIT_FUZZY, RECALL_EXIT_NOT_FOUND } from "./memory-cmd-recall-exit.js";

export function registerRecallCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("recall <key>")
    .alias("get")
    .description("Recall a memory by exact key (use --fuzzy to fall back to the nearest match)")
    .option("--scope <scope>", "Scope filter")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .option("--fuzzy", "If the exact key is absent, return the nearest match instead (exits 2)")
    .action((key: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agentId = resolveAgentFilter((opts.agent as string | undefined) || globalOpts.agent);
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const memory = getMemoryByKey(key, opts.scope as string | undefined, agentId, projectId);

        // Both store backends filter on `key = ?`, so this should always hold.
        // It is asserted anyway because the whole point of this command is that
        // a returned record IS the record that was asked for: if a backend ever
        // loosens that filter, this degrades to an honest "not found" instead of
        // silently reviving the substitution bug on the exact path.
        if (memory && memory.key === key) {
          touchMemory(memory.id);
          if (globalOpts.json) {
            outputJson(memory);
          } else {
            console.log(formatMemoryDetail(memory));
          }
          return;
        }

        if (opts.fuzzy) {
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
              outputJson({
                fuzzy_match: true,
                requested_key: key,
                returned_key: best.memory.key,
                score: best.score,
                match_type: best.match_type,
                memory: best.memory,
              });
            } else {
              console.error(
                chalk.yellow(
                  `No memory with key "${key}". Showing the nearest match "${best.memory.key}" ` +
                    `(score: ${best.score.toFixed(2)}, match: ${best.match_type}) — this is a DIFFERENT record.`
                )
              );
              console.log(formatMemoryDetail(best.memory));
            }
            // A substituted record is not the record that was asked for, so the
            // exit status must not say "found".
            process.exit(RECALL_EXIT_FUZZY);
          }
        }

        const message = opts.fuzzy
          ? `No memory found for key: ${key}`
          : `No memory found for key: ${key} (exact match; pass --fuzzy to return the nearest record instead)`;

        if (globalOpts.json) {
          outputJson({ error: message, requested_key: key });
        } else {
          console.error(chalk.yellow(message));
        }
        process.exit(RECALL_EXIT_NOT_FOUND);
      } catch (e) {
        handleError(e);
      }
    });
}
