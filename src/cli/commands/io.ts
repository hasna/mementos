import type { Command } from "commander";
import chalk from "chalk";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { getDatabase, getDbPath } from "../../db/database.js";
import { createMemory, listMemories } from "../../db/memories.js";
import { getProject } from "../../db/projects.js";
import { loadConfig } from "../../lib/config.js";
import { runCleanup } from "../../lib/retention.js";
import type {
  MemoryCategory,
  MemoryScope,
  MemoryFilter,
  CreateMemoryInput,
} from "../../types/index.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerIoCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // export
  // ============================================================================

  program
    .command("export")
    .description("Export memories as JSON")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-c, --category <cat>", "Category filter")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath =
          (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const filter: MemoryFilter = {
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as MemoryCategory | undefined,
          agent_id: agentId,
          project_id: projectId,
          limit: 10000,
        };

        const memories = listMemories(filter);

        // Export always outputs JSON
        outputJson(memories);
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // import <file>
  // ============================================================================

  program
    .command("import [file]")
    .description("Import memories from a JSON file or stdin (use '-' or pipe data)")
    .option("--overwrite", "Overwrite existing memories (default: merge)")
    .action(async (file: string | undefined, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        let raw: string;
        if (file === "-" || (!file && !process.stdin.isTTY)) {
          raw = await Bun.stdin.text();
        } else if (file) {
          raw = readFileSync(resolve(file), "utf-8");
        } else {
          console.error(chalk.red("No input: provide a file path, use '-' for stdin, or pipe data."));
          process.exit(1);
        }
        const memories = JSON.parse(raw) as CreateMemoryInput[];

        if (!Array.isArray(memories)) {
          throw new Error("JSON file must contain an array of memories");
        }

        const dedupeMode = opts.overwrite ? ("create" as const) : ("merge" as const);
        let imported = 0;

        for (const mem of memories) {
          createMemory(
            { ...mem, source: mem.source || "imported" },
            dedupeMode
          );
          imported++;
        }

        if (globalOpts.json) {
          outputJson({ imported });
        } else {
          console.log(
            chalk.green(
              `Imported ${imported} memor${imported === 1 ? "y" : "ies"}.`
            )
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // clean
  // ============================================================================

  program
    .command("clean")
    .description("Remove expired memories and enforce quotas")
    .action(() => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const config = loadConfig();
        const result = runCleanup(config);

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

  // ============================================================================
  // backup [path]
  // ============================================================================

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

  // ============================================================================
  // restore [file]
  // ============================================================================

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
          const { resetDatabase } = require("../../db/database.js");
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
