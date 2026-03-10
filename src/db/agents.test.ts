process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase } from "./database.js";
import { registerAgent, getAgent, listAgents } from "./agents.js";

beforeEach(() => {
  resetDatabase();
});

describe("registerAgent", () => {
  test("creates new agent with 8-char ID", () => {
    const agent = registerAgent("maximus");
    expect(agent.id).toHaveLength(8);
    expect(agent.name).toBe("maximus");
    expect(agent.role).toBe("agent");
    expect(agent.description).toBeNull();
    expect(agent.metadata).toEqual({});
    expect(agent.created_at).toBeTruthy();
    expect(agent.last_seen_at).toBeTruthy();
  });

  test("idempotent — same name returns same agent", () => {
    const first = registerAgent("cassius");
    const second = registerAgent("cassius");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("cassius");
  });

  test("updates last_seen_at on re-register", () => {
    const first = registerAgent("aurelius");
    const firstSeen = first.last_seen_at;
    // Small delay to ensure different timestamp
    const second = registerAgent("aurelius");
    // last_seen_at should be updated (>= first since timestamps may be same ms)
    expect(second.last_seen_at).toBeTruthy();
    expect(new Date(second.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(firstSeen).getTime()
    );
  });

  test("updates description on re-register", () => {
    const first = registerAgent("brutus", "original desc");
    expect(first.description).toBe("original desc");
    const second = registerAgent("brutus", "updated desc");
    expect(second.description).toBe("updated desc");
    expect(second.id).toBe(first.id);
  });

  test("updates role on re-register", () => {
    const first = registerAgent("titus", undefined, "agent");
    expect(first.role).toBe("agent");
    const second = registerAgent("titus", undefined, "supervisor");
    expect(second.role).toBe("supervisor");
    expect(second.id).toBe(first.id);
  });

  test("sets custom description and role on creation", () => {
    const agent = registerAgent("nero", "a helper", "coordinator");
    expect(agent.description).toBe("a helper");
    expect(agent.role).toBe("coordinator");
  });
});

describe("getAgent", () => {
  test("retrieves agent by ID", () => {
    const created = registerAgent("cicero");
    const found = getAgent(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.name).toBe("cicero");
  });

  test("retrieves agent by name", () => {
    const created = registerAgent("seneca");
    const found = getAgent("seneca");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  test("retrieves agent by partial ID", () => {
    const created = registerAgent("cato");
    // Use first 4 chars as partial ID
    const partial = created.id.slice(0, 4);
    const found = getAgent(partial);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  test("returns null for non-existent agent", () => {
    const found = getAgent("nonexistent");
    expect(found).toBeNull();
  });
});

describe("listAgents", () => {
  test("returns empty list when no agents exist", () => {
    const agents = listAgents();
    expect(agents).toEqual([]);
  });

  test("returns all registered agents", () => {
    registerAgent("alpha");
    registerAgent("beta");
    registerAgent("gamma");
    const agents = listAgents();
    expect(agents).toHaveLength(3);
    const names = agents.map((a) => a.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
  });

  test("ordered by last_seen_at DESC", () => {
    const a = registerAgent("first");
    const b = registerAgent("second");
    // Re-register "first" to bump its last_seen_at
    registerAgent("first");
    const agents = listAgents();
    expect(agents).toHaveLength(2);
    // "first" was re-registered last, so it should be first in the list
    expect(agents[0]!.name).toBe("first");
    expect(agents[1]!.name).toBe("second");
  });
});
