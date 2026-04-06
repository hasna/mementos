import type { Command } from "commander";
import chalk from "chalk";
import { outputJson, makeHandleError } from "../helpers.js";
import type { GlobalOpts } from "../helpers.js";

export function registerToolsCommand(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // tool-events [tool_name]
  // ============================================================================

  program
    .command("tool-events [tool_name]")
    .description("List tool events, optionally filtered by tool name")
    .option("--limit <n>", "Max results (default: 20)", parseInt)
    .option("--project-id <id>", "Filter by project ID")
    .action((toolName: string | undefined, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const { getToolEvents } = require("../../db/tool-events.js") as typeof import("../../db/tool-events.js");
        const limit = (opts.limit as number | undefined) || 20;
        const events = getToolEvents({
          tool_name: toolName,
          project_id: opts.projectId as string | undefined,
          limit,
        });

        if (globalOpts.json) {
          outputJson(events);
          return;
        }

        if (events.length === 0) {
          console.log(chalk.yellow("No tool events found."));
          return;
        }

        console.log(chalk.bold(`${events.length} tool event${events.length === 1 ? "" : "s"}:`));
        // Table header
        console.log(
          `  ${chalk.dim("tool_name".padEnd(24))} ${chalk.dim("action".padEnd(16))} ${chalk.dim("success")} ${chalk.dim("error_type".padEnd(20))} ${chalk.dim("created_at")}`
        );
        for (const e of events) {
          const successStr = e.success ? chalk.green("true   ") : chalk.red("false  ");
          const errorType = (e.error_type || "").padEnd(20);
          const action = (e.action || "-").padEnd(16);
          console.log(
            `  ${e.tool_name.padEnd(24)} ${action} ${successStr} ${errorType} ${chalk.dim(e.created_at)}`
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // tool-insights <tool_name>
  // ============================================================================

  program
    .command("tool-insights <tool_name>")
    .description("Show tool guide/stats and lessons for a tool")
    .option("--project-id <id>", "Filter by project ID")
    .action((toolName: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const { getToolStats, getToolLessons } = require("../../db/tool-events.js") as typeof import("../../db/tool-events.js");
        const projectId = opts.projectId as string | undefined;
        const stats = getToolStats(toolName, projectId);
        const lessons = getToolLessons(toolName, projectId);

        if (globalOpts.json) {
          outputJson({ stats, lessons });
          return;
        }

        // Stats line
        const successRate = (stats.success_rate * 100).toFixed(1);
        console.log(chalk.bold(`Tool: ${toolName}`));
        console.log(
          `  Calls: ${stats.total_calls}  Success: ${chalk.green(String(stats.success_count))}  Failures: ${chalk.red(String(stats.failure_count))}  Rate: ${successRate}%` +
          (stats.avg_latency_ms !== null ? `  Avg latency: ${stats.avg_latency_ms.toFixed(0)}ms` : "") +
          (stats.last_used ? `  Last used: ${chalk.dim(stats.last_used)}` : "")
        );

        if (stats.common_errors.length > 0) {
          console.log(chalk.bold("\n  Common errors:"));
          for (const err of stats.common_errors) {
            console.log(`    ${chalk.red(err.error_type)}: ${err.count} times`);
          }
        }

        if (lessons.length === 0) {
          console.log(chalk.dim("\n  No lessons recorded."));
          return;
        }

        console.log(chalk.bold(`\n  Lessons (${lessons.length}):`));
        for (const l of lessons) {
          console.log(`    ${chalk.cyan("-")} ${l.lesson} ${chalk.dim(`(${l.created_at.slice(0, 10)})`)}`);
          if (l.when_to_use) {
            console.log(`      ${chalk.dim("when_to_use:")} ${l.when_to_use}`);
          }
        }
      } catch (e) {
        handleError(e);
      }
    });
}
