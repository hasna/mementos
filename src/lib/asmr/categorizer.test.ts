// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect } from "bun:test";
import {
  categorizeMemory,
  categorizeMemoryBatch,
  vectorTag,
} from "./categorizer.js";

// Use neutral keys/values that do NOT match any keyword regex so we can
// exercise the deeper stages of categorizeSync (Stage 2–4 + default).

describe("categorizeSync — Stage 2: category + metadata heuristics", () => {
  test("category=fact with importance >= 8 → personal", async () => {
    const results = await categorizeMemoryBatch([
      { key: "xyz-data", value: "some info", category: "fact", importance: 8 },
    ]);
    expect(results[0]).toBe("personal");
  });

  test("category=fact with importance >= 8 (boundary 10) → personal", async () => {
    const results = await categorizeMemoryBatch([
      { key: "xyz-data", value: "stuff", category: "fact", importance: 10 },
    ]);
    expect(results[0]).toBe("personal");
  });

  test("category=fact with importance < 8 falls through", async () => {
    // importance=5 should NOT trigger line 65; falls to Stage 4 fact→personal
    const results = await categorizeMemoryBatch([
      { key: "xyz-data", value: "stuff", category: "fact", importance: 5 },
    ]);
    // Stage 4 fallback: fact → personal
    expect(results[0]).toBe("personal");
  });

  test("category=knowledge with version > 1 → updates", async () => {
    const results = await categorizeMemoryBatch([
      { key: "xyz-data", value: "some info", category: "knowledge", version: 2 },
    ]);
    expect(results[0]).toBe("updates");
  });

  test("category=knowledge with version=1 falls through", async () => {
    // version=1 should NOT trigger line 66; falls to Stage 4 knowledge→events
    const results = await categorizeMemoryBatch([
      { key: "xyz-data", value: "stuff", category: "knowledge", version: 1 },
    ]);
    // Stage 4 fallback: knowledge → events
    expect(results[0]).toBe("events");
  });

  test("valid_until set → temporal", async () => {
    const results = await categorizeMemoryBatch([
      {
        key: "xyz-data",
        value: "some info",
        category: "knowledge",
        valid_until: "2026-12-31",
      },
    ]);
    expect(results[0]).toBe("temporal");
  });

  test("category=preference → preferences (Stage 2 line 64)", async () => {
    const results = await categorizeMemoryBatch([
      { key: "xyz-data", value: "stuff", category: "preference" },
    ]);
    expect(results[0]).toBe("preferences");
  });
});

describe("categorizeSync — Stage 3: keyword matches on combined key+value", () => {
  // Key has no keyword, but value does → Stage 3 should catch it.

  test("value with personal keyword → personal", async () => {
    const result = await categorizeMemory("xyz-data", "my name is Bob");
    expect(result).toBe("personal");
  });

  test("value with preference keyword → preferences", async () => {
    const result = await categorizeMemory("xyz-data", "I prefer dark mode");
    expect(result).toBe("preferences");
  });

  test("value with events keyword → events", async () => {
    const result = await categorizeMemory("xyz-data", "has a meeting at noon");
    expect(result).toBe("events");
  });

  test("value with temporal keyword → temporal", async () => {
    const result = await categorizeMemory("xyz-data", "expires next month");
    expect(result).toBe("temporal");
  });

  test("value with update keyword → updates", async () => {
    const result = await categorizeMemory("xyz-data", "breaking change in v3");
    expect(result).toBe("updates");
  });

  test("value with assistant keyword → assistant", async () => {
    const result = await categorizeMemory("xyz-data", "configure the agent");
    expect(result).toBe("assistant");
  });
});

describe("categorizeSync — Stage 4: fallback using category field", () => {
  // Neutral key AND neutral value (no keyword matches), with a category.

  test("category=fact (no metadata) → personal via fallback", async () => {
    const result = await categorizeMemory("xyz-data", "bla bla", "fact");
    expect(result).toBe("personal");
  });

  test("category=knowledge (no metadata) → events via fallback", async () => {
    const result = await categorizeMemory("xyz-data", "bla bla", "knowledge");
    expect(result).toBe("events");
  });

  test("category=history → temporal via fallback", async () => {
    const result = await categorizeMemory("xyz-data", "bla bla", "history");
    expect(result).toBe("temporal");
  });

  test("category=procedural → assistant via fallback", async () => {
    const result = await categorizeMemory("xyz-data", "bla bla", "procedural");
    expect(result).toBe("assistant");
  });

  test("category=resource → assistant via fallback", async () => {
    const result = await categorizeMemory("xyz-data", "bla bla", "resource");
    expect(result).toBe("assistant");
  });

  test("unknown category not in fallback map → default personal", async () => {
    const result = await categorizeMemory("xyz-data", "bla bla", "custom-cat");
    expect(result).toBe("personal");
  });
});

describe("categorizeSync — default fallback", () => {
  test("no keywords, no category → personal", async () => {
    const result = await categorizeMemory("xyz-data", "bla bla");
    expect(result).toBe("personal");
  });
});

describe("categorizeMemoryBatch — metadata propagation", () => {
  test("batch passes importance, version, valid_until correctly", async () => {
    const memories = [
      { key: "xyz-a", value: "info", category: "fact", importance: 9 },
      { key: "xyz-b", value: "info", category: "knowledge", version: 3 },
      { key: "xyz-c", value: "info", category: "knowledge", valid_until: "2026-06-01" },
      { key: "xyz-d", value: "info", category: "history" },
      { key: "xyz-e", value: "info" },
    ];
    const results = await categorizeMemoryBatch(memories);
    expect(results).toEqual(["personal", "updates", "temporal", "temporal", "personal"]);
  });
});

describe("vectorTag", () => {
  test("all categories produce correct tags", () => {
    const cats = ["personal", "preferences", "events", "temporal", "updates", "assistant"] as const;
    for (const cat of cats) {
      expect(vectorTag(cat)).toBe(`vector:${cat}`);
    }
  });
});
