process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resetDatabase, getDatabase } from "../db/database.js";
import { loadConfig, DEFAULT_CONFIG, getActiveProfile, setActiveProfile, listProfiles, deleteProfile, getDbPath } from "./config.js";

const CONFIG_DIR = join(homedir(), ".mementos");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
  // Clear env overrides before each test
  delete process.env.MEMENTOS_DEFAULT_SCOPE;
  delete process.env.MEMENTOS_DEFAULT_CATEGORY;
  delete process.env.MEMENTOS_DEFAULT_IMPORTANCE;
});

afterEach(() => {
  delete process.env.MEMENTOS_DEFAULT_SCOPE;
  delete process.env.MEMENTOS_DEFAULT_CATEGORY;
  delete process.env.MEMENTOS_DEFAULT_IMPORTANCE;
});

describe("loadConfig", () => {
  test("returns defaults when no config file", () => {
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.default_scope).toBeDefined();
    expect(config.default_category).toBeDefined();
    expect(config.default_importance).toBeDefined();
    expect(config.max_entries).toBeDefined();
    expect(config.injection).toBeDefined();
    expect(config.sync_agents).toBeDefined();
    expect(config.auto_cleanup).toBeDefined();
  });

  test('default_scope is "private"', () => {
    const config = loadConfig();
    expect(config.default_scope).toBe("private");
  });

  test('default_category is "knowledge"', () => {
    const config = loadConfig();
    expect(config.default_category).toBe("knowledge");
  });

  test("default_importance is 5", () => {
    const config = loadConfig();
    expect(config.default_importance).toBe(5);
  });

  test("max_entries is 1000", () => {
    const config = loadConfig();
    expect(config.max_entries).toBe(1000);
  });

  test("injection defaults correct", () => {
    const config = loadConfig();
    expect(config.injection.max_tokens).toBe(500);
    expect(config.injection.min_importance).toBe(5);
    expect(config.injection.categories).toEqual(["preference", "fact"]);
    expect(config.injection.refresh_interval).toBe(5);
  });

  test("sync_agents defaults correct", () => {
    const config = loadConfig();
    expect(config.sync_agents).toEqual(["claude", "codex", "gemini"]);
  });

  test("env override MEMENTOS_DEFAULT_SCOPE", () => {
    process.env.MEMENTOS_DEFAULT_SCOPE = "global";
    const config = loadConfig();
    expect(config.default_scope).toBe("global");
  });

  test("env override MEMENTOS_DEFAULT_CATEGORY", () => {
    process.env.MEMENTOS_DEFAULT_CATEGORY = "preference";
    const config = loadConfig();
    expect(config.default_category).toBe("preference");
  });

  test("env override MEMENTOS_DEFAULT_IMPORTANCE", () => {
    process.env.MEMENTOS_DEFAULT_IMPORTANCE = "8";
    const config = loadConfig();
    expect(config.default_importance).toBe(8);
  });

  test("env override MEMENTOS_DEFAULT_IMPORTANCE ignores invalid values", () => {
    process.env.MEMENTOS_DEFAULT_IMPORTANCE = "not-a-number";
    const config = loadConfig();
    expect(config.default_importance).toBe(5);
  });

  test("env override MEMENTOS_DEFAULT_IMPORTANCE ignores out-of-range values", () => {
    process.env.MEMENTOS_DEFAULT_IMPORTANCE = "15";
    const config = loadConfig();
    expect(config.default_importance).toBe(5);
  });

  test("env override MEMENTOS_DEFAULT_SCOPE ignores invalid scope", () => {
    process.env.MEMENTOS_DEFAULT_SCOPE = "invalid-scope";
    const config = loadConfig();
    expect(config.default_scope).toBe("private");
  });

  test("env override MEMENTOS_DEFAULT_CATEGORY ignores invalid category", () => {
    process.env.MEMENTOS_DEFAULT_CATEGORY = "invalid-category";
    const config = loadConfig();
    expect(config.default_category).toBe("knowledge");
  });
});

describe("DEFAULT_CONFIG", () => {
  test("has all required fields", () => {
    expect(DEFAULT_CONFIG.default_scope).toBeDefined();
    expect(DEFAULT_CONFIG.default_category).toBeDefined();
    expect(DEFAULT_CONFIG.default_importance).toBeDefined();
    expect(DEFAULT_CONFIG.max_entries).toBeDefined();
    expect(DEFAULT_CONFIG.max_entries_per_scope).toBeDefined();
    expect(DEFAULT_CONFIG.injection).toBeDefined();
    expect(DEFAULT_CONFIG.sync_agents).toBeDefined();
    expect(DEFAULT_CONFIG.auto_cleanup).toBeDefined();
  });

  test("max_entries_per_scope adds up", () => {
    const { global: g, shared: s, private: p } =
      DEFAULT_CONFIG.max_entries_per_scope;
    const total = g + s + p;
    expect(total).toBe(1000);
    expect(total).toBe(DEFAULT_CONFIG.max_entries);
  });

  test("max_entries_per_scope has all scopes", () => {
    expect(DEFAULT_CONFIG.max_entries_per_scope.global).toBe(500);
    expect(DEFAULT_CONFIG.max_entries_per_scope.shared).toBe(300);
    expect(DEFAULT_CONFIG.max_entries_per_scope.private).toBe(200);
  });

  test("auto_cleanup defaults", () => {
    expect(DEFAULT_CONFIG.auto_cleanup.enabled).toBe(true);
    expect(DEFAULT_CONFIG.auto_cleanup.expired_check_interval).toBe(3600);
  });

  test("injection categories are valid", () => {
    const validCategories = ["preference", "fact", "knowledge", "history"];
    for (const cat of DEFAULT_CONFIG.injection.categories) {
      expect(validCategories).toContain(cat);
    }
  });
});

// ============================================================================
// getDbPath — exercises the config module's getDbPath and helpers
// ============================================================================

import { getDbPath } from "./config.js";

describe("getDbPath", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env["MEMENTOS_DB_PATH"] = ":memory:";
    delete process.env["MEMENTOS_DB_SCOPE"];
  });

  test("returns env MEMENTOS_DB_PATH when set", () => {
    process.env["MEMENTOS_DB_PATH"] = "/tmp/custom.db";
    const p = getDbPath();
    // resolve() will make it absolute
    expect(p).toContain("custom.db");
  });

  test("returns :memory: path resolved", () => {
    process.env["MEMENTOS_DB_PATH"] = ":memory:";
    const p = getDbPath();
    // resolve(":memory:") produces an absolute path containing ":memory:"
    expect(p).toContain(":memory:");
  });

  test("with MEMENTOS_DB_SCOPE=project and git root found, returns project path", () => {
    delete process.env["MEMENTOS_DB_PATH"];
    process.env["MEMENTOS_DB_SCOPE"] = "project";
    // We're running inside a git repo, so it should find .git
    const origCwd = process.cwd();
    try {
      // cwd is the project root which has .git
      process.chdir("/Users/hasna/Workspace/hasna/opensource/opensourcedev/open-mementos");
      const p = getDbPath();
      expect(p).toContain(".mementos");
      expect(p).toContain("mementos.db");
    } finally {
      process.chdir(origCwd);
      process.env["MEMENTOS_DB_PATH"] = ":memory:";
    }
  });

  test("with MEMENTOS_DB_SCOPE=project and no git root, falls back", () => {
    delete process.env["MEMENTOS_DB_PATH"];
    process.env["MEMENTOS_DB_SCOPE"] = "project";
    const origCwd = process.cwd();
    try {
      process.chdir("/tmp");
      const p = getDbPath();
      expect(p).toContain("mementos.db");
    } finally {
      process.chdir(origCwd);
      process.env["MEMENTOS_DB_PATH"] = ":memory:";
    }
  });

  test("fallback to ~/.mementos/mementos.db when no env, no local db, no git", () => {
    delete process.env["MEMENTOS_DB_PATH"];
    delete process.env["MEMENTOS_DB_SCOPE"];
    const origCwd = process.cwd();
    try {
      process.chdir("/tmp");
      const p = getDbPath();
      expect(p).toContain(".mementos");
      expect(p).toContain("mementos.db");
    } finally {
      process.chdir(origCwd);
      process.env["MEMENTOS_DB_PATH"] = ":memory:";
    }
  });
});

// ============================================================================
// deepMerge — tested indirectly via loadConfig with file config
// ============================================================================

describe("loadConfig deepMerge behavior", () => {
  test("env override MEMENTOS_DEFAULT_IMPORTANCE with 0 is out of range", () => {
    process.env.MEMENTOS_DEFAULT_IMPORTANCE = "0";
    const config = loadConfig();
    expect(config.default_importance).toBe(5); // 0 is out of 1-10 range
  });

  test("env override MEMENTOS_DEFAULT_IMPORTANCE with negative is ignored", () => {
    process.env.MEMENTOS_DEFAULT_IMPORTANCE = "-1";
    const config = loadConfig();
    expect(config.default_importance).toBe(5);
  });

  test("env override MEMENTOS_DEFAULT_IMPORTANCE at boundary 1", () => {
    process.env.MEMENTOS_DEFAULT_IMPORTANCE = "1";
    const config = loadConfig();
    expect(config.default_importance).toBe(1);
  });

  test("env override MEMENTOS_DEFAULT_IMPORTANCE at boundary 10", () => {
    process.env.MEMENTOS_DEFAULT_IMPORTANCE = "10";
    const config = loadConfig();
    expect(config.default_importance).toBe(10);
  });

  test("env override MEMENTOS_DEFAULT_IMPORTANCE at boundary 11 is ignored", () => {
    process.env.MEMENTOS_DEFAULT_IMPORTANCE = "11";
    const config = loadConfig();
    expect(config.default_importance).toBe(5);
  });

  test("env override MEMENTOS_DEFAULT_SCOPE with shared", () => {
    process.env.MEMENTOS_DEFAULT_SCOPE = "shared";
    const config = loadConfig();
    expect(config.default_scope).toBe("shared");
  });

  test("env override MEMENTOS_DEFAULT_CATEGORY with history", () => {
    process.env.MEMENTOS_DEFAULT_CATEGORY = "history";
    const config = loadConfig();
    expect(config.default_category).toBe("history");
  });

  test("env override MEMENTOS_DEFAULT_CATEGORY with fact", () => {
    process.env.MEMENTOS_DEFAULT_CATEGORY = "fact";
    const config = loadConfig();
    expect(config.default_category).toBe("fact");
  });
});

// ============================================================================
// loadConfig with file-based config (deep merge, malformed JSON, etc.)
// ============================================================================

describe("loadConfig with config file", () => {
  let configExistedBefore: boolean;
  let originalContent: string | null = null;

  beforeEach(() => {
    configExistedBefore = existsSync(CONFIG_PATH);
    if (configExistedBefore) {
      const { readFileSync } = require("node:fs");
      originalContent = readFileSync(CONFIG_PATH, "utf-8");
    }
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Restore original state
    if (configExistedBefore && originalContent !== null) {
      writeFileSync(CONFIG_PATH, originalContent, "utf-8");
    } else if (!configExistedBefore && existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
    }
  });

  test("reads and deep merges config file overrides", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        default_scope: "global",
        max_entries: 2000,
        injection: { max_tokens: 1000 },
      }),
      "utf-8"
    );
    const config = loadConfig();
    expect(config.default_scope).toBe("global");
    expect(config.max_entries).toBe(2000);
    // Deep merged: injection.max_tokens overridden, other injection fields from defaults
    expect(config.injection.max_tokens).toBe(1000);
    expect(config.injection.min_importance).toBe(5); // default preserved
  });

  test("deep merge handles nested objects", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        auto_cleanup: {
          expired_check_interval: 7200,
        },
      }),
      "utf-8"
    );
    const config = loadConfig();
    // Overridden
    expect(config.auto_cleanup.expired_check_interval).toBe(7200);
    // Default preserved through deep merge
    expect(config.auto_cleanup.enabled).toBe(true);
    expect(config.auto_cleanup.unused_archive_days).toBe(7);
  });

  test("deep merge handles array override (replaces, not merges)", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        sync_agents: ["only-claude"],
      }),
      "utf-8"
    );
    const config = loadConfig();
    expect(config.sync_agents).toEqual(["only-claude"]);
  });

  test("handles malformed JSON gracefully", () => {
    writeFileSync(CONFIG_PATH, "{ not valid json !!!", "utf-8");
    const config = loadConfig();
    // Should fall back to defaults
    expect(config.default_scope).toBe("private");
    expect(config.max_entries).toBe(1000);
  });

  test("handles empty JSON object", () => {
    writeFileSync(CONFIG_PATH, "{}", "utf-8");
    const config = loadConfig();
    // All defaults should be preserved
    expect(config.default_scope).toBe("private");
    expect(config.default_category).toBe("knowledge");
    expect(config.default_importance).toBe(5);
  });

  test("env vars take priority over file config", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ default_scope: "global" }),
      "utf-8"
    );
    process.env.MEMENTOS_DEFAULT_SCOPE = "shared";
    const config = loadConfig();
    // Env var wins over file config
    expect(config.default_scope).toBe("shared");
  });

  test("deep merge with max_entries_per_scope partial override", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        max_entries_per_scope: { global: 800 },
      }),
      "utf-8"
    );
    const config = loadConfig();
    expect(config.max_entries_per_scope.global).toBe(800);
    // Other scope entries preserved via deep merge
    expect(config.max_entries_per_scope.shared).toBe(300);
    expect(config.max_entries_per_scope.private).toBe(200);
  });
});

// ============================================================================
// Profile management
// ============================================================================

describe("profile management", () => {
  beforeEach(() => {
    // Clear MEMENTOS_PROFILE env var before each test
    delete process.env["MEMENTOS_PROFILE"];
    // Reset active profile in config
    try { setActiveProfile(null); } catch { /* ignore */ }
  });

  afterEach(() => {
    delete process.env["MEMENTOS_PROFILE"];
    try { setActiveProfile(null); } catch { /* ignore */ }
  });

  test("getActiveProfile returns null by default", () => {
    expect(getActiveProfile()).toBeNull();
  });

  test("setActiveProfile persists and getActiveProfile reads it back", () => {
    setActiveProfile("test-profile-galba");
    expect(getActiveProfile()).toBe("test-profile-galba");
    // cleanup
    setActiveProfile(null);
  });

  test("setActiveProfile(null) clears the active profile", () => {
    setActiveProfile("temp-profile");
    setActiveProfile(null);
    expect(getActiveProfile()).toBeNull();
  });

  test("MEMENTOS_PROFILE env var takes priority over persisted profile", () => {
    setActiveProfile("persisted-profile");
    process.env["MEMENTOS_PROFILE"] = "env-profile";
    expect(getActiveProfile()).toBe("env-profile");
    setActiveProfile(null);
  });

  test("listProfiles returns empty array when no profiles exist", () => {
    const profiles = listProfiles();
    expect(Array.isArray(profiles)).toBe(true);
  });

  test("deleteProfile returns false for non-existent profile", () => {
    expect(deleteProfile("nonexistent-profile-xyz")).toBe(false);
  });

  test("listProfiles finds a created profile DB file", () => {
    // Create a real profile DB file in the profiles dir
    const profilesPath = join(homedir(), ".mementos", "profiles");
    mkdirSync(profilesPath, { recursive: true });
    const dbPath = join(profilesPath, "galba-test-profile-001.db");
    writeFileSync(dbPath, ""); // empty file simulates a profile DB
    try {
      const profiles = listProfiles();
      expect(profiles).toContain("galba-test-profile-001");
    } finally {
      // cleanup
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  test("deleteProfile removes the DB file and returns true", () => {
    const profilesPath = join(homedir(), ".mementos", "profiles");
    mkdirSync(profilesPath, { recursive: true });
    const dbPath = join(profilesPath, "galba-delete-test-002.db");
    writeFileSync(dbPath, "");
    expect(existsSync(dbPath)).toBe(true);
    const result = deleteProfile("galba-delete-test-002");
    expect(result).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("deleteProfile clears active profile if deleted profile was active", () => {
    const profilesPath = join(homedir(), ".mementos", "profiles");
    mkdirSync(profilesPath, { recursive: true });
    const dbPath = join(profilesPath, "galba-active-delete-003.db");
    writeFileSync(dbPath, "");
    setActiveProfile("galba-active-delete-003");
    expect(getActiveProfile()).toBe("galba-active-delete-003");
    deleteProfile("galba-active-delete-003");
    // active profile cleared after delete
    expect(getActiveProfile()).toBeNull();
  });

  test("getDbPath returns profile path when profile is active", () => {
    // Temporarily unset MEMENTOS_DB_PATH so profile path takes effect
    const savedDbPath = process.env["MEMENTOS_DB_PATH"];
    delete process.env["MEMENTOS_DB_PATH"];
    try {
      setActiveProfile("galba-db-path-test");
      const dbPath = getDbPath();
      expect(dbPath).toContain("profiles");
      expect(dbPath).toContain("galba-db-path-test");
    } finally {
      setActiveProfile(null);
      if (savedDbPath) process.env["MEMENTOS_DB_PATH"] = savedDbPath;
    }
  });
});
