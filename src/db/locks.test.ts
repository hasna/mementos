process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase } from "./database.js";
import { registerAgent } from "./agents.js";
import {
  acquireLock,
  releaseLock,
  releaseResourceLocks,
  releaseAllAgentLocks,
  checkLock,
  agentHoldsLock,
  listAgentLocks,
  cleanExpiredLocks,
} from "./locks.js";

beforeEach(() => {
  resetDatabase();
});

describe("acquireLock", () => {
  test("acquires exclusive lock on a resource", () => {
    const alpha = registerAgent("alpha");
    const lock = acquireLock(alpha.id, "memory", "mem-123");
    expect(lock).not.toBeNull();
    expect(lock!.resource_type).toBe("memory");
    expect(lock!.resource_id).toBe("mem-123");
    expect(lock!.agent_id).toBe(alpha.id);
    expect(lock!.lock_type).toBe("exclusive");
    expect(lock!.expires_at).toBeTruthy();
  });

  test("blocks second exclusive lock on same resource", () => {
    const alpha = registerAgent("alpha");
    const beta = registerAgent("beta");
    acquireLock(alpha.id, "memory", "mem-123");
    const blocked = acquireLock(beta.id, "memory", "mem-123");
    expect(blocked).toBeNull();
  });

  test("same agent re-acquiring refreshes TTL", () => {
    const alpha = registerAgent("alpha");
    const first = acquireLock(alpha.id, "memory", "mem-123", "exclusive", 300);
    const second = acquireLock(alpha.id, "memory", "mem-123", "exclusive", 600);
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id);
  });

  test("multiple advisory locks can coexist", () => {
    const alpha = registerAgent("alpha");
    const beta = registerAgent("beta");
    const a = acquireLock(alpha.id, "memory", "mem-456", "advisory");
    const b = acquireLock(beta.id, "memory", "mem-456", "advisory");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  test("different resources don't block each other", () => {
    const alpha = registerAgent("alpha");
    const beta = registerAgent("beta");
    acquireLock(alpha.id, "memory", "mem-A");
    const lock = acquireLock(beta.id, "memory", "mem-B");
    expect(lock).not.toBeNull();
  });

  test("different resource types don't block each other", () => {
    const alpha = registerAgent("alpha");
    const beta = registerAgent("beta");
    acquireLock(alpha.id, "project", "proj-1");
    const lock = acquireLock(beta.id, "memory", "proj-1");
    expect(lock).not.toBeNull();
  });
});

describe("releaseLock", () => {
  test("releases own lock", () => {
    const alpha = registerAgent("alpha");
    const lock = acquireLock(alpha.id, "memory", "mem-123")!;
    const released = releaseLock(lock.id, alpha.id);
    expect(released).toBe(true);
    expect(checkLock("memory", "mem-123")).toHaveLength(0);
  });

  test("cannot release another agent's lock", () => {
    const alpha = registerAgent("alpha");
    const beta = registerAgent("beta");
    const lock = acquireLock(alpha.id, "memory", "mem-123")!;
    const released = releaseLock(lock.id, beta.id);
    expect(released).toBe(false);
    expect(checkLock("memory", "mem-123")).toHaveLength(1);
  });

  test("returns false for non-existent lock", () => {
    const alpha = registerAgent("alpha");
    expect(releaseLock("nonexistent", alpha.id)).toBe(false);
  });
});

describe("releaseResourceLocks", () => {
  test("releases all agent locks on a resource", () => {
    const alpha = registerAgent("alpha");
    acquireLock(alpha.id, "memory", "mem-1", "advisory");
    const count = releaseResourceLocks(alpha.id, "memory", "mem-1");
    expect(count).toBe(1);
    expect(checkLock("memory", "mem-1")).toHaveLength(0);
  });
});

describe("releaseAllAgentLocks", () => {
  test("releases all locks for an agent", () => {
    const alpha = registerAgent("alpha");
    acquireLock(alpha.id, "memory", "mem-1");
    acquireLock(alpha.id, "project", "proj-1", "advisory");
    const count = releaseAllAgentLocks(alpha.id);
    expect(count).toBe(2);
    expect(listAgentLocks(alpha.id)).toHaveLength(0);
  });

  test("does not affect other agents", () => {
    const alpha = registerAgent("alpha");
    const beta = registerAgent("beta");
    acquireLock(alpha.id, "memory", "mem-1");
    acquireLock(beta.id, "memory", "mem-2");
    releaseAllAgentLocks(alpha.id);
    expect(listAgentLocks(beta.id)).toHaveLength(1);
  });
});

describe("checkLock", () => {
  test("returns active locks for a resource", () => {
    const alpha = registerAgent("alpha");
    acquireLock(alpha.id, "memory", "mem-123");
    const locks = checkLock("memory", "mem-123");
    expect(locks).toHaveLength(1);
    expect(locks[0]!.agent_id).toBe(alpha.id);
  });

  test("filters by lock type", () => {
    const alpha = registerAgent("alpha");
    const beta = registerAgent("beta");
    acquireLock(alpha.id, "memory", "mem-123", "advisory");
    acquireLock(beta.id, "memory", "mem-123", "advisory");
    expect(checkLock("memory", "mem-123", "advisory")).toHaveLength(2);
    expect(checkLock("memory", "mem-123", "exclusive")).toHaveLength(0);
  });

  test("returns empty for unlocked resource", () => {
    expect(checkLock("memory", "nonexistent")).toHaveLength(0);
  });
});

describe("agentHoldsLock", () => {
  test("returns lock if agent holds it", () => {
    const alpha = registerAgent("alpha");
    acquireLock(alpha.id, "memory", "mem-123");
    expect(agentHoldsLock(alpha.id, "memory", "mem-123")).not.toBeNull();
  });

  test("returns null if agent does not hold lock", () => {
    const alpha = registerAgent("alpha");
    const beta = registerAgent("beta");
    acquireLock(alpha.id, "memory", "mem-123");
    expect(agentHoldsLock(beta.id, "memory", "mem-123")).toBeNull();
  });
});

describe("listAgentLocks", () => {
  test("lists all active locks for an agent", () => {
    const alpha = registerAgent("alpha");
    acquireLock(alpha.id, "memory", "mem-1");
    acquireLock(alpha.id, "project", "proj-1", "advisory");
    expect(listAgentLocks(alpha.id)).toHaveLength(2);
  });
});

describe("cleanExpiredLocks", () => {
  test("removes no locks when none are expired", () => {
    const alpha = registerAgent("alpha");
    acquireLock(alpha.id, "memory", "mem-1", "exclusive", 300);
    expect(cleanExpiredLocks()).toBe(0);
  });

  test("non-expired lock still visible after clean", () => {
    const alpha = registerAgent("alpha");
    acquireLock(alpha.id, "memory", "mem-1", "exclusive", 300);
    cleanExpiredLocks();
    expect(listAgentLocks(alpha.id)).toHaveLength(1);
  });
});
