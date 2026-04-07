import type { Command } from "commander";
import chalk from "chalk";
import { getMemory } from "../../db/memories.js";
import { outputJson, makeHandleError, resolveMemoryId, type GlobalOpts } from "../helpers.js";

export function registerWhenToUseCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("when-to-use <memory_id>")
    .description("Show the when_to_use guidance for a memory")
    .action((memoryId: string) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const resolvedId = resolveMemoryId(memoryId);
        const memory = getMemory(resolvedId);

        if (!memory) {
          if (globalOpts.json) {
            outputJson({ error: `Memory not found: ${memoryId}` });
          } else {
            console.error(chalk.red(`Memory not found: ${memoryId}`));
          }
          process.exit(1);
        }

        const whenToUse = memory.when_to_use ?? null;

        if (globalOpts.json) {
          outputJson({ id: memory.id, key: memory.key, when_to_use: whenToUse });
          return;
        }

        console.log(chalk.bold(`${memory.key} (${memory.id.slice(0, 8)})`));
        if (whenToUse) {
          console.log(`  ${chalk.cyan("when_to_use:")} ${whenToUse}`);
        } else {
          console.log(chalk.dim("  (not set)"));
        }
      } catch (e) {
        handleError(e);
      }
    });
}
