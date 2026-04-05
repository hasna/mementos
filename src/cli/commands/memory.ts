import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import {
  createMemory,
  getMemory,
  getMemoryByKey,
  getMemoriesByKey,
  listMemories,
  updateMemory,
  deleteMemory,
  bulkDeleteMemories,
  touchMemory,
  parseMemoryRow,
  getMemoryVersions,
} from "../../db/memories.js";
import { getProject } from "../../db/projects.js";
import { getAgent } from "../../db/agents.js";
import { searchMemories, getSearchHistory, getPopularSearches } from "../../lib/search.js";
import { parseDuration } from "../../lib/duration.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryFilter,
  MemoryStatus,
  MemorySource,
  CreateMemoryInput,
} from "../../types/index.js";
import {
  outputJson,
  getOutputFormat,
  outputYaml,
  formatMemoryLine,
  formatMemoryDetail,
  makeHandleError,
  resolveMemoryId,
  resolveKeyOrId,
  colorScope,
  colorCategory,
  diffMemory,
  formatWatchLine,
  sendNotification,
  type GlobalOpts,
} from "../helpers.js";

export function registerMemoryCommands(program: Command): void {
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
  // recall <key>
  // ============================================================================

  program
    .command("recall <key>")
    .description("Recall a memory by key")
    .option("-s, --scope <scope>", "Scope filter")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .action((key: string, opts) => {
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

        const memory = getMemoryByKey(
          key,
          opts.scope as string | undefined,
          agentId,
          projectId
        );

        if (memory) {
          touchMemory(memory.id);
          if (globalOpts.json) {
            outputJson(memory);
          } else {
            console.log(formatMemoryDetail(memory));
          }
          return;
        }

        // Fuzzy fallback: search for the key and show best match
        const results = searchMemories(key, {
          scope: opts.scope as MemoryScope | undefined,
          agent_id: agentId,
          project_id: projectId,
          limit: 1,
        });

        if (results.length > 0) {
          const best = results[0]!;
          touchMemory(best.memory.id);
          if (globalOpts.json) {
            outputJson({ fuzzy_match: true, score: best.score, match_type: best.match_type, memory: best.memory });
          } else {
            console.log(chalk.yellow(`No exact match, showing best result (score: ${best.score.toFixed(2)}, match: ${best.match_type}):`));
            console.log(formatMemoryDetail(best.memory));
          }
          return;
        }

        if (globalOpts.json) {
          outputJson({ error: `No memory found for key: ${key}` });
        } else {
          console.error(chalk.yellow(`No memory found for key: ${key}`));
        }
        process.exit(1);
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // list
  // ============================================================================

  program
    .command("list")
    .description("List memories with optional filters")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-c, --category <cat>", "Category filter")
    .option("--tags <tags>", "Comma-separated tags filter")
    .option("--importance-min <n>", "Minimum importance", parseInt)
    .option("--pinned", "Show only pinned")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .option("--session <id>", "Session ID filter")
    .option("--limit <n>", "Max results", parseInt)
    .option("--offset <n>", "Offset for pagination", parseInt)
    .option("--status <status>", "Status filter: active, archived, expired")
    .option("--format <fmt>", "Output format: compact (default), json, csv, yaml")
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
          tags: opts.tags
            ? (opts.tags as string).split(",").map((t: string) => t.trim())
            : undefined,
          min_importance: opts.importanceMin as number | undefined,
          pinned: opts.pinned ? true : undefined,
          agent_id: agentId,
          project_id: projectId,
          limit: (opts.limit as number | undefined) || 50,
          offset: opts.offset as number | undefined,
          status: opts.status as MemoryStatus | undefined,
          session_id: (opts.session as string | undefined) || globalOpts.session,
        };

        const memories = listMemories(filter);
        const fmt = getOutputFormat(program, opts.format as string | undefined);

        if (fmt === "json") {
          outputJson(memories);
          return;
        }

        if (fmt === "csv") {
          console.log("key,value,scope,category,importance,id");
          for (const m of memories) {
            const v = m.value.replace(/"/g, '""');
            console.log(`"${m.key}","${v}",${m.scope},${m.category},${m.importance},${m.id.slice(0, 8)}`);
          }
          return;
        }

        if (fmt === "yaml") {
          outputYaml(memories);
          return;
        }

        if (memories.length === 0) {
          console.log(chalk.yellow("No memories found."));
          return;
        }

        console.log(
          chalk.bold(
            `${memories.length} memor${memories.length === 1 ? "y" : "ies"}:`
          )
        );
        for (const m of memories) {
          console.log(formatMemoryLine(m));
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

        // Ambiguous — list matches and exit with guidance
        if (globalOpts.json) {
          outputJson({
            error: `Ambiguous key: ${matches.length} memories match "${keyOrId}"`,
            matches: matches.map((m) => ({
              id: m.id,
              scope: m.scope,
              agent_id: m.agent_id,
              project_id: m.project_id,
              importance: m.importance,
            })),
          });
        } else {
          console.error(
            chalk.yellow(`Ambiguous: ${matches.length} memories match key "${keyOrId}":\n`)
          );
          for (const m of matches) {
            const parts = [
              `  ${m.id.slice(0, 8)}`,
              `scope=${m.scope}`,
              m.agent_id ? `agent=${m.agent_id}` : null,
              m.project_id ? `project=${m.project_id}` : null,
              `importance=${m.importance}`,
            ]
              .filter(Boolean)
              .join("  ");
            console.error(parts);
          }
          console.error(
            chalk.cyan(
              `\nUse the full ID, or narrow with --scope, --agent, --project, or --all.`
            )
          );
        }
        process.exit(1);
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // search <query>
  // ============================================================================

  program
    .command("search <query>")
    .description("Full-text search across memories")
    .option("-s, --scope <scope>", "Scope filter")
    .option("-c, --category <cat>", "Category filter")
    .option("--tags <tags>", "Comma-separated tags filter")
    .option("--project <path>", "Project filter (path or name)")
    .option("--agent <name>", "Agent filter")
    .option("--session <id>", "Session ID filter")
    .option("--limit <n>", "Max results", parseInt)
    .option("--format <fmt>", "Output format: compact (default), json, csv, yaml")
    .option("--history", "Show recent search queries instead of searching")
    .option("--popular", "Show most popular search queries")
    .action((query: string, opts) => {
      try {
        if (opts.history) {
          const history = getSearchHistory(20);
          const fmt = getOutputFormat(program, opts.format as string | undefined);
          if (fmt === "json") {
            outputJson(history);
            return;
          }
          if (history.length === 0) {
            console.log(chalk.yellow("No search history."));
            return;
          }
          console.log(chalk.bold("Recent searches:"));
          for (const h of history) {
            console.log(`  ${chalk.cyan(h.query)} ${chalk.dim(`(${h.result_count} results, ${h.created_at})`)}`);
          }
          return;
        }

        if (opts.popular) {
          const popular = getPopularSearches(10);
          const fmt = getOutputFormat(program, opts.format as string | undefined);
          if (fmt === "json") {
            outputJson(popular);
            return;
          }
          if (popular.length === 0) {
            console.log(chalk.yellow("No search history."));
            return;
          }
          console.log(chalk.bold("Popular searches:"));
          for (const p of popular) {
            console.log(`  ${chalk.cyan(p.query)} ${chalk.dim(`(${p.count} times)`)}`);
          }
          return;
        }

        const globalOpts = program.opts<GlobalOpts>();
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }
        const agentName = (opts.agent as string | undefined) || globalOpts.agent;
        let agentId: string | undefined;
        if (agentName) {
          const { getAgent } = require("../../db/agents.js") as typeof import("../../db/agents.js");
          const agent = getAgent(agentName);
          if (agent) agentId = agent.id;
        }

        const filter: MemoryFilter = {
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as MemoryCategory | undefined,
          tags: opts.tags
            ? (opts.tags as string).split(",").map((t: string) => t.trim())
            : undefined,
          project_id: projectId,
          agent_id: agentId,
          session_id: (opts.session as string | undefined) || globalOpts.session,
          limit: (opts.limit as number | undefined) || 20,
        };

        const results = searchMemories(query, filter);
        const fmt = getOutputFormat(program, opts.format as string | undefined);

        if (fmt === "json") {
          outputJson(results);
          return;
        }

        if (fmt === "csv") {
          console.log("key,value,scope,category,importance,score,id");
          for (const r of results) {
            const v = r.memory.value.replace(/"/g, '""');
            console.log(`"${r.memory.key}","${v}",${r.memory.scope},${r.memory.category},${r.memory.importance},${r.score.toFixed(1)},${r.memory.id.slice(0, 8)}`);
          }
          return;
        }

        if (fmt === "yaml") {
          outputYaml(results);
          return;
        }

        if (results.length === 0) {
          console.log(
            chalk.yellow(`No memories found matching "${query}".`)
          );
          return;
        }

        console.log(
          chalk.bold(
            `${results.length} result${results.length === 1 ? "" : "s"} for "${query}":`
          )
        );
        for (const r of results) {
          const score = chalk.dim(`(score: ${r.score.toFixed(1)})`);
          console.log(`${formatMemoryLine(r.memory)} ${score}`);
          if (r.highlights && r.highlights.length > 0) {
            for (const h of r.highlights) {
              console.log(chalk.dim(`    ${h.field}: ${h.snippet}`));
            }
          }
        }
      } catch (e) {
        handleError(e);
      }
    });

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

  // ============================================================================
  // tail
  // ============================================================================

  program
    .command("tail")
    .description("Watch for new/updated memories in real-time (like tail -f)")
    .option("-s, --scope <scope>", "Scope filter: global, shared, private")
    .option("-c, --category <cat>", "Category filter: preference, fact, knowledge, history")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .option("--interval <ms>", "Poll interval in milliseconds (default: 2000)", parseInt)
    .option("--notify", "Send macOS notifications for each change")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const jsonMode = !!globalOpts.json;
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath =
          (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const intervalMs = (opts.interval as number | undefined) || 2000;
        const notifyEnabled = !!opts.notify;
        const startTime = new Date().toISOString();

        // Header
        if (!jsonMode) {
          console.log(
            chalk.bold.cyan("Watching for memory changes...") +
              chalk.dim(" (Ctrl+C to stop)")
          );

          // Show active filters
          const filters: string[] = [];
          if (opts.scope) filters.push(`scope=${colorScope(opts.scope as MemoryScope)}`);
          if (opts.category) filters.push(`category=${colorCategory(opts.category as MemoryCategory)}`);
          if (agentId) filters.push(`agent=${chalk.dim(agentId)}`);
          if (projectId) filters.push(`project=${chalk.dim(projectId)}`);
          if (filters.length > 0) {
            console.log(chalk.dim("Filters: ") + filters.join(chalk.dim(" | ")));
          }
          console.log(chalk.dim(`Poll interval: ${intervalMs}ms`));
          console.log();
        }

        // Start polling — on first tick the poller seeds lastSeen, so no existing
        // memories are emitted. Only genuinely new/updated rows trigger callbacks.
        const { startPolling } = require("../../lib/poll.js") as typeof import("../../lib/poll.js");

        const handle = startPolling({
          interval_ms: intervalMs,
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as MemoryCategory | undefined,
          agent_id: agentId,
          project_id: projectId,
          on_memories: (memories: Memory[]) => {
            for (const m of memories) {
              const isNew = m.created_at === m.updated_at && m.created_at >= startTime;
              if (jsonMode) {
                console.log(JSON.stringify({ event: isNew ? "new" : "updated", memory: m }));
              } else {
                const prefix = isNew
                  ? chalk.green.bold("+ ")
                  : chalk.yellow.bold("~ ");
                console.log(prefix + formatWatchLine(m));
              }
              if (notifyEnabled) sendNotification(m);
            }
          },
          on_error: (err: Error) => {
            if (jsonMode) {
              console.error(JSON.stringify({ event: "error", message: err.message }));
            } else {
              console.error(chalk.red(`Poll error: ${err.message}`));
            }
          },
        });

        // Graceful Ctrl+C
        const cleanup = () => {
          handle.stop();
          if (!jsonMode) {
            console.log();
            console.log(chalk.dim("Stopped watching."));
          }
          process.exit(0);
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // diff <id>
  // ============================================================================

  program
    .command("diff <id>")
    .description("Show diff between memory versions")
    .option("-v, --version <n>", "Compare version N with N-1")
    .action((idArg: string, opts: { version?: string }) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const db = getDatabase();

        // Resolve partial ID or key
        let memoryId: string | null = resolvePartialId(db, "memories", idArg);
        if (!memoryId) {
          const mem = resolveKeyOrId(idArg, {}, globalOpts);
          if (!mem) {
            console.error(chalk.red(`Memory not found: ${idArg}`));
            process.exit(1);
          }
          memoryId = mem.id;
        }
        diffMemory(memoryId!, opts, globalOpts);
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // when-to-use <memory_id>
  // ============================================================================

  program
    .command("when-to-use <memory_id>")
    .description("Show the when_to_use guidance for a memory")
    .action((memoryId: string) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const resolvedId = resolveMemoryId(memoryId);
        const memory = getMemory(resolvedId);

        if (!memory) {
          if (globalOpts.json) {
            outputJson({ error: `Memory not found: ${memoryId}` });
          } else {
            console.error(chalk.red(`Memory not found: ${memoryId}`));
          }
          process.exit(1);
        }

        const whenToUse = memory.when_to_use ?? null;

        if (globalOpts.json) {
          outputJson({ id: memory.id, key: memory.key, when_to_use: whenToUse });
          return;
        }

        console.log(chalk.bold(`${memory.key} (${memory.id.slice(0, 8)})`));
        if (whenToUse) {
          console.log(`  ${chalk.cyan("when_to_use:")} ${whenToUse}`);
        } else {
          console.log(chalk.dim("  (not set)"));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // chain <sequence_group>
  // ============================================================================

  program
    .command("chain <sequence_group>")
    .description("Show a memory chain (memories linked by sequence_group, ordered by sequence_order)")
    .action((sequenceGroup: string) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const db = getDatabase();

        const rows = db
          .query(
            "SELECT * FROM memories WHERE sequence_group = ? AND status = 'active' ORDER BY sequence_order ASC"
          )
          .all(sequenceGroup) as Record<string, unknown>[];

        const memories = rows.map(parseMemoryRow);

        if (globalOpts.json) {
          outputJson(memories);
          return;
        }

        if (memories.length === 0) {
          console.log(chalk.yellow(`No chain found for sequence group: ${sequenceGroup}`));
          return;
        }

        console.log(chalk.bold(`Chain: ${sequenceGroup} (${memories.length} step${memories.length === 1 ? "" : "s"}):\n`));
        for (let i = 0; i < memories.length; i++) {
          const m = memories[i]!;
          const order = m.sequence_order !== null && m.sequence_order !== undefined ? m.sequence_order : i + 1;
          const value = m.value.length > 120 ? m.value.slice(0, 120) + "..." : m.value;
          console.log(`  ${chalk.cyan(String(order) + ".")} ${chalk.bold(m.key)}: ${value}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // bulk <action> <ids...>
  // ============================================================================

  program
    .command("bulk <action> <ids...>")
    .description(
      "Batch operations: forget, archive, pin, unpin"
    )
    .action((action: string, ids: string[]) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const validActions = [
          "forget",
          "archive",
          "pin",
          "unpin",
        ] as const;

        if (
          !validActions.includes(
            action as (typeof validActions)[number]
          )
        ) {
          console.error(
            chalk.red(
              `Invalid action: ${action}. Valid: ${validActions.join(", ")}`
            )
          );
          process.exit(1);
        }

        const resolvedIds = ids.map((id) => resolveMemoryId(id));
        let affected = 0;

        switch (action) {
          case "forget": {
            affected = bulkDeleteMemories(resolvedIds);
            break;
          }
          case "archive": {
            for (const id of resolvedIds) {
              const mem = getMemory(id);
              if (mem) {
                updateMemory(id, {
                  status: "archived",
                  version: mem.version,
                });
                affected++;
              }
            }
            break;
          }
          case "pin": {
            for (const id of resolvedIds) {
              const mem = getMemory(id);
              if (mem) {
                updateMemory(id, {
                  pinned: true,
                  version: mem.version,
                });
                affected++;
              }
            }
            break;
          }
          case "unpin": {
            for (const id of resolvedIds) {
              const mem = getMemory(id);
              if (mem) {
                updateMemory(id, {
                  pinned: false,
                  version: mem.version,
                });
                affected++;
              }
            }
            break;
          }
        }

        if (globalOpts.json) {
          outputJson({ action, affected, ids: resolvedIds });
        } else {
          console.log(
            chalk.green(
              `${action}: ${affected} memor${affected === 1 ? "y" : "ies"} affected.`
            )
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // remove — alias for memory delete (consistent with open-* CLI conventions)
  program
    .command("remove <nameOrId>")
    .description("Remove/delete a memory by name or ID (alias for memory delete)")
    .option("--agent <id>", "Agent ID")
    .action((nameOrId: string, opts: { agent?: string }) => {
      const globalOpts = program.opts() as { agent?: string; json?: boolean };
      const agentId = opts.agent || globalOpts.agent;
      const { deleteMemory: _deleteMemory, getMemoryByKey: _getMemoryByKey, resolvePartialMemoryId } = require("../../db/memories.js") as any;
      // Try by partial ID first, then by key
      let id: string | null = null;
      try { id = resolvePartialMemoryId?.(nameOrId) || null; } catch {}
      if (!id) {
        const mem = _getMemoryByKey?.(nameOrId, agentId);
        if (mem) id = mem.id;
      }
      if (!id) { console.error(chalk.red(`Memory not found: ${nameOrId}`)); process.exit(1); }
      const deleted = _deleteMemory(id);
      if (deleted) console.log(chalk.green(`✓ Memory ${id.slice(0, 8)} removed`));
      else { console.error(chalk.red(`Memory not found: ${nameOrId}`)); process.exit(1); }
    });
}
