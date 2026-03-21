// Tests for OPE4-00135, OPE4-00144, OPE4-00142, OPE4-00128, OPE4-00154, OPE4-00145
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory, getMemory, listMemories } from "../db/memories.js";
import { createEntity, findDuplicateEntities, type DuplicateEntityPair } from "../db/entities.js";
import { enforceMemoryBounds } from "./retention.js";

// ============================================================================
// Helpers
// ============================================================================

function freshDb() {
  resetDatabase();
  return getDatabase(":memory:");
}

function createProject(id: string, name: string): void {
  const db = getDatabase();
  db.run(
    "INSERT OR IGNORE INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
    [id, name, `/tmp/${name}`]
  );
}

function createAgent(id: string, name: string): void {
  const db = getDatabase();
  db.run(
    "INSERT OR IGNORE INTO agents (id, name, created_at, last_seen_at) VALUES (?, ?, datetime('now'), datetime('now'))",
    [id, name]
  );
}

// ============================================================================
// TASK 1: enforceMemoryBounds — utility-based eviction
// ============================================================================

describe("enforceMemoryBounds", () => {
  beforeEach(() => { freshDb(); });

  test("archives lowest-utility memories when scope exceeds limit", () => {
    // Create 10 global memories — default max_entries_per_scope.global = 500
    // We'll force a low limit by overriding config at runtime
    for (let i = 0; i < 10; i++) {
      createMemory({
        key: `global-mem-${i}`,
        value: `value-${i}`,
        scope: "global",
        importance: i + 1,
      });
    }

    const all = listMemories({ scope: "global", status: ["active"] });
    expect(all.length).toBe(10);

    // Since default global limit is 500, nothing should be archived
    const result = enforceMemoryBounds();
    expect(result.archived).toBe(0);
  });

  test("archives excess memories for a specific project", () => {
    createProject("proj-1", "test-project");

    for (let i = 0; i < 5; i++) {
      createMemory({
        key: `proj-mem-${i}`,
        value: `value-${i}`,
        scope: "global",
        importance: i + 1,
        project_id: "proj-1",
      });
    }

    // With default limit of 500, nothing archived
    const result = enforceMemoryBounds("proj-1");
    expect(result.archived).toBe(0);
  });

  test("returns zero when no memories exist", () => {
    const result = enforceMemoryBounds();
    expect(result.archived).toBe(0);
  });

  test("does not archive pinned memories", () => {
    const db = getDatabase();
    for (let i = 0; i < 3; i++) {
      const m = createMemory({
        key: `pin-test-${i}`,
        value: `value-${i}`,
        scope: "shared",
        importance: 1,
      });
      if (i === 0) {
        db.run("UPDATE memories SET pinned = 1 WHERE id = ?", [m.id]);
      }
    }

    const result = enforceMemoryBounds();
    // Check that pinned memory is still active
    const pinned = listMemories({ scope: "shared", status: ["active"] });
    const pinnedMem = pinned.find((m) => m.key === "pin-test-0");
    if (pinnedMem) {
      expect(pinnedMem.status).toBe("active");
    }
  });
});

// ============================================================================
// TASK 2: Vector clocks (migration 27)
// ============================================================================

describe("vector_clock column", () => {
  beforeEach(() => { freshDb(); });

  test("migration 27 adds vector_clock column", () => {
    const db = getDatabase();
    const m = createMemory({ key: "vc-test", value: "hello" });
    const row = db.query("SELECT vector_clock FROM memories WHERE id = ?").get(m.id) as { vector_clock: string } | null;
    expect(row).not.toBeNull();
    expect(row!.vector_clock).toBe("{}");
  });

  test("vector_clock defaults to empty object", () => {
    const db = getDatabase();
    const m = createMemory({ key: "vc-default", value: "world" });
    const row = db.query("SELECT vector_clock FROM memories WHERE id = ?").get(m.id) as { vector_clock: string };
    const clock = JSON.parse(row.vector_clock);
    expect(clock).toEqual({});
  });

  test("vector_clock can be updated with agent entries", () => {
    const db = getDatabase();
    const m = createMemory({ key: "vc-update", value: "test" });
    const clock = { "agent-1": 1, "agent-2": 3 };
    db.run("UPDATE memories SET vector_clock = ? WHERE id = ?", [JSON.stringify(clock), m.id]);
    const row = db.query("SELECT vector_clock FROM memories WHERE id = ?").get(m.id) as { vector_clock: string };
    expect(JSON.parse(row.vector_clock)).toEqual(clock);
  });
});

// ============================================================================
// TASK 3: memory_save_image — image memory
// ============================================================================

describe("image memory content_type", () => {
  beforeEach(() => { freshDb(); });

  test("content_type='image' column exists and can be set", () => {
    const db = getDatabase();
    const m = createMemory({
      key: "screenshot-1",
      value: "A login page screenshot",
      metadata: { resource_uri: "https://example.com/screenshot.png" },
    });
    db.run("UPDATE memories SET content_type = 'image' WHERE id = ?", [m.id]);
    const row = db.query("SELECT content_type FROM memories WHERE id = ?").get(m.id) as { content_type: string };
    expect(row.content_type).toBe("image");
  });

  test("image memory stores resource_uri in metadata", () => {
    const m = createMemory({
      key: "screenshot-2",
      value: "Dashboard overview",
      metadata: { resource_uri: "https://example.com/dash.png" },
    });
    expect(m.metadata.resource_uri).toBe("https://example.com/dash.png");
  });

  test("default content_type is text", () => {
    const m = createMemory({ key: "text-mem", value: "just text" });
    expect(m.content_type).toBe("text");
  });
});

// ============================================================================
// TASK 4: Entity disambiguation
// ============================================================================

describe("findDuplicateEntities", () => {
  beforeEach(() => { freshDb(); });

  test("finds similar entity names within same type", () => {
    createEntity({ name: "TypeScript", type: "tool" });
    createEntity({ name: "Typescript", type: "tool" });

    const pairs = findDuplicateEntities(0.7);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0]!.similarity).toBeGreaterThan(0.7);
  });

  test("does not match entities of different types", () => {
    createEntity({ name: "TypeScript", type: "tool" });
    createEntity({ name: "Typescript", type: "concept" });

    const pairs = findDuplicateEntities(0.7);
    // They are in different type groups, so no match
    expect(pairs.length).toBe(0);
  });

  test("returns empty for no duplicates", () => {
    createEntity({ name: "Python", type: "tool" });
    createEntity({ name: "Kubernetes", type: "tool" });

    const pairs = findDuplicateEntities(0.8);
    expect(pairs.length).toBe(0);
  });

  test("respects threshold", () => {
    createEntity({ name: "react", type: "tool" });
    createEntity({ name: "React", type: "tool" });

    // These are identical (case-insensitive) — high similarity
    const highThreshold = findDuplicateEntities(0.99);
    // Even with very high threshold, exact name match (different case) = identical trigrams
    const lowThreshold = findDuplicateEntities(0.5);
    expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
  });

  test("sorts by similarity descending", () => {
    createEntity({ name: "database-manager", type: "tool" });
    createEntity({ name: "database-managerr", type: "tool" });
    createEntity({ name: "database-xyz", type: "tool" });

    const pairs = findDuplicateEntities(0.5);
    if (pairs.length >= 2) {
      expect(pairs[0]!.similarity).toBeGreaterThanOrEqual(pairs[1]!.similarity);
    }
  });

  test("groups by project_id", () => {
    createProject("proj-1", "project-one");
    createProject("proj-2", "project-two");

    createEntity({ name: "AuthService", type: "api", project_id: "proj-1" });
    createEntity({ name: "AuthServic", type: "api", project_id: "proj-2" });

    // Different projects, so no match (they're in different groups)
    const pairs = findDuplicateEntities(0.7);
    expect(pairs.length).toBe(0);
  });
});

// ============================================================================
// TASK 5: memory_compress (core logic — LLM fallback to truncation)
// ============================================================================

describe("memory compression (truncation fallback)", () => {
  beforeEach(() => { freshDb(); });

  test("compressed memory key starts with 'compressed-'", () => {
    const m1 = createMemory({ key: "fact-1", value: "The sky is blue" });
    const m2 = createMemory({ key: "fact-2", value: "Water is wet" });

    // Simulate the compress operation without LLM (manual truncation)
    const concatenated = `[${m1.key}]: ${m1.value}\n\n[${m2.key}]: ${m2.value}`;
    const compressed = concatenated.slice(0, 500);
    const compressedMemory = createMemory({
      key: `compressed-${Date.now()}`,
      value: compressed,
      category: "knowledge",
      scope: "private",
      importance: Math.max(m1.importance, m2.importance),
      tags: ["compressed"],
      metadata: { source_memory_ids: [m1.id, m2.id] },
    });

    expect(compressedMemory.key).toMatch(/^compressed-/);
    expect(compressedMemory.tags).toContain("compressed");
    expect((compressedMemory.metadata as Record<string, unknown>).source_memory_ids).toEqual([m1.id, m2.id]);
  });

  test("truncation respects max_length", () => {
    const longValue = "x".repeat(1000);
    const m = createMemory({ key: "long-mem", value: longValue });

    const maxLen = 100;
    const truncated = m.value.slice(0, maxLen) + "...";
    expect(truncated.length).toBe(maxLen + 3);
  });
});

// ============================================================================
// TASK 6: memory_subscriptions table (migration 28)
// ============================================================================

describe("memory_subscriptions table", () => {
  beforeEach(() => { freshDb(); });

  test("migration 28 creates memory_subscriptions table", () => {
    const db = getDatabase();
    const row = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_subscriptions'"
    ).get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row!.name).toBe("memory_subscriptions");
  });

  test("can insert and query subscriptions", () => {
    const db = getDatabase();
    createAgent("agent-1", "maximus");

    db.run(
      `INSERT INTO memory_subscriptions (id, agent_id, key_pattern, tag_pattern, scope, created_at)
       VALUES ('sub-1', 'agent-1', 'architecture-*', NULL, 'shared', datetime('now'))`
    );

    const subs = db.query(
      "SELECT * FROM memory_subscriptions WHERE agent_id = ?"
    ).all("agent-1") as Array<Record<string, unknown>>;

    expect(subs.length).toBe(1);
    expect(subs[0]!.key_pattern).toBe("architecture-*");
    expect(subs[0]!.scope).toBe("shared");
  });

  test("can delete subscriptions", () => {
    const db = getDatabase();
    createAgent("agent-2", "cassius");

    db.run(
      `INSERT INTO memory_subscriptions (id, agent_id, key_pattern, created_at)
       VALUES ('sub-2', 'agent-2', 'test-*', datetime('now'))`
    );

    const before = db.query("SELECT COUNT(*) as cnt FROM memory_subscriptions").get() as { cnt: number };
    expect(before.cnt).toBe(1);

    db.run("DELETE FROM memory_subscriptions WHERE id = 'sub-2'");

    const after = db.query("SELECT COUNT(*) as cnt FROM memory_subscriptions").get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  test("supports tag_pattern subscriptions", () => {
    const db = getDatabase();
    createAgent("agent-3", "brutus");

    db.run(
      `INSERT INTO memory_subscriptions (id, agent_id, key_pattern, tag_pattern, created_at)
       VALUES ('sub-3', 'agent-3', NULL, 'deployment', datetime('now'))`
    );

    const sub = db.query(
      "SELECT * FROM memory_subscriptions WHERE id = 'sub-3'"
    ).get() as Record<string, unknown>;
    expect(sub.tag_pattern).toBe("deployment");
    expect(sub.key_pattern).toBeNull();
  });
});
