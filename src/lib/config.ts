import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { MementosConfig, MemoryCategory, MemoryScope } from "../types";

// ============================================================================
// Default configuration
// ============================================================================

export const DEFAULT_CONFIG: MementosConfig = {
  default_scope: "private",
  default_category: "knowledge",
  default_importance: 5,
  max_entries: 1000,
  max_entries_per_scope: {
    global: 500,
    shared: 300,
    private: 200,
  },
  injection: {
    max_tokens: 500,
    min_importance: 5,
    categories: ["preference", "fact"],
    refresh_interval: 5,
  },
  sync_agents: ["claude", "codex", "gemini"],
  auto_cleanup: {
    enabled: true,
    expired_check_interval: 3600,
    unused_archive_days: 7,
    stale_deprioritize_days: 14,
  },
};

// ============================================================================
// Deep merge utility
// ============================================================================

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result as T;
}

// ============================================================================
// Validators
// ============================================================================

const VALID_SCOPES: MemoryScope[] = ["global", "shared", "private"];
const VALID_CATEGORIES: MemoryCategory[] = [
  "preference",
  "fact",
  "knowledge",
  "history",
];

function isValidScope(value: string): value is MemoryScope {
  return VALID_SCOPES.includes(value as MemoryScope);
}

function isValidCategory(value: string): value is MemoryCategory {
  return VALID_CATEGORIES.includes(value as MemoryCategory);
}

// ============================================================================
// loadConfig — reads config file + env overrides
// ============================================================================

export function loadConfig(): MementosConfig {
  const configPath = join(homedir(), ".mementos", "config.json");

  let fileConfig: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Malformed config — fall through to defaults
    }
  }

  // Deep merge: file config overrides defaults
  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    fileConfig
  ) as unknown as MementosConfig;

  // Environment variable overrides (highest priority)
  const envScope = process.env["MEMENTOS_DEFAULT_SCOPE"];
  if (envScope && isValidScope(envScope)) {
    merged.default_scope = envScope;
  }

  const envCategory = process.env["MEMENTOS_DEFAULT_CATEGORY"];
  if (envCategory && isValidCategory(envCategory)) {
    merged.default_category = envCategory;
  }

  const envImportance = process.env["MEMENTOS_DEFAULT_IMPORTANCE"];
  if (envImportance) {
    const parsed = parseInt(envImportance, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 10) {
      merged.default_importance = parsed;
    }
  }

  return merged;
}

// ============================================================================
// findFileWalkingUp — walk up from cwd looking for a path
// ============================================================================

function findFileWalkingUp(filename: string): string | null {
  let dir = process.cwd();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

// ============================================================================
// findGitRoot — find the nearest .git directory walking up
// ============================================================================

function findGitRoot(): string | null {
  let dir = process.cwd();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// ============================================================================
// getDbPath — resolve the database file path
// ============================================================================

export function getDbPath(): string {
  // 1. MEMENTOS_DB_PATH env var — highest priority
  const envDbPath = process.env["MEMENTOS_DB_PATH"];
  if (envDbPath) {
    const resolved = resolve(envDbPath);
    ensureDir(dirname(resolved));
    return resolved;
  }

  // 2. MEMENTOS_DB_SCOPE=project — force git-root/.mementos/mementos.db
  const dbScope = process.env["MEMENTOS_DB_SCOPE"];
  if (dbScope === "project") {
    const gitRoot = findGitRoot();
    if (gitRoot) {
      const dbPath = join(gitRoot, ".mementos", "mementos.db");
      ensureDir(dirname(dbPath));
      return dbPath;
    }
    // No git root found — fall through to walking up / home
  }

  // 3. Walk up from cwd looking for .mementos/mementos.db
  const found = findFileWalkingUp(join(".mementos", "mementos.db"));
  if (found) {
    return found;
  }

  // 4. Fallback — ~/.mementos/mementos.db
  const fallback = join(homedir(), ".mementos", "mementos.db");
  ensureDir(dirname(fallback));
  return fallback;
}

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
