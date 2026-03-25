process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import {
  checkDuplicate,
  dedup,
  getDedupStats,
  resetDedupStats,
  type DedupConfig,
} from "./dedup.js";
import { registerAgent } from "../db/agents.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
  resetDedupStats();
});

// ============================================================================
// getDedupStats / resetDedupStats
// ============================================================================

describe("getDedupStats", () => {
  test("returns zeroed stats after reset", () => {
    const stats = getDedupStats();
    expect(stats.checked).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.updated).toBe(0);
  });

  test("returns a copy (not a reference)", () => {
    const a = getDedupStats();
    const b = getDedupStats();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("resetDedupStats", () => {
  test("resets stats after checks have been performed", () => {
    checkDuplicate("some content here testing", {});
    expect(getDedupStats().checked).toBeGreaterThan(0);

    resetDedupStats();
    expect(getDedupStats().checked).toBe(0);
    expect(getDedupStats().skipped).toBe(0);
    expect(getDedupStats().updated).toBe(0);
  });
});

// ============================================================================
// checkDuplicate
// ============================================================================

describe("checkDuplicate", () => {
  test("returns 'unique' when no memories exist", () => {
    const result = checkDuplicate(
      "this is a completely new memory with enough words",
      {}
    );
    expect(result).toBe("unique");
  });

  test("returns 'unique' for content with only short words", () => {
    // All words <= 3 chars get filtered, so query is empty → unique
    const result = checkDuplicate("a is to be or of", {});
    expect(result).toBe("unique");
  });

  test("returns 'unique' for empty content", () => {
    const result = checkDuplicate("", {});
    expect(result).toBe("unique");
  });

  test("increments checked counter", () => {
    checkDuplicate("some content with enough words here", {});
    checkDuplicate("another content with different words here", {});
    expect(getDedupStats().checked).toBe(2);
  });

  test("returns 'duplicate' for near-identical content", () => {
    createMemory({
      key: "test-memory",
      value:
        "the quick brown fox jumps over the lazy dog in the garden today",
    });

    const result = checkDuplicate(
      "the quick brown fox jumps over the lazy dog in the garden today",
      {}
    );
    expect(result).toBe("duplicate");
  });

  test("returns 'unique' for sufficiently different content", () => {
    createMemory({
      key: "test-memory",
      value:
        "the quick brown fox jumps over the lazy dog in the garden today",
    });

    const result = checkDuplicate(
      "deploying microservices architecture using kubernetes clusters",
      {}
    );
    expect(result).toBe("unique");
  });

  test("returns updateId when new content is longer and keepLonger is true", () => {
    const mem = createMemory({
      key: "project-stack",
      value:
        "project uses typescript react postgres deployment configuration",
    });

    // Longer content with same core words — should trigger update
    const result = checkDuplicate(
      "project uses typescript react postgres deployment configuration with additional webpack bundling and docker containerization setup",
      {},
      { threshold: 0.4, keepLonger: true }
    );

    expect(result).not.toBe("unique");
    expect(result).not.toBe("duplicate");
    expect(typeof result).toBe("object");
    if (typeof result === "object") {
      expect(result.updateId).toBe(mem.id);
      expect(result.existingContent).toBe(mem.value);
    }
  });

  test("returns 'duplicate' when new content is shorter even if similar", () => {
    createMemory({
      key: "project-stack",
      value:
        "project uses typescript react postgres deployment configuration with additional webpack bundling and docker containerization setup",
    });

    // Shorter content with same core words — should be duplicate (not update)
    const result = checkDuplicate(
      "project uses typescript react postgres deployment configuration",
      {},
      { threshold: 0.4, keepLonger: true }
    );

    expect(result).toBe("duplicate");
  });

  test("respects custom threshold", () => {
    createMemory({
      key: "test-memory",
      value:
        "quick brown fox jumps over lazy dog garden flowers sunshine morning",
    });

    // Very high threshold — almost nothing is a duplicate
    const highThreshold = checkDuplicate(
      "quick brown fox jumps over lazy dog garden different ending here",
      {},
      { threshold: 0.99, keepLonger: true }
    );
    expect(highThreshold).toBe("unique");

    // Very low threshold — almost everything is a duplicate
    const lowThreshold = checkDuplicate(
      "quick brown fox jumps over lazy dog garden different ending here",
      {},
      { threshold: 0.1, keepLonger: true }
    );
    expect(lowThreshold).not.toBe("unique");
  });

  test("returns 'duplicate' when keepLonger is false even if new is longer", () => {
    createMemory({
      key: "short-memory",
      value: "quick brown fox jumps over lazy dog garden",
    });

    const result = checkDuplicate(
      "quick brown fox jumps over lazy dog garden with extra details and more specific information",
      {},
      { threshold: 0.5, keepLonger: false }
    );

    expect(result).toBe("duplicate");
  });

  test("filters by agent_id", () => {
    const agentA = registerAgent("agent-a");
    const agentB = registerAgent("agent-b");

    createMemory({
      key: "agent-a-memory",
      value:
        "typescript react postgres deployment configuration webpack bundling docker",
      agent_id: agentA.id,
    });

    // Different agent — should not find the duplicate
    const result = checkDuplicate(
      "typescript react postgres deployment configuration webpack bundling docker",
      { agent_id: agentB.id }
    );
    expect(result).toBe("unique");

    // Same agent — should find it
    const result2 = checkDuplicate(
      "typescript react postgres deployment configuration webpack bundling docker",
      { agent_id: agentA.id }
    );
    expect(result2).not.toBe("unique");
  });
});

// ============================================================================
// dedup
// ============================================================================

describe("dedup", () => {
  test("returns 'save' for unique content", () => {
    const result = dedup(
      "completely novel content about kubernetes deployment strategies",
      {}
    );
    expect(result).toBe("save");
  });

  test("returns 'skip' for duplicate content", () => {
    createMemory({
      key: "existing",
      value:
        "the quick brown fox jumps over the lazy dog in the garden today",
    });

    const result = dedup(
      "the quick brown fox jumps over the lazy dog in the garden today",
      {}
    );
    expect(result).toBe("skip");
    expect(getDedupStats().skipped).toBe(1);
  });

  test("returns 'skip' and increments updated when longer content replaces shorter", () => {
    createMemory({
      key: "project-stack",
      value:
        "project uses typescript react postgres deployment configuration",
    });

    const result = dedup(
      "project uses typescript react postgres deployment configuration with additional webpack bundling and docker containerization setup details",
      {},
      { threshold: 0.4, keepLonger: true }
    );

    expect(result).toBe("skip");
    expect(getDedupStats().updated).toBe(1);
    expect(getDedupStats().skipped).toBe(0);
  });

  test("returns 'save' for empty/short-word content", () => {
    const result = dedup("a is to", {});
    expect(result).toBe("save");
  });

  test("stats accumulate across multiple calls", () => {
    createMemory({
      key: "existing",
      value:
        "the quick brown fox jumps over the lazy dog in the garden today",
    });

    dedup("completely novel content about different topics entirely", {});
    dedup(
      "the quick brown fox jumps over the lazy dog in the garden today",
      {}
    );
    dedup("another brand new piece of content about databases", {});

    const stats = getDedupStats();
    expect(stats.checked).toBe(3);
    expect(stats.skipped).toBe(1);
  });
});
