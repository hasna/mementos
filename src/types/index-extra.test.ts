import { describe, test, expect } from "bun:test";
import {
  MemoryConflictError,
  isAgentConflict,
  AgentConflictError,
} from "./index.js";

// ============================================================================
// MemoryConflictError — lines 431-445
// ============================================================================

describe("MemoryConflictError", () => {
  test("has correct message, name, and properties", () => {
    const err = new MemoryConflictError("my-key", {
      id: "mem-123",
      agent_id: "agent-xyz",
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(err.name).toBe("MemoryConflictError");
    expect(err.existingId).toBe("mem-123");
    expect(err.existingAgentId).toBe("agent-xyz");
    expect(err.existingUpdatedAt).toBe("2026-01-01T00:00:00Z");
    expect(err.message).toContain("my-key");
    expect(err.message).toContain("agent-xyz");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoryConflictError);
  });

  test("handles null agent_id in message", () => {
    const err = new MemoryConflictError("some-key", {
      id: "mem-456",
      agent_id: null,
      updated_at: "2026-02-01T00:00:00Z",
    });
    expect(err.existingAgentId).toBeNull();
    expect(err.message).toContain("unknown");
  });
});

// ============================================================================
// isAgentConflict — line 196
// ============================================================================

describe("isAgentConflict", () => {
  test("returns true for AgentConflictError with conflict=true", () => {
    const err = new AgentConflictError({
      message: "Agent conflict",
      existing_id: "agent-123",
      existing_name: "galba",
      last_seen_at: "2026-01-01T00:00:00Z",
    });
    expect(isAgentConflict(err)).toBe(true);
  });

  test("returns false for regular Error", () => {
    const err = new Error("some error");
    expect(isAgentConflict(err)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isAgentConflict(null)).toBe(false);
  });

  test("returns false for plain object without conflict", () => {
    expect(isAgentConflict({ message: "no conflict" })).toBe(false);
  });

  test("returns true for plain object with conflict=true", () => {
    expect(isAgentConflict({ conflict: true })).toBe(true);
  });
});
