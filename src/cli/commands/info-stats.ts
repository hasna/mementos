import type { Command } from "commander";
import chalk from "chalk";
import { getMemoryStats } from "../../db/analytics.js";
import type { MemoryCategory, MemoryScope } from "../../types/index.js";
import {
  outputJson,
  getOutputFormat,
  colorScope,
  colorCategory,
  makeHandleError,
} from "../helpers.js";

export function registerStatsCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("stats")
    .description("Show memory statistics")
    .option("--format <fmt>", "Output format: compact (default), json, csv, yaml")
    .action((opts) => {
      try {
        const stats = getMemoryStats();
        const byAgent = Object.entries(stats.by_agent).map(([agent_id, c]) => ({ agent_id, c }));

        const fmt = getOutputFormat(program, opts.format as string | undefined);

        if (fmt === "json") {
          outputJson(stats);
          return;
        }

        if (fmt === "yaml") {
          const { outputYaml } = require("../helpers.js") as typeof import("../helpers.js");
          outputYaml(stats);
          return;
        }

        if (fmt === "csv") {
          console.log("scope,category,count");
          for (const [scope, count] of Object.entries(stats.by_scope)) {
            console.log(`${scope},all,${count}`);
          }
          for (const [cat, count] of Object.entries(stats.by_category)) {
            console.log(`all,${cat},${count}`);
          }
          return;
        }

        // Compact format
        console.log(chalk.bold("\n  Memory Stats"));
        console.log(`  ${chalk.dim("Total:")}   ${chalk.white(String(stats.total))}`);
        console.log(`  ${chalk.dim("Pinned:")}  ${stats.pinned_count > 0 ? chalk.red(String(stats.pinned_count)) : "0"}`);
        console.log(`  ${chalk.dim("Expired:")} ${stats.expired_count > 0 ? chalk.yellow(String(stats.expired_count)) : "0"}`);
        console.log();
        console.log(chalk.bold("  By Scope"));
        for (const [scope, count] of Object.entries(stats.by_scope)) {
          const bar = "█".repeat(Math.min(count, 50));
          console.log(`  ${colorScope(scope as MemoryScope).padEnd(10)} ${count.toString().padStart(5)} ${chalk.dim(bar)}`);
        }
        console.log();
        console.log(chalk.bold("  By Category"));
        for (const [cat, count] of Object.entries(stats.by_category)) {
          const bar = "█".repeat(Math.min(count, 50));
          console.log(`  ${colorCategory(cat as MemoryCategory).padEnd(12)} ${count.toString().padStart(5)} ${chalk.dim(bar)}`);
        }
        if (byAgent.length > 0) {
          console.log();
          console.log(chalk.bold("  By Agent"));
          for (const { agent_id, c } of byAgent) {
            console.log(`  ${chalk.cyan(agent_id.padEnd(36))} ${c}`);
          }
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });
}
