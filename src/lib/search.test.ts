process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { searchMemories } from "./search.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

describe("searchMemories", () => {
  test("exact key match scores highest", () => {
    createMemory({ key: "editor", value: "vim is preferred" });
    createMemory({ key: "editor-config", value: "some config" });
    createMemory({ key: "other", value: "editor mentioned in value" });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Exact key match should be first
    expect(results[0]!.memory.key).toBe("editor");
    expect(results[0]!.match_type).toBe("exact");
  });

  test("key contains query", () => {
    createMemory({ key: "preferred-editor-settings", value: "vim" });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("preferred-editor-settings");
    expect(results[0]!.match_type).toBe("fuzzy");
  });

  test("tag match", () => {
    createMemory({ key: "my-tool", value: "some tool", tags: ["editor"] });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.match_type).toBe("tag");
  });

  test("summary match", () => {
    createMemory({
      key: "tool-pref",
      value: "vim",
      summary: "The user prefers a specific editor",
    });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("tool-pref");
  });

  test("value match", () => {
    createMemory({ key: "note", value: "Use the editor for code" });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("note");
  });

  test("scores weighted by importance", () => {
    // Same match type (value match) but different importance
    createMemory({
      key: "low-imp",
      value: "uses typescript",
      importance: 2,
    });
    createMemory({
      key: "high-imp",
      value: "uses typescript",
      importance: 9,
    });

    const results = searchMemories("typescript");
    expect(results.length).toBe(2);
    // Higher importance should rank first because score is weighted
    expect(results[0]!.memory.key).toBe("high-imp");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  test("with scope filter", () => {
    createMemory({ key: "global-mem", value: "typescript", scope: "global" });
    createMemory({
      key: "private-mem",
      value: "typescript",
      scope: "private",
    });

    const results = searchMemories("typescript", { scope: "global" });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("global-mem");
  });

  test("with category filter", () => {
    createMemory({
      key: "pref-mem",
      value: "typescript",
      category: "preference",
    });
    createMemory({
      key: "fact-mem",
      value: "typescript",
      category: "fact",
    });

    const results = searchMemories("typescript", { category: "preference" });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("pref-mem");
  });

  test("with tag filter", () => {
    createMemory({
      key: "tagged",
      value: "typescript info",
      tags: ["lang"],
    });
    createMemory({
      key: "untagged",
      value: "typescript info",
      tags: ["other"],
    });

    const results = searchMemories("typescript", { tags: ["lang"] });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("tagged");
  });

  test("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      createMemory({
        key: `item-${i}`,
        value: "typescript related",
        scope: "private",
      });
    }

    const results = searchMemories("typescript", { limit: 3 });
    expect(results.length).toBe(3);
  });

  test("empty results for no match", () => {
    createMemory({ key: "hello", value: "world" });

    const results = searchMemories("zzzznotfound");
    expect(results).toEqual([]);
  });

  test("case-insensitive matching", () => {
    createMemory({ key: "TypeScript", value: "A programming language" });

    const results = searchMemories("typescript");
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("TypeScript");
    expect(results[0]!.match_type).toBe("exact");
  });

  test("special characters in query", () => {
    createMemory({ key: "c++ config", value: "compiler flags for c++" });

    const results = searchMemories("c++");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("c++ config");
  });

  test("multiple matching memories ranked correctly", () => {
    // exact key match (score 10 + 3 value bonus) * imp/10
    createMemory({
      key: "rust",
      value: "rust is a systems language",
      importance: 5,
    });
    // key contains (score 7) * imp/10
    createMemory({
      key: "rust-config",
      value: "some config",
      importance: 5,
    });
    // tag match (score 6) * imp/10
    createMemory({
      key: "systems-lang",
      value: "low-level coding",
      tags: ["rust"],
      importance: 5,
    });
    // value only match (score 3) * imp/10
    createMemory({
      key: "note",
      value: "I like rust",
      importance: 5,
    });

    const results = searchMemories("rust");
    expect(results.length).toBe(4);
    // Exact key match should be first (highest score)
    expect(results[0]!.memory.key).toBe("rust");
    // Key-contains should be second
    expect(results[1]!.memory.key).toBe("rust-config");
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  test("only returns active memories", () => {
    const mem = createMemory({ key: "active-mem", value: "golang info" });
    createMemory({ key: "archived-mem", value: "golang info" });

    // Archive the second memory directly via DB
    const db = getDatabase(":memory:");
    db.run("UPDATE memories SET status = 'archived' WHERE key = 'archived-mem'");

    const results = searchMemories("golang");
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("active-mem");
  });

  test("does not return expired memories", () => {
    createMemory({
      key: "fresh",
      value: "python info",
    });
    createMemory({
      key: "expired",
      value: "python info",
      expires_at: "2020-01-01T00:00:00.000Z",
    });

    const results = searchMemories("python");
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("fresh");
  });

  test("additive scoring across multiple fields", () => {
    // This memory matches in key (exact=10), value (3), so raw=13
    createMemory({
      key: "docker",
      value: "docker compose setup",
      importance: 5,
    });
    // This memory only matches in value (3)
    createMemory({
      key: "setup",
      value: "uses docker for dev",
      importance: 5,
    });

    const results = searchMemories("docker");
    expect(results.length).toBe(2);
    expect(results[0]!.memory.key).toBe("docker");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  test("tag + value match scores higher than value-only match", () => {
    createMemory({
      key: "tool-a",
      value: "uses kubernetes",
      tags: ["kubernetes"],
      importance: 5,
    });
    createMemory({
      key: "tool-b",
      value: "uses kubernetes",
      importance: 5,
    });

    const results = searchMemories("kubernetes");
    expect(results.length).toBe(2);
    // tag(6) + value(3) = 9 vs value-only(3) = 3
    expect(results[0]!.memory.key).toBe("tool-a");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  test("with min_importance filter", () => {
    createMemory({
      key: "low",
      value: "react info",
      importance: 2,
    });
    createMemory({
      key: "high",
      value: "react info",
      importance: 8,
    });

    const results = searchMemories("react", { min_importance: 5 });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("high");
  });

  test("with agent_id filter", () => {
    // Register agents in the DB first
    const db = getDatabase(":memory:");
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["agent-1", "alpha"]
    );
    db.run(
      "INSERT INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      ["agent-2", "beta"]
    );

    createMemory({
      key: "agent1-mem",
      value: "vue framework",
      agent_id: "agent-1",
    });
    createMemory({
      key: "agent2-mem",
      value: "vue framework",
      agent_id: "agent-2",
    });

    const results = searchMemories("vue", { agent_id: "agent-1" });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("agent1-mem");
  });

  test("with project_id filter", () => {
    const db = getDatabase(":memory:");
    db.run(
      "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      ["proj-1", "Project A", "/tmp/a"]
    );
    db.run(
      "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      ["proj-2", "Project B", "/tmp/b"]
    );

    createMemory({
      key: "proj1-mem",
      value: "angular framework",
      project_id: "proj-1",
    });
    createMemory({
      key: "proj2-mem",
      value: "angular framework",
      project_id: "proj-2",
    });

    const results = searchMemories("angular", { project_id: "proj-1" });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("proj1-mem");
  });

  test("summary contains query adds to score", () => {
    createMemory({
      key: "note-with-summary",
      value: "some unrelated value",
      summary: "This is about svelte framework",
      importance: 5,
    });
    createMemory({
      key: "note-no-summary",
      value: "svelte framework info",
      importance: 5,
    });

    const results = searchMemories("svelte");
    expect(results.length).toBe(2);
    // First has summary(4) = 4, second has value(3) = 3
    expect(results[0]!.memory.key).toBe("note-with-summary");
  });

  test("pinned filter works", () => {
    const mem = createMemory({ key: "pinned-mem", value: "nextjs info" });
    createMemory({ key: "unpinned-mem", value: "nextjs info" });

    // Pin the first memory
    const db = getDatabase(":memory:");
    db.run("UPDATE memories SET pinned = 1 WHERE key = 'pinned-mem'");

    const results = searchMemories("nextjs", { pinned: true });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("pinned-mem");
  });

  test("offset works with limit", () => {
    for (let i = 0; i < 5; i++) {
      createMemory({
        key: `offset-item-${i}`,
        value: "nuxt framework",
        importance: 5,
      });
    }

    const all = searchMemories("nuxt");
    expect(all.length).toBe(5);

    const page = searchMemories("nuxt", { offset: 2, limit: 2 });
    expect(page.length).toBe(2);
    expect(page[0]!.memory.id).toBe(all[2]!.memory.id);
    expect(page[1]!.memory.id).toBe(all[3]!.memory.id);
  });
});
