import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../../db/database.js";
import type { MemoryCategory, MemoryScope, MemoryStats } from "../../types/index.js";
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
        const db = getDatabase();

        const total = (
          db
            .query(
              "SELECT COUNT(*) as c FROM memories WHERE status = 'active'"
            )
            .get() as { c: number }
        ).c;

        const byScope = db
          .query(
            "SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope"
          )
          .all() as { scope: MemoryScope; c: number }[];

        const byCategory = db
          .query(
            "SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category"
          )
          .all() as { category: MemoryCategory; c: number }[];

        const byStatus = db
          .query(
            "SELECT status, COUNT(*) as c FROM memories GROUP BY status"
          )
          .all() as { status: string; c: number }[];

        const pinnedCount = (
          db
            .query(
              "SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'"
            )
            .get() as { c: number }
        ).c;

        const expiredCount = (
          db
            .query(
              "SELECT COUNT(*) as c FROM memories WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < datetime('now'))"
            )
            .get() as { c: number }
        ).c;

        const byAgent = db
          .query(
            "SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL GROUP BY agent_id"
          )
          .all() as { agent_id: string; c: number }[];

        const stats: MemoryStats = {
          total,
          by_scope: { global: 0, shared: 0, private: 0, working: 0 },
          by_category: {
            preference: 0,
            fact: 0,
            knowledge: 0,
            history: 0,
            procedural: 0,
            resource: 0,
          },
          by_status: { active: 0, archived: 0, expired: 0 },
          by_agent: {},
          pinned_count: pinnedCount,
          expired_count: expiredCount,
        };

        for (const row of byScope) {
          if (row.scope in stats.by_scope) {
            stats.by_scope[row.scope as MemoryScope] = row.c;
          }
        }

        for (const row of byCategory) {
          if (row.category in stats.by_category) {
            stats.by_category[row.category as keyof typeof stats.by_category] = row.c;
          }
        }

        for (const row of byStatus) {
          if (row.status in stats.by_status) {
            stats.by_status[row.status as keyof typeof stats.by_status] = row.c;
          }
        }

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
