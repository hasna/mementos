import { describe, test, expect } from "bun:test";
import { clusterByHeuristic, clusterByLLM } from "./topic-clusterer.js";
import type { Memory } from "../types/index.js";

function mockMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id || crypto.randomUUID(),
    key: overrides.key || "test-key",
    value: overrides.value || "test value",
    category: overrides.category || "knowledge",
    scope: overrides.scope || "shared",
    summary: null,
    tags: overrides.tags || [],
    importance: overrides.importance || 5,
    source: "agent",
    status: "active",
    pinned: false,
    agent_id: null,
    project_id: null,
    session_id: null,
    metadata: {},
    access_count: 0,
    version: 1,
    expires_at: null,
    valid_from: null,
    valid_until: null,
    ingested_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    accessed_at: null,
  };
}

// ============================================================================
// clusterByHeuristic
// ============================================================================

describe("clusterByHeuristic", () => {
  test("returns empty for empty input", () => {
    const result = clusterByHeuristic([]);
    expect(result).toEqual([]);
  });

  test("groups by category", () => {
    const memories = [
      mockMemory({ id: "m1", key: "db-schema", category: "fact", tags: ["database"] }),
      mockMemory({ id: "m2", key: "user-pref", category: "preference", tags: ["ui"] }),
      mockMemory({ id: "m3", key: "db-index", category: "fact", tags: ["database"] }),
    ];

    const clusters = clusterByHeuristic(memories);

    // Should have at least 2 clusters — one for "fact", one for "preference"
    const factCluster = clusters.find((c) => c.memory_ids.includes("m1"));
    const prefCluster = clusters.find((c) => c.memory_ids.includes("m2"));

    expect(factCluster).toBeDefined();
    expect(prefCluster).toBeDefined();
    // m1 and m3 are both "fact" — should be in the same cluster
    expect(factCluster!.memory_ids).toContain("m3");
    // m2 is "preference" — should NOT be in the fact cluster
    expect(factCluster!.memory_ids).not.toContain("m2");
  });

  test("extracts keywords from keys and tags", () => {
    const memories = [
      mockMemory({ key: "learning-typescript-generics", tags: ["typescript", "generics"] }),
      mockMemory({ key: "learning-typescript-enums", tags: ["typescript", "enums"] }),
    ];

    const clusters = clusterByHeuristic(memories);
    expect(clusters.length).toBeGreaterThan(0);

    // "typescript" should appear as a keyword (from both keys and tags)
    const allKeywords = clusters.flatMap((c) => c.keywords);
    expect(allKeywords).toContain("typescript");
    expect(allKeywords).toContain("learning");
  });

  test("sub-groups by tag overlap within category", () => {
    // 5 memories — enough to trigger sub-grouping (>3 threshold)
    const memories = [
      mockMemory({ id: "m1", key: "api-auth", category: "knowledge", tags: ["auth", "api"] }),
      mockMemory({ id: "m2", key: "api-rate-limit", category: "knowledge", tags: ["api", "security"] }),
      mockMemory({ id: "m3", key: "db-migration", category: "knowledge", tags: ["database", "schema"] }),
      mockMemory({ id: "m4", key: "db-index-perf", category: "knowledge", tags: ["database", "performance"] }),
      mockMemory({ id: "m5", key: "ui-theming", category: "knowledge", tags: ["frontend", "css"] }),
    ];

    const clusters = clusterByHeuristic(memories);

    // m1 and m2 share "api" tag — should cluster together
    const apiCluster = clusters.find((c) => c.memory_ids.includes("m1"));
    expect(apiCluster).toBeDefined();
    expect(apiCluster!.memory_ids).toContain("m2");

    // m3 and m4 share "database" tag — should cluster together
    const dbCluster = clusters.find((c) => c.memory_ids.includes("m3"));
    expect(dbCluster).toBeDefined();
    expect(dbCluster!.memory_ids).toContain("m4");

    // m5 has no tag overlap with others — should be in its own cluster
    const uiCluster = clusters.find((c) => c.memory_ids.includes("m5"));
    expect(uiCluster).toBeDefined();
    expect(uiCluster!.memory_ids).not.toContain("m1");
    expect(uiCluster!.memory_ids).not.toContain("m3");
  });

  test("handles single memory", () => {
    const memories = [mockMemory({ id: "solo", key: "only-one", tags: ["lonely"] })];
    const clusters = clusterByHeuristic(memories);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memory_ids).toEqual(["solo"]);
  });

  test("uses category as name when no keywords extracted", () => {
    // Short key parts (<=2 chars) get filtered out, no tags
    const memories = [mockMemory({ key: "ab", tags: [], category: "fact" })];
    const clusters = clusterByHeuristic(memories);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.name).toBe("fact");
  });

  test("cluster name uses top 3 keywords", () => {
    const memories = [
      mockMemory({ key: "learning-react-hooks", tags: ["react", "hooks", "frontend"] }),
    ];
    const clusters = clusterByHeuristic(memories);
    expect(clusters).toHaveLength(1);
    // Name should be comma-separated top keywords
    const parts = clusters[0]!.name.split(", ");
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.length).toBeGreaterThan(0);
  });

  test("returns all memory_ids across clusters", () => {
    const memories = [
      mockMemory({ id: "a", category: "fact" }),
      mockMemory({ id: "b", category: "knowledge" }),
      mockMemory({ id: "c", category: "preference" }),
    ];
    const clusters = clusterByHeuristic(memories);
    const allIds = clusters.flatMap((c) => c.memory_ids).sort();
    expect(allIds).toEqual(["a", "b", "c"]);
  });

  test("memories with no tags stay in same category group when <=3", () => {
    const memories = [
      mockMemory({ id: "x1", category: "history", tags: [] }),
      mockMemory({ id: "x2", category: "history", tags: [] }),
    ];
    const clusters = clusterByHeuristic(memories);
    // <=3 memories → no sub-grouping, all in one cluster
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memory_ids).toContain("x1");
    expect(clusters[0]!.memory_ids).toContain("x2");
  });
});

// ============================================================================
// clusterByLLM
// ============================================================================

describe("clusterByLLM", () => {
  test("falls back to heuristic without API key", async () => {
    // Ensure no API key is set for this test
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    try {
      const memories = [
        mockMemory({ id: "m1", category: "fact", key: "db-schema", tags: ["database"] }),
        mockMemory({ id: "m2", category: "preference", key: "editor-theme", tags: ["ui"] }),
      ];

      const clusters = await clusterByLLM(memories);

      // Should produce the same result as heuristic
      const heuristicClusters = clusterByHeuristic(memories);
      expect(clusters.length).toBe(heuristicClusters.length);

      const llmIds = clusters.flatMap((c) => c.memory_ids).sort();
      const heuristicIds = heuristicClusters.flatMap((c) => c.memory_ids).sort();
      expect(llmIds).toEqual(heuristicIds);
    } finally {
      // Restore the key if it existed
      if (saved !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = saved;
      }
    }
  });

  test("falls back to heuristic on empty input without API key", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    try {
      const clusters = await clusterByLLM([]);
      expect(clusters).toEqual([]);
    } finally {
      if (saved !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = saved;
      }
    }
  });
});
