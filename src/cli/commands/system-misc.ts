import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../../db/database.js";

export function registerMiscCommands(program: Command): void {

  // ============================================================================
  // migrate-pg command
  // ============================================================================

  program
    .command("migrate-pg")
    .description("Apply PostgreSQL migrations to the configured RDS instance")
    .option("--connection-string <url>", "PostgreSQL connection string (overrides cloud config)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const globalOpts = program.opts();
      const useJson = opts.json || globalOpts.json;

      let connStr: string;
      if (opts.connectionString) {
        connStr = opts.connectionString;
      } else {
        try {
          const { getConnectionString } = await import("@hasna/cloud");
          connStr = getConnectionString("mementos");
        } catch {
          const msg = "Cloud RDS not configured. Use --connection-string or run `cloud setup`.";
          if (useJson) {
            console.log(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(msg));
          }
          process.exit(1);
        }
      }

      try {
        const { applyPgMigrations } = await import("../../db/pg-migrate.js");
        const result = await applyPgMigrations(connStr);

        if (useJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.applied.length > 0) {
          console.log(chalk.green(`Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`));
        }
        if (result.alreadyApplied.length > 0) {
          console.log(chalk.dim(`Already applied: ${result.alreadyApplied.length} migration(s)`));
        }
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            console.error(chalk.red(`  Error: ${err}`));
          }
          process.exit(1);
        }
        if (result.applied.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("Schema is up to date."));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (useJson) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red(`Migration failed: ${msg}`));
        }
        process.exit(1);
      }
    });

  // ============================================================================
  // feedback command
  // ============================================================================

  program
    .command("feedback")
    .description("Send feedback about mementos")
    .argument("<message>", "Feedback message")
    .option("--email <email>", "Your email (optional)")
    .option("--category <category>", "Category: bug, feature, general", "general")
    .action(async (message: string, opts) => {
      try {
        const db = getDatabase();
        const { fileURLToPath: _ftu } = await import("node:url");
        const { dirname: _dir, join: _join } = await import("node:path");
        const { readFileSync: _rfs } = await import("node:fs");
        const pkg = JSON.parse(_rfs(_join(_dir(_ftu(import.meta.url)), "../../package.json"), "utf-8"));
        db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
          message, opts.email || null, opts.category || "general", pkg.version,
        ]);
        console.log(chalk.green("Feedback saved. Thank you!"));
      } catch (e) {
        console.error(chalk.red(`Failed to save feedback: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
