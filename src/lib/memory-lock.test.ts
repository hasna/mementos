process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase } from "../db/database.js";
import { registerAgent } from "../db/agents.js";
import { registerProject } from "../db/projects.js";
import {
  memoryLockId,
  acquireMemoryWriteLock,
  releaseMemoryWriteLock,
  checkMemoryWriteLock,
  withMemoryLock,
  MemoryLockConflictError,
} from "./memory-lock.js";

beforeEach(() => {
  resetDatabase();
});

describe("memoryLockId", () => {
  test("builds lock id with scope, key, and project", () => {
    expect(memoryLockId("my-key", "shared", "proj-123")).toBe(
      "shared:my-key:proj-123"
    );
  });

  test("builds lock id without project", () => {
    expect(memoryLockId("my-key", "global")).toBe("global:my-key:");
  });

  test("handles null project", () => {
    expect(memoryLockId("my-key", "private", null)).toBe("private:my-key:");
  });

  test("handles different scopes", () => {
    expect(memoryLockId("k", "shared", "p")).toBe("shared:k:p");
    expect(memoryLockId("k", "global", "p")).toBe("global:k:p");
    expect(memoryLockId("k", "private", "p")).toBe("private:k:p");
  });
});

describe("acquireMemoryWriteLock", () => {
  test("acquires a lock and returns it", () => {
    const agent = registerAgent("agent-a");
    const lock = acquireMemoryWriteLock(agent.id, "test-key", "shared", "proj");
    expect(lock).not.toBeNull();
    expect(lock!.agent_id).toBe(agent.id);
    expect(lock!.resource_type).toBe("memory");
    expect(lock!.lock_type).toBe("exclusive");
  });

  test("same agent can re-acquire (heartbeat refresh)", () => {
    const agent = registerAgent("agent-a");
    const lock1 = acquireMemoryWriteLock(agent.id, "k", "shared", "p");
    const lock2 = acquireMemoryWriteLock(agent.id, "k", "shared", "p");
    expect(lock1).not.toBeNull();
    expect(lock2).not.toBeNull();
    expect(lock1!.id).toBe(lock2!.id);
  });

  test("second agent is blocked by first agent's lock", () => {
    const a1 = registerAgent("agent-a");
    const a2 = registerAgent("agent-b");
    const lock1 = acquireMemoryWriteLock(a1.id, "k", "shared", "p");
    expect(lock1).not.toBeNull();
    const lock2 = acquireMemoryWriteLock(a2.id, "k", "shared", "p");
    expect(lock2).toBeNull();
  });

  test("different keys do not block each other", () => {
    const a1 = registerAgent("agent-a");
    const a2 = registerAgent("agent-b");
    const lock1 = acquireMemoryWriteLock(a1.id, "key-1", "shared", "p");
    const lock2 = acquireMemoryWriteLock(a2.id, "key-2", "shared", "p");
    expect(lock1).not.toBeNull();
    expect(lock2).not.toBeNull();
  });

  test("different projects do not block each other", () => {
    const a1 = registerAgent("agent-a");
    const a2 = registerAgent("agent-b");
    const lock1 = acquireMemoryWriteLock(a1.id, "k", "shared", "proj-1");
    const lock2 = acquireMemoryWriteLock(a2.id, "k", "shared", "proj-2");
    expect(lock1).not.toBeNull();
    expect(lock2).not.toBeNull();
  });

  test("different scopes do not block each other", () => {
    const a1 = registerAgent("agent-a");
    const a2 = registerAgent("agent-b");
    const lock1 = acquireMemoryWriteLock(a1.id, "k", "shared", "p");
    const lock2 = acquireMemoryWriteLock(a2.id, "k", "global", "p");
    expect(lock1).not.toBeNull();
    expect(lock2).not.toBeNull();
  });

  test("uses default TTL of 30 seconds", () => {
    const agent = registerAgent("agent-a");
    const lock = acquireMemoryWriteLock(agent.id, "k", "shared", "p");
    expect(lock).not.toBeNull();
    const expiresAt = new Date(lock!.expires_at).getTime();
    const lockedAt = new Date(lock!.locked_at).getTime();
    // TTL should be approximately 30 seconds
    const diff = (expiresAt - lockedAt) / 1000;
    expect(diff).toBeGreaterThan(25);
    expect(diff).toBeLessThan(35);
  });

  test("respects custom TTL", () => {
    const agent = registerAgent("agent-a");
    const lock = acquireMemoryWriteLock(agent.id, "k", "shared", "p", 60);
    expect(lock).not.toBeNull();
    const expiresAt = new Date(lock!.expires_at).getTime();
    const lockedAt = new Date(lock!.locked_at).getTime();
    const diff = (expiresAt - lockedAt) / 1000;
    expect(diff).toBeGreaterThan(55);
    expect(diff).toBeLessThan(65);
  });
});

describe("releaseMemoryWriteLock", () => {
  test("releases an acquired lock", () => {
    const agent = registerAgent("agent-a");
    const lock = acquireMemoryWriteLock(agent.id, "k", "shared", "p");
    expect(lock).not.toBeNull();
    const released = releaseMemoryWriteLock(lock!.id, agent.id);
    expect(released).toBe(true);
  });

  test("returns false for non-existent lock", () => {
    const agent = registerAgent("agent-a");
    const released = releaseMemoryWriteLock("nonexistent", agent.id);
    expect(released).toBe(false);
  });

  test("returns false if wrong agent tries to release", () => {
    const a1 = registerAgent("agent-a");
    const a2 = registerAgent("agent-b");
    const lock = acquireMemoryWriteLock(a1.id, "k", "shared", "p");
    expect(lock).not.toBeNull();
    const released = releaseMemoryWriteLock(lock!.id, a2.id);
    expect(released).toBe(false);
  });

  test("after release, another agent can acquire", () => {
    const a1 = registerAgent("agent-a");
    const a2 = registerAgent("agent-b");
    const lock1 = acquireMemoryWriteLock(a1.id, "k", "shared", "p");
    expect(lock1).not.toBeNull();
    releaseMemoryWriteLock(lock1!.id, a1.id);
    const lock2 = acquireMemoryWriteLock(a2.id, "k", "shared", "p");
    expect(lock2).not.toBeNull();
  });
});

describe("checkMemoryWriteLock", () => {
  test("returns null when no lock exists", () => {
    const result = checkMemoryWriteLock("k", "shared", "p");
    expect(result).toBeNull();
  });

  test("returns the active lock", () => {
    const agent = registerAgent("agent-a");
    acquireMemoryWriteLock(agent.id, "k", "shared", "p");
    const result = checkMemoryWriteLock("k", "shared", "p");
    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe(agent.id);
    expect(result!.lock_type).toBe("exclusive");
  });

  test("returns null after lock is released", () => {
    const agent = registerAgent("agent-a");
    const lock = acquireMemoryWriteLock(agent.id, "k", "shared", "p");
    releaseMemoryWriteLock(lock!.id, agent.id);
    const result = checkMemoryWriteLock("k", "shared", "p");
    expect(result).toBeNull();
  });

  test("does not return locks for different key/scope/project", () => {
    const agent = registerAgent("agent-a");
    acquireMemoryWriteLock(agent.id, "k", "shared", "p");
    expect(checkMemoryWriteLock("other-key", "shared", "p")).toBeNull();
    expect(checkMemoryWriteLock("k", "global", "p")).toBeNull();
    expect(checkMemoryWriteLock("k", "shared", "other-proj")).toBeNull();
  });
});

describe("withMemoryLock", () => {
  test("executes callback and returns result", () => {
    const agent = registerAgent("agent-a");
    const result = withMemoryLock(agent.id, "k", "shared", "p", () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test("releases lock after successful execution", () => {
    const agent = registerAgent("agent-a");
    withMemoryLock(agent.id, "k", "shared", "p", () => "done");
    // Lock should be released, so another agent can acquire
    const a2 = registerAgent("agent-b");
    const lock = acquireMemoryWriteLock(a2.id, "k", "shared", "p");
    expect(lock).not.toBeNull();
  });

  test("releases lock after callback throws", () => {
    const agent = registerAgent("agent-a");
    try {
      withMemoryLock(agent.id, "k", "shared", "p", () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    // Lock should be released
    const a2 = registerAgent("agent-b");
    const lock = acquireMemoryWriteLock(a2.id, "k", "shared", "p");
    expect(lock).not.toBeNull();
  });

  test("throws MemoryLockConflictError when blocked", () => {
    const a1 = registerAgent("agent-a");
    const a2 = registerAgent("agent-b");
    acquireMemoryWriteLock(a1.id, "k", "shared", "p");
    expect(() => {
      withMemoryLock(a2.id, "k", "shared", "p", () => "nope");
    }).toThrow(MemoryLockConflictError);
  });

  test("MemoryLockConflictError contains useful fields", () => {
    const a1 = registerAgent("agent-a");
    const a2 = registerAgent("agent-b");
    acquireMemoryWriteLock(a1.id, "k", "shared", "p");
    try {
      withMemoryLock(a2.id, "k", "shared", "p", () => "nope");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryLockConflictError);
      const e = err as MemoryLockConflictError;
      expect(e.key).toBe("k");
      expect(e.scope).toBe("shared");
      expect(e.blocking_agent_id).toBe(a1.id);
      expect(e.conflict).toBe(true);
      expect(e.name).toBe("MemoryLockConflictError");
      expect(e.message).toContain("k");
      expect(e.message).toContain("shared");
    }
  });

  test("works with null project", () => {
    const agent = registerAgent("agent-a");
    const result = withMemoryLock(agent.id, "k", "global", null, () => "ok");
    expect(result).toBe("ok");
  });

  test("works with undefined project", () => {
    const agent = registerAgent("agent-a");
    const result = withMemoryLock(
      agent.id,
      "k",
      "global",
      undefined,
      () => "ok"
    );
    expect(result).toBe("ok");
  });
});

describe("MemoryLockConflictError", () => {
  test("is an instance of Error", () => {
    const err = new MemoryLockConflictError("k", "shared", "agent-x");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoryLockConflictError);
  });

  test("has correct name", () => {
    const err = new MemoryLockConflictError("k", "shared", "agent-x");
    expect(err.name).toBe("MemoryLockConflictError");
  });

  test("has correct properties", () => {
    const err = new MemoryLockConflictError("my-key", "global", "agent-99");
    expect(err.key).toBe("my-key");
    expect(err.scope).toBe("global");
    expect(err.blocking_agent_id).toBe("agent-99");
    expect(err.conflict).toBe(true);
  });

  test("message includes key, scope, and blocking agent", () => {
    const err = new MemoryLockConflictError("my-key", "shared", "agent-99");
    expect(err.message).toContain("my-key");
    expect(err.message).toContain("shared");
    expect(err.message).toContain("agent-99");
  });
});
