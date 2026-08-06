process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import { registerAgent, getAgent, listAgents, updateAgent, touchAgent, listAgentsByProject } from "./agents.js";
import { registerProject } from "./projects.js";

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
    const first = registerAgent("brutus", undefined, "original desc");
    expect(first.description).toBe("original desc");
    const second = registerAgent("brutus", undefined, "updated desc");
    expect(second.description).toBe("updated desc");
    expect(second.id).toBe(first.id);
  });

  test("updates role on re-register", () => {
    const first = registerAgent("titus", undefined, undefined, "agent");
    expect(first.role).toBe("agent");
    const second = registerAgent("titus", undefined, undefined, "supervisor");
    expect(second.role).toBe("supervisor");
    expect(second.id).toBe(first.id);
  });

  test("sets custom description and role on creation", () => {
    const agent = registerAgent("nero", undefined, "a helper", "coordinator");
    expect(agent.description).toBe("a helper");
    expect(agent.role).toBe("coordinator");
  });

  test("session_id is stored and returned", () => {
    const agent = registerAgent("session-agent", "sess-abc123");
    expect(agent.session_id).toBe("sess-abc123");
  });

  test("same session_id re-register is idempotent (no conflict)", () => {
    const first = registerAgent("session-idem", "same-sess");
    const second = registerAgent("session-idem", "same-sess");
    expect(second.id).toBe(first.id);
    expect(second.session_id).toBe("same-sess");
  });

  test("different session_id within 30 min throws AgentConflictError", () => {
    const first = registerAgent("conflict-agent", "session-A");
    try {
      registerAgent("conflict-agent", "session-B");
      throw new Error("should have thrown");
    } catch (e: unknown) {
      const err = e as import("../types/index.js").AgentConflictError;
      expect(err.conflict).toBe(true);
      expect(err.existing_id).toBe(first.id);
      expect(err.existing_name).toBe("conflict-agent");
      expect(err.session_hint).toBe("session-");
      expect(err.last_seen_at).toBeTruthy();
      expect(err.working_dir).toBeNull();
      expect(err.message).toContain("conflict-agent");
    }
  });

  test("no session_id does not conflict", () => {
    registerAgent("no-sess-agent", "session-X");
    // Re-registering without session_id should not conflict
    expect(() => {
      registerAgent("no-sess-agent");
    }).not.toThrow();
  });

  test("registers with partial project_id", () => {
    const proj = registerProject("reg-proj", "/tmp/reg-proj");
    const partialId = proj.id.slice(0, 8);
    const agent = registerAgent("proj-reg-agent", undefined, undefined, undefined, partialId);
    expect(agent.active_project_id).toBe(proj.id);
  });

  test("throws when project_id is invalid", () => {
    expect(() => {
      registerAgent("bad-proj-agent", undefined, undefined, undefined, "nonexistent");
    }).toThrow("Project not found: nonexistent");
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

  test("ordered by created_at ASC with id as the immutable tie-breaker", () => {
    const db = getDatabase();
    const first = registerAgent("first");
    const tied = [registerAgent("second"), registerAgent("third")].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    db.run("UPDATE agents SET created_at = ?, last_seen_at = ? WHERE id = ?", [
      "2026-01-01T00:00:00.000Z",
      "2025-01-03T00:00:00.000Z",
      first.id,
    ]);
    for (const agent of tied) {
      db.run("UPDATE agents SET created_at = ?, last_seen_at = ? WHERE id = ?", [
        "2026-01-02T00:00:00.000Z",
        "2025-01-02T00:00:00.000Z",
        agent.id,
      ]);
    }

    touchAgent(tied[1]!.id, db);

    expect(listAgents(db).map((agent) => agent.id)).toEqual([
      first.id,
      tied[0]!.id,
      tied[1]!.id,
    ]);
  });

  test("respects limit and offset, including an empty terminal page", () => {
    const db = getDatabase();
    const created = ["page-a", "page-b", "page-c"].map((name, index) => {
      const agent = registerAgent(name);
      db.run("UPDATE agents SET created_at = ?, last_seen_at = ? WHERE id = ?", [
        new Date(Date.UTC(2026, 7, 6, 12, 0, index)).toISOString(),
        new Date(Date.UTC(2025, 7, 6, 12, 0, 3 - index)).toISOString(),
        agent.id,
      ]);
      return agent;
    });

    const first = listAgents({ limit: 2, offset: 0 });
    const second = listAgents({ limit: 2, offset: 2 });
    const offsetOnly = listAgents({ offset: 1 }, db);
    const terminal = listAgents({ limit: 2, offset: 3 });
    const legacyDbArg = listAgents(db);

    expect(first.map((agent) => agent.id)).toEqual([created[0]!.id, created[1]!.id]);
    expect(second.map((agent) => agent.id)).toEqual([created[2]!.id]);
    expect(offsetOnly.map((agent) => agent.id)).toEqual([created[1]!.id, created[2]!.id]);
    expect(terminal).toEqual([]);
    expect(legacyDbArg).toHaveLength(3);
  });

  test("keeps forward paging complete when an unseen agent heartbeats between pages", () => {
    const db = getDatabase();
    const created = ["stable-page-a", "stable-page-b", "stable-page-c", "stable-page-d"].map(
      (name, index) => {
        const agent = registerAgent(name);
        db.run("UPDATE agents SET created_at = ?, last_seen_at = ? WHERE id = ?", [
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          new Date(Date.UTC(2025, 0, 1, 0, 0, 4 - index)).toISOString(),
          agent.id,
        ]);
        return agent;
      }
    );
    const expectedIds = created.map((agent) => agent.id);
    const pageSize = 2;
    const seenIds = listAgents({ limit: pageSize, offset: 0 }, db).map((agent) => agent.id);

    expect(seenIds).toEqual(expectedIds.slice(0, pageSize));
    expect(seenIds).not.toContain(created[3]!.id);

    touchAgent(created[3]!.id, db);

    let offset = pageSize;
    while (true) {
      const page = listAgents({ limit: pageSize, offset }, db);
      if (page.length === 0) break;
      seenIds.push(...page.map((agent) => agent.id));
      offset += page.length;
    }

    expect(seenIds).toHaveLength(expectedIds.length);
    expect(new Set(seenIds).size).toBe(expectedIds.length);
    expect([...seenIds].sort()).toEqual([...expectedIds].sort());
  });

  test("uses a non-negative limit for offset-only adapter queries", () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const db = {
      query(sql: string) {
        capturedSql = sql;
        return {
          all(...params: unknown[]) {
            capturedParams = params;
            return [];
          },
        };
      },
    } as unknown as ReturnType<typeof getDatabase>;

    expect(listAgents({ offset: 4 }, db)).toEqual([]);
    expect(capturedSql).toEndWith("LIMIT ? OFFSET ?");
    expect(capturedSql).not.toContain("LIMIT -1");
    expect(capturedParams).toEqual([Number.MAX_SAFE_INTEGER, 4]);
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

  test("sets active_project_id", () => {
    const proj = registerProject("test-proj", "/tmp/test-proj");
    const agent = registerAgent("project-agent");
    const updated = updateAgent(agent.id, { active_project_id: proj.id });
    expect(updated!.active_project_id).toBe(proj.id);
  });

  test("sets active_project_id with partial ID", () => {
    const proj = registerProject("partial-proj", "/tmp/partial-proj");
    const agent = registerAgent("partial-project-agent");
    const partialId = proj.id.slice(0, 8);
    const updated = updateAgent(agent.id, { active_project_id: partialId });
    expect(updated!.active_project_id).toBe(proj.id);
  });

  test("throws when active_project_id is invalid", () => {
    const agent = registerAgent("bad-project-agent");
    expect(() => {
      updateAgent(agent.id, { active_project_id: "nonexistent-proj" });
    }).toThrow("Project not found: nonexistent-proj");
  });

  test("clears active_project_id with null", () => {
    const proj = registerProject("clear-proj", "/tmp/clear-proj");
    const agent = registerAgent("clearable-agent");
    updateAgent(agent.id, { active_project_id: proj.id });
    const cleared = updateAgent(agent.id, { active_project_id: null });
    expect(cleared!.active_project_id).toBeNull();
  });
});

describe("touchAgent", () => {
  test("updates last_seen_at for existing agent", () => {
    const agent = registerAgent("touch-me");
    const before = agent.last_seen_at;
    // Small sleep to ensure timestamp difference
    Bun.sleepSync(5);
    touchAgent(agent.id);
    const refreshed = getAgent(agent.id)!;
    expect(refreshed.last_seen_at).not.toBe(before);
  });

  test("no-op for unknown agent", () => {
    // Should not throw
    expect(() => touchAgent("nonexistent-xyz")).not.toThrow();
  });
});

describe("listAgentsByProject", () => {
  test("returns agents bound to a project", () => {
    const proj = registerProject("list-proj", "/tmp/list-proj");
    const a = registerAgent("agent-on-proj");
    updateAgent(a.id, { active_project_id: proj.id });
    const result = listAgentsByProject(proj.id, getDatabase());
    expect(result.some(x => x.id === a.id)).toBe(true);
  });

  test("excludes agents not on the project", () => {
    const proj = registerProject("exclusive-proj", "/tmp/exclusive-proj");
    registerAgent("unbound-agent-exclusive");
    const result = listAgentsByProject(proj.id);
    expect(result.every(x => x.active_project_id === proj.id)).toBe(true);
  });

  test("returns empty for project with no agents", () => {
    const proj = registerProject("empty-proj", "/tmp/empty-proj");
    const result = listAgentsByProject(proj.id);
    expect(result).toEqual([]);
  });

  test("finds agents by partial project ID", () => {
    const proj = registerProject("partial-list-proj", "/tmp/partial-list-proj");
    const a = registerAgent("agent-partial-list");
    updateAgent(a.id, { active_project_id: proj.id });
    const partialId = proj.id.slice(0, 8);
    const result = listAgentsByProject(partialId);
    expect(result.some(x => x.id === a.id)).toBe(true);
  });
});
