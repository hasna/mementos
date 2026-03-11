#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync, accessSync, constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase, getDbPath, resolvePartialId } from "../db/database.js";
import {
  createMemory,
  getMemory,
  getMemoryByKey,
  listMemories,
  updateMemory,
  deleteMemory,
  bulkDeleteMemories,
  touchMemory,
  parseMemoryRow,
} from "../db/memories.js";
import { registerAgent, listAgents, updateAgent } from "../db/agents.js";
import {
  registerProject,
  getProject,
  listProjects,
} from "../db/projects.js";
import { searchMemories } from "../lib/search.js";
import { loadConfig } from "../lib/config.js";
import { runCleanup } from "../lib/retention.js";
import { MemoryInjector } from "../lib/injector.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryFilter,
  MemoryStats,
  MemoryStatus,
  MemorySource,
  CreateMemoryInput,
} from "../types/index.js";

// ============================================================================
// Version
// ============================================================================

function getPackageVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ============================================================================
// Color helpers
// ============================================================================

const scopeColor: Record<MemoryScope, (s: string) => string> = {
  global: chalk.cyan,
  shared: chalk.yellow,
  private: chalk.magenta,
};

const categoryColor: Record<MemoryCategory, (s: string) => string> = {
  preference: chalk.blue,
  fact: chalk.green,
  knowledge: chalk.yellow,
  history: chalk.gray,
};

function importanceColor(importance: number): (s: string) => string {
  if (importance >= 8) return chalk.red.bold;
  if (importance >= 5) return chalk.yellow;
  return chalk.gray;
}

function colorScope(scope: MemoryScope): string {
  return scopeColor[scope](scope);
}

function colorCategory(category: MemoryCategory): string {
  return categoryColor[category](category);
}

function colorImportance(importance: number): string {
  return importanceColor(importance)(String(importance));
}

// ============================================================================
// Output helpers
// ============================================================================

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function formatMemoryLine(m: Memory): string {
  const id = chalk.dim(m.id.slice(0, 8));
  const scope = colorScope(m.scope);
  const cat = colorCategory(m.category);
  const imp = colorImportance(m.importance);
  const pin = m.pinned ? chalk.red(" *") : "";
  const value =
    m.value.length > 80 ? m.value.slice(0, 80) + "..." : m.value;
  return `${id} [${scope}/${cat}] ${chalk.bold(m.key)} = ${value} (${imp})${pin}`;
}

function formatMemoryDetail(m: Memory): string {
  const lines = [
    `${chalk.bold("ID:")}         ${m.id}`,
    `${chalk.bold("Key:")}        ${m.key}`,
    `${chalk.bold("Value:")}      ${m.value}`,
    `${chalk.bold("Scope:")}      ${colorScope(m.scope)}`,
    `${chalk.bold("Category:")}   ${colorCategory(m.category)}`,
    `${chalk.bold("Importance:")} ${colorImportance(m.importance)}/10`,
    `${chalk.bold("Source:")}     ${m.source}`,
    `${chalk.bold("Status:")}     ${m.status}`,
    `${chalk.bold("Pinned:")}     ${m.pinned ? chalk.red("yes") : "no"}`,
  ];
  if (m.summary) lines.push(`${chalk.bold("Summary:")}    ${m.summary}`);
  if (m.tags.length > 0)
    lines.push(`${chalk.bold("Tags:")}       ${m.tags.join(", ")}`);
  if (m.agent_id) lines.push(`${chalk.bold("Agent:")}      ${m.agent_id}`);
  if (m.project_id)
    lines.push(`${chalk.bold("Project:")}    ${m.project_id}`);
  if (m.session_id)
    lines.push(`${chalk.bold("Session:")}    ${m.session_id}`);
  if (m.expires_at)
    lines.push(`${chalk.bold("Expires:")}    ${m.expires_at}`);
  lines.push(`${chalk.bold("Access:")}     ${m.access_count}`);
  lines.push(`${chalk.bold("Version:")}    ${m.version}`);
  lines.push(`${chalk.bold("Created:")}    ${m.created_at}`);
  lines.push(`${chalk.bold("Updated:")}    ${m.updated_at}`);
  if (m.accessed_at)
    lines.push(`${chalk.bold("Accessed:")}   ${m.accessed_at}`);
  return lines.join("\n");
}

// ============================================================================
// Error handler
// ============================================================================

const program = new Command();

function handleError(e: unknown): never {
  const globalOpts = program.opts<GlobalOpts>();
  if (globalOpts.json) {
    outputJson({
      error: e instanceof Error ? e.message : String(e),
    });
  } else {
    console.error(chalk.red(e instanceof Error ? e.message : String(e)));
  }
  process.exit(1);
}

// ============================================================================
// ID resolution
// ============================================================================

function resolveMemoryId(partialId: string): string {
  const db = getDatabase();
  const id = resolvePartialId(db, "memories", partialId);
  if (!id) {
    console.error(chalk.red(`Could not resolve memory ID: ${partialId}`));
    process.exit(1);
  }
  return id;
}

// ============================================================================
// Types
// ============================================================================

interface GlobalOpts {
  project?: string;
  json?: boolean;
  agent?: string;
  session?: string;
}

// ============================================================================
// Program
// ============================================================================

program
  .name("mementos")
  .description("Universal memory system for AI agents")
  .version(getPackageVersion())
  .option("--project <path>", "Project path for scoping")
  .option("--json", "Output as JSON")
  .option("--agent <name>", "Agent name or ID")
  .option("--session <id>", "Session ID");

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
  .option("--ttl <ms>", "Time-to-live in milliseconds", parseInt)
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
        ttl_ms: opts.ttl,
        source: opts.source as MemorySource | undefined,
        agent_id: globalOpts.agent,
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
        console.log(chalk.green("Memory saved:"));
        console.log(formatMemoryDetail(memory));
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
  .option("--limit <n>", "Max results", parseInt)
  .option("--offset <n>", "Offset for pagination", parseInt)
  .option("--status <status>", "Status filter: active, archived, expired")
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
        session_id: globalOpts.session,
      };

      const memories = listMemories(filter);

      if (globalOpts.json) {
        outputJson(memories);
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
        console.log(chalk.green("Memory updated:"));
        console.log(formatMemoryDetail(updated));
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
  .action((keyOrId: string) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();

      // Try by ID first
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

      // Try by key
      const memory = getMemoryByKey(keyOrId);
      if (memory) {
        deleteMemory(memory.id);
        if (globalOpts.json) {
          outputJson({ deleted: memory.id, key: keyOrId });
        } else {
          console.log(
            chalk.green(`Memory "${keyOrId}" (${memory.id}) deleted.`)
          );
        }
        return;
      }

      if (globalOpts.json) {
        outputJson({ error: `No memory found: ${keyOrId}` });
      } else {
        console.error(chalk.red(`No memory found: ${keyOrId}`));
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
  .option("--limit <n>", "Max results", parseInt)
  .action((query: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const filter: MemoryFilter = {
        scope: opts.scope as MemoryScope | undefined,
        category: opts.category as MemoryCategory | undefined,
        tags: opts.tags
          ? (opts.tags as string).split(",").map((t: string) => t.trim())
          : undefined,
        limit: (opts.limit as number | undefined) || 20,
      };

      const results = searchMemories(query, filter);

      if (globalOpts.json) {
        outputJson(results);
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
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// stats
// ============================================================================

program
  .command("stats")
  .description("Show memory statistics")
  .action(() => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const db = getDatabase();

      const total = (
        db
          .query(
            "SELECT COUNT(*) as c FROM memories WHERE status = 'active'"
          )
          .get() as { c: number }
      ).c;

      const byScope = db
        .query(
          "SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope"
        )
        .all() as { scope: MemoryScope; c: number }[];

      const byCategory = db
        .query(
          "SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category"
        )
        .all() as { category: MemoryCategory; c: number }[];

      const byStatus = db
        .query(
          "SELECT status, COUNT(*) as c FROM memories GROUP BY status"
        )
        .all() as { status: string; c: number }[];

      const pinnedCount = (
        db
          .query(
            "SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'"
          )
          .get() as { c: number }
      ).c;

      const expiredCount = (
        db
          .query(
            "SELECT COUNT(*) as c FROM memories WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < datetime('now'))"
          )
          .get() as { c: number }
      ).c;

      const byAgent = db
        .query(
          "SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL GROUP BY agent_id"
        )
        .all() as { agent_id: string; c: number }[];

      const stats: MemoryStats = {
        total,
        by_scope: { global: 0, shared: 0, private: 0 },
        by_category: {
          preference: 0,
          fact: 0,
          knowledge: 0,
          history: 0,
        },
        by_status: { active: 0, archived: 0, expired: 0 },
        by_agent: {},
        pinned_count: pinnedCount,
        expired_count: expiredCount,
      };

      for (const row of byScope) stats.by_scope[row.scope] = row.c;
      for (const row of byCategory)
        stats.by_category[row.category] = row.c;
      for (const row of byStatus) {
        if (row.status in stats.by_status) {
          stats.by_status[
            row.status as keyof typeof stats.by_status
          ] = row.c;
        }
      }
      for (const row of byAgent)
        stats.by_agent[row.agent_id] = row.c;

      if (globalOpts.json) {
        outputJson(stats);
        return;
      }

      console.log(chalk.bold("Memory Statistics"));
      console.log(
        `${chalk.bold("Total active:")}  ${chalk.white(String(total))}`
      );
      console.log(
        `${chalk.bold("By scope:")}      ${chalk.cyan("global")}=${stats.by_scope.global}  ${chalk.yellow("shared")}=${stats.by_scope.shared}  ${chalk.magenta("private")}=${stats.by_scope.private}`
      );
      console.log(
        `${chalk.bold("By category:")}   ${chalk.blue("preference")}=${stats.by_category.preference}  ${chalk.green("fact")}=${stats.by_category.fact}  ${chalk.yellow("knowledge")}=${stats.by_category.knowledge}  ${chalk.gray("history")}=${stats.by_category.history}`
      );
      console.log(
        `${chalk.bold("By status:")}     active=${stats.by_status.active}  archived=${stats.by_status.archived}  expired=${stats.by_status.expired}`
      );
      console.log(
        `${chalk.bold("Pinned:")}        ${stats.pinned_count}`
      );
      console.log(
        `${chalk.bold("Expired:")}       ${stats.expired_count}`
      );
      if (Object.keys(stats.by_agent).length > 0) {
        const agentParts = Object.entries(stats.by_agent)
          .map(([k, v]) => `${k}=${v}`)
          .join("  ");
        console.log(`${chalk.bold("By agent:")}      ${agentParts}`);
      }
    } catch (e) {
      handleError(e);
    }
  });

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

      const dedupeMode = opts.overwrite ? ("merge" as const) : ("create" as const);
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
// init <name>
// ============================================================================

program
  .command("init <name>")
  .description("Register an agent (returns ID)")
  .option("-d, --description <text>", "Agent description")
  .option("-r, --role <role>", "Agent role")
  .action((name: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const agent = registerAgent(
        name,
        opts.description as string | undefined,
        opts.role as string | undefined
      );

      if (globalOpts.json) {
        outputJson(agent);
      } else {
        console.log(chalk.green("Agent registered:"));
        console.log(`  ${chalk.bold("ID:")}        ${agent.id}`);
        console.log(`  ${chalk.bold("Name:")}      ${agent.name}`);
        console.log(
          `  ${chalk.bold("Role:")}      ${agent.role || "agent"}`
        );
        console.log(
          `  ${chalk.bold("Created:")}   ${agent.created_at}`
        );
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// agents
// ============================================================================

program
  .command("agents")
  .description("List all registered agents")
  .action(() => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const agents = listAgents();

      if (globalOpts.json) {
        outputJson(agents);
        return;
      }

      if (agents.length === 0) {
        console.log(chalk.yellow("No agents registered."));
        return;
      }

      console.log(
        chalk.bold(
          `${agents.length} agent${agents.length === 1 ? "" : "s"}:`
        )
      );
      for (const a of agents) {
        console.log(
          `  ${chalk.dim(a.id)} ${chalk.bold(a.name)} ${chalk.gray(a.role || "agent")} ${chalk.dim(`last seen: ${a.last_seen_at}`)}`
        );
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// agent-update <id>
// ============================================================================

program
  .command("agent-update <id>")
  .description("Update an agent's name, description, or role")
  .option("--name <name>", "New agent name")
  .option("-d, --description <text>", "New description")
  .option("-r, --role <role>", "New role")
  .action((id: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const updates: { name?: string; description?: string; role?: string } = {};
      if (opts.name !== undefined) updates.name = opts.name as string;
      if (opts.description !== undefined) updates.description = opts.description as string;
      if (opts.role !== undefined) updates.role = opts.role as string;

      if (Object.keys(updates).length === 0) {
        if (globalOpts.json) {
          outputJson({ error: "No updates provided. Use --name, --description, or --role." });
        } else {
          console.error(chalk.red("No updates provided. Use --name, --description, or --role."));
        }
        process.exit(1);
      }

      const agent = updateAgent(id, updates);
      if (!agent) {
        if (globalOpts.json) {
          outputJson({ error: `Agent not found: ${id}` });
        } else {
          console.error(chalk.red(`Agent not found: ${id}`));
        }
        process.exit(1);
      }

      if (globalOpts.json) {
        outputJson(agent);
      } else {
        console.log(chalk.green("Agent updated:"));
        console.log(`  ${chalk.bold("ID:")}          ${agent.id}`);
        console.log(`  ${chalk.bold("Name:")}        ${agent.name}`);
        console.log(`  ${chalk.bold("Description:")} ${agent.description || "-"}`);
        console.log(`  ${chalk.bold("Role:")}        ${agent.role || "agent"}`);
        console.log(`  ${chalk.bold("Last seen:")}   ${agent.last_seen_at}`);
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// projects
// ============================================================================

program
  .command("projects")
  .description("Manage projects")
  .option("--add", "Add a new project")
  .option("--name <name>", "Project name")
  .option("--path <path>", "Project path")
  .option("--description <text>", "Project description")
  .action((opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();

      if (opts.add) {
        const name = opts.name as string | undefined;
        const path = opts.path as string | undefined;
        if (!name || !path) {
          console.error(
            chalk.red("--name and --path are required when adding a project")
          );
          process.exit(1);
        }
        const project = registerProject(
          name,
          resolve(path),
          opts.description as string | undefined
        );

        if (globalOpts.json) {
          outputJson(project);
        } else {
          console.log(chalk.green("Project registered:"));
          console.log(`  ${chalk.bold("ID:")}     ${project.id}`);
          console.log(
            `  ${chalk.bold("Name:")}   ${project.name}`
          );
          console.log(
            `  ${chalk.bold("Path:")}   ${project.path}`
          );
        }
        return;
      }

      // List projects
      const projects = listProjects();

      if (globalOpts.json) {
        outputJson(projects);
        return;
      }

      if (projects.length === 0) {
        console.log(chalk.yellow("No projects registered."));
        return;
      }

      console.log(
        chalk.bold(
          `${projects.length} project${projects.length === 1 ? "" : "s"}:`
        )
      );
      for (const p of projects) {
        console.log(
          `  ${chalk.dim(p.id.slice(0, 8))} ${chalk.bold(p.name)} ${chalk.gray(p.path)}${p.description ? chalk.dim(` — ${p.description}`) : ""}`
        );
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// inject
// ============================================================================

program
  .command("inject")
  .description(
    "Output injection context for agent system prompts"
  )
  .option("--agent <name>", "Agent ID for scope filtering")
  .option("--project <path>", "Project path for scope filtering")
  .option("--session <id>", "Session ID for scope filtering")
  .option(
    "--max-tokens <n>",
    "Max approximate token budget",
    parseInt
  )
  .option(
    "--categories <cats>",
    "Comma-separated categories to include"
  )
  .action((opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const maxTokens =
        (opts.maxTokens as number | undefined) || 500;
      const minImportance = 3;
      const categoriesRaw =
        (opts.categories as string | undefined) ||
        "preference,fact,knowledge";
      const categories = categoriesRaw
        .split(",")
        .map((c: string) => c.trim()) as MemoryCategory[];

      const agentId =
        (opts.agent as string | undefined) || globalOpts.agent;
      const projectPath =
        (opts.project as string | undefined) || globalOpts.project;
      const sessionId =
        (opts.session as string | undefined) || globalOpts.session;

      let projectId: string | undefined;
      if (projectPath) {
        const project = getProject(resolve(projectPath));
        if (project) projectId = project.id;
      }

      // Collect memories from all visible scopes
      const allMemories: Memory[] = [];

      // Global memories
      const globalMems = listMemories({
        scope: "global",
        category: categories,
        min_importance: minImportance,
        status: "active",
        project_id: projectId,
        limit: 50,
      });
      allMemories.push(...globalMems);

      // Shared memories (project-scoped)
      if (projectId) {
        const sharedMems = listMemories({
          scope: "shared",
          category: categories,
          min_importance: minImportance,
          status: "active",
          project_id: projectId,
          limit: 50,
        });
        allMemories.push(...sharedMems);
      }

      // Private memories (agent-scoped)
      if (agentId) {
        const privateMems = listMemories({
          scope: "private",
          category: categories,
          min_importance: minImportance,
          status: "active",
          agent_id: agentId,
          session_id: sessionId,
          limit: 50,
        });
        allMemories.push(...privateMems);
      }

      // Deduplicate by ID
      const seen = new Set<string>();
      const unique = allMemories.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      // Sort by importance DESC, then recency
      unique.sort((a, b) => {
        if (b.importance !== a.importance)
          return b.importance - a.importance;
        return (
          new Date(b.updated_at).getTime() -
          new Date(a.updated_at).getTime()
        );
      });

      // Build context within token budget (~4 chars per token estimate)
      const charBudget = maxTokens * 4;
      const lines: string[] = [];
      let totalChars = 0;

      for (const m of unique) {
        const line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
        if (totalChars + line.length > charBudget) break;
        lines.push(line);
        totalChars += line.length;
        touchMemory(m.id);
      }

      if (lines.length === 0) {
        if (globalOpts.json) {
          outputJson({ context: "", count: 0 });
        } else {
          console.log(
            chalk.yellow(
              "No relevant memories found for injection."
            )
          );
        }
        return;
      }

      const context = `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;

      if (globalOpts.json) {
        outputJson({ context, count: lines.length });
      } else {
        console.log(context);
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

// ============================================================================
// doctor
// ============================================================================

program
  .command("doctor")
  .description("Run health checks on the mementos database")
  .action(() => {
    const globalOpts = program.opts<GlobalOpts>();
    const checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[] = [];

    // 1. Check DB file exists and is readable
    const dbPath = getDbPath();
    if (existsSync(dbPath)) {
      try {
        accessSync(dbPath, fsConstants.R_OK | fsConstants.W_OK);
        checks.push({ name: "Database file", status: "ok", detail: dbPath });
      } catch {
        checks.push({ name: "Database file", status: "fail", detail: `Not readable/writable: ${dbPath}` });
      }
    } else {
      checks.push({ name: "Database file", status: "fail", detail: `Not found: ${dbPath}` });
    }

    // 2. Check schema version
    try {
      const db = getDatabase();
      const migRow = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
      const schemaVersion = migRow?.max_id ?? 0;
      checks.push({ name: "Schema version", status: schemaVersion > 0 ? "ok" : "warn", detail: `v${schemaVersion}` });

      // 3. Count totals
      const memCount = (db.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
      const agentCount = (db.query("SELECT COUNT(*) as c FROM agents").get() as { c: number }).c;
      const projectCount = (db.query("SELECT COUNT(*) as c FROM projects").get() as { c: number }).c;
      checks.push({ name: "Memories", status: "ok", detail: String(memCount) });
      checks.push({ name: "Agents", status: "ok", detail: String(agentCount) });
      checks.push({ name: "Projects", status: "ok", detail: String(projectCount) });

      // 4. Check for orphaned memory_tags
      const orphanedTags = (db.query(
        "SELECT COUNT(*) as c FROM memory_tags WHERE memory_id NOT IN (SELECT id FROM memories)"
      ).get() as { c: number }).c;
      checks.push({
        name: "Orphaned tags",
        status: orphanedTags > 0 ? "warn" : "ok",
        detail: orphanedTags > 0 ? `${orphanedTags} orphaned tag(s)` : "None",
      });

      // 5. Check for expired memories still in DB
      const expiredCount = (db.query(
        "SELECT COUNT(*) as c FROM memories WHERE status != 'expired' AND expires_at IS NOT NULL AND expires_at < datetime('now')"
      ).get() as { c: number }).c;
      checks.push({
        name: "Expired memories",
        status: expiredCount > 0 ? "warn" : "ok",
        detail: expiredCount > 0 ? `${expiredCount} expired but not cleaned up (run 'mementos clean')` : "None pending",
      });
    } catch (e) {
      checks.push({ name: "Database connection", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }

    // Output
    if (globalOpts.json) {
      outputJson({ checks, healthy: checks.every((c) => c.status === "ok") });
    } else {
      console.log(chalk.bold("\nMementos Health Report\n"));
      for (const check of checks) {
        const icon =
          check.status === "ok" ? chalk.green("\u2713") :
          check.status === "warn" ? chalk.yellow("!") :
          chalk.red("\u2717");
        console.log(`  ${icon} ${chalk.bold(check.name)}: ${check.detail}`);
      }
      const healthy = checks.every((c) => c.status === "ok");
      const warnings = checks.filter((c) => c.status === "warn").length;
      const failures = checks.filter((c) => c.status === "fail").length;
      console.log("");
      if (healthy) {
        console.log(chalk.green("  All checks passed."));
      } else {
        if (failures > 0) console.log(chalk.red(`  ${failures} check(s) failed.`));
        if (warnings > 0) console.log(chalk.yellow(`  ${warnings} warning(s).`));
      }
      console.log("");
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
// history
// ============================================================================

program
  .command("history")
  .description("List memories sorted by most recently accessed")
  .option("--limit <n>", "Max results (default: 20)", parseInt)
  .action((opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const limit = (opts.limit as number | undefined) || 20;
      const db = getDatabase();

      const rows = db
        .query(
          "SELECT * FROM memories WHERE status = 'active' AND accessed_at IS NOT NULL ORDER BY accessed_at DESC LIMIT ?"
        )
        .all(limit) as Record<string, unknown>[];

      const memories = rows.map(parseMemoryRow);

      if (globalOpts.json) {
        outputJson(memories);
        return;
      }

      if (memories.length === 0) {
        console.log(chalk.yellow("No recently accessed memories."));
        return;
      }

      console.log(
        chalk.bold(
          `${memories.length} recently accessed memor${memories.length === 1 ? "y" : "ies"}:`
        )
      );
      for (const m of memories) {
        const id = chalk.dim(m.id.slice(0, 8));
        const scope = colorScope(m.scope);
        const cat = colorCategory(m.category);
        const value =
          m.value.length > 60 ? m.value.slice(0, 60) + "..." : m.value;
        const accessed = m.accessed_at
          ? chalk.dim(m.accessed_at)
          : chalk.dim("never");
        console.log(
          `${id} [${scope}/${cat}] ${chalk.bold(m.key)} = ${value}  ${accessed}`
        );
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// context
// ============================================================================

program
  .command("context")
  .description(
    "Output formatted injection context (for piping into agent prompts)"
  )
  .option("--agent <name>", "Agent ID for private memory scope")
  .option("--project <path>", "Project path for shared memory scope")
  .option("--max-tokens <n>", "Token budget for context", parseInt)
  .option(
    "--categories <cats>",
    "Comma-separated categories: preference, fact, knowledge, history"
  )
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

      const categories = opts.categories
        ? ((opts.categories as string).split(",").map((c: string) =>
            c.trim()
          ) as MemoryCategory[])
        : undefined;

      const injector = new MemoryInjector();
      const context = injector.getInjectionContext({
        agent_id: agentId,
        project_id: projectId,
        max_tokens: opts.maxTokens as number | undefined,
        categories,
      });

      if (globalOpts.json) {
        outputJson({
          context,
          injected_count: injector.getInjectedCount(),
        });
      } else if (context) {
        console.log(context);
      } else {
        console.error(chalk.yellow("No memories matched the injection criteria."));
        process.exit(1);
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// MCP install command
// ============================================================================

program
  .command("mcp")
  .description("Install mementos MCP server into Claude Code, Codex, or Gemini")
  .option("--claude", "Install into Claude Code (~/.claude/.mcp.json)")
  .option("--codex", "Install into Codex (~/.codex/config.toml)")
  .option("--gemini", "Install into Gemini (~/.gemini/settings.json)")
  .option("--all", "Install into all supported agents")
  .option("--uninstall", "Remove mementos MCP from config")
  .action((opts: { claude?: boolean; codex?: boolean; gemini?: boolean; all?: boolean; uninstall?: boolean }) => {
    const { readFileSync, writeFileSync, existsSync: fileExists } = require("node:fs") as typeof import("node:fs");
    const { join: pathJoin } = require("node:path") as typeof import("node:path");
    const { homedir: getHome } = require("node:os") as typeof import("node:os");
    const home = getHome();

    const mementosCmd = process.argv[0]?.includes("bun")
      ? pathJoin(home, ".bun", "bin", "mementos-mcp")
      : "mementos-mcp";

    const targets = opts.all
      ? ["claude", "codex", "gemini"]
      : [
          opts.claude ? "claude" : null,
          opts.codex ? "codex" : null,
          opts.gemini ? "gemini" : null,
        ].filter(Boolean) as string[];

    if (targets.length === 0) {
      console.log(chalk.yellow("Specify a target: --claude, --codex, --gemini, or --all"));
      console.log(chalk.gray("Example: mementos mcp --all"));
      return;
    }

    for (const target of targets) {
      try {
        if (target === "claude") {
          const configPath = pathJoin(home, ".claude", ".mcp.json");
          let config: Record<string, unknown> = {};
          if (fileExists(configPath)) {
            config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
          }
          const servers = (config["mcpServers"] || {}) as Record<string, unknown>;
          if (opts.uninstall) {
            delete servers["mementos"];
          } else {
            servers["mementos"] = { command: mementosCmd, args: [] };
          }
          config["mcpServers"] = servers;
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
          console.log(chalk.green(`${opts.uninstall ? "Removed from" : "Installed into"} Claude Code: ${configPath}`));
        }

        if (target === "codex") {
          const configPath = pathJoin(home, ".codex", "config.toml");
          if (fileExists(configPath)) {
            let content = readFileSync(configPath, "utf-8");
            if (opts.uninstall) {
              content = content.replace(/\n\[mcp_servers\.mementos\]\ncommand = "[^"]*"\nargs = \[\]\n?/g, "\n");
            } else if (!content.includes("[mcp_servers.mementos]")) {
              content += `\n[mcp_servers.mementos]\ncommand = "${mementosCmd}"\nargs = []\n`;
            }
            writeFileSync(configPath, content, "utf-8");
            console.log(chalk.green(`${opts.uninstall ? "Removed from" : "Installed into"} Codex: ${configPath}`));
          } else {
            console.log(chalk.yellow(`Codex config not found: ${configPath}`));
          }
        }

        if (target === "gemini") {
          const configPath = pathJoin(home, ".gemini", "settings.json");
          let config: Record<string, unknown> = {};
          if (fileExists(configPath)) {
            config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
          }
          const servers = (config["mcpServers"] || {}) as Record<string, unknown>;
          if (opts.uninstall) {
            delete servers["mementos"];
          } else {
            servers["mementos"] = { command: mementosCmd, args: [] };
          }
          config["mcpServers"] = servers;
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
          console.log(chalk.green(`${opts.uninstall ? "Removed from" : "Installed into"} Gemini: ${configPath}`));
        }
      } catch (e) {
        console.error(chalk.red(`Failed for ${target}: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  });

// ============================================================================
// watch
// ============================================================================

program
  .command("watch")
  .description("Watch for new and changed memories in real-time")
  .option("-s, --scope <scope>", "Scope filter: global, shared, private")
  .option("-c, --category <cat>", "Category filter: preference, fact, knowledge, history")
  .option("--agent <name>", "Agent filter")
  .option("--project <path>", "Project filter")
  .option("--interval <ms>", "Poll interval in milliseconds", parseInt)
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

      const intervalMs = (opts.interval as number | undefined) || 500;

      // Header
      console.log(
        chalk.bold.cyan("Watching memories...") +
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

      // Show last 20 memories as "Recent"
      const filter: MemoryFilter = {
        scope: opts.scope as MemoryScope | undefined,
        category: opts.category as MemoryCategory | undefined,
        agent_id: agentId,
        project_id: projectId,
        limit: 20,
      };

      const recent = listMemories(filter);
      if (recent.length > 0) {
        console.log(chalk.bold.dim(`Recent (${recent.length}):`));
        // Show oldest first
        for (const m of recent.reverse()) {
          console.log(formatWatchLine(m));
        }
      } else {
        console.log(chalk.dim("No recent memories."));
      }

      console.log(chalk.dim("──────────── Live ────────────"));
      console.log();

      // Start polling for new/changed memories
      const { startPolling } = require("../lib/poll.js") as typeof import("../lib/poll.js");

      const handle = startPolling({
        interval_ms: intervalMs,
        scope: opts.scope as MemoryScope | undefined,
        category: opts.category as MemoryCategory | undefined,
        agent_id: agentId,
        project_id: projectId,
        on_memories: (memories) => {
          for (const m of memories) {
            console.log(formatWatchLine(m));
            sendNotification(m);
          }
        },
        on_error: (err) => {
          console.error(chalk.red(`Poll error: ${err.message}`));
        },
      });

      // Graceful Ctrl+C
      const cleanup = () => {
        handle.stop();
        console.log();
        console.log(chalk.dim("Stopped watching."));
        process.exit(0);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// Watch helpers
// ============================================================================

function formatWatchLine(m: Memory): string {
  const scope = colorScope(m.scope);
  const cat = colorCategory(m.category);
  const imp = colorImportance(m.importance);
  const value =
    m.value.length > 100 ? m.value.slice(0, 100) + "..." : m.value;

  const main = `  [${scope}/${cat}] ${chalk.bold(m.key)} = ${value} ${chalk.dim(`(importance: ${imp})`)}`;

  const parts: string[] = [];
  if (m.tags.length > 0) parts.push(`Tags: ${m.tags.join(", ")}`);
  if (m.agent_id) parts.push(`Agent: ${m.agent_id}`);
  parts.push(`Updated: ${m.updated_at}`);

  const detail = chalk.dim(`    ${parts.join("  |  ")}`);
  return `${main}\n${detail}`;
}

function sendNotification(m: Memory): void {
  if (process.platform !== "darwin") return;
  try {
    const title = "Mementos";
    const msg = `[${m.scope}/${m.category}] ${m.key} = ${m.value.slice(0, 60)}`;
    const escaped = msg.replace(/"/g, '\\"');
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync(
      `osascript -e 'display notification "${escaped}" with title "${title}"'`,
      { stdio: "ignore", timeout: 2000 }
    );
  } catch {
    // Notification failure is non-critical
  }
}

// ============================================================================
// Parse and run
// ============================================================================

program.parse(process.argv);
