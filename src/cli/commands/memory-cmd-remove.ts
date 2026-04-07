import type { Command } from "commander";
import chalk from "chalk";

export function registerRemoveCommand(program: Command): void {
  program
    .command("remove <nameOrId>")
    .description("Remove/delete a memory by name or ID (alias for memory delete)")
    .option("--agent <id>", "Agent ID")
    .action((nameOrId: string, opts: { agent?: string }) => {
      const globalOpts = program.opts() as { agent?: string; json?: boolean };
      const agentId = opts.agent || globalOpts.agent;
      const { deleteMemory: _deleteMemory, getMemoryByKey: _getMemoryByKey, resolvePartialMemoryId } = require("../../db/memories.js") as any;
      let id: string | null = null;
      try {
        id = resolvePartialMemoryId?.(nameOrId) || null;
      } catch {}
      if (!id) {
        const mem = _getMemoryByKey?.(nameOrId, agentId);
        if (mem) id = mem.id;
      }
      if (!id) {
        console.error(chalk.red(`Memory not found: ${nameOrId}`));
        process.exit(1);
      }
      const deleted = _deleteMemory(id);
      if (deleted) {
        console.log(chalk.green(`✓ Memory ${id.slice(0, 8)} removed`));
      } else {
        console.error(chalk.red(`Memory not found: ${nameOrId}`));
        process.exit(1);
      }
    });
}
