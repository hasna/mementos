process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";

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
