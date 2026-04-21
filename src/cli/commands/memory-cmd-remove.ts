import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { deleteMemory, getMemoryByKey } from "../../db/memories.js";
import { outputJson, type GlobalOpts } from "../helpers.js";

export function registerRemoveCommand(program: Command): void {
  program
    .command("remove <nameOrId>")
    .description("Remove/delete a memory by name or ID (alias for memory forget)")
    .option("--agent <id>", "Agent ID")
    .option("-s, --scope <scope>", "Filter by scope (when looking up by key)")
    .action((nameOrId: string, opts: { agent?: string; scope?: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const agentId = opts.agent || globalOpts.agent;

      // Try by partial ID first
      const db = getDatabase();
      let id = resolvePartialId(db, "memories", nameOrId);

      // Fall back to key lookup
      if (!id) {
        const mem = getMemoryByKey(nameOrId, opts.scope, agentId);
        if (mem) id = mem.id;
      }

      if (!id) {
        if (globalOpts.json) {
          outputJson({ error: `Memory not found: ${nameOrId}` });
        } else {
          console.error(chalk.red(`Memory not found: ${nameOrId}`));
        }
        process.exit(1);
      }

      const deleted = deleteMemory(id);
      if (deleted) {
        if (globalOpts.json) {
          outputJson({ deleted: id });
        } else {
          console.log(chalk.green(`Memory ${id.slice(0, 8)} removed`));
        }
      } else {
        if (globalOpts.json) {
          outputJson({ error: `Memory not found: ${nameOrId}` });
        } else {
          console.error(chalk.red(`Memory not found: ${nameOrId}`));
        }
        process.exit(1);
      }
    });
}
