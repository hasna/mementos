import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../../db/database.js";
import { parseMemoryRow } from "../../db/memories.js";
import {
  DEFAULT_SEARCH_LIMIT,
  outputJson,
  colorScope,
  colorCategory,
  makeHandleError,
  cursorOrOffset,
  positiveIntOrDefault,
  printPageHint,
  truncateText,
  type GlobalOpts,
} from "../helpers.js";

export function registerHistoryCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("history")
    .description("List memories sorted by most recently accessed")
    .option("--limit <n>", "Max results (compact default: 10)", parseInt)
    .option("--offset <n>", "Offset for pagination", parseInt)
    .option("--cursor <n>", "Cursor offset for the next page", parseInt)
    .option("--verbose", "Show wider memory snippets")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const isJson = Boolean(globalOpts.json);
        const limit = positiveIntOrDefault(opts.limit, isJson ? 20 : DEFAULT_SEARCH_LIMIT);
        const offset = cursorOrOffset(opts.cursor, opts.offset);
        const db = getDatabase();

        const rows = db
          .query(
            `SELECT * FROM memories WHERE status = 'active' AND accessed_at IS NOT NULL ORDER BY accessed_at DESC LIMIT ?${offset ? " OFFSET ?" : ""}`
          )
          .all(...(offset ? [isJson ? limit : limit + 1, offset] : [isJson ? limit : limit + 1])) as Record<string, unknown>[];

        const fetched = rows.map(parseMemoryRow);
        const hasMore = !isJson && fetched.length > limit;
        const memories = hasMore ? fetched.slice(0, limit) : fetched;

        if (globalOpts.json) {
          outputJson(fetched);
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
          const value = truncateText(m.value, opts.verbose ? 120 : 64);
          const accessed = m.accessed_at
            ? chalk.dim(m.accessed_at)
            : chalk.dim("never");
          console.log(
            `${id} [${scope}/${cat}] ${chalk.bold(m.key)} = ${value}  ${accessed}`
          );
        }
        printPageHint({
          shown: memories.length,
          limit,
          offset,
          hasMore,
          command: "mementos history",
          detailHint: "use mementos show <id> for full details or --json for full objects",
        });
      } catch (e) {
        handleError(e);
      }
    });
}
