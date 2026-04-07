import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { diffMemory, makeHandleError, resolveKeyOrId, type GlobalOpts } from "../helpers.js";

export function registerDiffCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("diff <id>")
    .description("Show diff between memory versions")
    .option("-v, --version <n>", "Compare version N with N-1")
    .action((idArg: string, opts: { version?: string }) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const db = getDatabase();

        let memoryId: string | null = resolvePartialId(db, "memories", idArg);
        if (!memoryId) {
          const mem = resolveKeyOrId(idArg, {}, globalOpts);
          if (!mem) {
            console.error(chalk.red(`Memory not found: ${idArg}`));
            process.exit(1);
          }
          memoryId = mem.id;
        }
        diffMemory(memoryId, opts, globalOpts);
      } catch (e) {
        handleError(e);
      }
    });
}
