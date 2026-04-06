import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import {
  getMemory,
  getMemoryByKey,
  getMemoryVersions,
  touchMemory,
  updateMemory,
} from "../../db/memories.js";
import type { MemoryScope } from "../../types/index.js";
import {
  outputJson,
  formatMemoryDetail,
  makeHandleError,
  resolveKeyOrId,
  resolveMemoryId,
  type GlobalOpts,
} from "../helpers.js";

export function registerViewCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // show <id>
  // ============================================================================

  program
    .command("show <id>")
    .description("Show full detail of a memory by ID (supports partial IDs)")
    .action((id: string) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const resolvedId = resolveMemoryId(id);
        const memory = getMemory(resolvedId);

        if (!memory) {
          if (globalOpts.json) {
            outputJson({ error: `Memory not found: ${id}` });
          } else {
            console.error(chalk.red(`Memory not found: ${id}`));
          }
          process.exit(1);
        }

        touchMemory(memory.id);

        if (globalOpts.json) {
          outputJson(memory);
        } else {
          console.log(formatMemoryDetail(memory));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // pin <keyOrId>
  // ============================================================================

  program
    .command("pin <keyOrId>")
    .description("Pin a memory by key or partial ID")
    .option("-s, --scope <scope>", "Scope filter for key lookup")
    .option("--agent <name>", "Agent filter for key lookup")
    .option("--project <path>", "Project filter for key lookup")
    .action((keyOrId: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const memory = resolveKeyOrId(keyOrId, opts, globalOpts);
        if (!memory) {
          if (globalOpts.json) {
            outputJson({ error: `No memory found: ${keyOrId}` });
          } else {
            console.error(chalk.red(`No memory found: ${keyOrId}`));
          }
          process.exit(1);
        }

        const updated = updateMemory(memory.id, {
          version: memory.version,
          pinned: true,
        });

        if (globalOpts.json) {
          outputJson(updated);
        } else {
          console.log(chalk.green(`Pinned: ${updated.key} (${updated.id.slice(0, 8)})`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // unpin <keyOrId>
  // ============================================================================

  program
    .command("unpin <keyOrId>")
    .description("Unpin a memory by key or partial ID")
    .option("-s, --scope <scope>", "Scope filter for key lookup")
    .option("--agent <name>", "Agent filter for key lookup")
    .option("--project <path>", "Project filter for key lookup")
    .action((keyOrId: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const memory = resolveKeyOrId(keyOrId, opts, globalOpts);
        if (!memory) {
          if (globalOpts.json) {
            outputJson({ error: `No memory found: ${keyOrId}` });
          } else {
            console.error(chalk.red(`No memory found: ${keyOrId}`));
          }
          process.exit(1);
        }

        const updated = updateMemory(memory.id, {
          version: memory.version,
          pinned: false,
        });

        if (globalOpts.json) {
          outputJson(updated);
        } else {
          console.log(chalk.green(`Unpinned: ${updated.key} (${updated.id.slice(0, 8)})`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // archive <keyOrId>
  // ============================================================================

  program
    .command("archive <keyOrId>")
    .description("Archive a memory by key or ID (hides from lists, keeps history)")
    .option("-s, --scope <scope>", "Scope filter for key lookup")
    .action((keyOrId: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        // Try by ID first, then by key
        let memory = getMemory(resolvePartialId(getDatabase(), "memories", keyOrId) || keyOrId)
          || getMemoryByKey(keyOrId, opts.scope as MemoryScope | undefined, globalOpts.agent);
        if (!memory) {
          console.error(chalk.red(`No memory found: ${keyOrId}`));
          process.exit(1);
        }
        updateMemory(memory.id, { status: "archived", version: memory.version });
        if (globalOpts.json) {
          outputJson({ archived: true, id: memory.id, key: memory.key });
        } else {
          console.log(chalk.green(`✓ Archived: ${chalk.bold(memory.key)} (${memory.id.slice(0, 8)})`));
        }
      } catch (e) {
        console.error(chalk.red(`archive failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  // ============================================================================
  // versions <keyOrId>
  // ============================================================================

  program
    .command("versions <keyOrId>")
    .description("Show version history for a memory")
    .option("-s, --scope <scope>", "Scope filter for key lookup")
    .action((keyOrId: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        let memory = getMemory(resolvePartialId(getDatabase(), "memories", keyOrId) || keyOrId)
          || getMemoryByKey(keyOrId, opts.scope as MemoryScope | undefined, globalOpts.agent);
        if (!memory) {
          console.error(chalk.red(`No memory found: ${keyOrId}`));
          process.exit(1);
        }
        const versions = getMemoryVersions(memory.id);
        if (globalOpts.json) {
          outputJson({ memory: { id: memory.id, key: memory.key, current_version: memory.version }, versions });
          return;
        }
        console.log(chalk.bold(`\nVersion history: ${memory.key} (current: v${memory.version})\n`));
        if (versions.length === 0) {
          console.log(chalk.dim("  No previous versions."));
          return;
        }
        for (const v of versions) {
          console.log(`  ${chalk.cyan(`v${v.version}`)} ${chalk.dim(v.created_at.slice(0, 16))} scope=${v.scope} imp=${v.importance}`);
          console.log(`    ${v.value.slice(0, 120)}${v.value.length > 120 ? "..." : ""}`);
        }
        console.log("");
      } catch (e) {
        console.error(chalk.red(`versions failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
