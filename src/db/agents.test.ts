process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase } from "./database.js";
import { registerAgent, getAgent, listAgents, updateAgent } from "./agents.js";

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

// ============================================================================
// updateAgent
// ============================================================================

describe("updateAgent", () => {
  test("updates name", () => {
    const agent = registerAgent("old-name");
    const updated = updateAgent(agent.id, { name: "new-name" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("new-name");
  });

  test("updates description", () => {
    const agent = registerAgent("desc-agent");
    const updated = updateAgent(agent.id, { description: "new desc" });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("new desc");
  });

  test("updates role", () => {
    const agent = registerAgent("role-agent");
    const updated = updateAgent(agent.id, { role: "supervisor" });
    expect(updated).not.toBeNull();
    expect(updated!.role).toBe("supervisor");
  });

  test("updates metadata", () => {
    const agent = registerAgent("meta-agent");
    const updated = updateAgent(agent.id, { metadata: { key: "value" } });
    expect(updated).not.toBeNull();
    expect(updated!.metadata).toEqual({ key: "value" });
  });

  test("returns null for non-existent agent", () => {
    const result = updateAgent("nonexistent-id", { name: "x" });
    expect(result).toBeNull();
  });

  test("throws on duplicate name", () => {
    registerAgent("taken-name");
    const agent = registerAgent("other-name");
    expect(() => {
      updateAgent(agent.id, { name: "taken-name" });
    }).toThrow("Agent name already taken: taken-name");
  });

  test("updates last_seen_at", () => {
    const agent = registerAgent("seen-agent");
    const originalSeen = agent.last_seen_at;
    const updated = updateAgent(agent.id, { description: "bump" });
    expect(updated).not.toBeNull();
    expect(
      new Date(updated!.last_seen_at).getTime()
    ).toBeGreaterThanOrEqual(new Date(originalSeen).getTime());
  });

  test("updates multiple fields at once", () => {
    const agent = registerAgent("multi-update");
    const updated = updateAgent(agent.id, {
      description: "new desc",
      role: "coordinator",
      metadata: { foo: "bar" },
    });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("new desc");
    expect(updated!.role).toBe("coordinator");
    expect(updated!.metadata).toEqual({ foo: "bar" });
  });

  test("name change to same name is no-op", () => {
    const agent = registerAgent("same-name-agent");
    const updated = updateAgent(agent.id, { name: "same-name-agent" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("same-name-agent");
  });
});
