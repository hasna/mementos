process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { registerProject } from "../db/projects.js";
import { registerAgent } from "../db/agents.js";
import { serializeEmbedding, generateEmbedding } from "./embeddings.js";
import { sliceEmbedding, l2Normalize, matryoshkaSearch } from "./matryoshka.js";
import type { MatryoshkaConfig } from "./matryoshka.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

// ============================================================================
// sliceEmbedding
// ============================================================================

describe("sliceEmbedding", () => {
  test("returns first N dimensions", () => {
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const sliced = sliceEmbedding(embedding, 3);
    expect(sliced).toEqual([0.1, 0.2, 0.3]);
  });

  test("returns original when dims >= length", () => {
    const embedding = [0.1, 0.2, 0.3];
    const sliced = sliceEmbedding(embedding, 5);
    expect(sliced).toBe(embedding); // same reference
  });

  test("returns original when dims equals length", () => {
    const embedding = [0.1, 0.2, 0.3];
    const sliced = sliceEmbedding(embedding, 3);
    expect(sliced).toBe(embedding);
  });

  test("returns empty array when slicing to 0", () => {
    const embedding = [0.1, 0.2, 0.3];
    const sliced = sliceEmbedding(embedding, 0);
    expect(sliced).toEqual([]);
  });

  test("works with empty embedding", () => {
    const sliced = sliceEmbedding([], 3);
    expect(sliced).toEqual([]);
  });

  test("slicing to 1 returns first element only", () => {
    const embedding = [0.5, 0.6, 0.7, 0.8];
    expect(sliceEmbedding(embedding, 1)).toEqual([0.5]);
  });
});

// ============================================================================
// l2Normalize
// ============================================================================

describe("l2Normalize", () => {
  test("normalizes a simple vector to unit length", () => {
    const vec = [3, 4]; // norm = 5
    const normalized = l2Normalize(vec);
    expect(normalized[0]).toBeCloseTo(0.6, 10);
    expect(normalized[1]).toBeCloseTo(0.8, 10);
  });

  test("result has unit norm", () => {
    const vec = [1, 2, 3, 4, 5];
    const normalized = l2Normalize(vec);
    let norm = 0;
    for (const v of normalized) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 10);
  });

  test("normalizing a unit vector returns itself (approximately)", () => {
    const unitVec = [1, 0, 0];
    const normalized = l2Normalize(unitVec);
    expect(normalized[0]).toBeCloseTo(1.0, 10);
    expect(normalized[1]).toBeCloseTo(0.0, 10);
    expect(normalized[2]).toBeCloseTo(0.0, 10);
  });

  test("returns original for zero vector", () => {
    const zero = [0, 0, 0];
    const normalized = l2Normalize(zero);
    expect(normalized).toEqual([0, 0, 0]);
  });

  test("handles single element vector", () => {
    const vec = [5];
    const normalized = l2Normalize(vec);
    expect(normalized[0]).toBeCloseTo(1.0, 10);
  });

  test("handles negative values", () => {
    const vec = [-3, 4];
    const normalized = l2Normalize(vec);
    expect(normalized[0]).toBeCloseTo(-0.6, 10);
    expect(normalized[1]).toBeCloseTo(0.8, 10);
    let norm = 0;
    for (const v of normalized) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 10);
  });

  test("preserves direction", () => {
    const vec = [2, 4, 6];
    const normalized = l2Normalize(vec);
    // All ratios should be the same
    const ratio = normalized[0]! / normalized[1]!;
    expect(ratio).toBeCloseTo(2 / 4, 10);
    const ratio2 = normalized[1]! / normalized[2]!;
    expect(ratio2).toBeCloseTo(4 / 6, 10);
  });
});

// ============================================================================
// matryoshkaSearch
// ============================================================================

describe("matryoshkaSearch", () => {
  /**
   * Helper: insert a memory and its embedding into the DB.
   * Uses generateEmbedding (TF-IDF fallback in tests since no OPENAI_API_KEY).
   */
  async function insertMemoryWithEmbedding(
    key: string,
    value: string,
    opts?: { project_id?: string; agent_id?: string },
  ): Promise<string> {
    const mem = createMemory({
      key,
      value,
      project_id: opts?.project_id,
      agent_id: opts?.agent_id,
    });
    const { embedding, model, dimensions } = await generateEmbedding(value);
    const db = getDatabase();
    db.prepare(
      `INSERT INTO memory_embeddings (memory_id, embedding, model, dimensions) VALUES (?, ?, ?, ?)`,
    ).run(mem.id, serializeEmbedding(embedding), model, dimensions);
    return mem.id;
  }

  test("returns empty array when no memories exist", async () => {
    const results = await matryoshkaSearch(getDatabase(), "test query");
    expect(results).toEqual([]);
  });

  test("returns matching memories", async () => {
    await insertMemoryWithEmbedding("typescript-pref", "We prefer TypeScript for all projects");
    await insertMemoryWithEmbedding("python-note", "Python is used for data science work");

    const results = await matryoshkaSearch(getDatabase(), "TypeScript projects");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Results should have score and shortlist_score
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.shortlist_score).toBeGreaterThan(0);
      expect(r.memory).toBeDefined();
      expect(r.memory.id).toBeDefined();
      expect(r.memory.key).toBeDefined();
    }
  });

  test("respects limit parameter", async () => {
    await insertMemoryWithEmbedding("mem-1", "JavaScript framework development");
    await insertMemoryWithEmbedding("mem-2", "JavaScript testing patterns");
    await insertMemoryWithEmbedding("mem-3", "JavaScript build tools and bundlers");
    await insertMemoryWithEmbedding("mem-4", "JavaScript deployment pipelines");

    const results = await matryoshkaSearch(getDatabase(), "JavaScript", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("filters by project_id", async () => {
    const projA = registerProject("proj-a", "/tmp/proj-a");
    const projB = registerProject("proj-b", "/tmp/proj-b");
    await insertMemoryWithEmbedding("proj-a-mem", "React component architecture", {
      project_id: projA.id,
    });
    await insertMemoryWithEmbedding("proj-b-mem", "React component patterns", {
      project_id: projB.id,
    });

    const results = await matryoshkaSearch(getDatabase(), "React components", {
      project_id: projA.id,
    });
    for (const r of results) {
      expect(r.memory.project_id).toBe(projA.id);
    }
  });

  test("filters by agent_id", async () => {
    const agentX = registerAgent("agent-x");
    const agentY = registerAgent("agent-y");
    await insertMemoryWithEmbedding("agent-x-mem", "Database migration strategy", {
      agent_id: agentX.id,
    });
    await insertMemoryWithEmbedding("agent-y-mem", "Database backup plan", {
      agent_id: agentY.id,
    });

    const results = await matryoshkaSearch(getDatabase(), "database", {
      agent_id: agentX.id,
    });
    for (const r of results) {
      expect(r.memory.agent_id).toBe(agentX.id);
    }
  });

  test("results are sorted by full-dimension score descending", async () => {
    await insertMemoryWithEmbedding("close-match", "TypeScript strict mode configuration");
    await insertMemoryWithEmbedding("distant-match", "Go language concurrency patterns");
    await insertMemoryWithEmbedding("medium-match", "TypeScript generics and type utilities");

    const results = await matryoshkaSearch(getDatabase(), "TypeScript strict mode", {
      threshold: 0,
    });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  test("scores are rounded to 3 decimal places", async () => {
    await insertMemoryWithEmbedding("test-mem", "Bun runtime for server-side JavaScript");

    const results = await matryoshkaSearch(getDatabase(), "Bun JavaScript runtime", {
      threshold: 0,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      // Check that score has at most 3 decimal places
      expect(r.score).toBe(Math.round(r.score * 1000) / 1000);
      expect(r.shortlist_score).toBe(Math.round(r.shortlist_score * 1000) / 1000);
    }
  });

  test("respects threshold parameter", async () => {
    await insertMemoryWithEmbedding("irrelevant", "quantum physics experiments");
    await insertMemoryWithEmbedding("relevant", "CSS grid layout techniques");

    // Very high threshold — should return fewer or no results
    const highThreshold = await matryoshkaSearch(getDatabase(), "CSS grid", {
      threshold: 0.99,
    });
    // Low threshold — should return more results
    const lowThreshold = await matryoshkaSearch(getDatabase(), "CSS grid", {
      threshold: 0.0,
    });
    expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
  });

  test("custom config with different shortlist dims", async () => {
    await insertMemoryWithEmbedding("config-test", "Custom embedding dimensions test");

    const customConfig: MatryoshkaConfig = {
      full_dims: 512,
      shortlist_dims: 128,
      shortlist_multiplier: 2,
    };

    const results = await matryoshkaSearch(getDatabase(), "embedding dimensions", {
      config: customConfig,
      threshold: 0,
    });
    // Should still work with smaller dims
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("skips memories without embeddings", async () => {
    // Create a memory without embedding
    createMemory({ key: "no-embed", value: "This has no embedding" });
    // Create one with embedding
    await insertMemoryWithEmbedding("has-embed", "This has an embedding for search");

    const results = await matryoshkaSearch(getDatabase(), "embedding search", {
      threshold: 0,
    });
    // Only the one with embedding should appear
    for (const r of results) {
      expect(r.memory.key).not.toBe("no-embed");
    }
  });

  test("excludes non-active memories", async () => {
    const id = await insertMemoryWithEmbedding("archived-mem", "Archived memory content");
    // Mark as archived
    const db = getDatabase();
    db.prepare(`UPDATE memories SET status = 'archived' WHERE id = ?`).run(id);

    const results = await matryoshkaSearch(getDatabase(), "Archived memory", {
      threshold: 0,
    });
    for (const r of results) {
      expect(r.memory.id).not.toBe(id);
    }
  });

  test("memory object has expected fields", async () => {
    await insertMemoryWithEmbedding("fields-test", "Testing memory fields are populated");

    const results = await matryoshkaSearch(getDatabase(), "testing memory fields", {
      threshold: 0,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const mem = results[0]!.memory;
    expect(mem.id).toBeDefined();
    expect(mem.key).toBe("fields-test");
    expect(mem.value).toBe("Testing memory fields are populated");
    expect(mem.status).toBe("active");
    expect(mem.created_at).toBeDefined();
    expect(mem.updated_at).toBeDefined();
  });
});
