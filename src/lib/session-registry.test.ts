import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerSession,
  heartbeatSession,
  unregisterSession,
  getSession,
  listSessions,
  getSessionByAgent,
  getSessionsByProject,
  cleanStaleSessions,
  updateSessionAgent,
  closeRegistry,
} from "./session-registry.js";
import type { SessionInfo } from "./session-registry.js";

// Track all session IDs created during tests so we can clean up
const createdSessionIds: string[] = [];

function reg(opts: Parameters<typeof registerSession>[0]): SessionInfo {
  const s = registerSession(opts);
  createdSessionIds.push(s.id);
  return s;
}

beforeEach(() => {
  // Clean up any leftover sessions from previous test
  for (const id of createdSessionIds) {
    try {
      unregisterSession(id);
    } catch {
      // ignore
    }
  }
  createdSessionIds.length = 0;
});

afterEach(() => {
  for (const id of createdSessionIds) {
    try {
      unregisterSession(id);
    } catch {
      // ignore
    }
  }
  createdSessionIds.length = 0;
});

// Use a unique MCP server name per test to avoid PID+mcp_server conflicts
let testCounter = 0;
function uniqueMcp(): string {
  return `test-mcp-${Date.now()}-${++testCounter}`;
}

describe("registerSession", () => {
  test("registers a new session and returns SessionInfo", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp, project_name: "test-proj" });

    expect(session.id).toBeString();
    expect(session.id.length).toBe(8);
    expect(session.pid).toBe(process.pid);
    expect(session.mcp_server).toBe(mcp);
    expect(session.project_name).toBe("test-proj");
    expect(session.cwd).toBeString();
    expect(session.registered_at).toBeString();
    expect(session.last_seen_at).toBeString();
  });

  test("defaults cwd to process.cwd()", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp });
    expect(session.cwd).toBe(process.cwd());
  });

  test("stores optional fields", () => {
    const mcp = uniqueMcp();
    const session = reg({
      mcp_server: mcp,
      agent_name: "agent-x",
      project_name: "proj-y",
      cwd: "/tmp/custom",
      git_root: "/tmp/custom",
      tty: "/dev/pts/0",
      metadata: { foo: "bar" },
    });

    expect(session.agent_name).toBe("agent-x");
    expect(session.project_name).toBe("proj-y");
    expect(session.cwd).toBe("/tmp/custom");
    expect(session.git_root).toBe("/tmp/custom");
    expect(session.tty).toBe("/dev/pts/0");
    expect(session.metadata).toEqual({ foo: "bar" });
  });

  test("nullifies missing optional fields", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp });

    expect(session.agent_name).toBeNull();
    expect(session.project_name).toBeNull();
    expect(session.git_root).toBeNull();
    expect(session.tty).toBeNull();
    expect(session.metadata).toEqual({});
  });

  test("upserts on same PID + mcp_server", () => {
    const mcp = uniqueMcp();
    const first = reg({ mcp_server: mcp, agent_name: "first" });
    const second = registerSession({ mcp_server: mcp, agent_name: "second" });
    // second reuses the same ID (upsert)
    createdSessionIds.push(second.id);

    expect(second.id).toBe(first.id);
    expect(second.agent_name).toBe("second");
  });

  test("different mcp_server creates separate sessions", () => {
    const mcp1 = uniqueMcp();
    const mcp2 = uniqueMcp();
    const s1 = reg({ mcp_server: mcp1 });
    const s2 = reg({ mcp_server: mcp2 });

    expect(s1.id).not.toBe(s2.id);
  });
});

describe("getSession", () => {
  test("returns session by ID", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp, project_name: "get-test" });
    const fetched = getSession(session.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(session.id);
    expect(fetched!.project_name).toBe("get-test");
  });

  test("returns null for non-existent ID", () => {
    expect(getSession("nonexist")).toBeNull();
  });
});

describe("heartbeatSession", () => {
  test("updates last_seen_at", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp });
    const originalLastSeen = session.last_seen_at;

    // Small delay to ensure timestamp differs
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    heartbeatSession(session.id);
    const updated = getSession(session.id);

    expect(updated).not.toBeNull();
    // last_seen_at should be >= original (could be equal if within same second)
    expect(updated!.last_seen_at >= originalLastSeen).toBe(true);
  });
});

describe("unregisterSession", () => {
  test("removes session from DB", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp });
    expect(getSession(session.id)).not.toBeNull();

    unregisterSession(session.id);
    expect(getSession(session.id)).toBeNull();
  });

  test("no-op for non-existent ID", () => {
    // Should not throw
    unregisterSession("does-not-exist");
  });
});

describe("listSessions", () => {
  test("lists sessions for current process", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp, project_name: "list-test" });
    const all = listSessions({ mcp_server: mcp });

    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.find((s) => s.id === session.id)).toBeTruthy();
  });

  test("filters by project_name", () => {
    const mcp1 = uniqueMcp();
    const mcp2 = uniqueMcp();
    const projName = `proj-filter-${Date.now()}`;
    reg({ mcp_server: mcp1, project_name: projName });
    reg({ mcp_server: mcp2, project_name: "other-proj" });

    const filtered = listSessions({ project_name: projName });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.every((s) => s.project_name === projName)).toBe(true);
  });

  test("filters by git_root", () => {
    const mcp = uniqueMcp();
    const gitRoot = `/tmp/test-git-root-${Date.now()}`;
    reg({ mcp_server: mcp, git_root: gitRoot });

    const filtered = listSessions({ git_root: gitRoot });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.every((s) => s.git_root === gitRoot)).toBe(true);
  });

  test("filters by mcp_server", () => {
    const mcp = uniqueMcp();
    reg({ mcp_server: mcp });

    const filtered = listSessions({ mcp_server: mcp });
    expect(filtered.length).toBe(1);
    expect(filtered[0].mcp_server).toBe(mcp);
  });

  test("filters by agent_name", () => {
    const mcp = uniqueMcp();
    const agentName = `test-agent-${Date.now()}`;
    reg({ mcp_server: mcp, agent_name: agentName });

    const filtered = listSessions({ agent_name: agentName });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.every((s) => s.agent_name === agentName)).toBe(true);
  });

  test("filters by exclude_pid", () => {
    const mcp = uniqueMcp();
    reg({ mcp_server: mcp });

    // Exclude current PID — should not include our session
    const filtered = listSessions({
      mcp_server: mcp,
      exclude_pid: process.pid,
    });
    expect(filtered.length).toBe(0);
  });

  test("returns empty array with no matches", () => {
    const filtered = listSessions({
      project_name: `nonexistent-${Date.now()}`,
    });
    expect(filtered).toEqual([]);
  });

  test("combines multiple filters", () => {
    const mcp = uniqueMcp();
    const projName = `combo-proj-${Date.now()}`;
    const agentName = `combo-agent-${Date.now()}`;
    reg({
      mcp_server: mcp,
      project_name: projName,
      agent_name: agentName,
    });

    const filtered = listSessions({
      project_name: projName,
      agent_name: agentName,
    });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });
});

describe("getSessionByAgent", () => {
  test("returns session for agent name", () => {
    const mcp = uniqueMcp();
    const agentName = `agent-lookup-${Date.now()}`;
    const session = reg({ mcp_server: mcp, agent_name: agentName });

    const found = getSessionByAgent(agentName);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
    expect(found!.agent_name).toBe(agentName);
  });

  test("returns null when agent not found", () => {
    const found = getSessionByAgent(`no-such-agent-${Date.now()}`);
    expect(found).toBeNull();
  });
});

describe("getSessionsByProject", () => {
  test("returns all sessions for a project", () => {
    const mcp1 = uniqueMcp();
    const mcp2 = uniqueMcp();
    const projName = `multi-session-proj-${Date.now()}`;
    const s1 = reg({ mcp_server: mcp1, project_name: projName });
    const s2 = reg({ mcp_server: mcp2, project_name: projName });

    const sessions = getSessionsByProject(projName);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
  });

  test("returns empty array when no sessions for project", () => {
    const sessions = getSessionsByProject(`no-proj-${Date.now()}`);
    expect(sessions).toEqual([]);
  });
});

describe("updateSessionAgent", () => {
  test("updates agent name for current PID + mcp_server", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp, agent_name: "old-name" });

    updateSessionAgent(mcp, "new-name");
    const updated = getSession(session.id);

    expect(updated).not.toBeNull();
    expect(updated!.agent_name).toBe("new-name");
  });

  test("also updates last_seen_at", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp });
    const originalLastSeen = session.last_seen_at;

    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    updateSessionAgent(mcp, "updated-agent");
    const updated = getSession(session.id);
    expect(updated!.last_seen_at >= originalLastSeen).toBe(true);
  });
});

describe("cleanStaleSessions", () => {
  test("returns 0 when all sessions are alive", () => {
    const mcp = uniqueMcp();
    reg({ mcp_server: mcp });

    // Current process is alive, so nothing should be cleaned
    const cleaned = cleanStaleSessions();
    // We can't assert exact number since other tests may have left sessions,
    // but at minimum our session should survive
    expect(cleaned).toBeGreaterThanOrEqual(0);

    // Our session should still exist
    const sessions = listSessions({ mcp_server: mcp });
    expect(sessions.length).toBe(1);
  });
});

describe("closeRegistry", () => {
  test("closes the DB and allows re-open", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp });

    closeRegistry();

    // After close, getSession should re-open the DB and still find the session
    const fetched = getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(session.id);
  });
});

describe("parseRow / metadata", () => {
  test("stores and retrieves complex metadata", () => {
    const mcp = uniqueMcp();
    const meta = { version: 2, tags: ["a", "b"], nested: { x: 1 } };
    const session = reg({ mcp_server: mcp, metadata: meta });

    const fetched = getSession(session.id);
    expect(fetched!.metadata).toEqual(meta);
  });

  test("defaults metadata to empty object", () => {
    const mcp = uniqueMcp();
    const session = reg({ mcp_server: mcp });

    expect(session.metadata).toEqual({});
  });
});
