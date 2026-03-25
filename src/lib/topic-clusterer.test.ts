import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
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
  let savedApiKey: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedApiKey = process.env["ANTHROPIC_API_KEY"];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedApiKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = savedApiKey;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  test("falls back to heuristic without API key", async () => {
    delete process.env["ANTHROPIC_API_KEY"];

    const memories = [
      mockMemory({ id: "m1", category: "fact", key: "db-schema", tags: ["database"] }),
      mockMemory({ id: "m2", category: "preference", key: "editor-theme", tags: ["ui"] }),
    ];

    const clusters = await clusterByLLM(memories);

    const heuristicClusters = clusterByHeuristic(memories);
    expect(clusters.length).toBe(heuristicClusters.length);

    const llmIds = clusters.flatMap((c) => c.memory_ids).sort();
    const heuristicIds = heuristicClusters.flatMap((c) => c.memory_ids).sort();
    expect(llmIds).toEqual(heuristicIds);
  });

  test("falls back to heuristic on empty input without API key", async () => {
    delete process.env["ANTHROPIC_API_KEY"];

    const clusters = await clusterByLLM([]);
    expect(clusters).toEqual([]);
  });

  test("sends memories to API and parses successful response", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const memories = [
      mockMemory({ id: "m1", key: "db-schema", value: "PostgreSQL schema design patterns" }),
      mockMemory({ id: "m2", key: "api-design", value: "REST API best practices" }),
      mockMemory({ id: "m3", key: "db-index", value: "Index optimization tips" }),
    ];

    const llmResponse = JSON.stringify([
      { name: "Database", indices: [0, 2] },
      { name: "API Design", indices: [1] },
    ]);

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: llmResponse }],
          }),
          { status: 200 }
        )
      )
    ) as typeof fetch;

    const clusters = await clusterByLLM(memories);

    expect(clusters).toHaveLength(2);

    const dbCluster = clusters.find((c) => c.name === "Database");
    expect(dbCluster).toBeDefined();
    expect(dbCluster!.memory_ids).toEqual(["m1", "m3"]);
    expect(dbCluster!.keywords).toEqual(["database"]);

    const apiCluster = clusters.find((c) => c.name === "API Design");
    expect(apiCluster).toBeDefined();
    expect(apiCluster!.memory_ids).toEqual(["m2"]);
    expect(apiCluster!.keywords).toEqual(["api design"]);
  });

  test("falls back to heuristic on non-ok response", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const memories = [
      mockMemory({ id: "m1", key: "test-memory", category: "knowledge", tags: ["test"] }),
    ];

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    ) as typeof fetch;

    const clusters = await clusterByLLM(memories);
    const heuristicClusters = clusterByHeuristic(memories);

    expect(clusters.length).toBe(heuristicClusters.length);
    const llmIds = clusters.flatMap((c) => c.memory_ids).sort();
    const heuristicIds = heuristicClusters.flatMap((c) => c.memory_ids).sort();
    expect(llmIds).toEqual(heuristicIds);
  });

  test("falls back to heuristic when response has no text content", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const memories = [
      mockMemory({ id: "m1", key: "test-memory", category: "fact", tags: ["test"] }),
    ];

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [] }),
          { status: 200 }
        )
      )
    ) as typeof fetch;

    const clusters = await clusterByLLM(memories);
    const heuristicClusters = clusterByHeuristic(memories);

    expect(clusters.length).toBe(heuristicClusters.length);
  });

  test("falls back to heuristic when response text is empty string", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const memories = [
      mockMemory({ id: "m1", key: "test-memory", category: "fact" }),
    ];

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "   " }] }),
          { status: 200 }
        )
      )
    ) as typeof fetch;

    const clusters = await clusterByLLM(memories);
    const heuristicClusters = clusterByHeuristic(memories);
    expect(clusters.length).toBe(heuristicClusters.length);
  });

  test("falls back to heuristic on JSON parse error", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const memories = [
      mockMemory({ id: "m1", key: "test-memory", category: "knowledge" }),
    ];

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "not valid json at all" }] }),
          { status: 200 }
        )
      )
    ) as typeof fetch;

    const clusters = await clusterByLLM(memories);
    const heuristicClusters = clusterByHeuristic(memories);

    expect(clusters.length).toBe(heuristicClusters.length);
  });

  test("falls back to heuristic on fetch exception", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const memories = [
      mockMemory({ id: "m1", key: "test-memory", category: "knowledge" }),
    ];

    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network error"))
    ) as typeof fetch;

    const clusters = await clusterByLLM(memories);
    const heuristicClusters = clusterByHeuristic(memories);

    expect(clusters.length).toBe(heuristicClusters.length);
  });

  test("filters out-of-bounds indices from LLM response", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const memories = [
      mockMemory({ id: "m1", key: "only-memory", value: "single memory" }),
    ];

    const llmResponse = JSON.stringify([
      { name: "Group", indices: [0, 5, 99] },
    ]);

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: llmResponse }] }),
          { status: 200 }
        )
      )
    ) as typeof fetch;

    const clusters = await clusterByLLM(memories);

    expect(clusters).toHaveLength(1);
    // Only index 0 is valid (5 and 99 are out of bounds)
    expect(clusters[0]!.memory_ids).toEqual(["m1"]);
    expect(clusters[0]!.name).toBe("Group");
  });

  test("slices memories to max 50 for API call", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    // Create 60 memories
    const memories = Array.from({ length: 60 }, (_, i) =>
      mockMemory({ id: `m${i}`, key: `memory-${i}`, value: `value for memory ${i}` })
    );

    let capturedBody: string | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify([{ name: "All", indices: [0] }]) }],
          }),
          { status: 200 }
        )
      );
    }) as typeof fetch;

    await clusterByLLM(memories);

    // Verify the body sent to the API only contains 50 memories
    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    const messageContent = parsed.messages[0].content as string;
    const lines = messageContent.split("\n");
    expect(lines).toHaveLength(50);
  });

  test("truncates memory values to 100 chars in API payload", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const longValue = "x".repeat(200);
    const memories = [
      mockMemory({ id: "m1", key: "long-value", value: longValue }),
    ];

    let capturedBody: string | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify([{ name: "Test", indices: [0] }]) }],
          }),
          { status: 200 }
        )
      );
    }) as typeof fetch;

    await clusterByLLM(memories);

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    const messageContent = parsed.messages[0].content as string;
    // The value portion should be truncated to 100 chars
    // Format is "key: value", so remove "long-value: " prefix
    const valuePart = messageContent.replace("long-value: ", "");
    expect(valuePart.length).toBe(100);
  });

  test("falls back when content field is null/undefined", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-for-unit-test";

    const memories = [
      mockMemory({ id: "m1", key: "test", category: "fact" }),
    ];

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: null }),
          { status: 200 }
        )
      )
    ) as typeof fetch;

    const clusters = await clusterByLLM(memories);
    const heuristicClusters = clusterByHeuristic(memories);
    expect(clusters.length).toBe(heuristicClusters.length);
  });
});
