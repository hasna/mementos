import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../lib/config.js";
import { runCleanup } from "../../lib/retention.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerCleanCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("clean")
    .description("Remove expired memories and enforce quotas")
    .action(() => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const config = loadConfig();
        const result = runCleanup(config);

        if (globalOpts.json) {
          outputJson(result);
        } else {
          console.log(chalk.bold("Cleanup complete:"));
          console.log(
            `  Expired removed:    ${chalk.red(String(result.expired))}`
          );
          console.log(
            `  Evicted (quota):    ${chalk.yellow(String(result.evicted))}`
          );
          console.log(
            `  Archived (stale):   ${chalk.gray(String(result.archived))}`
          );
          console.log(
            `  Archived (unused):  ${chalk.gray(String(result.unused_archived))}`
          );
          console.log(
            `  Deprioritized:      ${chalk.blue(String(result.deprioritized))}`
          );
        }
      } catch (e) {
        handleError(e);
      }
    });
}
