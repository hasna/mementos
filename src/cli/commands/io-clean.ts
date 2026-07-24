import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../lib/config.js";
import { runCleanup } from "../../lib/retention.js";
import { isApiMode, apiJson } from "../../db/api-mode.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

interface CleanupResult {
  expired: number;
  evicted: number;
  archived: number;
  unused_archived: number;
  deprioritized: number;
}

/**
 * Run cleanup server-side in API mode. Prefers the full retention sweep
 * (`/maintenance/cleanup`, expired + quotas + stale). Falls back to the legacy
 * expired-only endpoint (`/memories/clean`) when the server predates the full
 * endpoint (404), so a newer client stays usable against a not-yet-redeployed
 * server instead of crashing on an undefined result.
 */
function runCleanupViaApi(): CleanupResult {
  const empty: CleanupResult = { expired: 0, evicted: 0, archived: 0, unused_archived: 0, deprioritized: 0 };
  const { status, data } = apiJson<CleanupResult>("POST", "/maintenance/cleanup");
  if (status !== 404 && data) return { ...empty, ...data };
  // Legacy server: expired-only cleanup.
  const legacy = apiJson<{ cleaned: number }>("POST", "/memories/clean");
  return { ...empty, expired: legacy.data?.cleaned ?? 0 };
}

export function registerCleanCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("clean")
    .description("Remove expired memories and enforce quotas")
    .action(() => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        // In API mode, cleanup must run server-side against the shared cloud
        // store — opening a local SQLite DB here would be a split-brain island.
        // The server runs the identical runCleanup() over cloud Postgres.
        const result: CleanupResult = isApiMode()
          ? runCleanupViaApi()
          : runCleanup(loadConfig());

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
