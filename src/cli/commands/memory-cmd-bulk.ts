import type { Command } from "commander";
import chalk from "chalk";
import {
  getMemory,
  bulkDeleteMemories,
  updateMemory,
} from "../../db/memories.js";
import { outputJson, makeHandleError, resolveMemoryId, type GlobalOpts } from "../helpers.js";

export function registerBulkCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("bulk <action> <ids...>")
    .description("Batch operations: forget, archive, pin, unpin")
    .action((action: string, ids: string[]) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const validActions = ["forget", "archive", "pin", "unpin"] as const;

        if (!validActions.includes(action as (typeof validActions)[number])) {
          console.error(chalk.red(`Invalid action: ${action}. Valid: ${validActions.join(", ")}`));
          process.exit(1);
        }

        const resolvedIds = ids.map((id) => resolveMemoryId(id));
        let affected = 0;

        switch (action) {
          case "forget": {
            affected = bulkDeleteMemories(resolvedIds);
            break;
          }
          case "archive": {
            for (const id of resolvedIds) {
              const mem = getMemory(id);
              if (mem) {
                updateMemory(id, {
                  status: "archived",
                  version: mem.version,
                });
                affected++;
              }
            }
            break;
          }
          case "pin": {
            for (const id of resolvedIds) {
              const mem = getMemory(id);
              if (mem) {
                updateMemory(id, {
                  pinned: true,
                  version: mem.version,
                });
                affected++;
              }
            }
            break;
          }
          case "unpin": {
            for (const id of resolvedIds) {
              const mem = getMemory(id);
              if (mem) {
                updateMemory(id, {
                  pinned: false,
                  version: mem.version,
                });
                affected++;
              }
            }
            break;
          }
        }

        if (globalOpts.json) {
          outputJson({ action, affected, ids: resolvedIds });
        } else {
          console.log(chalk.green(`${action}: ${affected} memor${affected === 1 ? "y" : "ies"} affected.`));
        }
      } catch (e) {
        handleError(e);
      }
    });
}
