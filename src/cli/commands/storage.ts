import type { Command } from "commander";
import chalk from "chalk";
import {
  getSafeStorageConfigSummary,
  getStorageConfig,
  getStorageConnectionString,
  getStorageStatus,
} from "../../storage.js";
import { getStorageSyncStatus, pullStorageChanges, pushStorageChanges } from "../../lib/storage-sync.js";
import { resolveStoreBackend } from "../../db/store-backend.js";
import { withoutStartupDbAccess } from "../startup-side-effects.js";

function parseTables(raw?: string): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const tables = raw
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);
  return tables.length > 0 ? tables : undefined;
}

function outputJson(enabled: boolean, value: unknown): void {
  if (enabled) {
    console.log(JSON.stringify(value, null, 2));
  }
}

function printSyncResult(result: ReturnType<typeof pushStorageChanges>): void {
  const summary = `${result.direction} synced ${result.total_synced} row(s) across ${result.tables.length} table(s)`;
  console.log(result.errors.length > 0 ? chalk.yellow(summary) : chalk.green(summary));
  for (const table of result.tables) {
    console.log(
      `${table.table}: ${table.synced_rows} synced, ${table.skipped_rows} skipped, ${table.conflicts} conflicts`
    );
    for (const error of table.errors) {
      console.error(chalk.red(`  ${error}`));
    }
  }
}

function installStorageSubcommands(storage: Command, program: Command): void {
  // `storage mode` answers one question — which store will this process actually
  // read and write? — from the environment alone: no database is opened, no HTTP
  // request is made, and no credential value is printed. `storage status` cannot
  // serve that purpose because it opens the local database, which FAILS CLOSED
  // in API mode (src/db/database.ts getDatabase), so it cannot report the very
  // state an operator most needs to see. Test harnesses use this to prove they
  // are isolated before writing anything.
  // Opted out of the global startup DB access (src/cli/index.tsx `preAction`),
  // which would otherwise CREATE and migrate the SQLite file this command only
  // means to name — defeating the point of a side-effect-free probe.
  withoutStartupDbAccess(
    storage
      .command("mode")
      .description("Show which store this process will actually read and write (no DB or network access)")
      .option("--json", "Output JSON")
      .action((opts) => {
        const useJson = Boolean(opts.json || program.opts().json);
        let report: ReturnType<typeof resolveStoreBackend>;
        try {
          report = resolveStoreBackend();
        } catch (error) {
          // A misconfigured storage mode makes this command throw — and this is
          // the ONE command an operator runs precisely because they are unsure
          // which store they are on. Handing them a Bun stack trace here buries
          // the one line that names the variable and the bad value. Every other
          // command already surfaces this cleanly; `mode` opted out of the
          // global preAction wrapper, so it needs its own.
          const message = error instanceof Error ? error.message : String(error);
          // Note the local `outputJson(enabled, value)` here takes a GATE as its
          // first argument, not a success flag — passing `false` prints nothing.
          if (useJson) outputJson(true, { ok: false, error: message });
          else console.error(chalk.red(message));
          process.exitCode = 1;
          return;
        }
        if (useJson) {
          outputJson(true, report);
          return;
        }

        const label =
          report.backend === "local-sqlite"
            ? chalk.green(report.backend)
            : chalk.yellow(report.backend);
        console.log(`Backend: ${label}`);
        console.log(`Selected by: ${report.selected_by}`);
        console.log(`API mode: ${report.api_mode ? "yes" : "no"}`);
        console.log(`Storage mode: ${report.storage_mode}`);
        if (report.backend === "local-sqlite") {
          console.log(`Database: ${report.db_path}`);
        } else {
          console.log(`API endpoint: ${report.api_endpoint ?? "(none)"}`);
          console.log(`API key: ${report.api_key_present ? "configured" : "not configured"}`);
          console.log(`Local SQLite (not authoritative): ${report.db_path}`);
        }
      }),
  );

  storage
    .command("status")
    .description("Show local database, legacy sync, and storage runtime status")
    .option("--json", "Output JSON")
    .action((opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      const status = getStorageSyncStatus();
      const config = getStorageConfig();
      const runtime = getStorageStatus();
      const safeConfig = getSafeStorageConfigSummary(config);
      if (useJson) {
        outputJson(true, { ...status, runtime, config: safeConfig });
        return;
      }

      console.log(`Mode: ${status.mode}`);
      console.log(`Enabled: ${status.enabled ? "yes" : "no"}`);
      console.log(`Runtime: ${runtime.runtime.kind}`);
      console.log(`Database: ${status.db_path}`);
      console.log(`Machine: ${status.current_machine_id ?? "(not registered)"}`);
      console.log(`Local SQLite: ${runtime.runtime.local.primary_runtime ? "primary runtime" : "disabled"}`);
      console.log(`Local file sync: unsupported`);
      console.log(`Remote PostgreSQL/RDS: ${runtime.runtime.remote.configured ? "configured" : "not configured"}`);
      console.log(`Remote source: ${runtime.runtime.remote.source}`);
      console.log(`S3/AWS mutation: unsupported`);
      console.log(`Generic sync tables: ${status.generic_sync_meta.length}`);
      console.log(`Memory sync tables: ${status.memory_sync_meta.length}`);
      for (const issue of runtime.issues) {
        console.error(chalk.red(`Issue: ${issue}`));
      }
      for (const warning of runtime.warnings) {
        console.error(chalk.yellow(`Warning: ${warning}`));
      }
    });

  storage
    .command("push")
    .description("Push local rows to the remote PostgreSQL database")
    .option("--tables <tables>", "Comma-separated tables to sync")
    .option("--json", "Output JSON")
    .action((opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      try {
        const result = pushStorageChanges({ tables: parseTables(opts.tables) });
        if (useJson) {
          outputJson(true, result);
          return;
        }
        printSyncResult(result);
        if (result.errors.length > 0) {
          process.exitCode = 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (useJson) {
          outputJson(true, { error: message });
        } else {
          console.error(chalk.red(message));
        }
        process.exitCode = 1;
      }
    });

  storage
    .command("pull")
    .description("Pull remote PostgreSQL rows into the local database")
    .option("--tables <tables>", "Comma-separated tables to sync")
    .option("--json", "Output JSON")
    .action((opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      try {
        const result = pullStorageChanges({ tables: parseTables(opts.tables) });
        if (useJson) {
          outputJson(true, result);
          return;
        }
        printSyncResult(result);
        if (result.errors.length > 0) {
          process.exitCode = 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (useJson) {
          outputJson(true, { error: message });
        } else {
          console.error(chalk.red(message));
        }
        process.exitCode = 1;
      }
    });

  storage
    .command("sync")
    .description("Push local changes, then pull remote changes")
    .option("--tables <tables>", "Comma-separated tables to sync")
    .option("--json", "Output JSON")
    .action((opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      try {
        const tables = parseTables(opts.tables);
        const push = pushStorageChanges({ tables });
        const pull = pullStorageChanges({ tables });
        if (useJson) {
          outputJson(true, { push, pull });
          return;
        }
        printSyncResult(push);
        printSyncResult(pull);
        if (push.errors.length > 0 || pull.errors.length > 0) {
          process.exitCode = 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (useJson) {
          outputJson(true, { error: message });
        } else {
          console.error(chalk.red(message));
        }
        process.exitCode = 1;
      }
    });

  storage
    .command("migrate")
    .description("Apply PostgreSQL migrations to the remote database")
    .option("--connection-string <url>", "PostgreSQL connection string")
    .option("--dry-run", "Print safe PostgreSQL/RDS migration diagnostics without connecting")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      try {
        const { applyPgMigrations, getPgMigrationDiagnostics } = await import("../../db/pg-migrate.js");
        if (opts.dryRun) {
          const diagnostics = getPgMigrationDiagnostics(opts.connectionString);
          if (useJson) {
            outputJson(true, diagnostics);
            if (!diagnostics.ok) {
              process.exitCode = 1;
            }
            return;
          }
          console.log(`Target: ${diagnostics.target}`);
          console.log(`Configured: ${diagnostics.configured ? "yes" : "no"}`);
          console.log(`Total migrations: ${diagnostics.total_migrations}`);
          console.log("Network: not contacted");
          console.log("Production approval: required before live apply");
          for (const issue of diagnostics.issues) {
            console.error(chalk.red(`Issue: ${issue}`));
          }
          for (const warning of diagnostics.warnings) {
            console.error(chalk.yellow(`Warning: ${warning}`));
          }
          if (!diagnostics.ok) {
            process.exitCode = 1;
          }
          return;
        }

        const connectionString = opts.connectionString || getStorageConnectionString("mementos");
        const result = await applyPgMigrations(connectionString);
        if (useJson) {
          outputJson(true, result);
          return;
        }
        if (result.applied.length > 0) {
          console.log(chalk.green(`Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`));
        }
        if (result.alreadyApplied.length > 0) {
          console.log(chalk.dim(`Already applied: ${result.alreadyApplied.length} migration(s)`));
        }
        if (result.errors.length > 0) {
          for (const error of result.errors) {
            console.error(chalk.red(error));
          }
          process.exitCode = 1;
        } else if (result.applied.length === 0) {
          console.log(chalk.dim("Schema is up to date."));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (useJson) {
          outputJson(true, { error: message });
        } else {
          console.error(chalk.red(message));
        }
        process.exitCode = 1;
      }
    });

  storage
    .command("feedback")
    .description("Save feedback to the selected store")
    .argument("<message>", "Feedback message")
    .option("--email <email>", "Contact email")
    .option("--category <category>", "Feedback category", "general")
    .option("--json", "Output JSON")
    .action((message: string, opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      try {
        // Route through the Store (api mode → POST /feedback; local → SQLite);
        // never open the DB directly, which would fail-close in api mode.
        const { saveFeedback } = require("../../db/feedback.js") as typeof import("../../db/feedback.js");
        saveFeedback({
          message,
          email: opts.email || null,
          category: opts.category || "general",
          version: "mementos",
        });
        if (useJson) {
          outputJson(true, { saved: true });
        } else {
          console.log(chalk.green("Feedback saved."));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (useJson) {
          outputJson(true, { error: errorMessage });
        } else {
          console.error(chalk.red(errorMessage));
        }
        process.exitCode = 1;
      }
    });
}

export function registerStorageCommands(program: Command): void {
  const storage = program
    .command("storage")
    .description("Inspect storage and manage migrations or legacy row sync");
  installStorageSubcommands(storage, program);
}
