import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createMemory } from "../../db/memories.js";
import type { CreateMemoryInput } from "../../types/index.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerImportCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("import [file]")
    .description("Import memories from a JSON file or stdin (use '-' or pipe data)")
    .option("--overwrite", "Overwrite existing memories (default: merge)")
    .action(async (file: string | undefined, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        let raw: string;
        if (file === "-" || (!file && !process.stdin.isTTY)) {
          raw = await Bun.stdin.text();
        } else if (file) {
          raw = readFileSync(resolve(file), "utf-8");
        } else {
          console.error(chalk.red("No input: provide a file path, use '-' for stdin, or pipe data."));
          process.exit(1);
        }
        const memories = JSON.parse(raw) as CreateMemoryInput[];

        if (!Array.isArray(memories)) {
          throw new Error("JSON file must contain an array of memories");
        }

        const dedupeMode = opts.overwrite ? ("create" as const) : ("merge" as const);
        let imported = 0;

        for (const mem of memories) {
          createMemory(
            { ...mem, source: mem.source || "imported" },
            dedupeMode
          );
          imported++;
        }

        if (globalOpts.json) {
          outputJson({ imported });
        } else {
          console.log(
            chalk.green(
              `Imported ${imported} memor${imported === 1 ? "y" : "ies"}.`
            )
          );
        }
      } catch (e) {
        handleError(e);
      }
    });
}
