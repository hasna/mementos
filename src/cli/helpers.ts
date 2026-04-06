import chalk from "chalk";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { getMemory, getMemoryByKey } from "../db/memories.js";
import { getProject } from "../db/projects.js";
import { getEntityByName, getEntity } from "../db/entities.js";
import type { Command } from "commander";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryVersion,
} from "../types/index.js";
import type { Entity, EntityType } from "../types/index.js";

// ============================================================================
// Version
// ============================================================================

export function getPackageVersion(): string {
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
  working: chalk.gray,
};

const categoryColor: Record<MemoryCategory, (s: string) => string> = {
  preference: chalk.blue,
  fact: chalk.green,
  knowledge: chalk.yellow,
  history: chalk.gray,
  procedural: chalk.cyan,
  resource: chalk.magenta,
};

export function importanceColor(importance: number): (s: string) => string {
  if (importance >= 9) return chalk.red.bold;
  if (importance >= 7) return chalk.yellow;
  if (importance >= 5) return chalk.green;
  return chalk.dim;
}

export function colorScope(scope: MemoryScope): string {
  return scopeColor[scope](scope);
}

export function colorCategory(category: MemoryCategory): string {
  return categoryColor[category](category);
}

export function colorImportance(importance: number): string {
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

export function colorEntityType(type: string): string {
  const colorFn = entityTypeColor[type] || chalk.white;
  return colorFn(type);
}

export function resolveEntityArg(nameOrId: string, type?: EntityType): Entity {
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

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Resolve output format from local command flag, global flag, or --json alias.
 * Priority: localFmt > global --format > --json > "compact"
 */
export function getOutputFormat(program: Command, localFmt?: string): string {
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
export function outputYaml(data: unknown): void {
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

export function formatMemoryLine(m: Memory): string {
  const id = chalk.dim(m.id.slice(0, 8));
  const scope = colorScope(m.scope);
  const cat = colorCategory(m.category);
  const imp = colorImportance(m.importance);
  const pin = m.pinned ? chalk.red(" *") : "";
  const value =
    m.value.length > 80 ? m.value.slice(0, 80) + "..." : m.value;
  return `${id} [${scope}/${cat}] ${chalk.bold(m.key)} = ${value} (${imp})${pin}`;
}

export function formatMemoryDetail(m: Memory): string {
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

export function makeHandleError(program: Command): (e: unknown) => never {
  return function handleError(e: unknown): never {
    const globalOpts = program.opts<GlobalOpts>();
    if (globalOpts.json || globalOpts.format === "json") {
      outputJson({
        error: e instanceof Error ? e.message : String(e),
      });
    } else {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    }
    process.exit(1);
  };
}

// ============================================================================
// ID resolution
// ============================================================================

export function resolveMemoryId(partialId: string): string {
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
export function resolveKeyOrId(
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
// Watch helpers
// ============================================================================

export function formatWatchLine(m: Memory): string {
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

export function sendNotification(m: Memory): void {
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
// Types
// ============================================================================

export interface GlobalOpts {
  project?: string;
  json?: boolean;
  format?: string;
  agent?: string;
  session?: string;
}

// ============================================================================
// diff helpers
// ============================================================================

export function diffLines(oldText: string, newText: string): void {
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

export function diffMemory(
  memoryId: string,
  opts: { version?: string },
  globalOpts: GlobalOpts
): void {
  const current = getMemory(memoryId);
  if (!current) {
    console.error(chalk.red(`Memory not found: ${memoryId}`));
    process.exit(1);
  }

  const { getMemoryVersions } = require("../db/memories.js") as typeof import("../db/memories.js");
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
      const prev = versions.find((v: MemoryVersion) => v.version === targetVersion - 1);
      if (!prev) {
        console.error(chalk.red(`No version ${targetVersion - 1} found to compare against.`));
        process.exit(1);
      }
      older = prev;
      newer = current;
      olderVersion = prev.version;
      newerVersion = current.version;
    } else {
      const targetSnap = versions.find((v: MemoryVersion) => v.version === targetVersion);
      const prevSnap = versions.find((v: MemoryVersion) => v.version === targetVersion - 1);

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
    const removed = oldTags.filter((t: string) => !newTags.includes(t));
    const added = newTags.filter((t: string) => !oldTags.includes(t));
    console.log(`  ${chalk.bold("tags:")}`);
    for (const t of removed) console.log(chalk.red(`    - ${t}`));
    for (const t of added) console.log(chalk.green(`    + ${t}`));
  }

  if (!hasChanges) {
    console.log(chalk.dim("  No changes between these versions."));
  }
}

// ============================================================================
// Config helpers
// ============================================================================

export const VALID_SCOPES = ["global", "shared", "private", "working"];
export const VALID_CATEGORIES = ["preference", "fact", "knowledge", "history"];

/** Navigate a nested object using dot-notation key path */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set a nested value using dot-notation key path */
export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
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
export function deleteNestedKey(obj: Record<string, unknown>, path: string): void {
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
export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Validate a config key/value pair against known constraints */
export function validateConfigKeyValue(key: string, value: unknown, DEFAULT_CONFIG: unknown): string | null {
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

export function getConfigPath(): string {
  const { homedir } = require("node:os") as typeof import("node:os");
  return join(homedir(), ".hasna", "mementos", "config.json");
}

export function readFileConfig(): Record<string, unknown> {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeFileConfig(data: Record<string, unknown>): void {
  const { existsSync, writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
