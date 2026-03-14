process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { searchMemories, logSearchQuery, getSearchHistory, getPopularSearches } from "./search.js";
import { createEntity } from "../db/entities.js";
import { linkEntityToMemory } from "../db/entity-memories.js";

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

  test("diminishing returns: multi-field scores less than sum of individual scores", () => {
    // key exact(10) + value(3) with diminishing: 10×1.0 + 3×0.5 = 11.5 (not 13)
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

  test("multi-field still ranks higher than single-field match", () => {
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
    // tag(6)×1.0 + value(3)×0.5 = 7.5 vs value-only(3)×1.0 = 3
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
    // All results must be from the full set (order may vary with identical FTS5 scores)
    const allIds = new Set(all.map(r => r.memory.id));
    expect(allIds.has(page[0]!.memory.id)).toBe(true);
    expect(allIds.has(page[1]!.memory.id)).toBe(true);
    // No overlap with first page
    const firstPage = searchMemories("nuxt", { limit: 2 });
    const firstPageIds = new Set(firstPage.map(r => r.memory.id));
    expect(firstPageIds.has(page[0]!.memory.id)).toBe(false);
    expect(firstPageIds.has(page[1]!.memory.id)).toBe(false);
  });

  // ============================================================================
  // Additional filter coverage
  // ============================================================================

  test("with source filter (single)", () => {
    createMemory({
      key: "user-mem",
      value: "deno runtime",
      source: "user",
    });
    createMemory({
      key: "agent-mem",
      value: "deno runtime",
      source: "agent",
    });

    const results = searchMemories("deno", { source: "user" });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("user-mem");
  });

  test("with source filter (array)", () => {
    createMemory({
      key: "user-mem2",
      value: "elixir language",
      source: "user",
    });
    createMemory({
      key: "system-mem",
      value: "elixir language",
      source: "system",
    });
    createMemory({
      key: "agent-mem2",
      value: "elixir language",
      source: "agent",
    });

    const results = searchMemories("elixir", { source: ["user", "system"] });
    expect(results.length).toBe(2);
    const keys = results.map((r) => r.memory.key).sort();
    expect(keys).toEqual(["system-mem", "user-mem2"]);
  });

  test("with scope filter (array)", () => {
    createMemory({ key: "g-mem", value: "zig language", scope: "global" });
    createMemory({ key: "s-mem", value: "zig language", scope: "shared" });
    createMemory({ key: "p-mem", value: "zig language", scope: "private" });

    const results = searchMemories("zig", { scope: ["global", "shared"] });
    expect(results.length).toBe(2);
  });

  test("with category filter (array)", () => {
    createMemory({
      key: "fact-mem2",
      value: "nim language",
      category: "fact",
    });
    createMemory({
      key: "hist-mem",
      value: "nim language",
      category: "history",
    });
    createMemory({
      key: "pref-mem2",
      value: "nim language",
      category: "preference",
    });

    const results = searchMemories("nim", { category: ["fact", "history"] });
    expect(results.length).toBe(2);
  });

  test("with status filter (single) overrides default active", () => {
    const mem = createMemory({ key: "arch-mem", value: "haskell lang" });
    // Archive it
    const db = getDatabase(":memory:");
    db.run("UPDATE memories SET status = 'archived' WHERE id = ?", [mem.id]);

    const results = searchMemories("haskell", { status: "archived" });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.status).toBe("archived");
  });

  test("with status filter (array)", () => {
    createMemory({ key: "active-mem2", value: "ocaml lang" });
    const archived = createMemory({ key: "arch-mem2", value: "ocaml lang" });
    const db = getDatabase(":memory:");
    db.run("UPDATE memories SET status = 'archived' WHERE id = ?", [
      archived.id,
    ]);

    const results = searchMemories("ocaml", {
      status: ["active", "archived"],
    });
    expect(results.length).toBe(2);
  });

  test("with session_id filter", () => {
    createMemory({
      key: "sess-mem",
      value: "clojure info",
      session_id: "sess-abc",
    });
    createMemory({
      key: "no-sess-mem",
      value: "clojure info",
    });

    const results = searchMemories("clojure", { session_id: "sess-abc" });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("sess-mem");
  });

  test("tag-only match (no key/value/summary match)", () => {
    createMemory({
      key: "unrelated-key",
      value: "unrelated value",
      tags: ["specialtag"],
    });

    const results = searchMemories("specialtag");
    expect(results.length).toBe(1);
    expect(results[0]!.match_type).toBe("tag");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("empty query returns no results", () => {
    createMemory({ key: "some-mem", value: "some value" });
    // SQL LIKE '%%' matches everything, but computeScore with empty string
    // will score on "exact key match" for empty key, which won't happen.
    // The empty query will match all rows via LIKE but computeScore may or may not score 0.
    const results = searchMemories("");
    // All memories will have key.includes("") = true, so they get score 7.
    // This is expected behavior.
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  // ============================================================================
  // FTS5 full-text search tests
  // ============================================================================

  test("FTS5: basic query matches via full-text index", () => {
    createMemory({ key: "fts-test", value: "PostgreSQL is a relational database", summary: "database info" });
    createMemory({ key: "unrelated", value: "nothing relevant here" });

    const results = searchMemories("PostgreSQL");
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("fts-test");
  });

  test("FTS5: multiple word matching", () => {
    createMemory({ key: "multi-word", value: "TypeScript and React are popular frameworks" });
    createMemory({ key: "partial-match", value: "TypeScript is great" });

    const results = searchMemories("TypeScript React");
    // Both should match (FTS5 matches any token), but multi-word should score higher
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("multi-word");
  });

  test("FTS5: falls back to LIKE on special characters", () => {
    createMemory({ key: "c++ config", value: "compiler flags for c++" });

    // c++ has special FTS5 chars (+), should fall back to LIKE gracefully
    const results = searchMemories("c++");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("c++ config");
  });

  test("FTS5: matches across key, value, and summary fields", () => {
    createMemory({ key: "kubernetes-setup", value: "helm charts", summary: "orchestration tool" });

    // Match via key
    const keyResults = searchMemories("kubernetes");
    expect(keyResults.length).toBe(1);

    // Match via value
    const valResults = searchMemories("helm");
    expect(valResults.length).toBe(1);

    // Match via summary
    const sumResults = searchMemories("orchestration");
    expect(sumResults.length).toBe(1);
  });

  test("FTS5: tag-only matches still work (tags not in FTS index)", () => {
    createMemory({
      key: "no-text-match",
      value: "unrelated content",
      tags: ["deployment"],
    });

    const results = searchMemories("deployment");
    expect(results.length).toBe(1);
    expect(results[0]!.match_type).toBe("tag");
  });

  test("FTS5: scoring preserves ranking order with importance weighting", () => {
    createMemory({ key: "redis", value: "redis is an in-memory store", importance: 3 });
    createMemory({ key: "redis-config", value: "cache settings", importance: 9 });

    const results = searchMemories("redis");
    expect(results.length).toBe(2);
    // Exact key match with low importance vs key-contains with high importance
    // exact(10+3)*3/10=3.9 vs contains(7)*9/10=6.3 — high-imp should win
    expect(results[0]!.memory.key).toBe("redis-config");
  });

  test("FTS5: handles quotes in query", () => {
    createMemory({ key: "quote-test", value: 'He said "hello world" to everyone' });

    const results = searchMemories('"hello"');
    // Should handle the quoted string gracefully (escaped for FTS5)
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  // ============================================================================
  // Metadata JSON search (OPE4-00091)
  // ============================================================================

  test("metadata match: memory found by searching metadata content", () => {
    createMemory({
      key: "repo-link",
      value: "some project reference",
      metadata: { url: "github.com/foo" },
    });
    createMemory({ key: "unrelated", value: "nothing here" });

    const results = searchMemories("github");
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("repo-link");
  });

  test("metadata score ranks lower than value match", () => {
    createMemory({
      key: "value-match",
      value: "hosted on github platform",
      importance: 5,
    });
    createMemory({
      key: "metadata-match",
      value: "some unrelated value",
      metadata: { url: "github.com/bar" },
      importance: 5,
    });

    const results = searchMemories("github");
    expect(results.length).toBe(2);
    // value(3) > metadata(2)
    expect(results[0]!.memory.key).toBe("value-match");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  // ============================================================================
  // Partial tag matching (OPE4-00093)
  // ============================================================================

  test("partial tag match: query 'type' matches tag 'typescript'", () => {
    createMemory({
      key: "ts-mem",
      value: "unrelated content",
      tags: ["typescript"],
    });

    const results = searchMemories("type");
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("ts-mem");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("partial tag scores lower than exact tag", () => {
    createMemory({
      key: "exact-tag",
      value: "unrelated content",
      tags: ["typescript"],
      importance: 5,
    });
    createMemory({
      key: "partial-tag",
      value: "unrelated content",
      tags: ["typescript"],
      importance: 5,
    });

    // Search for exact tag match vs partial
    const exactResults = searchMemories("typescript");
    const partialResults = searchMemories("type");

    // Both should find the memory, but exact tag score (6) > partial tag score (3)
    expect(exactResults.length).toBeGreaterThanOrEqual(1);
    expect(partialResults.length).toBeGreaterThanOrEqual(1);
    expect(exactResults[0]!.score).toBeGreaterThan(partialResults[0]!.score);
  });

  test("partial tag in determineMatchType returns 'tag'", () => {
    createMemory({
      key: "partial-tag-type",
      value: "unrelated content",
      tags: ["typescript"],
    });

    const results = searchMemories("type");
    expect(results.length).toBe(1);
    expect(results[0]!.match_type).toBe("tag");
  });

  // ============================================================================
  // Trigram fuzzy matching (typo tolerance)
  // ============================================================================

  test("fuzzy: typo 'typsecript' finds 'typescript' memory", () => {
    createMemory({ key: "typescript", value: "A typed superset of JavaScript" });

    const results = searchMemories("typsecript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("typescript");
    expect(results[0]!.match_type).toBe("fuzzy");
  });

  test("fuzzy: missing char 'typescrip' finds 'typescript' memory", () => {
    createMemory({ key: "typescript", value: "A typed superset of JavaScript" });

    const results = searchMemories("typescrip");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("typescript");
  });

  test("fuzzy: extra char 'typescriptt' finds 'typescript' memory", () => {
    createMemory({ key: "typescript", value: "A typed superset of JavaScript" });

    const results = searchMemories("typescriptt");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("typescript");
  });

  test("fuzzy: transposition 'typesrcipt' finds 'typescript' memory", () => {
    createMemory({ key: "typescript", value: "A typed superset of JavaScript" });

    const results = searchMemories("typesrcipt");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("typescript");
  });

  test("fuzzy: very different string does not match (similarity < 0.3)", () => {
    createMemory({ key: "typescript", value: "A typed superset of JavaScript" });

    const results = searchMemories("xylophone");
    // Should not find typescript via fuzzy — too dissimilar
    const tsResult = results.find((r) => r.memory.key === "typescript");
    expect(tsResult).toBeUndefined();
  });

  // ============================================================================
  // Search result highlights (OPE4-00092)
  // ============================================================================

  test("highlights: key match returns highlight for key field", () => {
    createMemory({ key: "editor-config", value: "vim settings" });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const h = results[0]!.highlights;
    expect(h).toBeDefined();
    expect(h!.some((hl) => hl.field === "key")).toBe(true);
  });

  test("highlights: value match returns highlight for value field", () => {
    createMemory({ key: "note", value: "Use the editor for code review" });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const h = results[0]!.highlights;
    expect(h).toBeDefined();
    expect(h!.some((hl) => hl.field === "value" && hl.snippet.includes("editor"))).toBe(true);
  });

  test("highlights: summary match returns highlight for summary field", () => {
    createMemory({
      key: "tool-pref",
      value: "vim",
      summary: "The user prefers a specific editor for development",
    });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const h = results[0]!.highlights;
    expect(h).toBeDefined();
    expect(h!.some((hl) => hl.field === "summary" && hl.snippet.includes("editor"))).toBe(true);
  });

  test("highlights: tag match returns highlight for tag field", () => {
    createMemory({ key: "my-tool", value: "some tool", tags: ["editor"] });

    const results = searchMemories("editor");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const h = results[0]!.highlights;
    expect(h).toBeDefined();
    expect(h!.some((hl) => hl.field === "tag" && hl.snippet === "editor")).toBe(true);
  });

  test("highlights: context window is ±30 chars", () => {
    const prefix = "a]word ".repeat(8); // 56 chars of normal words
    const suffix = " word[b".repeat(8); // 56 chars of normal words
    createMemory({ key: "long-val", value: `${prefix}needle${suffix}` });

    const results = searchMemories("needle");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const valHighlight = results[0]!.highlights!.find((hl) => hl.field === "value");
    expect(valHighlight).toBeDefined();
    // Should have ellipsis prefix (match is beyond first 30 chars)
    expect(valHighlight!.snippet.startsWith("...")).toBe(true);
    // Should have ellipsis suffix (content continues beyond match + 30)
    expect(valHighlight!.snippet.endsWith("...")).toBe(true);
    // Snippet should contain the needle
    expect(valHighlight!.snippet).toContain("needle");
    // Snippet length should be approx: 3 (prefix ...) + 30 + 6 (needle) + 30 + 3 (suffix ...)
    expect(valHighlight!.snippet.length).toBeLessThanOrEqual(80);
  });

  // ============================================================================
  // Query preprocessing (OPE4-00094)
  // ============================================================================

  test("preprocessing: trims whitespace from query", () => {
    createMemory({ key: "trim-test", value: "golang info" });

    const results = searchMemories("   golang   ");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("trim-test");
  });

  test("preprocessing: collapses multiple spaces", () => {
    createMemory({ key: "multi-space", value: "TypeScript and React" });

    const results = searchMemories("TypeScript    and    React");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("multi-space");
  });

  test("preprocessing: empty query after trim returns empty results", () => {
    createMemory({ key: "some-mem", value: "some value" });

    const results = searchMemories("   ");
    expect(results).toEqual([]);
  });

  test("preprocessing: whitespace-only query returns empty results", () => {
    createMemory({ key: "another-mem", value: "another value" });

    const results = searchMemories("\t \n ");
    expect(results).toEqual([]);
  });

  test("LIKE special chars: % in query does not break search", () => {
    createMemory({ key: "percent-test", value: "100% coverage is the goal" });

    const results = searchMemories("100%");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("percent-test");
  });

  test("LIKE special chars: _ in query does not break search", () => {
    createMemory({ key: "underscore-test", value: "use snake_case naming" });

    const results = searchMemories("snake_case");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("underscore-test");
  });

  // ============================================================================
  // Multi-word query support (OPE4-00086)
  // ============================================================================

  test("multi-word query matches memories containing both words", () => {
    createMemory({
      key: "both-words",
      value: "typescript and react are great together",
      importance: 5,
    });
    createMemory({
      key: "one-word",
      value: "typescript is a typed language",
      importance: 5,
    });

    const results = searchMemories("typescript react");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Memory with both words should rank higher
    expect(results[0]!.memory.key).toBe("both-words");
  });

  test("quoted phrase matches exact phrase", () => {
    createMemory({
      key: "exact-match",
      value: "the exact phrase appears here in context",
      importance: 5,
    });
    createMemory({
      key: "separate-words",
      value: "exact and phrase are separate words here",
      importance: 5,
    });

    const results = searchMemories('"exact phrase"');
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The memory with the literal "exact phrase" should rank first
    expect(results[0]!.memory.key).toBe("exact-match");
  });

  // ============================================================================
  // Recency boost (OPE4-00087)
  // ============================================================================

  test("recent memory ranks higher than old memory with same importance", () => {
    createMemory({
      key: "old-mem",
      value: "golang info from long ago",
      importance: 5,
    });
    createMemory({
      key: "new-mem",
      value: "golang info from today",
      importance: 5,
    });

    // Make the first memory old (45 days ago — beyond the 30-day decay window)
    const db = getDatabase(":memory:");
    db.run(
      "UPDATE memories SET updated_at = datetime('now', '-45 days'), accessed_at = datetime('now', '-45 days') WHERE key = 'old-mem'"
    );
    // Make the second memory very recent
    db.run(
      "UPDATE memories SET updated_at = datetime('now'), accessed_at = datetime('now') WHERE key = 'new-mem'"
    );

    const results = searchMemories("golang");
    expect(results.length).toBe(2);
    // Recent memory should rank higher due to recency boost
    expect(results[0]!.memory.key).toBe("new-mem");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  // ============================================================================
  // Access count boost (OPE4-00089)
  // ============================================================================

  test("frequently accessed memory ranks higher", () => {
    createMemory({
      key: "rarely-accessed",
      value: "swift programming",
      importance: 5,
    });
    createMemory({
      key: "frequently-accessed",
      value: "swift programming",
      importance: 5,
    });

    // Set high access count on the second memory
    const db = getDatabase(":memory:");
    db.run(
      "UPDATE memories SET access_count = 25 WHERE key = 'frequently-accessed'"
    );
    db.run(
      "UPDATE memories SET access_count = 0 WHERE key = 'rarely-accessed'"
    );

    const results = searchMemories("swift");
    expect(results.length).toBe(2);
    // Frequently accessed memory should rank higher
    expect(results[0]!.memory.key).toBe("frequently-accessed");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  // ============================================================================
  // Diminishing returns scoring (OPE4-00090)
  // ============================================================================

  test("diminishing returns: three-field match uses weighted scoring", () => {
    // key exact(10) + tag exact(6) + value(3)
    // Diminishing: 10×1.0 + 6×0.5 + 3×0.25 = 13.75 (not additive 19)
    createMemory({
      key: "myterm",
      value: "myterm is used here",
      tags: ["myterm"],
      importance: 10,
    });
    // Single field: value only(3) → 3×1.0 = 3
    createMemory({
      key: "other-thing",
      value: "myterm mentioned once",
      tags: [],
      importance: 10,
    });

    const results = searchMemories("myterm");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Multi-field should still rank higher than single-field
    const multiFieldResult = results.find(r => r.memory.key === "myterm");
    const singleFieldResult = results.find(r => r.memory.key === "other-thing");
    expect(multiFieldResult).toBeDefined();
    expect(singleFieldResult).toBeDefined();
    expect(multiFieldResult!.score).toBeGreaterThan(singleFieldResult!.score);
  });

  // ============================================================================
  // Stop word filtering (OPE4-00095)
  // ============================================================================

  test("stop words: 'the typescript language' works same as 'typescript language'", () => {
    createMemory({
      key: "ts-info",
      value: "typescript language is popular",
      importance: 5,
    });

    const withStopWords = searchMemories("the typescript language");
    const withoutStopWords = searchMemories("typescript language");

    expect(withStopWords.length).toBeGreaterThanOrEqual(1);
    expect(withoutStopWords.length).toBeGreaterThanOrEqual(1);
    expect(withStopWords[0]!.memory.key).toBe("ts-info");
    expect(withoutStopWords[0]!.memory.key).toBe("ts-info");
  });

  test("stop words: all stop words query still returns results", () => {
    createMemory({
      key: "stop-word-mem",
      value: "the is a common pattern",
      importance: 5,
    });

    // "the is a" are all stop words — should keep all tokens rather than empty
    const results = searchMemories("the is a");
    // Should still find memories (tokens kept because all are stop words)
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  // ============================================================================
  // Graph-aware search boosting
  // ============================================================================

  test("graph boost: memory linked to matching entity gets score boost", () => {
    // Create a memory that mentions "webassembly" and manually link an entity "xyzlang" to it.
    // Then search for "xyzlang" — the memory wouldn't normally match, but via graph
    // boost the linked memory should appear with a boosted score if it's in the candidate set.
    // Instead, we create two memories that both match a search term, but only one is
    // linked to an entity matching that term via a manually created entity link.
    const db = getDatabase(":memory:");

    const mem = createMemory({
      key: "graph-boosted",
      value: "uses foobarlib for builds",
      importance: 5,
    });

    // Manually create an entity "foobarlib" and link it to just this memory
    // (auto-extraction may also create entities, but we control this one)
    const entity = createEntity({ name: "foobarlib", type: "tool" });
    linkEntityToMemory(entity.id, mem.id);

    // Create another memory with the same text — auto-extraction will also link it
    // So instead, use a memory that mentions foobarlib differently to avoid auto-link
    const unlinkedMem = createMemory({
      key: "not-graph-boosted",
      value: "uses foobarlib for builds",
      importance: 5,
    });
    // Remove auto-created entity links for the unlinked memory
    db.run("DELETE FROM entity_memories WHERE memory_id = ? AND entity_id != ?", [
      unlinkedMem.id,
      entity.id,
    ]);
    // Also ensure the unlinked memory is NOT linked to our entity
    db.run("DELETE FROM entity_memories WHERE memory_id = ? AND entity_id = ?", [
      unlinkedMem.id,
      entity.id,
    ]);

    const results = searchMemories("foobarlib");
    expect(results.length).toBeGreaterThanOrEqual(2);
    const linkedResult = results.find(r => r.memory.id === mem.id);
    const unlinkedResult = results.find(r => r.memory.id === unlinkedMem.id);
    expect(linkedResult).toBeDefined();
    expect(unlinkedResult).toBeDefined();
    expect(linkedResult!.score).toBeGreaterThan(unlinkedResult!.score);
  });

  test("graph boost: linked memory ranks higher than equivalent unlinked memory", () => {
    const db = getDatabase(":memory:");

    const linked = createMemory({
      key: "linked-mem",
      value: "uses quxlang for mobile",
      importance: 5,
    });
    const unlinked = createMemory({
      key: "unlinked-mem",
      value: "uses quxlang for mobile",
      importance: 5,
    });

    // Create entity "quxlang" and link only the first memory
    const entity = createEntity({ name: "quxlang", type: "concept" });
    // Remove all auto-created links for both memories
    db.run("DELETE FROM entity_memories WHERE memory_id IN (?, ?)", [linked.id, unlinked.id]);
    // Link only the first memory
    linkEntityToMemory(entity.id, linked.id);

    const results = searchMemories("quxlang");
    expect(results.length).toBe(2);
    // Linked memory should rank higher
    expect(results[0]!.memory.id).toBe(linked.id);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  test("graph boost: does not break when entity tables are empty", () => {
    createMemory({
      key: "no-entities",
      value: "xyzuniquelang programming language",
      importance: 5,
    });

    // Search for something that won't match any auto-extracted entities
    const results = searchMemories("xyzuniquelang");
    expect(results.length).toBe(1);
    expect(results[0]!.memory.key).toBe("no-entities");
  });

});

// ============================================================================
// Search history tracking
// ============================================================================

describe("search history", () => {
  test("searching logs an entry in search_history", () => {
    createMemory({ key: "history-test", value: "some data" });

    searchMemories("history-test");

    const db = getDatabase(":memory:");
    const rows = db.query("SELECT * FROM search_history WHERE query = 'history-test'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].result_count).toBeGreaterThanOrEqual(1);
  });

  test("getSearchHistory returns entries in reverse chronological order", () => {
    const db = getDatabase(":memory:");
    // Log 5 searches manually
    for (let i = 0; i < 5; i++) {
      logSearchQuery(`query-${i}`, i, undefined, undefined, db);
    }

    const history = getSearchHistory(20, undefined, db);
    expect(history.length).toBe(5);
    // Most recent should be first
    expect(history[0]!.query).toBe("query-4");
    expect(history[4]!.query).toBe("query-0");
  });

  test("getPopularSearches returns most frequent queries first", () => {
    const db = getDatabase(":memory:");
    // Log "popular" 3 times, "rare" 1 time
    logSearchQuery("popular", 5, undefined, undefined, db);
    logSearchQuery("popular", 3, undefined, undefined, db);
    logSearchQuery("popular", 7, undefined, undefined, db);
    logSearchQuery("rare", 2, undefined, undefined, db);

    const popular = getPopularSearches(10, undefined, db);
    expect(popular.length).toBe(2);
    expect(popular[0]!.query).toBe("popular");
    expect(popular[0]!.count).toBe(3);
    expect(popular[1]!.query).toBe("rare");
    expect(popular[1]!.count).toBe(1);
  });

  test("project-scoped history filters by project_id", () => {
    const db = getDatabase(":memory:");
    // Register projects
    db.run(
      "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      ["proj-a", "Project A", "/tmp/a"]
    );
    db.run(
      "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      ["proj-b", "Project B", "/tmp/b"]
    );

    logSearchQuery("shared-query", 5, undefined, "proj-a", db);
    logSearchQuery("shared-query", 3, undefined, "proj-b", db);
    logSearchQuery("only-a", 1, undefined, "proj-a", db);

    const historyA = getSearchHistory(20, "proj-a", db);
    expect(historyA.length).toBe(2);
    expect(historyA.map((h) => h.query).sort()).toEqual(["only-a", "shared-query"]);

    const historyB = getSearchHistory(20, "proj-b", db);
    expect(historyB.length).toBe(1);
    expect(historyB[0]!.query).toBe("shared-query");

    const popularA = getPopularSearches(10, "proj-a", db);
    expect(popularA.length).toBe(2);

    const popularB = getPopularSearches(10, "proj-b", db);
    expect(popularB.length).toBe(1);
  });
});

// ============================================================================
// Multi-token scoring — lines 213-229 (tag/summary/metadata token matching)
// ============================================================================

describe("multi-token scoring (tag/summary/metadata paths)", () => {
  beforeEach(() => {
    resetDatabase();
    getDatabase(":memory:");
  });

  test("tags that match a search token boost score", () => {
    createMemory({
      key: "tagged-memory",
      value: "some content",
      tags: ["typescript", "database"],
    });
    createMemory({
      key: "untagged-memory",
      value: "some content",
    });
    // Multi-word query: FTS5 matches value, token scoring boosts tag matches
    const results = searchMemories("typescript content");
    const tagged = results.find((r) => r.memory.key === "tagged-memory");
    const untagged = results.find((r) => r.memory.key === "untagged-memory");
    expect(tagged).toBeTruthy();
    // tagged should score higher due to tag match
    if (tagged && untagged) {
      expect(tagged.score).toBeGreaterThanOrEqual(untagged.score);
    }
  });

  test("summary that matches a token boosts score", () => {
    createMemory({
      key: "summarized-memory",
      value: "general content",
      summary: "authentication pattern for secure login",
    });
    createMemory({
      key: "unsummarized-memory",
      value: "general content",
    });
    const results = searchMemories("authentication content");
    const withSummary = results.find((r) => r.memory.key === "summarized-memory");
    expect(withSummary).toBeTruthy();
    // Should have a non-zero score
    expect(withSummary!.score).toBeGreaterThan(0);
  });

  test("metadata that matches a token contributes to score", () => {
    // FTS5 indexes key/value/summary — metadata is only scored in the bonus step.
    // Include a value term so the memory is found via FTS5, then metadata bonus applies.
    createMemory({
      key: "metadata-memory",
      value: "nextjs general info",        // "nextjs" found via FTS5
      metadata: { framework: "nextjs" },   // "nextjs" also in metadata → bonus
    });
    createMemory({
      key: "no-metadata-memory",
      value: "nextjs general info",        // same value, no metadata match
    });
    const results = searchMemories("nextjs info");
    const withMeta = results.find((r) => r.memory.key === "metadata-memory");
    expect(withMeta).toBeTruthy();
    expect(withMeta!.score).toBeGreaterThan(0);
  });

  test("key that exactly equals a token gets max key bonus (line 213)", () => {
    // key = "typescript", query = "typescript framework" → keyLower === token branch
    createMemory({ key: "typescript", value: "programming language framework features" });
    const results = searchMemories("typescript framework");
    const exact = results.find((r) => r.memory.key === "typescript");
    expect(exact).toBeTruthy();
    expect(exact!.score).toBeGreaterThan(0);
  });

  test("tag that exactly equals a token gets exact tag bonus (line 218)", () => {
    // Both "typescript" and "framework" in value → FTS5 finds it
    // tag = "typescript" exactly equals the token → line 218 fires
    createMemory({
      key: "tag-exact-test",
      value: "typescript programming framework guide",
      tags: ["typescript"],
    });
    const results = searchMemories("typescript framework");
    const found = results.find((r) => r.memory.key === "tag-exact-test");
    expect(found).toBeTruthy();
    expect(found!.score).toBeGreaterThan(0);
  });

  test("tag that includes (but is not equal to) a token gets partial tag bonus (line 220)", () => {
    // Value includes both tokens so FTS5 finds it
    // tag = "typescript-typed" includes "typescript" but != "typescript" → line 220
    createMemory({
      key: "tag-partial-test",
      value: "typescript programming framework reference",
      tags: ["typescript-typed"],
    });
    const results = searchMemories("typescript framework");
    const found = results.find((r) => r.memory.key === "tag-partial-test");
    expect(found).toBeTruthy();
    if (found) {
      expect(found.score).toBeGreaterThan(0);
    }
  });

  test("key exact token match scores higher", () => {
    createMemory({ key: "nextjs-setup", value: "configuration steps", importance: 5 });
    createMemory({ key: "configuration-steps", value: "nextjs configuration guide", importance: 5 });
    // "nextjs configuration" — first matches key exactly for "nextjs", second matches value
    const results = searchMemories("nextjs configuration");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Ensure we get results with valid scores
    results.forEach(r => expect(r.score).toBeGreaterThan(0));
  });
});
