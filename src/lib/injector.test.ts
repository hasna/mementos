process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory, getMemory } from "../db/memories.js";
import { MemoryInjector } from "./injector.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { MementosConfig } from "../types/index.js";

let db: ReturnType<typeof getDatabase>;

function makeConfig(overrides?: Partial<MementosConfig>): MementosConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as MementosConfig;
}

beforeEach(() => {
  resetDatabase();
  db = getDatabase(":memory:");
});

describe("MemoryInjector", () => {
  test("returns empty string when no memories", () => {
    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({ db });
    expect(result).toBe("");
  });

  test("injects global memories", () => {
    createMemory({
      key: "global-pref",
      value: "use typescript",
      scope: "global",
      category: "preference",
      importance: 7,
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({ db });
    expect(result).toContain("global-pref");
    expect(result).toContain("use typescript");
    expect(result).toContain("<agent-memories>");
    expect(result).toContain("</agent-memories>");
  });

  test("injects shared memories when project_id provided", () => {
    db.run(
      "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      ["proj-1", "TestProject", "/tmp/test"]
    );

    createMemory({
      key: "shared-fact",
      value: "project uses bun",
      scope: "shared",
      category: "fact",
      importance: 7,
      project_id: "proj-1",
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({
      project_id: "proj-1",
      db,
    });
    expect(result).toContain("shared-fact");
    expect(result).toContain("project uses bun");
  });

  test("injects private memories when agent_id provided", () => {
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["agent-a", "maximus"]
    );

    createMemory({
      key: "private-pref",
      value: "prefers vim",
      scope: "private",
      category: "preference",
      importance: 7,
      agent_id: "agent-a",
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({
      agent_id: "agent-a",
      db,
    });
    expect(result).toContain("private-pref");
    expect(result).toContain("prefers vim");
  });

  test("respects min_importance threshold", () => {
    createMemory({
      key: "low-imp",
      value: "minor note",
      scope: "global",
      category: "fact",
      importance: 2,
    });
    createMemory({
      key: "high-imp",
      value: "important note",
      scope: "global",
      category: "fact",
      importance: 8,
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    // Default min_importance is 5, so importance=2 should be excluded
    const result = injector.getInjectionContext({ db });
    expect(result).toContain("high-imp");
    expect(result).not.toContain("low-imp");
  });

  test("respects category filter", () => {
    createMemory({
      key: "pref-mem",
      value: "likes dark mode",
      scope: "global",
      category: "preference",
      importance: 7,
    });
    createMemory({
      key: "history-mem",
      value: "ran tests yesterday",
      scope: "global",
      category: "history",
      importance: 7,
    });

    // DEFAULT_CONFIG categories are ["preference", "fact"] — no "history"
    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({ db });
    expect(result).toContain("pref-mem");
    expect(result).not.toContain("history-mem");
  });

  test("respects max_tokens budget (truncates)", () => {
    // Create many memories that together exceed a small token budget
    for (let i = 0; i < 50; i++) {
      createMemory({
        key: `mem-${i}`,
        value: "A".repeat(100), // 100 chars of value per memory
        scope: "global",
        category: "preference",
        importance: 7,
      });
    }

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    // Use very small token budget: 50 tokens * 4 chars = 200 chars
    const result = injector.getInjectionContext({ max_tokens: 50, db });

    // Should have some memories but not all 50
    const lineCount = result
      .split("\n")
      .filter((l) => l.startsWith("- [")).length;
    expect(lineCount).toBeGreaterThan(0);
    expect(lineCount).toBeLessThan(50);
  });

  test("pinned memories come first", () => {
    createMemory({
      key: "unpinned",
      value: "regular note",
      scope: "global",
      category: "preference",
      importance: 9,
    });

    const pinnedMem = createMemory({
      key: "pinned",
      value: "important pinned note",
      scope: "global",
      category: "preference",
      importance: 5,
    });

    // Pin the memory
    db.run("UPDATE memories SET pinned = 1 WHERE id = ?", [pinnedMem.id]);

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({ db });

    const pinnedIdx = result.indexOf("pinned:");
    const unpinnedIdx = result.indexOf("unpinned:");
    // Pinned should appear before unpinned despite lower importance
    expect(pinnedIdx).toBeLessThan(unpinnedIdx);
  });

  test("dedup across refresh windows", () => {
    createMemory({
      key: "dedup-test",
      value: "should appear once",
      scope: "global",
      category: "fact",
      importance: 7,
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);

    const first = injector.getInjectionContext({ db });
    expect(first).toContain("dedup-test");

    // Second call should NOT include the same memory (already injected)
    const second = injector.getInjectionContext({ db });
    expect(second).toBe("");
  });

  test("resetDedup clears tracking", () => {
    createMemory({
      key: "reset-test",
      value: "should reappear",
      scope: "global",
      category: "fact",
      importance: 7,
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);

    const first = injector.getInjectionContext({ db });
    expect(first).toContain("reset-test");

    injector.resetDedup();

    const second = injector.getInjectionContext({ db });
    expect(second).toContain("reset-test");
  });

  test("updates access count on injected memories", () => {
    const mem = createMemory({
      key: "access-test",
      value: "track access",
      scope: "global",
      category: "preference",
      importance: 7,
    });

    expect(mem.access_count).toBe(0);

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    injector.getInjectionContext({ db });

    const updated = getMemory(mem.id, db);
    expect(updated).not.toBeNull();
    expect(updated!.access_count).toBe(1);
  });

  test("output wrapped in agent-memories tags", () => {
    createMemory({
      key: "wrap-test",
      value: "test value",
      scope: "global",
      category: "fact",
      importance: 7,
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({ db });

    expect(result.startsWith("<agent-memories>\n")).toBe(true);
    expect(result.endsWith("\n</agent-memories>")).toBe(true);
  });

  test("scope isolation (private not visible to other agents)", () => {
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["agent-x", "agentX"]
    );
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["agent-y", "agentY"]
    );

    createMemory({
      key: "agent-x-secret",
      value: "only for agent-x",
      scope: "private",
      category: "preference",
      importance: 7,
      agent_id: "agent-x",
    });

    // Agent Y should not see agent X's private memories
    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({
      agent_id: "agent-y",
      db,
    });
    expect(result).not.toContain("agent-x-secret");
  });

  test("getInjectedCount returns correct count", () => {
    createMemory({
      key: "count-1",
      value: "first",
      scope: "global",
      category: "preference",
      importance: 7,
    });
    createMemory({
      key: "count-2",
      value: "second",
      scope: "global",
      category: "fact",
      importance: 7,
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    expect(injector.getInjectedCount()).toBe(0);

    injector.getInjectionContext({ db });
    expect(injector.getInjectedCount()).toBe(2);
  });

  test("combines global and shared and private memories", () => {
    db.run(
      "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      ["proj-x", "ProjX", "/tmp/px"]
    );
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["agent-z", "agentZ"]
    );

    createMemory({
      key: "global-mem",
      value: "everyone sees this",
      scope: "global",
      category: "fact",
      importance: 7,
    });
    createMemory({
      key: "shared-mem",
      value: "project sees this",
      scope: "shared",
      category: "fact",
      importance: 7,
      project_id: "proj-x",
    });
    createMemory({
      key: "private-mem",
      value: "agent sees this",
      scope: "private",
      category: "preference",
      importance: 7,
      agent_id: "agent-z",
    });

    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const result = injector.getInjectionContext({
      project_id: "proj-x",
      agent_id: "agent-z",
      db,
    });

    expect(result).toContain("global-mem");
    expect(result).toContain("shared-mem");
    expect(result).toContain("private-mem");
    expect(injector.getInjectedCount()).toBe(3);
  });

  test("custom categories via options override config", () => {
    createMemory({
      key: "history-mem",
      value: "ran build yesterday",
      scope: "global",
      category: "history",
      importance: 7,
    });

    // DEFAULT_CONFIG only includes preference + fact
    const injector = new MemoryInjector(DEFAULT_CONFIG);
    const withDefault = injector.getInjectionContext({ db });
    expect(withDefault).not.toContain("history-mem");

    injector.resetDedup();

    const withOverride = injector.getInjectionContext({
      categories: ["history"],
      db,
    });
    expect(withOverride).toContain("history-mem");
  });
});
