import type { Command } from "commander";
import chalk from "chalk";
import { getStorageConfig, getStorageConnectionString } from "../../storage.js";
import { getStorageSyncStatus, pullStorageChanges, pushStorageChanges } from "../../lib/storage-sync.js";
import { getDatabase } from "../../db/database.js";

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
  storage
    .command("status")
    .description("Show local database and remote storage sync status")
    .option("--json", "Output JSON")
    .action((opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      const status = getStorageSyncStatus();
      const config = getStorageConfig();
      if (useJson) {
        outputJson(true, { ...status, config });
        return;
      }

      console.log(`Mode: ${status.mode}`);
      console.log(`Enabled: ${status.enabled ? "yes" : "no"}`);
      console.log(`Database: ${status.db_path}`);
      console.log(`Machine: ${status.current_machine_id ?? "(not registered)"}`);
      console.log(`Remote host: ${config.rds.host || "(not configured)"}`);
      console.log(`Generic sync tables: ${status.generic_sync_meta.length}`);
      console.log(`Memory sync tables: ${status.memory_sync_meta.length}`);
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
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      try {
        const connectionString = opts.connectionString || getStorageConnectionString("mementos");
        const { applyPgMigrations } = await import("../../db/pg-migrate.js");
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
    .description("Save feedback locally")
    .argument("<message>", "Feedback message")
    .option("--email <email>", "Contact email")
    .option("--category <category>", "Feedback category", "general")
    .option("--json", "Output JSON")
    .action((message: string, opts) => {
      const useJson = Boolean(opts.json || program.opts().json);
      try {
        const db = getDatabase();
        const version = "mementos";
        db.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          message,
          opts.email || null,
          opts.category || "general",
          version
        );
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
    .description("Manage mementos local/remote storage sync");
  installStorageSubcommands(storage, program);
}
