import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { existsSync, statSync, copyFileSync, readdirSync } from "node:fs";
import { getDatabase, getDbPath, resetDatabase } from "../../db/database.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerRestoreCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("restore [file]")
    .description("Restore the database from a backup file")
    .option("--latest", "Restore the most recent backup from ~/.hasna/mementos/backups/")
    .option("--force", "Skip confirmation and perform the restore")
    .action((filePath: string | undefined, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
        const backupsDir = resolve(home, ".hasna", "mementos", "backups");

        let source: string;

        if (opts.latest) {
          if (!existsSync(backupsDir)) {
            console.error(chalk.red("No backups directory found."));
            process.exit(1);
          }
          const files = readdirSync(backupsDir)
            .filter((f: string) => f.endsWith(".db"))
            .map((f: string) => {
              const fp = resolve(backupsDir, f);
              const st = statSync(fp);
              return { path: fp, mtime: st.mtime };
            })
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

          if (files.length === 0) {
            console.error(chalk.red("No backups found in " + backupsDir));
            process.exit(1);
          }
          source = files[0]!.path;
        } else if (filePath) {
          source = resolve(filePath);
        } else {
          console.error(chalk.red("Provide a backup file path or use --latest"));
          process.exit(1);
        }

        if (!existsSync(source)) {
          console.error(chalk.red(`Backup file not found: ${source}`));
          process.exit(1);
        }

        const dbPath = getDbPath();
        const backupStat = statSync(source);
        const backupSizeMB = (backupStat.size / (1024 * 1024)).toFixed(1);
        const backupSizeStr = backupStat.size >= 1024 * 1024 ? `${backupSizeMB} MB` : `${(backupStat.size / 1024).toFixed(1)} KB`;

        // Get current DB memory count
        let currentCount = 0;
        if (existsSync(dbPath)) {
          try {
            const db = getDatabase();
            const row = db.query("SELECT COUNT(*) as count FROM memories").get() as { count: number } | null;
            currentCount = row?.count ?? 0;
          } catch {
            // DB might be corrupted, that's ok
          }
        }

        // Get backup memory count by opening it temporarily
        let backupCount = 0;
        try {
          const { Database } = require("bun:sqlite");
          const backupDb = new Database(source, { readonly: true });
          const row = backupDb.query("SELECT COUNT(*) as count FROM memories").get() as { count: number } | null;
          backupCount = row?.count ?? 0;
          backupDb.close();
        } catch {
          // Can't read backup stats, that's ok
        }

        if (!opts.force) {
          if (globalOpts.json) {
            outputJson({
              action: "restore",
              source,
              target: dbPath,
              backup_size: backupStat.size,
              current_memories: currentCount,
              backup_memories: backupCount,
              status: "dry_run",
              message: "Use --force to confirm restore",
            });
            return;
          }
          console.log(chalk.bold("Restore preview:"));
          console.log(`  Source:           ${chalk.cyan(source)} (${backupSizeStr})`);
          console.log(`  Target:           ${chalk.cyan(dbPath)}`);
          console.log(`  Current memories: ${chalk.yellow(String(currentCount))}`);
          console.log(`  Backup memories:  ${chalk.green(String(backupCount))}`);
          console.log();
          console.log(chalk.yellow("Use --force to confirm restore"));
          return;
        }

        // Perform the restore
        copyFileSync(source, dbPath);

        // Verify restored DB
        let newCount = 0;
        try {
          // Reset the singleton so getDatabase re-opens
          resetDatabase();
          const db = getDatabase();
          const row = db.query("SELECT COUNT(*) as count FROM memories").get() as { count: number } | null;
          newCount = row?.count ?? 0;
        } catch {
          // Just report what we can
        }

        if (globalOpts.json) {
          outputJson({
            action: "restore",
            source,
            target: dbPath,
            previous_memories: currentCount,
            restored_memories: newCount,
            status: "completed",
          });
          return;
        }

        console.log(`Restored from: ${chalk.green(source)}`);
        console.log(`  Previous memories: ${chalk.yellow(String(currentCount))}`);
        console.log(`  Restored memories: ${chalk.green(String(newCount))}`);
      } catch (e) {
        handleError(e);
      }
    });
}
