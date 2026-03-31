// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { autoResolveAgentProject } from "./session-auto-resolve.js";

// ============================================================================
// Session auto-resolve — covers lines 60-61, 77, 79-86
// ============================================================================

beforeEach(() => {
  resetDatabase();
  const db = getDatabase(":memory:");

  // Seed projects FIRST (agents have FK to projects via active_project_id)
  db.run(`
    INSERT INTO projects (id, name, path, created_at, updated_at)
    VALUES ('proj-active-001', 'active-project', '/workspace/active', datetime('now'), datetime('now'))
  `);
  db.run(`
    INSERT INTO projects (id, name, path, created_at, updated_at)
    VALUES ('proj-sub-001', 'sub-project', '/workspace/repos/sub-project', datetime('now'), datetime('now'))
  `);

  // Seed agent with active_project_id
  db.run(`
    INSERT INTO agents (id, name, role, metadata, active_project_id, created_at, last_seen_at)
    VALUES ('agent-with-proj', 'proj-agent', 'developer', '{}', 'proj-active-001', datetime('now'), datetime('now'))
  `);

  // Seed agent without active_project_id
  db.run(`
    INSERT INTO agents (id, name, role, metadata, created_at, last_seen_at)
    VALUES ('agent-no-proj', 'no-proj-agent', 'developer', '{}', datetime('now'), datetime('now'))
  `);
});

describe("autoResolveAgentProject", () => {
  it("uses agent active_project_id when agent is found with active project (line 59-62)", () => {
    const result = autoResolveAgentProject({ agentName: "proj-agent" });
    expect(result.agentId).toBe("agent-with-proj");
    expect(result.projectId).toBe("proj-active-001");
    expect(result.confidence).toBe("high");
    expect(result.method).toContain("agent-by-name");
    expect(result.method).toContain("project-from-agent-active");
  });

  it("resolves agent without auto-assigning project when agent has no active_project_id", () => {
    const result = autoResolveAgentProject({ agentName: "no-proj-agent" });
    expect(result.agentId).toBe("agent-no-proj");
    expect(result.projectId).toBeNull();
    expect(result.confidence).toBe("high");
  });

  it("resolves project by subdirectory prefix match (lines 79-86)", () => {
    // workingDir is a subdirectory of proj-sub-001's path
    const result = autoResolveAgentProject({
      workingDir: "/workspace/repos/sub-project/src/components",
    });
    expect(result.projectId).toBe("proj-sub-001");
    expect(result.confidence).toBe("high");
    expect(result.method).toContain("project-by-path-prefix");
  });

  it("uses workingDir exact match when available (line 77)", () => {
    const result = autoResolveAgentProject({ workingDir: "/workspace/active" });
    expect(result.projectId).toBe("proj-active-001");
    expect(result.method).toContain("project-by-path");
    expect(result.confidence).toBe("high");
  });

  it("skips workingDir resolution when projectId already set from agent", () => {
    // Agent has active project, workingDir also matches another project
    const result = autoResolveAgentProject({
      agentName: "proj-agent",
      workingDir: "/workspace/repos/sub-project",
    });
    // Project should come from agent's active_project_id
    expect(result.projectId).toBe("proj-active-001");
    // workingDir resolution is skipped (projectId already set)
    expect(result.method).toContain("project-from-agent");
  });

  it("resolves by git remote using https URL format", () => {
    const result = autoResolveAgentProject({
      gitRemote: "https://github.com/user/active-project",
    });
    expect(result.projectId).toBe("proj-active-001");
    expect(result.confidence).toBe("low");
    expect(result.method).toContain("project-by-git-remote");
  });

  it("resolves by git remote with .git suffix", () => {
    const result = autoResolveAgentProject({
      gitRemote: "git@github.com:user/active-project.git",
    });
    expect(result.projectId).toBe("proj-active-001");
    expect(result.confidence).toBe("low");
  });

  it("returns method=none when no resolution succeeds", () => {
    const result = autoResolveAgentProject({
      agentName: "unknown-agent",
      workingDir: "/nonexistent/path",
      gitRemote: "https://github.com/user/unknown-repo",
    });
    expect(result.confidence).toBe("none");
    expect(result.method).toBe("none");
  });

  it("returns method string listing all successful resolutions", () => {
    const result = autoResolveAgentProject({
      agentName: "proj-agent",
    });
    // Method lists agent-by-name and project-from-agent-active
    expect(result.method).toContain(",");
  });
});
