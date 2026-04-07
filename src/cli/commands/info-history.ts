import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../../db/database.js";
import { parseMemoryRow } from "../../db/memories.js";
import {
  outputJson,
  colorScope,
  colorCategory,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerHistoryCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("history")
    .description("List memories sorted by most recently accessed")
    .option("--limit <n>", "Max results (default: 20)", parseInt)
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const limit = (opts.limit as number | undefined) || 20;
        const db = getDatabase();

        const rows = db
          .query(
            "SELECT * FROM memories WHERE status = 'active' AND accessed_at IS NOT NULL ORDER BY accessed_at DESC LIMIT ?"
          )
          .all(limit) as Record<string, unknown>[];

        const memories = rows.map(parseMemoryRow);

        if (globalOpts.json) {
          outputJson(memories);
          return;
        }

        if (memories.length === 0) {
          console.log(chalk.yellow("No recently accessed memories."));
          return;
        }

        console.log(
          chalk.bold(
            `${memories.length} recently accessed memor${memories.length === 1 ? "y" : "ies"}:`
          )
        );
        for (const m of memories) {
          const id = chalk.dim(m.id.slice(0, 8));
          const scope = colorScope(m.scope);
          const cat = colorCategory(m.category);
          const value =
            m.value.length > 60 ? m.value.slice(0, 60) + "..." : m.value;
          const accessed = m.accessed_at
            ? chalk.dim(m.accessed_at)
            : chalk.dim("never");
          console.log(
            `${id} [${scope}/${cat}] ${chalk.bold(m.key)} = ${value}  ${accessed}`
          );
        }
      } catch (e) {
        handleError(e);
      }
    });
}
