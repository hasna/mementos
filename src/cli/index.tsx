#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync, unlinkSync, accessSync, statSync, copyFileSync, mkdirSync, readdirSync, constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getDatabase, getDbPath, resolvePartialId } from "../db/database.js";
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
} from "../db/memories.js";
import { registerAgent, listAgents, updateAgent } from "../db/agents.js";
import {
  registerProject,
  getProject,
  listProjects,
} from "../db/projects.js";
import { searchMemories, getSearchHistory, getPopularSearches } from "../lib/search.js";
import { loadConfig, DEFAULT_CONFIG, getActiveProfile, setActiveProfile, listProfiles, deleteProfile } from "../lib/config.js";
import { runCleanup } from "../lib/retention.js";

import { parseDuration } from "../lib/duration.js";
import { createEntity, getEntity, getEntityByName, listEntities, deleteEntity, mergeEntities } from "../db/entities.js";
import { createRelation, listRelations, deleteRelation, getRelatedEntities, getEntityGraph, findPath } from "../db/relations.js";
import { linkEntityToMemory, getMemoriesForEntity } from "../db/entity-memories.js";
import type {
  Entity,
  EntityType,
  RelationType,
} from "../types/index.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryFilter,
  MemoryStats,
  MemoryStatus,
  MemorySource,
  MemoryVersion,
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
  if (importance >= 9) return chalk.red.bold;
  if (importance >= 7) return chalk.yellow;
  if (importance >= 5) return chalk.green;
  return chalk.dim;
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

const entityTypeColor: Record<string, (s: string) => string> = {
  person: chalk.cyan,
  project: chalk.yellow,
  tool: chalk.green,
  concept: chalk.blue,
  file: chalk.magenta,
  api: chalk.red,
  pattern: chalk.gray,
  organization: chalk.white,
};

function colorEntityType(type: string): string {
  const colorFn = entityTypeColor[type] || chalk.white;
  return colorFn(type);
}

function resolveEntityArg(nameOrId: string, type?: EntityType): Entity {
  // Try by name first
  const byName = getEntityByName(nameOrId, type);
  if (byName) return byName;
  // Try partial ID
  const db = getDatabase();
  const id = resolvePartialId(db, "entities", nameOrId);
  if (id) return getEntity(id);
  console.error(chalk.red(`Entity not found: ${nameOrId}`));
  process.exit(1);
}

// ============================================================================
// Output helpers
// ============================================================================

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Resolve output format from local command flag, global flag, or --json alias.
 * Priority: localFmt > global --format > --json > "compact"
 */
function getOutputFormat(localFmt?: string): string {
  const globalOpts = program.opts<GlobalOpts>();
  if (localFmt) return localFmt;
  if (globalOpts.format) return globalOpts.format;
  if (globalOpts.json) return "json";
  return "compact";
}

/**
 * Simple YAML output — no library dependency.
 * Arrays of objects: each item as `- key: value` block.
 * Single objects: `key: value` per line.
 */
function outputYaml(data: unknown): void {
  const quote = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    if (
      s === "" ||
      s.includes(":") ||
      s.includes("#") ||
      s.includes("\n") ||
      s.includes('"') ||
      s.includes("'") ||
      s.startsWith("{") ||
      s.startsWith("[") ||
      s.startsWith(" ") ||
      s.endsWith(" ") ||
      /^(true|false|null|yes|no)$/i.test(s)
    ) {
      return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
    }
    return s;
  };

  const formatObj = (obj: Record<string, unknown>, indent: string): string => {
    return Object.entries(obj)
      .map(([k, v]) => {
        if (Array.isArray(v)) {
          if (v.length === 0) return `${indent}${k}: []`;
          return `${indent}${k}:\n${v.map((item) => `${indent}  - ${quote(item)}`).join("\n")}`;
        }
        if (v !== null && typeof v === "object") {
          return `${indent}${k}:\n${formatObj(v as Record<string, unknown>, indent + "  ")}`;
        }
        return `${indent}${k}: ${quote(v)}`;
      })
      .join("\n");
  };

  if (Array.isArray(data)) {
    const lines: string[] = [];
    for (const item of data) {
      if (item !== null && typeof item === "object") {
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length === 0) {
          lines.push("- {}");
          continue;
        }
        const [firstKey, firstVal] = entries[0]!;
        if (Array.isArray(firstVal) || (firstVal !== null && typeof firstVal === "object")) {
          lines.push(`- ${firstKey}:\n${formatObj({ [firstKey]: firstVal } as Record<string, unknown>, "    ").replace(/^\s*\S+:\n/, "")}`);
        } else {
          lines.push(`- ${firstKey}: ${quote(firstVal)}`);
        }
        for (let i = 1; i < entries.length; i++) {
          const [k, v] = entries[i]!;
          if (Array.isArray(v) || (v !== null && typeof v === "object")) {
            lines.push(`  ${k}:\n${formatObj({ [k]: v } as Record<string, unknown>, "    ").replace(/^\s*\S+:\n/, "")}`);
          } else {
            lines.push(`  ${k}: ${quote(v)}`);
          }
        }
      } else {
        lines.push(`- ${quote(item)}`);
      }
    }
    console.log(lines.join("\n"));
  } else if (data !== null && typeof data === "object") {
    console.log(formatObj(data as Record<string, unknown>, ""));
  } else {
    console.log(quote(data));
  }
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
  if (globalOpts.json || globalOpts.format === "json") {
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

/**
 * Resolve a key-or-id argument to a Memory object.
 * Tries key lookup first (with optional scope/agent/project filters), then partial ID.
 */
function resolveKeyOrId(
  keyOrId: string,
  opts: { scope?: string; agent?: string; project?: string },
  globalOpts: GlobalOpts
): Memory | null {
  const agentId = (opts.agent as string | undefined) || globalOpts.agent;
  const projectPath =
    (opts.project as string | undefined) || globalOpts.project;
  let projectId: string | undefined;
  if (projectPath) {
    const project = getProject(resolve(projectPath));
    if (project) projectId = project.id;
  }

  // Try by key first
  const byKey = getMemoryByKey(
    keyOrId,
    opts.scope as string | undefined,
    agentId,
    projectId
  );
  if (byKey) return byKey;

  // Try by partial ID
  const db = getDatabase();
  const fullId = resolvePartialId(db, "memories", keyOrId);
  if (fullId) return getMemory(fullId);

  return null;
}

// ============================================================================
// Types
// ============================================================================

interface GlobalOpts {
  project?: string;
  json?: boolean;
  format?: string;
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
  .option("--format <fmt>", "Output format: compact, json, csv, yaml")
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
        session_id: globalOpts.session,
      };

      const memories = listMemories(filter);
      const fmt = getOutputFormat(opts.format as string | undefined);

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
        console.log(chalk.green(`Updated: ${updated.key} (${updated.id.slice(0, 8)})`) );
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
  .option("--limit <n>", "Max results", parseInt)
  .option("--format <fmt>", "Output format: compact (default), json, csv, yaml")
  .option("--history", "Show recent search queries instead of searching")
  .option("--popular", "Show most popular search queries")
  .action((query: string, opts) => {
    try {


      if (opts.history) {
        const history = getSearchHistory(20);
        const fmt = getOutputFormat(opts.format as string | undefined);
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
        const fmt = getOutputFormat(opts.format as string | undefined);
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

      const filter: MemoryFilter = {
        scope: opts.scope as MemoryScope | undefined,
        category: opts.category as MemoryCategory | undefined,
        tags: opts.tags
          ? (opts.tags as string).split(",").map((t: string) => t.trim())
          : undefined,
        limit: (opts.limit as number | undefined) || 20,
      };

      const results = searchMemories(query, filter);
      const fmt = getOutputFormat(opts.format as string | undefined);

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
// stats
// ============================================================================

program
  .command("stats")
  .description("Show memory statistics")
  .option("--format <fmt>", "Output format: compact (default), json, csv, yaml")
  .action((opts) => {
    try {

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

      const fmt = getOutputFormat(opts.format as string | undefined);

      if (fmt === "json") {
        outputJson(stats);
        return;
      }

      if (fmt === "yaml") {
        outputYaml(stats);
        return;
      }

      if (fmt === "csv") {
        console.log("metric,key,value");
        console.log(`total,active,${stats.total}`);
        for (const [k, v] of Object.entries(stats.by_scope)) console.log(`by_scope,${k},${v}`);
        for (const [k, v] of Object.entries(stats.by_category)) console.log(`by_category,${k},${v}`);
        for (const [k, v] of Object.entries(stats.by_status)) console.log(`by_status,${k},${v}`);
        console.log(`pinned,count,${stats.pinned_count}`);
        console.log(`expired,count,${stats.expired_count}`);
        for (const [k, v] of Object.entries(stats.by_agent)) console.log(`by_agent,${k},${v}`);
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
// report
// ============================================================================

program
  .command("report")
  .description("Rich summary of memory activity and top memories")
  .option("--days <n>", "Activity window in days (default: 7)", "7")
  .option("--project <path>", "Filter by project path")
  .option("--markdown", "Output as Markdown (for PRs, docs, etc.)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const days = parseInt(opts.days as string, 10) || 7;
      // --json and --markdown may be consumed by global opts — check both
      const isJson = (opts.json as boolean | undefined) || globalOpts.json;
      const isMarkdown = opts.markdown as boolean | undefined;
      const projectPath = (opts.project as string | undefined) || globalOpts.project;
      let projectId: string | undefined;
      if (projectPath) {
        const project = getProject(resolve(projectPath));
        if (project) projectId = project.id;
      }

      const db = getDatabase();

      // Total counts
      const conditions = projectId ? "AND project_id = ?" : "";
      const params = projectId ? [projectId] : [];
      const total = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' ${conditions}`).get(...params) as { c: number }).c;
      const pinned = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1 ${conditions}`).get(...params) as { c: number }).c;

      // Activity trend (last N days)
      const activityRows = db.query(`
        SELECT date(created_at) AS d, COUNT(*) AS cnt
        FROM memories WHERE status = 'active' AND date(created_at) >= date('now', '-${days} days') ${conditions}
        GROUP BY d ORDER BY d ASC
      `).all(...params) as { d: string; cnt: number }[];
      const recentTotal = activityRows.reduce((s, r) => s + r.cnt, 0);
      const avgPerDay = activityRows.length > 0 ? (recentTotal / activityRows.length).toFixed(1) : "0";

      // By scope
      const byScopeRows = db.query(`SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' ${conditions} GROUP BY scope`).all(...params) as { scope: string; c: number }[];
      const byScope = Object.fromEntries(byScopeRows.map(r => [r.scope, r.c]));

      // By category
      const byCatRows = db.query(`SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' ${conditions} GROUP BY category`).all(...params) as { category: string; c: number }[];
      const byCat = Object.fromEntries(byCatRows.map(r => [r.category, r.c]));

      // Top memories by importance
      const topMems = db.query(`SELECT key, value, importance, scope, category FROM memories WHERE status = 'active' ${conditions} ORDER BY importance DESC, access_count DESC LIMIT 5`).all(...params) as { key: string; value: string; importance: number; scope: string; category: string }[];

      // Top agents by memory count
      const topAgents = db.query(`SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL ${conditions} GROUP BY agent_id ORDER BY c DESC LIMIT 5`).all(...params) as { agent_id: string; c: number }[];

      if (isJson) {
        console.log(JSON.stringify({ total, pinned, recent: { days, total: recentTotal, avg_per_day: parseFloat(avgPerDay) }, by_scope: byScope, by_category: byCat, top_memories: topMems, top_agents: topAgents }, null, 2));
        return;
      }

      if (isMarkdown) {
        const lines = [
          `## Mementos Report (last ${days} days)`,
          "",
          `- **Total memories:** ${total} (${pinned} pinned)`,
          `- **Recent activity:** ${recentTotal} new in ${days} days (~${avgPerDay}/day)`,
          `- **Scopes:** global=${byScope["global"] || 0} shared=${byScope["shared"] || 0} private=${byScope["private"] || 0}`,
          `- **Categories:** knowledge=${byCat["knowledge"] || 0} fact=${byCat["fact"] || 0} preference=${byCat["preference"] || 0} history=${byCat["history"] || 0}`,
          "",
          "### Top Memories",
          ...topMems.map(m => `- **${m.key}** (${m.scope}/${m.category}, imp:${m.importance}): ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`),
        ];
        if (topAgents.length > 0) {
          lines.push("", "### Top Agents", ...topAgents.map(a => `- ${a.agent_id}: ${a.c} memories`));
        }
        console.log(lines.join("\n"));
        return;
      }

      // Default human-readable output
      const sparkline = activityRows.map(r => {
        const bars = "▁▂▃▄▅▆▇█";
        const maxC = Math.max(...activityRows.map(x => x.cnt), 1);
        return bars[Math.round((r.cnt / maxC) * 7)] || "▁";
      }).join("");

      console.log(chalk.bold(`\nmementos report — last ${days} days\n`));
      console.log(`  ${chalk.cyan("Total:")}     ${total} memories (${chalk.yellow(String(pinned))} pinned)`);
      console.log(`  ${chalk.cyan("Recent:")}    ${recentTotal} new · ${chalk.dim(`~${avgPerDay}/day`)}`);
      console.log(`  ${chalk.cyan("Activity:")}  ${sparkline || chalk.dim("no activity")}`);
      console.log(`  ${chalk.cyan("Scopes:")}    global=${byScope["global"] || 0} shared=${byScope["shared"] || 0} private=${byScope["private"] || 0}`);
      console.log(`  ${chalk.cyan("Categories:")} knowledge=${byCat["knowledge"] || 0} fact=${byCat["fact"] || 0} preference=${byCat["preference"] || 0} history=${byCat["history"] || 0}`);

      if (topMems.length > 0) {
        console.log(`\n  ${chalk.bold("Top memories by importance:")}`);
        topMems.forEach(m => {
          console.log(`    ${chalk.green(`[${m.importance}]`)} ${chalk.bold(m.key)} ${chalk.dim(`(${m.scope}/${m.category})`)}`);
          console.log(`       ${m.value.slice(0, 90)}${m.value.length > 90 ? "..." : ""}`);
        });
      }

      if (topAgents.length > 0) {
        console.log(`\n  ${chalk.bold("Top agents:")}`);
        topAgents.forEach(a => console.log(`    ${a.agent_id}: ${a.c} memories`));
      }
      console.log("");
    } catch (e) {
      console.error(chalk.red(`report failed: ${e instanceof Error ? e.message : String(e)}`));
      process.exit(1);
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
  .description("Diagnose common issues with the mementos installation")
  .action(() => {
    const globalOpts = program.opts<GlobalOpts>();
    const checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[] = [];

    // 1. Version
    const version = getPackageVersion();
    checks.push({ name: "Version", status: "ok", detail: version });

    // 2. DB connectivity
    const dbPath = getDbPath();
    let db: ReturnType<typeof getDatabase> | null = null;
    if (dbPath !== ":memory:" && existsSync(dbPath)) {
      try {
        accessSync(dbPath, fsConstants.R_OK | fsConstants.W_OK);
        checks.push({ name: "Database file", status: "ok", detail: dbPath });
      } catch {
        checks.push({ name: "Database file", status: "fail", detail: `Not readable/writable: ${dbPath}` });
      }
    } else if (dbPath === ":memory:") {
      checks.push({ name: "Database file", status: "ok", detail: "in-memory database" });
    } else {
      checks.push({ name: "Database file", status: "warn", detail: `Not found: ${dbPath} (will be created on first use)` });
    }

    try {
      db = getDatabase();
      checks.push({ name: "Database connection", status: "ok", detail: "Connected" });
    } catch (e) {
      checks.push({ name: "Database connection", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }

    // 3. DB file size
    try {
      if (dbPath !== ":memory:" && existsSync(dbPath)) {
        const stats = statSync(dbPath);
        const sizeKb = (stats.size / 1024).toFixed(1);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
        const label = stats.size > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
        checks.push({ name: "DB file size", status: "ok", detail: label });
      } else if (dbPath === ":memory:") {
        checks.push({ name: "DB file size", status: "ok", detail: "in-memory database" });
      }
    } catch {
      checks.push({ name: "DB file size", status: "warn", detail: "Could not read file size" });
    }

    // 4. Config file
    try {
      loadConfig();
      checks.push({ name: "Config", status: "ok", detail: "valid" });
    } catch (e) {
      checks.push({ name: "Config", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }

    if (!db) {
      checks.push({ name: "Data checks", status: "fail", detail: "Skipped — database not available" });
      outputDoctorResults(globalOpts, checks);
      process.exitCode = 1;
      return;
    }

    // 5. Schema version
    try {
      const migRow = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
      const schemaVersion = migRow?.max_id ?? 0;
      checks.push({ name: "Schema version", status: schemaVersion > 0 ? "ok" : "warn", detail: `v${schemaVersion}` });
    } catch (e) {
      checks.push({ name: "Schema version", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }

    // 6. Memory counts with scope breakdown, expired, and stale
    try {
      const all = listMemories(undefined, db);
      const total = all.length;
      checks.push({ name: "Memories", status: "ok", detail: `${total} total` });

      const byScope: Record<string, number> = {};
      let expiredCount = 0;
      let staleCount = 0;
      const now = Date.now();
      const staleThreshold = 14 * 24 * 60 * 60 * 1000; // 14 days

      for (const m of all) {
        byScope[m.scope] = (byScope[m.scope] || 0) + 1;
        if (m.status === "expired") expiredCount++;
        const lastAccess = m.accessed_at
          ? new Date(m.accessed_at).getTime()
          : new Date(m.created_at).getTime();
        if (now - lastAccess > staleThreshold && m.status === "active") {
          staleCount++;
        }
      }

      const scopeParts = Object.entries(byScope)
        .map(([s, c]) => `${s}: ${c}`)
        .join(", ");
      if (scopeParts) {
        checks.push({ name: "  By scope", status: "ok", detail: scopeParts });
      }

      checks.push({
        name: "  Expired",
        status: expiredCount > 10 ? "warn" : "ok",
        detail: expiredCount > 10 ? `${expiredCount} (run 'mementos clean' to remove)` : String(expiredCount),
      });

      checks.push({
        name: "  Stale (14+ days)",
        status: staleCount > 10 ? "warn" : "ok",
        detail: String(staleCount),
      });
    } catch (e) {
      checks.push({ name: "Memories", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }

    // 7. Orphaned tags
    try {
      const orphanedTags = (db.query(
        "SELECT COUNT(*) as c FROM memory_tags WHERE memory_id NOT IN (SELECT id FROM memories)"
      ).get() as { c: number }).c;
      checks.push({
        name: "Orphaned tags",
        status: orphanedTags > 0 ? "warn" : "ok",
        detail: orphanedTags > 0 ? `${orphanedTags} orphaned tag(s)` : "None",
      });
    } catch (e) {
      checks.push({ name: "Orphaned tags", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }

    // 8. Agent count
    try {
      const agents = listAgents(db);
      checks.push({ name: "Agents", status: "ok", detail: String(agents.length) });
    } catch (e) {
      checks.push({ name: "Agents", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }

    // 9. Project count
    try {
      const projects = listProjects(db);
      checks.push({ name: "Projects", status: "ok", detail: String(projects.length) });
    } catch (e) {
      checks.push({ name: "Projects", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }

    // 10. Active profile
    try {
      const activeProfile = getActiveProfile();
      const profiles = listProfiles();
      if (activeProfile) {
        checks.push({ name: "Active profile", status: "ok", detail: `${activeProfile} (${profiles.length} total)` });
      } else {
        checks.push({ name: "Active profile", status: "ok", detail: `default (~/.mementos/mementos.db) — ${profiles.length} profile(s) available` });
      }
    } catch (e) {
      checks.push({ name: "Active profile", status: "warn", detail: e instanceof Error ? e.message : String(e) });
    }

    // 11. REST server reachability (quick check)
    try {
      const mementosUrl = process.env["MEMENTOS_URL"] || `http://127.0.0.1:19428`;
      checks.push({ name: "REST server URL", status: "ok", detail: `${mementosUrl} (use 'mementos-serve' to start)` });
    } catch {
      checks.push({ name: "REST server URL", status: "ok", detail: "http://127.0.0.1:19428" });
    }

    outputDoctorResults(globalOpts, checks);
  });

function outputDoctorResults(
  globalOpts: GlobalOpts,
  checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[],
): void {
  if (globalOpts.json) {
    outputJson({ checks, healthy: checks.every((c) => c.status === "ok") });
  } else {
    console.log(chalk.bold("\nmementos doctor\n"));
    for (const check of checks) {
      const icon =
        check.status === "ok"
          ? chalk.green("\u2713")
          : check.status === "warn"
            ? chalk.yellow("\u26A0")
            : chalk.red("\u2717");
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
}

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
          // CORRECT: use `claude mcp add` CLI — do NOT write ~/.claude/.mcp.json directly
          const { execSync } = require("node:child_process") as typeof import("node:child_process");
          if (opts.uninstall) {
            try {
              execSync(`claude mcp remove mementos`, { stdio: "pipe" });
              console.log(chalk.green("Removed mementos from Claude Code MCP"));
            } catch {
              console.log(chalk.yellow("mementos was not installed in Claude Code (or claude CLI not found)"));
            }
          } else {
            try {
              execSync(`claude mcp add --transport stdio --scope user mementos -- ${mementosCmd}`, { stdio: "pipe" });
              console.log(chalk.green(`Installed mementos into Claude Code (user scope)`));
              console.log(chalk.gray("  Restart Claude Code for the change to take effect."));
            } catch (e) {
              // claude CLI not available — print the command for manual install
              console.log(chalk.yellow("claude CLI not found. Run this manually:"));
              console.log(chalk.white(`  claude mcp add --transport stdio --scope user mementos -- ${mementosCmd}`));
            }
          }
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
      const { startPolling } = require("../lib/poll.js") as typeof import("../lib/poll.js");

      const handle = startPolling({
        interval_ms: intervalMs,
        scope: opts.scope as MemoryScope | undefined,
        category: opts.category as MemoryCategory | undefined,
        agent_id: agentId,
        project_id: projectId,
        on_memories: (memories) => {
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
        on_error: (err) => {
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
// context [query]
// ============================================================================

program
  .command("context [query]")
  .description(
    "Get formatted, prompt-ready block of relevant memories"
  )
  .option("--max-tokens <n>", "Max approximate token budget", parseInt)
  .option("--min-importance <n>", "Minimum importance threshold", parseInt)
  .option("--scope <scope>", "Filter by scope (global, shared, private)")
  .option("--categories <cats>", "Comma-separated categories to include")
  .option("--agent <name>", "Agent ID for scope filtering")
  .option("--project <path>", "Project path for scope filtering")
  .action((query: string | undefined, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const maxTokens = (opts.maxTokens as number | undefined) || 500;
      const minImportance = (opts.minImportance as number | undefined) || 1;
      const scope = opts.scope as MemoryScope | undefined;
      const categoriesRaw = opts.categories as string | undefined;
      const categories = categoriesRaw
        ? (categoriesRaw.split(",").map((c: string) => c.trim()) as MemoryCategory[])
        : undefined;
      const agentId = (opts.agent as string | undefined) || globalOpts.agent;
      const projectPath = (opts.project as string | undefined) || globalOpts.project;

      let projectId: string | undefined;
      if (projectPath) {
        const project = getProject(resolve(projectPath));
        if (project) projectId = project.id;
      }

      let memories: Memory[];

      if (query) {
        // Use search for relevance-ranked results
        const filter: MemoryFilter = {
          min_importance: minImportance,
          status: "active",
        };
        if (scope) filter.scope = scope;
        if (categories) filter.category = categories;
        if (agentId) filter.agent_id = agentId;
        if (projectId) filter.project_id = projectId;

        const results = searchMemories(query, filter);
        memories = results.map((r) => r.memory);
      } else {
        // No query — gather all relevant memories like inject
        memories = [];
        const baseFilter = {
          min_importance: minImportance,
          status: "active" as const,
          category: categories,
          limit: 100,
        };

        if (!scope || scope === "global") {
          memories.push(
            ...listMemories({ ...baseFilter, scope: "global", project_id: projectId })
          );
        }
        if ((!scope || scope === "shared") && projectId) {
          memories.push(
            ...listMemories({ ...baseFilter, scope: "shared", project_id: projectId })
          );
        }
        if ((!scope || scope === "private") && agentId) {
          memories.push(
            ...listMemories({ ...baseFilter, scope: "private", agent_id: agentId })
          );
        }

        // Deduplicate
        const seen = new Set<string>();
        memories = memories.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });

        // Sort by importance DESC, then recency
        memories.sort((a, b) => {
          if (b.importance !== a.importance) return b.importance - a.importance;
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });
      }

      // Trim to token budget (~4 chars per token)
      const charBudget = maxTokens * 4;
      const lines: string[] = [];
      let totalChars = 0;

      for (const m of memories) {
        const line = `- [${m.category}] ${m.key}: ${m.value} (importance: ${m.importance})`;
        if (totalChars + line.length > charBudget) break;
        lines.push(line);
        totalChars += line.length;
        touchMemory(m.id);
      }

      if (globalOpts.json) {
        outputJson({ context: lines.length > 0 ? `## Memories\n\n${lines.join("\n")}` : "", count: lines.length });
        return;
      }

      if (lines.length === 0) {
        // Pipe-friendly: output nothing if no memories
        if (process.stdout.isTTY) {
          console.log(chalk.yellow("No relevant memories found."));
        }
        return;
      }

      console.log(`## Memories\n\n${lines.join("\n")}`);
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
  .option("--list", "List available backups in ~/.mementos/backups/")
  .action((targetPath: string | undefined, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
      const backupsDir = join(home, ".mementos", "backups");

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
            const filePath = join(backupsDir, f);
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
        dest = join(backupsDir, `mementos-${ts}.db`);
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
  .option("--latest", "Restore the most recent backup from ~/.mementos/backups/")
  .option("--force", "Skip confirmation and perform the restore")
  .action((filePath: string | undefined, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
      const backupsDir = join(home, ".mementos", "backups");

      let source: string;

      if (opts.latest) {
        if (!existsSync(backupsDir)) {
          console.error(chalk.red("No backups directory found."));
          process.exit(1);
        }
        const files = readdirSync(backupsDir)
          .filter((f: string) => f.endsWith(".db"))
          .map((f: string) => {
            const fp = join(backupsDir, f);
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
        const { resetDatabase } = require("../db/database.js");
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

function diffMemory(
  memoryId: string,
  opts: { version?: string },
  globalOpts: GlobalOpts
): void {
  const current = getMemory(memoryId);
  if (!current) {
    console.error(chalk.red(`Memory not found: ${memoryId}`));
    process.exit(1);
  }

  const versions = getMemoryVersions(memoryId);

  if (versions.length === 0) {
    if (globalOpts.json) {
      outputJson({ error: "No version history available", memory_id: memoryId });
    } else {
      console.log(chalk.yellow("No version history available."));
      console.log(chalk.dim(`Memory "${current.key}" is at version ${current.version} but has no prior snapshots.`));
    }
    return;
  }

  let older: MemoryVersion;
  let newer: MemoryVersion | Memory;
  let olderVersion: number;
  let newerVersion: number;

  if (opts.version) {
    const targetVersion = parseInt(opts.version, 10);
    if (isNaN(targetVersion) || targetVersion < 1) {
      console.error(chalk.red("Version must be a positive integer."));
      process.exit(1);
    }

    if (targetVersion === current.version) {
      const prev = versions.find((v) => v.version === targetVersion - 1);
      if (!prev) {
        console.error(chalk.red(`No version ${targetVersion - 1} found to compare against.`));
        process.exit(1);
      }
      older = prev;
      newer = current;
      olderVersion = prev.version;
      newerVersion = current.version;
    } else {
      const targetSnap = versions.find((v) => v.version === targetVersion);
      const prevSnap = versions.find((v) => v.version === targetVersion - 1);

      if (targetSnap && prevSnap) {
        older = prevSnap;
        newer = targetSnap;
        olderVersion = prevSnap.version;
        newerVersion = targetSnap.version;
      } else if (targetSnap && !prevSnap) {
        console.error(chalk.red(`No version ${targetVersion - 1} found to compare against.`));
        process.exit(1);
      } else {
        console.error(chalk.red(`Version ${targetVersion} not found.`));
        process.exit(1);
      }
    }
  } else {
    const latest = versions[versions.length - 1]!;
    older = latest;
    newer = current;
    olderVersion = latest.version;
    newerVersion = current.version;
  }

  if (globalOpts.json) {
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    const n = newer as unknown as Record<string, unknown>;

    if (older.value !== n.value) changes.value = { old: older.value, new: n.value };
    if (older.importance !== n.importance) changes.importance = { old: older.importance, new: n.importance };
    if (older.scope !== n.scope) changes.scope = { old: older.scope, new: n.scope };
    if (older.category !== n.category) changes.category = { old: older.category, new: n.category };
    if (JSON.stringify(older.tags) !== JSON.stringify(newer.tags)) changes.tags = { old: older.tags, new: newer.tags };
    if ((older.summary || null) !== (n.summary || null)) changes.summary = { old: older.summary, new: n.summary };
    if (older.pinned !== n.pinned) changes.pinned = { old: older.pinned, new: n.pinned };
    if (older.status !== n.status) changes.status = { old: older.status, new: n.status };

    outputJson({
      memory_id: memoryId,
      key: current.key,
      from_version: olderVersion,
      to_version: newerVersion,
      changes,
    });
    return;
  }

  console.log(chalk.bold(`Diff for "${current.key}" (${memoryId.slice(0, 8)})`));
  console.log(chalk.dim(`Version ${olderVersion} → ${newerVersion}`));
  console.log();

  let hasChanges = false;
  const n = newer as unknown as Record<string, unknown>;

  const oldValue = older.value;
  const newValue = n.value as string;
  if (oldValue !== newValue) {
    hasChanges = true;
    console.log(chalk.bold("  value:"));
    diffLines(oldValue, newValue);
  }

  const scalarFields: { name: string; oldVal: unknown; newVal: unknown }[] = [
    { name: "importance", oldVal: older.importance, newVal: n.importance },
    { name: "scope", oldVal: older.scope, newVal: n.scope },
    { name: "category", oldVal: older.category, newVal: n.category },
    { name: "summary", oldVal: older.summary || "(none)", newVal: n.summary || "(none)" },
    { name: "pinned", oldVal: older.pinned, newVal: n.pinned },
    { name: "status", oldVal: older.status, newVal: n.status },
  ];

  for (const field of scalarFields) {
    if (String(field.oldVal) !== String(field.newVal)) {
      hasChanges = true;
      console.log(`  ${chalk.bold(field.name + ":")} ${chalk.red(String(field.oldVal))} → ${chalk.green(String(field.newVal))}`);
    }
  }

  const oldTags = older.tags;
  const newTags = newer.tags;
  if (JSON.stringify(oldTags) !== JSON.stringify(newTags)) {
    hasChanges = true;
    const removed = oldTags.filter((t) => !newTags.includes(t));
    const added = newTags.filter((t) => !oldTags.includes(t));
    console.log(`  ${chalk.bold("tags:")}`);
    for (const t of removed) console.log(chalk.red(`    - ${t}`));
    for (const t of added) console.log(chalk.green(`    + ${t}`));
  }

  if (!hasChanges) {
    console.log(chalk.dim("  No changes between these versions."));
  }
}

function diffLines(oldText: string, newText: string): void {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length === 1 && newLines.length === 1) {
    console.log(chalk.red(`    - ${oldLines[0]}`));
    console.log(chalk.green(`    + ${newLines[0]}`));
    return;
  }

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  for (const line of oldLines) {
    if (!newSet.has(line)) {
      console.log(chalk.red(`    - ${line}`));
    } else {
      console.log(chalk.dim(`      ${line}`));
    }
  }
  for (const line of newLines) {
    if (!oldSet.has(line)) {
      console.log(chalk.green(`    + ${line}`));
    }
  }
}

// ============================================================================
// Shell completions
// ============================================================================

program
  .command("completions <shell>")
  .description("Output shell completion script (bash, zsh, fish)")
  .action((shell: string) => {
    const commands = "save recall list update forget search stats export import clean inject context pin unpin doctor tail diff init agents projects bulk completions config backup restore report profile mcp";
    const commandList = commands.split(" ");

    switch (shell.toLowerCase()) {
      case "bash": {
        console.log(`_mementos_completions() {
  local commands="${commands}"
  local scopes="global shared private"
  local categories="preference fact knowledge history"

  if [ "\${#COMP_WORDS[@]}" -eq 2 ]; then
    COMPREPLY=($(compgen -W "$commands" -- "\${COMP_WORDS[1]}"))
  elif [ "\${COMP_WORDS[1]}" = "recall" ] || [ "\${COMP_WORDS[1]}" = "forget" ] || [ "\${COMP_WORDS[1]}" = "pin" ] || [ "\${COMP_WORDS[1]}" = "unpin" ]; then
    COMPREPLY=()
  fi
}
complete -F _mementos_completions mementos`);
        break;
      }
      case "zsh": {
        console.log(`#compdef mementos
_mementos() {
  local commands=(${commands})
  _arguments '1:command:($commands)'
}
compdef _mementos mementos`);
        break;
      }
      case "fish": {
        const descriptions: Record<string, string> = {
          save: "Save a memory",
          recall: "Recall a memory by key",
          list: "List memories",
          update: "Update a memory",
          forget: "Delete a memory",
          search: "Search memories",
          stats: "Show memory statistics",
          export: "Export memories to JSON",
          import: "Import memories from JSON",
          clean: "Clean expired memories",
          inject: "Inject memories into a prompt",
          context: "Get context-relevant memories",
          pin: "Pin a memory",
          unpin: "Unpin a memory",
          doctor: "Check database health",
          tail: "Watch recent memories",
          diff: "Show memory changes",
          init: "Initialize a new database",
          agents: "Manage agents",
          projects: "Manage projects",
          bulk: "Bulk operations",
          completions: "Output shell completion script",
          config: "Manage configuration",
          backup: "Backup the database",
          restore: "Restore from a backup",
        };
        const lines = commandList.map(
          (cmd) =>
            `complete -c mementos -n "__fish_use_subcommand" -a "${cmd}" -d "${descriptions[cmd] || cmd}"`
        );
        console.log(lines.join("\n"));
        break;
      }
      default:
        console.error(
          `Unknown shell: ${shell}. Supported: bash, zsh, fish`
        );
        process.exit(1);
    }
  });

// ============================================================================
// config [subcommand]
// ============================================================================

const VALID_SCOPES = ["global", "shared", "private"];
const VALID_CATEGORIES = ["preference", "fact", "knowledge", "history"];

/** Navigate a nested object using dot-notation key path */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set a nested value using dot-notation key path */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

/** Remove a nested key using dot-notation key path */
function deleteNestedKey(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) return;
    current = current[part] as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]!];
}

/** Parse a CLI value: try JSON.parse for numbers/booleans/arrays, fall back to string */
function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Validate a config key/value pair against known constraints */
function validateConfigKeyValue(key: string, value: unknown): string | null {
  if (key === "default_scope") {
    if (typeof value !== "string" || !VALID_SCOPES.includes(value)) {
      return `Invalid scope "${value}". Must be one of: ${VALID_SCOPES.join(", ")}`;
    }
  }
  if (key === "default_category") {
    if (typeof value !== "string" || !VALID_CATEGORIES.includes(value)) {
      return `Invalid category "${value}". Must be one of: ${VALID_CATEGORIES.join(", ")}`;
    }
  }
  if (key === "default_importance") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
      return `Invalid importance "${value}". Must be an integer 1-10`;
    }
  }
  if (key === "injection.min_importance") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
      return `Invalid min_importance "${value}". Must be an integer 1-10`;
    }
  }
  if (key === "injection.max_tokens" || key === "injection.refresh_interval") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return `Invalid ${key} "${value}". Must be a non-negative integer`;
    }
  }
  if (key === "max_entries") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return `Invalid max_entries "${value}". Must be a positive integer`;
    }
  }
  if (key === "auto_cleanup.enabled") {
    if (typeof value !== "boolean") {
      return `Invalid auto_cleanup.enabled "${value}". Must be true or false`;
    }
  }
  // Validate that the key exists in DEFAULT_CONFIG
  const defaultVal = getNestedValue(DEFAULT_CONFIG as unknown as Record<string, unknown>, key);
  if (defaultVal === undefined) {
    return `Unknown config key "${key}". Run 'mementos config' to see valid keys`;
  }
  return null;
}

function getConfigPath(): string {
  return join(homedir(), ".mementos", "config.json");
}

function readFileConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeFileConfig(data: Record<string, unknown>): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

program
  .command("config [subcommand] [args...]")
  .description(
    "View or modify configuration. Subcommands: get <key>, set <key> <value>, reset [key], path"
  )
  .action((subcommand: string | undefined, args: string[]) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const useJson = globalOpts.json || globalOpts.format === "json";

      // No subcommand: show full merged config
      if (!subcommand) {
        const config = loadConfig();
        if (useJson) {
          outputJson(config);
        } else {
          console.log(JSON.stringify(config, null, 2));
        }
        return;
      }

      // config path
      if (subcommand === "path") {
        const p = getConfigPath();
        if (useJson) {
          outputJson({ path: p });
        } else {
          console.log(p);
        }
        return;
      }

      // config get <key>
      if (subcommand === "get") {
        const key = args[0];
        if (!key) {
          console.error(chalk.red("Usage: mementos config get <key>"));
          process.exit(1);
        }
        const config = loadConfig();
        const value = getNestedValue(config as unknown as Record<string, unknown>, key);
        if (value === undefined) {
          console.error(chalk.red(`Unknown config key: ${key}`));
          process.exit(1);
        }
        if (useJson) {
          outputJson({ key, value });
        } else if (typeof value === "object" && value !== null) {
          console.log(JSON.stringify(value, null, 2));
        } else {
          console.log(String(value));
        }
        return;
      }

      // config set <key> <value>
      if (subcommand === "set") {
        const key = args[0];
        const rawValue = args[1];
        if (!key || rawValue === undefined) {
          console.error(chalk.red("Usage: mementos config set <key> <value>"));
          process.exit(1);
        }
        const value = parseConfigValue(rawValue);
        const err = validateConfigKeyValue(key, value);
        if (err) {
          console.error(chalk.red(err));
          process.exit(1);
        }
        const fileConfig = readFileConfig();
        setNestedValue(fileConfig, key, value);
        writeFileConfig(fileConfig);
        if (useJson) {
          outputJson({ key, value, saved: true });
        } else {
          console.log(chalk.green(`Set ${key} = ${JSON.stringify(value)}`));
        }
        return;
      }

      // config reset [key]
      if (subcommand === "reset") {
        const key = args[0];
        if (key) {
          // Validate key exists in defaults
          const defaultVal = getNestedValue(DEFAULT_CONFIG as unknown as Record<string, unknown>, key);
          if (defaultVal === undefined) {
            console.error(chalk.red(`Unknown config key: ${key}`));
            process.exit(1);
          }
          const fileConfig = readFileConfig();
          deleteNestedKey(fileConfig, key);
          writeFileConfig(fileConfig);
          if (useJson) {
            outputJson({ key, reset: true, default_value: defaultVal });
          } else {
            console.log(chalk.green(`Reset ${key} to default (${JSON.stringify(defaultVal)})`));
          }
        } else {
          // Reset all: delete the config file
          const configPath = getConfigPath();
          if (existsSync(configPath)) {
            unlinkSync(configPath);
          }
          if (useJson) {
            outputJson({ reset: true, all: true });
          } else {
            console.log(chalk.green("Config reset to defaults (file removed)"));
          }
        }
        return;
      }

      console.error(chalk.red(`Unknown config subcommand: ${subcommand}`));
      console.error("Usage: mementos config [get|set|reset|path]");
      process.exit(1);
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// Entity commands
// ============================================================================

const entityCmd = program.command("entity").description("Knowledge graph entity commands");

// ============================================================================
// entity create <name>
// ============================================================================

entityCmd
  .command("create <name>")
  .description("Create a knowledge graph entity")
  .requiredOption("--type <type>", "Entity type: person, project, tool, concept, file, api, pattern, organization")
  .option("--description <text>", "Entity description")
  .option("--project <path>", "Project path for scoping")
  .action((name: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const projectPath = (opts.project as string | undefined) || globalOpts.project;
      let projectId: string | undefined;
      if (projectPath) {
        const project = getProject(resolve(projectPath));
        if (project) projectId = project.id;
      }

      const entity = createEntity({
        name,
        type: opts.type as EntityType,
        description: opts.description as string | undefined,
        project_id: projectId,
      });

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson(entity);
      } else {
        console.log(chalk.green(`Entity: ${entity.name} (${entity.id.slice(0, 8)})`));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// entity show <nameOrId>
// ============================================================================

entityCmd
  .command("show <nameOrId>")
  .description("Show entity details with related entities and linked memories")
  .option("--type <type>", "Entity type hint for name lookup")
  .action((nameOrId: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const entity = resolveEntityArg(nameOrId, opts.type as EntityType | undefined);
      const related = getRelatedEntities(entity.id);
      const memories = getMemoriesForEntity(entity.id);

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson({ ...entity, related, memories });
        return;
      }

      console.log(`${chalk.bold("ID:")}          ${entity.id}`);
      console.log(`${chalk.bold("Name:")}        ${entity.name}`);
      console.log(`${chalk.bold("Type:")}        ${colorEntityType(entity.type)}`);
      if (entity.description) console.log(`${chalk.bold("Description:")} ${entity.description}`);
      if (entity.project_id) console.log(`${chalk.bold("Project:")}     ${entity.project_id}`);
      console.log(`${chalk.bold("Created:")}     ${entity.created_at}`);
      console.log(`${chalk.bold("Updated:")}     ${entity.updated_at}`);

      if (related.length > 0) {
        console.log(`\n${chalk.bold("Related entities:")}`);
        for (const r of related) {
          console.log(`  ${chalk.dim(r.id.slice(0, 8))} [${colorEntityType(r.type)}] ${r.name}${r.description ? chalk.dim(` — ${r.description}`) : ""}`);
        }
      }

      if (memories.length > 0) {
        console.log(`\n${chalk.bold("Linked memories:")}`);
        for (const m of memories) {
          const value = m.value.length > 60 ? m.value.slice(0, 60) + "..." : m.value;
          console.log(`  ${chalk.dim(m.id.slice(0, 8))} ${chalk.bold(m.key)} = ${value}`);
        }
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// entity list
// ============================================================================

entityCmd
  .command("list")
  .description("List entities with optional filters")
  .option("--type <type>", "Filter by entity type")
  .option("--project <path>", "Filter by project")
  .option("--search <query>", "Search by name or description")
  .option("--limit <n>", "Max results", parseInt)
  .option("--format <fmt>", "Output format: compact, json, csv, yaml")
  .action((opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const projectPath = (opts.project as string | undefined) || globalOpts.project;
      let projectId: string | undefined;
      if (projectPath) {
        const project = getProject(resolve(projectPath));
        if (project) projectId = project.id;
      }

      const entities = listEntities({
        type: opts.type as EntityType | undefined,
        project_id: projectId,
        search: opts.search as string | undefined,
        limit: opts.limit as number | undefined,
      });

      const fmt = getOutputFormat(opts.format as string | undefined);

      if (fmt === "json") {
        outputJson(entities);
        return;
      }

      if (fmt === "csv") {
        console.log("id,type,name,description");
        for (const e of entities) {
          const desc = (e.description || "").replace(/"/g, '""');
          console.log(`${e.id.slice(0, 8)},${e.type},"${e.name}","${desc}"`);
        }
        return;
      }

      if (fmt === "yaml") {
        outputYaml(entities);
        return;
      }

      if (entities.length === 0) {
        console.log(chalk.yellow("No entities found."));
        return;
      }

      console.log(chalk.bold(`${entities.length} entit${entities.length === 1 ? "y" : "ies"}:`));
      for (const e of entities) {
        const id = chalk.dim(e.id.slice(0, 8));
        const desc = e.description ? chalk.dim(` (${e.description})`) : "";
        console.log(`${id}  ${colorEntityType(e.type)}  ${e.name}${desc}`);
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// entity delete <nameOrId>
// ============================================================================

entityCmd
  .command("delete <nameOrId>")
  .description("Delete an entity and cascade its relations and memory links")
  .option("--type <type>", "Entity type hint for name lookup")
  .action((nameOrId: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const entity = resolveEntityArg(nameOrId, opts.type as EntityType | undefined);
      deleteEntity(entity.id);

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson({ deleted: entity.id, name: entity.name });
      } else {
        console.log(chalk.green(`Deleted entity: ${entity.name} (${entity.id.slice(0, 8)}) — relations and memory links cascaded`));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// entity merge <source> <target>
// ============================================================================

entityCmd
  .command("merge <source> <target>")
  .description("Merge source entity into target (moves relations and memory links)")
  .action((source: string, target: string) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const srcEntity = resolveEntityArg(source);
      const tgtEntity = resolveEntityArg(target);
      const merged = mergeEntities(srcEntity.id, tgtEntity.id);

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson(merged);
      } else {
        console.log(chalk.green(`Merged: ${srcEntity.name} → ${merged.name} (${merged.id.slice(0, 8)})`));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// entity link <entity> <memoryKeyOrId>
// ============================================================================

entityCmd
  .command("link <entity> <memoryKeyOrId>")
  .description("Link an entity to a memory")
  .option("--role <role>", "Link role: subject, object, context", "context")
  .option("--type <type>", "Entity type hint for name lookup")
  .action((entityArg: string, memoryKeyOrId: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const entity = resolveEntityArg(entityArg, opts.type as EntityType | undefined);

      // Resolve memory by key or partial ID
      const memory = resolveKeyOrId(memoryKeyOrId, {}, globalOpts);
      if (!memory) {
        console.error(chalk.red(`Memory not found: ${memoryKeyOrId}`));
        process.exit(1);
      }

      const link = linkEntityToMemory(entity.id, memory.id, opts.role as "subject" | "object" | "context");

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson(link);
      } else {
        console.log(chalk.green(`Linked: ${entity.name} ↔ ${memory.key} (role: ${link.role})`));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// Relation commands
// ============================================================================

const relationCmd = program.command("relation").description("Knowledge graph relation commands");

// ============================================================================
// relation create <source> <target>
// ============================================================================

relationCmd
  .command("create <source> <target>")
  .description("Create a relation between two entities")
  .requiredOption("--type <relationType>", "Relation type: uses, knows, depends_on, created_by, related_to, contradicts, part_of, implements")
  .option("--weight <n>", "Relation weight (default: 1.0)", parseFloat)
  .action((source: string, target: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const srcEntity = resolveEntityArg(source);
      const tgtEntity = resolveEntityArg(target);

      const relation = createRelation({
        source_entity_id: srcEntity.id,
        target_entity_id: tgtEntity.id,
        relation_type: opts.type as RelationType,
        weight: opts.weight as number | undefined,
      });

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson(relation);
      } else {
        console.log(chalk.green(`Relation: ${srcEntity.name} —[${relation.relation_type}]→ ${tgtEntity.name} (${relation.id.slice(0, 8)})`));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// relation list <entityNameOrId>
// ============================================================================

relationCmd
  .command("list <entityNameOrId>")
  .description("List relations for an entity")
  .option("--type <relationType>", "Filter by relation type")
  .option("--direction <dir>", "Direction: outgoing, incoming, both", "both")
  .option("--format <fmt>", "Output format: compact, json, csv, yaml")
  .action((entityNameOrId: string, opts) => {
    try {
      const entity = resolveEntityArg(entityNameOrId);

      const relations = listRelations({
        entity_id: entity.id,
        relation_type: opts.type as RelationType | undefined,
        direction: opts.direction as "outgoing" | "incoming" | "both",
      });

      const fmt = getOutputFormat(opts.format as string | undefined);

      if (fmt === "json") {
        outputJson(relations);
        return;
      }

      if (fmt === "csv") {
        console.log("id,source,target,type,weight");
        for (const r of relations) {
          console.log(`${r.id.slice(0, 8)},${r.source_entity_id.slice(0, 8)},${r.target_entity_id.slice(0, 8)},${r.relation_type},${r.weight}`);
        }
        return;
      }

      if (fmt === "yaml") {
        outputYaml(relations);
        return;
      }

      if (relations.length === 0) {
        console.log(chalk.yellow(`No relations found for: ${entity.name}`));
        return;
      }

      // Resolve entity names for display
      const entityCache = new Map<string, Entity>();
      entityCache.set(entity.id, entity);
      const resolveName = (id: string): string => {
        if (entityCache.has(id)) return entityCache.get(id)!.name;
        try {
          const e = getEntity(id);
          entityCache.set(id, e);
          return e.name;
        } catch {
          return id.slice(0, 8);
        }
      };

      console.log(chalk.bold(`${relations.length} relation${relations.length === 1 ? "" : "s"} for ${entity.name}:`));
      for (const r of relations) {
        const src = resolveName(r.source_entity_id);
        const tgt = resolveName(r.target_entity_id);
        const id = chalk.dim(r.id.slice(0, 8));
        const weight = r.weight !== 1.0 ? chalk.dim(` w:${r.weight}`) : "";
        console.log(`${id}  ${src} —[${chalk.cyan(r.relation_type)}]→ ${tgt}${weight}`);
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// relation delete <id>
// ============================================================================

relationCmd
  .command("delete <id>")
  .description("Delete a relation by ID")
  .action((id: string) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const db = getDatabase();
      const resolvedId = resolvePartialId(db, "relations", id);
      if (!resolvedId) {
        console.error(chalk.red(`Relation not found: ${id}`));
        process.exit(1);
      }

      deleteRelation(resolvedId);

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson({ deleted: resolvedId });
      } else {
        console.log(chalk.green(`Deleted relation: ${resolvedId.slice(0, 8)}`));
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// Graph commands
// ============================================================================

const graphCmd = program.command("graph").description("Knowledge graph traversal commands");

// ============================================================================
// graph show <entityNameOrId>
// ============================================================================

graphCmd
  .command("show <entityNameOrId>")
  .description("Show connected entities as an indented tree")
  .option("--depth <n>", "Traversal depth (default: 2)", parseInt)
  .action((entityNameOrId: string, opts) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const entity = resolveEntityArg(entityNameOrId);
      const depth = (opts.depth as number | undefined) || 2;
      const graph = getEntityGraph(entity.id, depth);

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson(graph);
        return;
      }

      if (graph.entities.length === 0) {
        console.log(chalk.yellow(`No graph data for: ${entity.name}`));
        return;
      }

      // Build adjacency list for tree display
      const adj = new Map<string, { entity: Entity; relation: string }[]>();
      const entityMap = new Map<string, Entity>();
      for (const e of graph.entities) {
        entityMap.set(e.id, e);
        adj.set(e.id, []);
      }
      for (const r of graph.relations) {
        const srcList = adj.get(r.source_entity_id);
        const tgtList = adj.get(r.target_entity_id);
        if (srcList && entityMap.has(r.target_entity_id)) {
          srcList.push({ entity: entityMap.get(r.target_entity_id)!, relation: r.relation_type });
        }
        if (tgtList && entityMap.has(r.source_entity_id)) {
          tgtList.push({ entity: entityMap.get(r.source_entity_id)!, relation: r.relation_type });
        }
      }

      // BFS tree print
      const visited = new Set<string>();
      const printTree = (id: string, indent: string, isLast: boolean) => {
        const e = entityMap.get(id);
        if (!e) return;
        visited.add(id);

        const prefix = indent === "" ? "" : (isLast ? "└── " : "├── ");
        const label = `[${colorEntityType(e.type)}] ${e.name}`;
        console.log(`${indent}${prefix}${label}`);

        const children = (adj.get(id) || []).filter((c) => !visited.has(c.entity.id));
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!;
          const childIndent = indent + (indent === "" ? "" : (isLast ? "    " : "│   "));
          const relLabel = chalk.dim(` (${child.relation})`);
          const childPrefix = i === children.length - 1 ? "└── " : "├── ";
          visited.add(child.entity.id);
          console.log(`${childIndent}${childPrefix}[${colorEntityType(child.entity.type)}] ${child.entity.name}${relLabel}`);

          // Recurse one more level for nested children
          const grandChildren = (adj.get(child.entity.id) || []).filter((c) => !visited.has(c.entity.id));
          for (let j = 0; j < grandChildren.length; j++) {
            const gc = grandChildren[j]!;
            const gcIndent = childIndent + (i === children.length - 1 ? "    " : "│   ");
            const gcPrefix = j === grandChildren.length - 1 ? "└── " : "├── ";
            const gcRelLabel = chalk.dim(` (${gc.relation})`);
            visited.add(gc.entity.id);
            console.log(`${gcIndent}${gcPrefix}[${colorEntityType(gc.entity.type)}] ${gc.entity.name}${gcRelLabel}`);
          }
        }
      };

      printTree(entity.id, "", true);
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// graph path <from> <to>
// ============================================================================

graphCmd
  .command("path <from> <to>")
  .description("Show shortest path between two entities")
  .action((from: string, to: string) => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const fromEntity = resolveEntityArg(from);
      const toEntity = resolveEntityArg(to);
      const path = findPath(fromEntity.id, toEntity.id);

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson(path);
        return;
      }

      if (!path) {
        console.log(chalk.yellow(`No path found between ${fromEntity.name} and ${toEntity.name}`));
        return;
      }

      console.log(chalk.bold(`Path (${path.length} hop${path.length === 1 ? "" : "s"}):`));
      for (let i = 0; i < path.length; i++) {
        const e = path[i]!;
        const arrow = i < path.length - 1 ? " →" : "";
        console.log(`  ${i + 1}. [${colorEntityType(e.type)}] ${e.name}${arrow}`);
      }
    } catch (e) {
      handleError(e);
    }
  });

// ============================================================================
// graph stats
// ============================================================================

graphCmd
  .command("stats")
  .description("Show knowledge graph statistics")
  .action(() => {
    try {
      const globalOpts = program.opts<GlobalOpts>();
      const db = getDatabase();

      // Entity counts by type
      const entityRows = db.query(
        "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC"
      ).all() as { type: string; count: number }[];

      // Relation counts by type
      const relationRows = db.query(
        "SELECT relation_type, COUNT(*) as count FROM relations GROUP BY relation_type ORDER BY count DESC"
      ).all() as { relation_type: string; count: number }[];

      // Total memory links
      const linkCount = db.query(
        "SELECT COUNT(*) as count FROM entity_memories"
      ).get() as { count: number };

      const totalEntities = entityRows.reduce((sum, r) => sum + r.count, 0);
      const totalRelations = relationRows.reduce((sum, r) => sum + r.count, 0);

      if (globalOpts.json || globalOpts.format === "json") {
        outputJson({
          entities: { total: totalEntities, by_type: Object.fromEntries(entityRows.map((r) => [r.type, r.count])) },
          relations: { total: totalRelations, by_type: Object.fromEntries(relationRows.map((r) => [r.relation_type, r.count])) },
          memory_links: linkCount.count,
        });
        return;
      }

      console.log(chalk.bold("Knowledge Graph Stats"));
      console.log();

      console.log(chalk.bold(`Entities: ${totalEntities}`));
      for (const r of entityRows) {
        console.log(`  ${colorEntityType(r.type)}: ${r.count}`);
      }

      console.log();
      console.log(chalk.bold(`Relations: ${totalRelations}`));
      for (const r of relationRows) {
        console.log(`  ${chalk.cyan(r.relation_type)}: ${r.count}`);
      }

      console.log();
      console.log(chalk.bold(`Memory links: ${linkCount.count}`));
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
// Profile commands — MEMENTOS_PROFILE support
// ============================================================================

const profileCmd = program.command("profile").description("Manage memory profiles (isolated DBs per context)");

profileCmd
  .command("list")
  .description("List all available profiles")
  .action(() => {
    const profiles = listProfiles();
    const active = getActiveProfile();
    if (profiles.length === 0) {
      console.log(chalk.dim("No profiles yet. Create one with: mementos profile set <name>"));
      return;
    }
    console.log(chalk.bold("Profiles:"));
    for (const p of profiles) {
      const marker = p === active ? chalk.green(" ✓ (active)") : "";
      console.log(`  ${p}${marker}`);
    }
    if (!active) {
      console.log(chalk.dim("\n  (no active profile — using default DB)"));
    }
  });

profileCmd
  .command("get")
  .description("Show the currently active profile")
  .action(() => {
    const active = getActiveProfile();
    if (active) {
      console.log(chalk.green(`Active profile: ${active}`));
      if (!process.env["MEMENTOS_PROFILE"]) {
        console.log(chalk.dim("(persisted in ~/.mementos/config.json)"));
      } else {
        console.log(chalk.dim("(from MEMENTOS_PROFILE env var)"));
      }
    } else {
      console.log(chalk.dim("No active profile — using default DB (~/.mementos/mementos.db)"));
    }
  });

profileCmd
  .command("set <name>")
  .description("Switch to a named profile (creates the DB on first use)")
  .action((name: string) => {
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!clean) {
      console.error(chalk.red("Invalid profile name. Use letters, numbers, hyphens, underscores."));
      process.exit(1);
    }
    setActiveProfile(clean);
    console.log(chalk.green(`✓ Switched to profile: ${clean}`));
    console.log(chalk.dim(`  DB: ~/.mementos/profiles/${clean}.db (created on first use)`));
  });

profileCmd
  .command("unset")
  .description("Clear the active profile (revert to default DB)")
  .action(() => {
    const was = getActiveProfile();
    setActiveProfile(null);
    if (was) {
      console.log(chalk.green(`✓ Cleared profile (was: ${was})`));
    } else {
      console.log(chalk.dim("No active profile was set."));
    }
    console.log(chalk.dim("  Now using default DB: ~/.mementos/mementos.db"));
  });

profileCmd
  .command("delete <name>")
  .description("Delete a profile and its DB file (irreversible)")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (name: string, opts: { yes?: boolean }) => {
    if (!opts.yes) {
      const profiles = listProfiles();
      if (!profiles.includes(name)) {
        console.error(chalk.red(`Profile not found: ${name}`));
        process.exit(1);
      }
      // Simple readline confirmation
      process.stdout.write(chalk.yellow(`Delete profile "${name}" and its DB? This cannot be undone. [y/N] `));
      const answer = await new Promise<string>((resolve) => {
        process.stdin.once("data", (d) => resolve(d.toString().trim().toLowerCase()));
      });
      if (answer !== "y" && answer !== "yes") {
        console.log(chalk.dim("Cancelled."));
        return;
      }
    }
    const deleted = deleteProfile(name);
    if (deleted) {
      console.log(chalk.green(`✓ Profile "${name}" deleted.`));
    } else {
      console.error(chalk.red(`Profile not found: ${name}`));
      process.exit(1);
    }
  });

// ============================================================================
// Parse and run
// ============================================================================

program.parse(process.argv);
