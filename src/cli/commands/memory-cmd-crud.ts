import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import {
  createMemory,
  getMemory,
  getMemoriesByKey,
  updateMemory,
  deleteMemory,
} from "../../db/memories.js";
import { getProject } from "../../db/projects.js";
import { getAgent } from "../../db/agents.js";
import { parseDuration } from "../../lib/duration.js";
import type {
  MemoryCategory,
  MemoryScope,
  MemoryStatus,
  MemorySource,
  CreateMemoryInput,
} from "../../types/index.js";
import {
  outputJson,
  makeHandleError,
  resolveMemoryId,
  type GlobalOpts,
} from "../helpers.js";

export function registerCrudCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // save <key> <value>
  // ============================================================================

  program
    .command("save <key> <value>")
    .description("Save a memory (create or upsert)")
    .option("-c, --category <cat>", "Category: preference, fact, knowledge, history")
    .option("-s, --scope <scope>", "Scope: global, shared, private")
    .option("--importance <n>", "Importance 1-10", parseInt)
    .option("--tags <tags>", "Comma-separated tags")
    .option("--summary <text>", "Brief summary")
    .option("--ttl <duration>", "Time-to-live: 30s, 5m, 2h, 1d, 1w, or milliseconds")
    .option("--source <src>", "Source: user, agent, system, auto, imported")
    .option(
      "--template <name>",
      "Apply a template: correction, preference, decision, learning"
    )
    .action((key: string, value: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();

        // Template defaults — explicit flags override template values
        const templates: Record<
          string,
          {
            scope: MemoryScope;
            category: MemoryCategory;
            importance: number;
            tags: string[];
          }
        > = {
          correction: {
            scope: "shared",
            category: "knowledge",
            importance: 9,
            tags: ["correction"],
          },
          preference: {
            scope: "global",
            category: "preference",
            importance: 8,
            tags: [],
          },
          decision: {
            scope: "shared",
            category: "fact",
            importance: 8,
            tags: ["decision"],
          },
          learning: {
            scope: "shared",
            category: "knowledge",
            importance: 7,
            tags: ["learning"],
          },
        };

        let templateDefaults:
          | {
              scope: MemoryScope;
              category: MemoryCategory;
              importance: number;
              tags: string[];
            }
          | undefined;
        if (opts.template) {
          const tpl = templates[opts.template as string];
          if (!tpl) {
            console.error(
              chalk.red(
                `Unknown template: ${opts.template}. Valid templates: ${Object.keys(templates).join(", ")}`
              )
            );
            process.exit(1);
          }
          templateDefaults = tpl;
        }

        const explicitTags = opts.tags
          ? (opts.tags as string).split(",").map((t: string) => t.trim())
          : undefined;

        // Merge: explicit flags > template defaults > undefined
        const mergedTags = explicitTags
          ? explicitTags
          : templateDefaults?.tags && templateDefaults.tags.length > 0
            ? templateDefaults.tags
            : undefined;

        // Resolve agent name/partial-id → actual agent ID (avoids FK violation)
        let resolvedAgentId: string | undefined;
        if (globalOpts.agent) {
          const ag = getAgent(globalOpts.agent);
          resolvedAgentId = ag?.id; // undefined if agent not found — don't store unresolvable IDs
        }

        const input: CreateMemoryInput = {
          key,
          value,
          category:
            (opts.category as MemoryCategory | undefined) ??
            templateDefaults?.category,
          scope:
            (opts.scope as MemoryScope | undefined) ?? templateDefaults?.scope,
          importance:
            (opts.importance as number | undefined) ??
            templateDefaults?.importance,
          tags: mergedTags,
          summary: opts.summary as string | undefined,
          ttl_ms: opts.ttl ? parseDuration(opts.ttl) : undefined,
          source: opts.source as MemorySource | undefined,
          agent_id: resolvedAgentId,
          session_id: globalOpts.session,
        };

        // Resolve project from --project path
        if (globalOpts.project) {
          const project = getProject(resolve(globalOpts.project));
          if (project) input.project_id = project.id;
        }

        const memory = createMemory(input);

        if (globalOpts.json) {
          outputJson(memory);
        } else {
          console.log(chalk.green(`Saved: ${memory.key} (${memory.id.slice(0, 8)})`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // update <id>
  // ============================================================================

  program
    .command("update <id>")
    .description("Update a memory by ID")
    .option("--value <text>", "New value")
    .option("--importance <n>", "New importance 1-10", parseInt)
    .option("--tags <tags>", "New comma-separated tags")
    .option("--summary <text>", "New summary")
    .option("--pin", "Pin the memory")
    .option("--unpin", "Unpin the memory")
    .option("-c, --category <cat>", "New category")
    .option("-s, --scope <scope>", "New scope")
    .option("--status <status>", "New status: active, archived, expired")
    .action((id: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const resolvedId = resolveMemoryId(id);
        const existing = getMemory(resolvedId);
        if (!existing) {
          if (globalOpts.json) {
            outputJson({ error: `Memory not found: ${id}` });
          } else {
            console.error(chalk.red(`Memory not found: ${id}`));
          }
          process.exit(1);
        }

        const updateInput: {
          version: number;
          value?: string;
          importance?: number;
          tags?: string[];
          summary?: string | null;
          pinned?: boolean;
          category?: MemoryCategory;
          scope?: MemoryScope;
          status?: MemoryStatus;
        } = {
          version: existing.version,
        };

        if (opts.value !== undefined)
          updateInput.value = opts.value as string;
        if (opts.importance !== undefined)
          updateInput.importance = opts.importance as number;
        if (opts.tags !== undefined)
          updateInput.tags = (opts.tags as string)
            .split(",")
            .map((t: string) => t.trim());
        if (opts.summary !== undefined)
          updateInput.summary = opts.summary as string;
        if (opts.pin) updateInput.pinned = true;
        if (opts.unpin) updateInput.pinned = false;
        if (opts.category !== undefined)
          updateInput.category = opts.category as MemoryCategory;
        if (opts.scope !== undefined)
          updateInput.scope = opts.scope as MemoryScope;
        if (opts.status !== undefined)
          updateInput.status = opts.status as MemoryStatus;

        const updated = updateMemory(resolvedId, updateInput);

        if (globalOpts.json) {
          outputJson(updated);
        } else {
          console.log(chalk.green(`Updated: ${updated.key} (${updated.id.slice(0, 8)})`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // forget <key-or-id>
  // ============================================================================

  program
    .command("forget <keyOrId>")
    .description("Delete a memory by key or ID")
    .option("-s, --scope <scope>", "Filter by scope (global, shared, private)")
    .option("-a, --agent <agent>", "Filter by agent ID")
    .option("-p, --project <project>", "Filter by project ID")
    .option("--all", "Delete ALL matching memories (no disambiguation needed)")
    .action((keyOrId: string, opts: { scope?: string; agent?: string; project?: string; all?: boolean }) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();

        // Try by ID first (exact/partial ID always unambiguous)
        const db = getDatabase();
        const idMatch = resolvePartialId(db, "memories", keyOrId);
        if (idMatch) {
          deleteMemory(idMatch);
          if (globalOpts.json) {
            outputJson({ deleted: idMatch });
          } else {
            console.log(chalk.green(`Memory ${idMatch} deleted.`));
          }
          return;
        }

        // Try by key — find ALL matches, then disambiguate
        const matches = getMemoriesByKey(keyOrId, opts.scope, opts.agent, opts.project);

        if (matches.length === 0) {
          if (globalOpts.json) {
            outputJson({ error: `No memory found: ${keyOrId}` });
          } else {
            console.error(chalk.red(`No memory found: ${keyOrId}`));
          }
          process.exit(1);
        }

        if (matches.length === 1) {
          deleteMemory(matches[0]!.id);
          if (globalOpts.json) {
            outputJson({ deleted: matches[0]!.id, key: keyOrId });
          } else {
            console.log(chalk.green(`Memory "${keyOrId}" (${matches[0]!.id}) deleted.`));
          }
          return;
        }

        // Multiple matches
        if (opts.all) {
          const ids = matches.map((m) => m.id);
          for (const id of ids) deleteMemory(id);
          if (globalOpts.json) {
            outputJson({ deleted: ids, key: keyOrId, count: ids.length });
          } else {
            console.log(chalk.green(`Deleted ${ids.length} memories with key "${keyOrId}".`));
          }
          return;
        }

        // Show disambiguation table
        if (globalOpts.json) {
          outputJson({
            error: `Ambiguous key "${keyOrId}" — ${matches.length} memories found. Use --all to delete all, or specify an ID.`,
            matches: matches.map((m) => ({ id: m.id, key: m.key, scope: m.scope, category: m.category, agent_id: m.agent_id })),
          });
        } else {
          console.log(chalk.yellow(`Ambiguous key "${keyOrId}" — ${matches.length} memories found:`));
          for (const m of matches) {
            console.log(`  ${m.id}  scope=${m.scope}  category=${m.category}  agent=${m.agent_id}  ${chalk.dim(m.key)}`);
          }
          console.log(chalk.dim("\nUse --all to delete all, or specify an ID."));
        }
        process.exit(1);
      } catch (e) {
        handleError(e);
      }
    });
}
