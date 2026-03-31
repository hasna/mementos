import { describe, test, expect } from "bun:test";
import {
  MemoryNotFoundError,
  DuplicateMemoryError,
  MemoryExpiredError,
  InvalidScopeError,
  VersionConflictError,
  EntityNotFoundError,
  isAgentConflict,
} from "./index.js";

describe("MemoryNotFoundError", () => {
  test("has correct message and name", () => {
    const err = new MemoryNotFoundError("abc-123");
    expect(err.message).toBe("Memory not found: abc-123");
    expect(err.name).toBe("MemoryNotFoundError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoryNotFoundError);
  });
});

describe("DuplicateMemoryError", () => {
  test("has correct message and name", () => {
    const err = new DuplicateMemoryError("my-key", "shared");
    expect(err.message).toBe(
      'Memory already exists with key "my-key" in scope "shared"'
    );
    expect(err.name).toBe("DuplicateMemoryError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DuplicateMemoryError);
  });

  test("works with different scopes", () => {
    const global = new DuplicateMemoryError("k", "global");
    expect(global.message).toContain('"global"');

    const priv = new DuplicateMemoryError("k", "private");
    expect(priv.message).toContain('"private"');
  });
});

describe("MemoryExpiredError", () => {
  test("has correct message and name", () => {
    const err = new MemoryExpiredError("exp-id");
    expect(err.message).toBe("Memory has expired: exp-id");
    expect(err.name).toBe("MemoryExpiredError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoryExpiredError);
  });
});

describe("InvalidScopeError", () => {
  test("has correct message and name", () => {
    const err = new InvalidScopeError("bad scope value");
    expect(err.message).toBe("bad scope value");
    expect(err.name).toBe("InvalidScopeError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidScopeError);
  });
});

describe("VersionConflictError", () => {
  test("has correct message, name, and properties", () => {
    const err = new VersionConflictError("mem-id", 3, 5);
    expect(err.message).toBe(
      "Version conflict for memory mem-id: expected 3, got 5"
    );
    expect(err.name).toBe("VersionConflictError");
    expect(err.expected).toBe(3);
    expect(err.actual).toBe(5);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VersionConflictError);
  });
});

describe("EntityNotFoundError", () => {
  test("has correct message and name (lines 355-356)", () => {
    const err = new EntityNotFoundError("entity-abc-123");
    expect(err.message).toBe("Entity not found: entity-abc-123");
    expect(err.name).toBe("EntityNotFoundError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EntityNotFoundError);
  });
});

describe("isAgentConflict", () => {
  test("returns true for AgentConflictError objects (line 196)", () => {
    const conflict = { conflict: true };
    expect(isAgentConflict(conflict)).toBe(true);
  });

  test("returns false for non-conflict objects", () => {
    expect(isAgentConflict(null)).toBe(false);
    expect(isAgentConflict({})).toBe(false);
    expect(isAgentConflict({ conflict: false })).toBe(false);
    expect(isAgentConflict("string")).toBe(false);
  });
});
