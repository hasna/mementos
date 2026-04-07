/**
 * Info commands have been split into separate modules:
 * - info-stats.ts: stats command
 * - info-report.ts: report command
 * - info-stale.ts: stale command
 * - info-history.ts: history command
 * - info-context.ts: context command
 * This stub remains for backwards compatibility with any code that imports from this module.
 */
import type { Command } from "commander";
import { registerStatsCommand } from "./info-stats.js";
import { registerReportCommand } from "./info-report.js";
import { registerStaleCommand } from "./info-stale.js";
import { registerHistoryCommand } from "./info-history.js";
import { registerContextCommand } from "./info-context.js";

export function registerInfoCommands(program: Command): void {
  registerStatsCommand(program);
  registerReportCommand(program);
  registerStaleCommand(program);
  registerHistoryCommand(program);
  registerContextCommand(program);
}
