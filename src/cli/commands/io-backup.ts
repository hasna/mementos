import type { Command } from "commander";
import chalk from "chalk";
import { resolve, dirname } from "node:path";
import { existsSync, statSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { getDbPath } from "../../db/database.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerBackupCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("backup [path]")
    .description("Backup the SQLite database to a file")
    .option("--list", "List available backups in ~/.hasna/mementos/backups/")
    .action((targetPath: string | undefined, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
        const backupsDir = resolve(home, ".hasna", "mementos", "backups");

        // --list: show available backups
        if (opts.list) {
          if (!existsSync(backupsDir)) {
            if (globalOpts.json) {
              outputJson({ backups: [] });
              return;
            }
            console.log(chalk.yellow("No backups directory found."));
            return;
          }

          const files = readdirSync(backupsDir)
            .filter((f: string) => f.endsWith(".db"))
            .map((f: string) => {
              const filePath = resolve(backupsDir, f);
              const st = statSync(filePath);
              return { name: f, path: filePath, size: st.size, mtime: st.mtime };
            })
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

          if (files.length === 0) {
            if (globalOpts.json) {
              outputJson({ backups: [] });
              return;
            }
            console.log(chalk.yellow("No backups found."));
            return;
          }

          if (globalOpts.json) {
            outputJson({
              backups: files.map((f) => ({
                name: f.name,
                path: f.path,
                size: f.size,
                modified: f.mtime.toISOString(),
              })),
            });
            return;
          }

          console.log(chalk.bold(`Backups in ${backupsDir}:`));
          for (const f of files) {
            const date = f.mtime.toISOString().replace("T", " ").slice(0, 19);
            const sizeMB = (f.size / (1024 * 1024)).toFixed(1);
            const sizeStr = f.size >= 1024 * 1024 ? `${sizeMB} MB` : `${(f.size / 1024).toFixed(1)} KB`;
            console.log(`  ${chalk.dim(date)}  ${chalk.cyan(sizeStr.padStart(8))}  ${f.name}`);
          }
          return;
        }

        // Backup the database
        const dbPath = getDbPath();
        if (!existsSync(dbPath)) {
          console.error(chalk.red(`Database not found at ${dbPath}`));
          process.exit(1);
        }

        let dest: string;
        if (targetPath) {
          dest = resolve(targetPath);
        } else {
          if (!existsSync(backupsDir)) {
            mkdirSync(backupsDir, { recursive: true });
          }
          const now = new Date();
          const ts = now.toISOString().replace(/[-:T]/g, "").replace(/\..+/, "").slice(0, 15);
          dest = resolve(backupsDir, `mementos-${ts}.db`);
        }

        // Ensure destination directory exists
        const destDir = dirname(dest);
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }

        copyFileSync(dbPath, dest);
        const st = statSync(dest);
        const sizeMB = (st.size / (1024 * 1024)).toFixed(1);
        const sizeStr = st.size >= 1024 * 1024 ? `${sizeMB} MB` : `${(st.size / 1024).toFixed(1)} KB`;

        if (globalOpts.json) {
          outputJson({ backed_up_to: dest, size: st.size, source: dbPath });
          return;
        }
        console.log(`Backed up to: ${chalk.green(dest)} (size: ${sizeStr})`);
      } catch (e) {
        handleError(e);
      }
    });
}
