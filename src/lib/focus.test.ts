process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase } from "../db/database.js";
import { registerAgent } from "../db/agents.js";
import { registerProject } from "../db/projects.js";
import {
  setFocus,
  getFocus,
  unfocus,
  resolveProjectId,
  buildFocusFilter,
  focusFilterSQL,
} from "./focus.js";
import { updateAgent, getAgent } from "../db/agents.js";

beforeEach(() => {
  resetDatabase();
});

describe("setFocus / getFocus", () => {
  test("set and get focus for an agent", () => {
    const agent = registerAgent("maximus");
    const project = registerProject("open-mementos", "/tmp/test");
    setFocus(agent.id, project.id);
    expect(getFocus(agent.id)).toBe(project.id);
  });

  test("set focus to null clears it", () => {
    const agent = registerAgent("maximus");
    const project = registerProject("proj", "/tmp/proj");
    setFocus(agent.id, project.id);
    setFocus(agent.id, null);
    expect(getFocus(agent.id)).toBeNull();
  });

  test("getFocus returns null for agent with no focus", () => {
    const agent = registerAgent("cassius");
    expect(getFocus(agent.id)).toBeNull();
  });

  test("getFocus reads from DB when set via updateAgent", () => {
    const agent = registerAgent("brutus");
    const project = registerProject("proj2", "/tmp/proj2");
    // Set via updateAgent directly to simulate DB-only focus
    updateAgent(agent.id, { active_project_id: project.id });
    // getFocus will fall back to DB since session cache is empty for this agent
    expect(getFocus(agent.id)).toBe(project.id);
  });

  test("persists focus to agent DB record", () => {
    const agent = registerAgent("titus");
    const project = registerProject("proj3", "/tmp/proj3");
    setFocus(agent.id, project.id);
    const dbAgent = getAgent(agent.id);
    expect(dbAgent?.active_project_id).toBe(project.id);
  });
});

describe("unfocus", () => {
  test("unfocus clears both session and DB", () => {
    const agent = registerAgent("nero");
    const project = registerProject("proj4", "/tmp/proj4");
    setFocus(agent.id, project.id);
    unfocus(agent.id);
    expect(getFocus(agent.id)).toBeNull();
  });
});

describe("resolveProjectId", () => {
  test("explicit project_id takes priority", () => {
    const agent = registerAgent("julius");
    const project = registerProject("proj5", "/tmp/proj5");
    const other = registerProject("other", "/tmp/other");
    setFocus(agent.id, project.id);
    expect(resolveProjectId(agent.id, other.id)).toBe(other.id);
  });

  test("returns focus when no explicit project_id", () => {
    const agent = registerAgent("cicero");
    const project = registerProject("proj6", "/tmp/proj6");
    setFocus(agent.id, project.id);
    expect(resolveProjectId(agent.id, null)).toBe(project.id);
  });

  test("returns null when no focus and no explicit project_id", () => {
    const agent = registerAgent("seneca");
    expect(resolveProjectId(agent.id, null)).toBeNull();
  });

  test("returns null when no agent_id", () => {
    expect(resolveProjectId(null, null)).toBeNull();
  });
});

describe("buildFocusFilter", () => {
  test("returns filter when agent is focused and no explicit overrides", () => {
    const agent = registerAgent("cato");
    const project = registerProject("proj7", "/tmp/proj7");
    setFocus(agent.id, project.id);
    const filter = buildFocusFilter(agent.id, null, null);
    expect(filter).not.toBeNull();
    expect(filter!.focusMode).toBe(true);
    expect(filter!.agentId).toBe(agent.id);
    expect(filter!.projectId).toBe(project.id);
  });

  test("returns null when explicit scope is provided", () => {
    const agent = registerAgent("pompey");
    const project = registerProject("proj8", "/tmp/proj8");
    setFocus(agent.id, project.id);
    expect(buildFocusFilter(agent.id, null, "private")).toBeNull();
  });

  test("returns null when explicit project_id is provided", () => {
    const agent = registerAgent("crassus");
    const project = registerProject("proj9", "/tmp/proj9");
    setFocus(agent.id, project.id);
    expect(buildFocusFilter(agent.id, "some-project", null)).toBeNull();
  });

  test("returns null when agent has no focus", () => {
    const agent = registerAgent("lepidus");
    expect(buildFocusFilter(agent.id, null, null)).toBeNull();
  });
});

describe("focusFilterSQL", () => {
  test("generates correct SQL fragment", () => {
    const { sql, params } = focusFilterSQL("agent-123", "proj-456");
    expect(sql).toContain("scope = 'global'");
    expect(sql).toContain("scope = 'private' AND agent_id = ?");
    expect(sql).toContain("scope = 'shared' AND project_id = ?");
    expect(params).toEqual(["agent-123", "proj-456"]);
  });
});
