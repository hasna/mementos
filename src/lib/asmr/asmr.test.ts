// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect } from "bun:test";
import {
  categorizeMemory,
  categorizeMemoryBatch,
  vectorTag,
} from "./categorizer.js";
import type { VectorCategory } from "./categorizer.js";
import { sliceEmbedding, l2Normalize } from "../matryoshka.js";

// ============================================================================
// Categorizer
// ============================================================================

describe("categorizeMemory", () => {
  test("key with personal keyword → personal", async () => {
    const result = await categorizeMemory("user-name", "John", "fact");
    expect(result).toBe("personal");
  });

  test("key with preference keyword → preferences", async () => {
    const result = await categorizeMemory(
      "preferred-language",
      "TypeScript",
      "preference",
    );
    expect(result).toBe("preferences");
  });

  test("key with event keyword → events", async () => {
    const result = await categorizeMemory(
      "meeting-2026-03-22",
      "standup at 9am",
      "knowledge",
    );
    expect(result).toBe("events");
  });

  test("key with temporal keyword → temporal", async () => {
    // "deadline" appears in BOTH events and temporal keyword lists,
    // and events is checked first in Stage 1. Use a purely temporal key.
    const result = await categorizeMemory(
      "expires-q2",
      "valid until June 30",
      "knowledge",
    );
    expect(result).toBe("temporal");
  });

  test("key with update keyword → updates", async () => {
    const result = await categorizeMemory(
      "update-api-v2",
      "changed endpoint",
      "knowledge",
    );
    expect(result).toBe("updates");
  });

  test("procedural category falls back to assistant", async () => {
    const result = await categorizeMemory(
      "agent-config",
      "use haiku for extraction",
      "procedural",
    );
    expect(result).toBe("assistant");
  });

  test("batch categorization returns parallel array", async () => {
    const memories = [
      { key: "user-email", value: "john@example.com", category: "fact" },
      { key: "preferred-editor", value: "neovim", category: "preference" },
      { key: "meeting-standup", value: "daily at 9am", category: "knowledge" },
      { key: "update-schema", value: "added column", category: "knowledge" },
    ];
    const results = await categorizeMemoryBatch(memories);
    expect(results).toHaveLength(4);
    expect(results[0]).toBe("personal");
    expect(results[1]).toBe("preferences");
    expect(results[2]).toBe("events");
    expect(results[3]).toBe("updates");
  });

  test("vectorTag returns prefixed string", () => {
    expect(vectorTag("personal")).toBe("vector:personal");
    expect(vectorTag("events")).toBe("vector:events");
    expect(vectorTag("assistant")).toBe("vector:assistant");
  });
});

// ============================================================================
// Matryoshka embedding utilities
// ============================================================================

describe("sliceEmbedding", () => {
  test("slices to requested dimensions", () => {
    const result = sliceEmbedding([1, 2, 3, 4, 5, 6], 3);
    expect(result).toEqual([1, 2, 3]);
  });

  test("empty array returns empty", () => {
    const result = sliceEmbedding([], 5);
    expect(result).toEqual([]);
  });

  test("returns original when dims >= length", () => {
    const input = [1, 2, 3];
    const result = sliceEmbedding(input, 10);
    expect(result).toBe(input); // same reference — no copy needed
  });

  test("1536-dim slice to 384 preserves first 384 elements", () => {
    const full = Array.from({ length: 1536 }, (_, i) => i / 1536);
    const sliced = sliceEmbedding(full, 384);
    expect(sliced).toHaveLength(384);
    // First and last elements of the slice match the original
    expect(sliced[0]).toBe(full[0]);
    expect(sliced[383]).toBe(full[383]);
    // The slice does NOT include element 384
    expect(sliced.includes(full[384]!)).toBe(false);
  });
});

describe("l2Normalize", () => {
  test("normalizes 3-4-5 triangle vector", () => {
    const result = l2Normalize([3, 4]);
    // norm = sqrt(9+16) = 5 → [3/5, 4/5] = [0.6, 0.8]
    expect(result[0]).toBeCloseTo(0.6, 10);
    expect(result[1]).toBeCloseTo(0.8, 10);
  });

  test("zero vector returns zero vector", () => {
    const result = l2Normalize([0, 0, 0]);
    expect(result).toEqual([0, 0, 0]);
  });
});
