import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../../db/database.js";
import { parseMemoryRow } from "../../db/memories.js";
import { outputJson, makeHandleError, type GlobalOpts } from "../helpers.js";

export function registerChainCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("chain <sequence_group>")
    .description("Show a memory chain (memories linked by sequence_group, ordered by sequence_order)")
    .action((sequenceGroup: string) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const db = getDatabase();

        const rows = db
          .query(
            "SELECT * FROM memories WHERE sequence_group = ? AND status = 'active' ORDER BY sequence_order ASC"
          )
          .all(sequenceGroup) as Record<string, unknown>[];

        const memories = rows.map(parseMemoryRow);

        if (globalOpts.json) {
          outputJson(memories);
          return;
        }

        if (memories.length === 0) {
          console.log(chalk.yellow(`No chain found for sequence group: ${sequenceGroup}`));
          return;
        }

        console.log(chalk.bold(`Chain: ${sequenceGroup} (${memories.length} step${memories.length === 1 ? "" : "s"}):\n`));
        for (let i = 0; i < memories.length; i++) {
          const m = memories[i]!;
          const order = m.sequence_order !== null && m.sequence_order !== undefined ? m.sequence_order : i + 1;
          const value = m.value.length > 120 ? m.value.slice(0, 120) + "..." : m.value;
          console.log(`  ${chalk.cyan(String(order) + ".")} ${chalk.bold(m.key)}: ${value}`);
        }
      } catch (e) {
        handleError(e);
      }
    });
}
