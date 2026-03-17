// Set env BEFORE any imports so the database module picks it up
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetDatabase,
  getDatabase,
  createMemory,
  getMemory,
  getMemoryByKey,
  listMemories,
  updateMemory,
  deleteMemory,
  touchMemory,
  cleanExpiredMemories,
  registerAgent,
  getAgent,
  listAgents,
  registerProject,
  getProject,
  listProjects,
} from "../index.js";
import { searchMemories } from "../lib/search.js";
import { MemoryInjector } from "../lib/injector.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
} from "../types/index.js";
import type {
  CreateMemoryInput,
  Memory,
  MemoryScope,
  MemoryCategory,
} from "../types/index.js";

// ============================================================================
// Test helpers
// ============================================================================

function freshDb() {
  resetDatabase();
  return getDatabase(":memory:");
}

function makeMemory(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    key: `test-key-${crypto.randomUUID().slice(0, 8)}`,
    value: "test value",
    ...overrides,
  };
}

// ============================================================================
// memory_save flow
// ============================================================================

describe("memory_save flow", () => {
  beforeEach(() => { freshDb(); });

  test("save basic memory", () => {
    const m = createMemory({ key: "greeting", value: "hello world" });
    expect(m.key).toBe("greeting");
    expect(m.value).toBe("hello world");
    expect(m.id).toBeTruthy();
    expect(m.version).toBe(1);
    expect(m.status).toBe("active");
  });

  test("save with all options (scope, category, importance, tags, summary, ttl, metadata)", () => {
    const m = createMemory({
      key: "full-options",
      value: "detailed value",
      scope: "global",
      category: "preference",
      importance: 9,
      tags: ["tag1", "tag2"],
      summary: "A summary",
      ttl_ms: 60000,
      metadata: { foo: "bar" },
      source: "user",
    });
    expect(m.scope).toBe("global");
    expect(m.category).toBe("preference");
    expect(m.importance).toBe(9);
    expect(m.tags).toEqual(["tag1", "tag2"]);
    expect(m.summary).toBe("A summary");
    expect(m.expires_at).toBeTruthy();
    expect(m.metadata).toEqual({ foo: "bar" });
    expect(m.source).toBe("user");
  });

  test("upsert: save same key twice updates value", () => {
    const m1 = createMemory({ key: "upsert-key", value: "v1" });
    const m2 = createMemory({ key: "upsert-key", value: "v2" });
    expect(m2.id).toBe(m1.id);
    expect(m2.value).toBe("v2");
    expect(m2.version).toBe(2);
  });

  test("save with scope=global", () => {
    const m = createMemory({ key: "k-global", value: "v", scope: "global" });
    expect(m.scope).toBe("global");
  });

  test("save with scope=shared", () => {
    const m = createMemory({ key: "k-shared", value: "v", scope: "shared" });
    expect(m.scope).toBe("shared");
  });

  test("save with scope=private", () => {
    const m = createMemory({ key: "k-private", value: "v", scope: "private" });
    expect(m.scope).toBe("private");
  });

  test("save with category=preference", () => {
    const m = createMemory({ key: "k-pref", value: "v", category: "preference" });
    expect(m.category).toBe("preference");
  });

  test("save with category=fact", () => {
    const m = createMemory({ key: "k-fact", value: "v", category: "fact" });
    expect(m.category).toBe("fact");
  });

  test("save with category=knowledge", () => {
    const m = createMemory({ key: "k-know", value: "v", category: "knowledge" });
    expect(m.category).toBe("knowledge");
  });

  test("save with category=history", () => {
    const m = createMemory({ key: "k-hist", value: "v", category: "history" });
    expect(m.category).toBe("history");
  });

  test("defaults: scope=private, category=knowledge, importance=5", () => {
    const m = createMemory({ key: "defaults", value: "v" });
    expect(m.scope).toBe("private");
    expect(m.category).toBe("knowledge");
    expect(m.importance).toBe(5);
  });
});

// ============================================================================
// memory_recall flow
// ============================================================================

describe("memory_recall flow", () => {
  beforeEach(() => { freshDb(); });

  test("recall by key", () => {
    createMemory({ key: "recall-me", value: "found it" });
    const m = getMemoryByKey("recall-me");
    expect(m).not.toBeNull();
    expect(m!.value).toBe("found it");
  });

  test("recall returns null for missing key", () => {
    const m = getMemoryByKey("nonexistent");
    expect(m).toBeNull();
  });

  test("recall with scope filter", () => {
    createMemory({ key: "scoped", value: "global-val", scope: "global" });
    createMemory({ key: "scoped", value: "private-val", scope: "private" });
    const m = getMemoryByKey("scoped", "global");
    expect(m).not.toBeNull();
    expect(m!.value).toBe("global-val");
  });

  test("recall with agent filter", () => {
    const agent = registerAgent("recall-agent");
    createMemory({ key: "agent-mem", value: "agent-val", agent_id: agent.id });
    createMemory({ key: "agent-mem", value: "no-agent-val" });
    const m = getMemoryByKey("agent-mem", undefined, agent.id);
    expect(m).not.toBeNull();
    expect(m!.value).toBe("agent-val");
  });
});

// ============================================================================
// memory_list flow
// ============================================================================

describe("memory_list flow", () => {
  beforeEach(() => { freshDb(); });

  test("list all active", () => {
    createMemory({ key: "a1", value: "v1" });
    createMemory({ key: "a2", value: "v2" });
    const list = listMemories();
    expect(list.length).toBe(2);
  });

  test("list with scope filter", () => {
    createMemory({ key: "g1", value: "v", scope: "global" });
    createMemory({ key: "p1", value: "v", scope: "private" });
    const list = listMemories({ scope: "global" });
    expect(list.length).toBe(1);
    expect(list[0]!.scope).toBe("global");
  });

  test("list with category filter", () => {
    createMemory({ key: "f1", value: "v", category: "fact" });
    createMemory({ key: "k1", value: "v", category: "knowledge" });
    const list = listMemories({ category: "fact" });
    expect(list.length).toBe(1);
    expect(list[0]!.category).toBe("fact");
  });

  test("list with tag filter", () => {
    createMemory({ key: "tagged", value: "v", tags: ["important", "work"] });
    createMemory({ key: "untagged", value: "v" });
    const list = listMemories({ tags: ["important"] });
    expect(list.length).toBe(1);
    expect(list[0]!.key).toBe("tagged");
  });

  test("list with importance filter", () => {
    createMemory({ key: "hi", value: "v", importance: 8 });
    createMemory({ key: "lo", value: "v", importance: 2 });
    const list = listMemories({ min_importance: 7 });
    expect(list.length).toBe(1);
    expect(list[0]!.key).toBe("hi");
  });

  test("list with pinned filter", () => {
    const m = createMemory({ key: "pinned-mem", value: "v" });
    updateMemory(m.id, { pinned: true, version: m.version });
    createMemory({ key: "not-pinned", value: "v" });
    const list = listMemories({ pinned: true });
    expect(list.length).toBe(1);
    expect(list[0]!.key).toBe("pinned-mem");
  });

  test("list with limit", () => {
    for (let i = 0; i < 5; i++) {
      createMemory({ key: `item-${i}`, value: `v${i}` });
    }
    const list = listMemories({ limit: 2 });
    expect(list.length).toBe(2);
  });

  test("list with limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      createMemory({ key: `offset-${i}`, value: `v${i}`, importance: 10 - i });
    }
    const all = listMemories();
    // OFFSET requires LIMIT in SQLite, so pass both
    const withOffset = listMemories({ limit: 100, offset: 2 });
    expect(withOffset.length).toBe(3);
    expect(withOffset[0]!.id).toBe(all[2]!.id);
  });

  test("list with combined filters", () => {
    createMemory({ key: "combo1", value: "v", scope: "global", category: "fact", importance: 8, tags: ["alpha"] });
    createMemory({ key: "combo2", value: "v", scope: "global", category: "knowledge", importance: 8, tags: ["alpha"] });
    createMemory({ key: "combo3", value: "v", scope: "private", category: "fact", importance: 8, tags: ["alpha"] });
    const list = listMemories({ scope: "global", category: "fact", tags: ["alpha"], min_importance: 7 });
    expect(list.length).toBe(1);
    expect(list[0]!.key).toBe("combo1");
  });
});

// ============================================================================
// memory_update flow
// ============================================================================

describe("memory_update flow", () => {
  beforeEach(() => { freshDb(); });

  test("update value", () => {
    const m = createMemory({ key: "upd-val", value: "old" });
    const updated = updateMemory(m.id, { value: "new", version: m.version });
    expect(updated.value).toBe("new");
    expect(updated.version).toBe(2);
  });

  test("update importance", () => {
    const m = createMemory({ key: "upd-imp", value: "v" });
    const updated = updateMemory(m.id, { importance: 10, version: m.version });
    expect(updated.importance).toBe(10);
  });

  test("update tags", () => {
    const m = createMemory({ key: "upd-tags", value: "v", tags: ["old"] });
    const updated = updateMemory(m.id, { tags: ["new1", "new2"], version: m.version });
    expect(updated.tags).toEqual(["new1", "new2"]);
  });

  test("update pinned", () => {
    const m = createMemory({ key: "upd-pin", value: "v" });
    expect(m.pinned).toBe(false);
    const updated = updateMemory(m.id, { pinned: true, version: m.version });
    expect(updated.pinned).toBe(true);
  });

  test("update status to archived", () => {
    const m = createMemory({ key: "upd-status", value: "v" });
    const updated = updateMemory(m.id, { status: "archived", version: m.version });
    expect(updated.status).toBe("archived");
  });

  test("version conflict error", () => {
    const m = createMemory({ key: "conflict", value: "v" });
    expect(() => {
      updateMemory(m.id, { value: "new", version: 999 });
    }).toThrow(VersionConflictError);
  });

  test("not found error", () => {
    expect(() => {
      updateMemory("nonexistent-id", { value: "x", version: 1 });
    }).toThrow(MemoryNotFoundError);
  });
});

// ============================================================================
// memory_forget flow
// ============================================================================

describe("memory_forget flow", () => {
  beforeEach(() => { freshDb(); });

  test("delete by id", () => {
    const m = createMemory({ key: "del-me", value: "v" });
    const deleted = deleteMemory(m.id);
    expect(deleted).toBe(true);
    expect(getMemory(m.id)).toBeNull();
  });

  test("delete returns false for non-existent", () => {
    const deleted = deleteMemory("non-existent-id");
    expect(deleted).toBe(false);
  });
});

// ============================================================================
// memory_search flow
// ============================================================================

describe("memory_search flow", () => {
  beforeEach(() => { freshDb(); });

  test("search by key term", () => {
    createMemory({ key: "typescript-config", value: "strict mode" });
    createMemory({ key: "python-setup", value: "venv" });
    const results = searchMemories("typescript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.key).toBe("typescript-config");
  });

  test("search by value content", () => {
    createMemory({ key: "lang-pref", value: "I prefer TypeScript over JavaScript" });
    createMemory({ key: "editor-pref", value: "I use vim" });
    const results = searchMemories("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.memory.key === "lang-pref")).toBe(true);
  });

  test("search returns empty for no match", () => {
    createMemory({ key: "hello", value: "world" });
    const results = searchMemories("zzzznotfound");
    expect(results.length).toBe(0);
  });

  test("search scores exact key match higher than value match", () => {
    createMemory({ key: "editor", value: "vim is great", importance: 5 });
    createMemory({ key: "tools", value: "my editor is vscode", importance: 5 });
    const results = searchMemories("editor");
    expect(results.length).toBe(2);
    // Exact key match should score higher
    expect(results[0]!.memory.key).toBe("editor");
    expect(results[0]!.match_type).toBe("exact");
  });
});

// ============================================================================
// memory_stats flow
// ============================================================================

describe("memory_stats flow", () => {
  beforeEach(() => { freshDb(); });

  test("stats with no memories", () => {
    const db = getDatabase(":memory:");
    const total = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get() as { c: number }).c;
    expect(total).toBe(0);
  });

  test("stats counts by scope", () => {
    createMemory({ key: "g1", value: "v", scope: "global" });
    createMemory({ key: "g2", value: "v", scope: "global" });
    createMemory({ key: "s1", value: "v", scope: "shared" });
    createMemory({ key: "p1", value: "v", scope: "private" });

    const db = getDatabase(":memory:");
    const byScope = db.query("SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope").all() as { scope: string; c: number }[];
    const scopeMap: Record<string, number> = {};
    for (const row of byScope) scopeMap[row.scope] = row.c;

    expect(scopeMap["global"]).toBe(2);
    expect(scopeMap["shared"]).toBe(1);
    expect(scopeMap["private"]).toBe(1);
  });

  test("stats counts by category", () => {
    createMemory({ key: "f1", value: "v", category: "fact" });
    createMemory({ key: "p1", value: "v", category: "preference" });
    createMemory({ key: "k1", value: "v", category: "knowledge" });

    const db = getDatabase(":memory:");
    const byCat = db.query("SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category").all() as { category: string; c: number }[];
    const catMap: Record<string, number> = {};
    for (const row of byCat) catMap[row.category] = row.c;

    expect(catMap["fact"]).toBe(1);
    expect(catMap["preference"]).toBe(1);
    expect(catMap["knowledge"]).toBe(1);
  });

  test("stats counts pinned", () => {
    const m = createMemory({ key: "pin1", value: "v" });
    updateMemory(m.id, { pinned: true, version: m.version });
    createMemory({ key: "nopin", value: "v" });

    const db = getDatabase(":memory:");
    const pinnedCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'").get() as { c: number }).c;
    expect(pinnedCount).toBe(1);
  });
});

// ============================================================================
// memory_export/import flow
// ============================================================================

describe("memory_export/import flow", () => {
  beforeEach(() => { freshDb(); });

  test("export returns all memories", () => {
    createMemory({ key: "exp1", value: "v1" });
    createMemory({ key: "exp2", value: "v2" });
    const memories = listMemories({ limit: 10000 });
    expect(memories.length).toBe(2);
  });

  test("export with scope filter", () => {
    createMemory({ key: "eg", value: "v", scope: "global" });
    createMemory({ key: "ep", value: "v", scope: "private" });
    const memories = listMemories({ scope: "global", limit: 10000 });
    expect(memories.length).toBe(1);
    expect(memories[0]!.scope).toBe("global");
  });

  test("import memories (merge mode)", () => {
    const toImport = [
      { key: "imp1", value: "val1", source: "imported" as const },
      { key: "imp2", value: "val2", source: "imported" as const },
    ];
    for (const mem of toImport) {
      createMemory(mem, "merge");
    }
    const all = listMemories();
    expect(all.length).toBe(2);
  });

  test("import with overwrite=false (create mode) creates duplicates if key differs by scope", () => {
    createMemory({ key: "dup-key", value: "original", scope: "private" });
    // create mode with different scope should succeed as new entry
    createMemory({ key: "dup-key", value: "imported", scope: "global", source: "imported" }, "create");
    const all = listMemories();
    expect(all.length).toBe(2);
  });
});

// ============================================================================
// memory_inject flow
// ============================================================================

describe("memory_inject flow", () => {
  beforeEach(() => { freshDb(); });

  test("inject returns formatted context", () => {
    createMemory({ key: "inj1", value: "injected value", scope: "global", importance: 8 });
    const injector = new MemoryInjector();
    const ctx = injector.getInjectionContext({
      db: getDatabase(":memory:"),
      min_importance: 1,
      categories: ["preference", "fact", "knowledge", "history"],
    });
    expect(ctx).toContain("<agent-memories>");
    expect(ctx).toContain("inj1");
    expect(ctx).toContain("injected value");
  });

  test("inject respects importance threshold", () => {
    createMemory({ key: "low-imp", value: "low", scope: "global", importance: 1 });
    createMemory({ key: "high-imp", value: "high", scope: "global", importance: 9 });
    const injector = new MemoryInjector();
    const ctx = injector.getInjectionContext({
      db: getDatabase(":memory:"),
      min_importance: 8,
      categories: ["preference", "fact", "knowledge", "history"],
    });
    expect(ctx).toContain("high-imp");
    expect(ctx).not.toContain("low-imp");
  });

  test("inject respects max_tokens budget", () => {
    // Create many memories to exceed a tiny token budget
    for (let i = 0; i < 20; i++) {
      createMemory({
        key: `budget-${i}`,
        value: "short value",
        scope: "global",
        importance: 8,
      });
    }
    const injector = new MemoryInjector();
    const ctx = injector.getInjectionContext({
      db: getDatabase(":memory:"),
      max_tokens: 100, // ~400 chars budget, should fit some but not all 20
      min_importance: 1,
      categories: ["preference", "fact", "knowledge", "history"],
    });
    // Should contain at least one memory but not all 20
    const lines = ctx.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(20);
  });

  test("inject empty when no matches", () => {
    const injector = new MemoryInjector();
    const ctx = injector.getInjectionContext({
      db: getDatabase(":memory:"),
      min_importance: 1,
      categories: ["preference", "fact", "knowledge", "history"],
    });
    expect(ctx).toBe("");
  });
});

// ============================================================================
// agent registration flow
// ============================================================================

describe("agent registration flow", () => {
  beforeEach(() => { freshDb(); });

  test("register new agent", () => {
    const agent = registerAgent("claude");
    expect(agent.name).toBe("claude");
    expect(agent.id).toBeTruthy();
    expect(agent.id.length).toBe(8);
  });

  test("register idempotent", () => {
    const a1 = registerAgent("same-agent");
    const a2 = registerAgent("same-agent");
    expect(a2.id).toBe(a1.id);
  });

  test("register updates description on re-register", () => {
    registerAgent("desc-agent", undefined, "first desc");
    const a2 = registerAgent("desc-agent", undefined, "updated desc");
    expect(a2.description).toBe("updated desc");
  });

  test("list agents", () => {
    registerAgent("agent-a");
    registerAgent("agent-b");
    const agents = listAgents();
    expect(agents.length).toBe(2);
  });

  test("get agent by id", () => {
    const created = registerAgent("by-id-agent");
    const found = getAgent(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("by-id-agent");
  });

  test("get agent by name", () => {
    registerAgent("by-name-agent");
    const found = getAgent("by-name-agent");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("by-name-agent");
  });

  test("get agent returns null for unknown", () => {
    const found = getAgent("nonexistent-agent-xyz");
    expect(found).toBeNull();
  });
});

// ============================================================================
// project registration flow
// ============================================================================

describe("project registration flow", () => {
  beforeEach(() => { freshDb(); });

  test("register project", () => {
    const project = registerProject("my-project", "/tmp/my-project");
    expect(project.name).toBe("my-project");
    expect(project.path).toBe("/tmp/my-project");
    expect(project.id).toBeTruthy();
  });

  test("register project is idempotent by path", () => {
    const p1 = registerProject("proj", "/tmp/proj");
    const p2 = registerProject("proj-renamed", "/tmp/proj");
    expect(p2.id).toBe(p1.id);
  });

  test("list projects", () => {
    registerProject("proj-a", "/tmp/proj-a");
    registerProject("proj-b", "/tmp/proj-b");
    const projects = listProjects();
    expect(projects.length).toBe(2);
  });

  test("get project by id", () => {
    const created = registerProject("by-id-proj", "/tmp/by-id-proj");
    const found = getProject(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("by-id-proj");
  });

  test("get project by path", () => {
    registerProject("by-path-proj", "/tmp/by-path-proj");
    const found = getProject("/tmp/by-path-proj");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("by-path-proj");
  });

  test("get project returns null for unknown", () => {
    const found = getProject("/tmp/nonexistent");
    expect(found).toBeNull();
  });
});

// ============================================================================
// clean_expired flow
// ============================================================================

describe("clean_expired flow", () => {
  beforeEach(() => { freshDb(); });

  test("removes expired memories", () => {
    const db = getDatabase(":memory:");
    // Insert a memory that is already expired
    const pastDate = new Date(Date.now() - 100000).toISOString();
    createMemory({ key: "expired-mem", value: "v", expires_at: pastDate });

    const cleaned = cleanExpiredMemories();
    expect(cleaned).toBe(1);

    const remaining = listMemories({ status: ["active", "expired"] });
    expect(remaining.length).toBe(0);
  });

  test("keeps active memories", () => {
    // Memory with no expiry — should not be cleaned
    createMemory({ key: "keep-me", value: "v" });
    // Memory with future expiry — should not be cleaned
    const futureDate = new Date(Date.now() + 1000000).toISOString();
    createMemory({ key: "future-exp", value: "v", expires_at: futureDate });

    const cleaned = cleanExpiredMemories();
    expect(cleaned).toBe(0);

    const remaining = listMemories();
    expect(remaining.length).toBe(2);
  });

  test("keeps non-expired and removes only expired", () => {
    const pastDate = new Date(Date.now() - 100000).toISOString();
    createMemory({ key: "old", value: "v", expires_at: pastDate });
    createMemory({ key: "fresh", value: "v" });

    const cleaned = cleanExpiredMemories();
    expect(cleaned).toBe(1);

    const remaining = listMemories();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.key).toBe("fresh");
  });
});

// ============================================================================
// Additional edge case tests
// ============================================================================

describe("additional edge cases", () => {
  beforeEach(() => { freshDb(); });

  test("touch memory increments access_count", () => {
    const m = createMemory({ key: "touch-me", value: "v" });
    expect(m.access_count).toBe(0);
    touchMemory(m.id);
    const after = getMemory(m.id);
    expect(after!.access_count).toBe(1);
    expect(after!.accessed_at).toBeTruthy();
  });

  test("getMemory returns null for nonexistent id", () => {
    const m = getMemory("nonexistent-uuid");
    expect(m).toBeNull();
  });

  test("create memory with agent_id scoping", () => {
    const agent = registerAgent("scoped-agent");
    const m = createMemory({ key: "agent-scoped", value: "v", agent_id: agent.id });
    expect(m.agent_id).toBe(agent.id);
  });

  test("create memory with project_id scoping", () => {
    const project = registerProject("scoped-proj", "/tmp/scoped-proj");
    const m = createMemory({ key: "proj-scoped", value: "v", project_id: project.id });
    expect(m.project_id).toBe(project.id);
  });

  test("list with multiple scope values", () => {
    createMemory({ key: "g", value: "v", scope: "global" });
    createMemory({ key: "s", value: "v", scope: "shared" });
    createMemory({ key: "p", value: "v", scope: "private" });
    const list = listMemories({ scope: ["global", "shared"] });
    expect(list.length).toBe(2);
  });

  test("list with multiple category values", () => {
    createMemory({ key: "f", value: "v", category: "fact" });
    createMemory({ key: "h", value: "v", category: "history" });
    createMemory({ key: "k", value: "v", category: "knowledge" });
    const list = listMemories({ category: ["fact", "history"] });
    expect(list.length).toBe(2);
  });

  test("update metadata", () => {
    const m = createMemory({ key: "meta", value: "v" });
    const updated = updateMemory(m.id, { metadata: { nested: { deep: true } }, version: m.version });
    expect(updated.metadata).toEqual({ nested: { deep: true } });
  });

  test("search with scope filter", () => {
    createMemory({ key: "search-global", value: "findme", scope: "global" });
    createMemory({ key: "search-private", value: "findme", scope: "private" });
    const results = searchMemories("findme", { scope: "global" });
    expect(results.length).toBe(1);
    expect(results[0]!.memory.scope).toBe("global");
  });

  test("upsert same key different scope creates separate entries", () => {
    createMemory({ key: "multi-scope", value: "global-v", scope: "global" });
    createMemory({ key: "multi-scope", value: "private-v", scope: "private" });
    const all = listMemories();
    expect(all.length).toBe(2);
  });
});
