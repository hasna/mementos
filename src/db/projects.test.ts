process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase } from "./database.js";
import {
  registerProject,
  getProject,
  listProjects,
  updateProject,
} from "./projects.js";
import {
  createMemory,
  getMemoryVersions,
  listMemories,
  updateMemory,
} from "./memories.js";

beforeEach(() => {
  resetDatabase();
});

describe("registerProject", () => {
  test("creates new project with UUID", () => {
    const project = registerProject("my-project", "/home/user/my-project");
    expect(project.id).toBeTruthy();
    expect(project.id.length).toBeGreaterThanOrEqual(36);
    expect(project.name).toBe("my-project");
    expect(project.path).toBe("/home/user/my-project");
    expect(project.description).toBeNull();
    expect(project.memory_prefix).toBeNull();
    expect(project.created_at).toBeTruthy();
    expect(project.updated_at).toBeTruthy();
  });

  test("idempotent — same path returns existing project", () => {
    const first = registerProject("proj-a", "/path/a");
    const second = registerProject("proj-a", "/path/a");
    expect(second.id).toBe(first.id);
    expect(second.path).toBe("/path/a");
  });

  test("updates updated_at on re-register", () => {
    const first = registerProject("proj-b", "/path/b");
    const firstUpdated = first.updated_at;
    const second = registerProject("proj-b", "/path/b");
    // updated_at should be >= first
    expect(new Date(second.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(firstUpdated).getTime()
    );
  });

  test("creates project with description and memory_prefix", () => {
    const project = registerProject(
      "proj-c",
      "/path/c",
      "A test project",
      "proj_c"
    );
    expect(project.description).toBe("A test project");
    expect(project.memory_prefix).toBe("proj_c");
  });
});

describe("getProject", () => {
  test("retrieves project by ID", () => {
    const created = registerProject("proj-d", "/path/d");
    const found = getProject(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.name).toBe("proj-d");
  });

  test("retrieves project by path", () => {
    const created = registerProject("proj-e", "/path/e");
    const found = getProject("/path/e");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.path).toBe("/path/e");
  });

  test("returns null for non-existent project", () => {
    const found = getProject("nonexistent-id");
    expect(found).toBeNull();
  });
});

describe("listProjects", () => {
  test("returns empty list when no projects exist", () => {
    const projects = listProjects();
    expect(projects).toEqual([]);
  });

  test("returns all registered projects", () => {
    registerProject("proj-1", "/path/1");
    registerProject("proj-2", "/path/2");
    registerProject("proj-3", "/path/3");
    const projects = listProjects();
    expect(projects).toHaveLength(3);
    const names = projects.map((p) => p.name);
    expect(names).toContain("proj-1");
    expect(names).toContain("proj-2");
    expect(names).toContain("proj-3");
  });

  test("ordered by updated_at DESC", () => {
    registerProject("oldest", "/path/oldest");
    registerProject("middle", "/path/middle");
    registerProject("newest", "/path/newest");
    // Re-register "oldest" to bump its updated_at
    registerProject("oldest", "/path/oldest");
    const projects = listProjects();
    expect(projects).toHaveLength(3);
    // "oldest" was re-registered last, so it should appear first
    expect(projects[0]!.name).toBe("oldest");
  });
});

describe("updateProject", () => {
  test("renames and repaths one stable project without moving its memories or history", () => {
    const original = registerProject(
      "iproj-dubai-fraud",
      "/Users/andreihasna/.hasna/projects/workspaces/wks-dubai-fraud",
      "Private investigation",
      "iproj_dubai_fraud"
    );
    const memory = createMemory({
      key: "dubai-evidence-index",
      value: "version one",
      project_id: original.id,
      scope: "shared",
    });
    updateMemory(memory.id, { value: "version two", version: memory.version });

    const memoryIdsBefore = listMemories({ project_id: original.id, limit: 100 })
      .map((item) => item.id);
    const historyBefore = getMemoryVersions(memory.id);

    const updated = updateProject(original.id, {
      name: "Dubai Fraud",
      path: "/home/hasna/.hasna/projects/workspaces/wks-dubai-fraud",
      memory_prefix: "dubai_fraud",
    });

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(original.id);
    expect(updated!.name).toBe("Dubai Fraud");
    expect(updated!.path).toBe(
      "/home/hasna/.hasna/projects/workspaces/wks-dubai-fraud"
    );
    expect(updated!.description).toBe("Private investigation");
    expect(updated!.memory_prefix).toBe("dubai_fraud");
    expect(getProject("iproj-dubai-fraud")).toBeNull();
    expect(
      getProject("/Users/andreihasna/.hasna/projects/workspaces/wks-dubai-fraud")
    ).toBeNull();

    const memoriesAfter = listMemories({ project_id: original.id, limit: 100 });
    expect(memoriesAfter.map((item) => item.id)).toEqual(memoryIdsBefore);
    expect(memoriesAfter[0]!.project_id).toBe(original.id);
    expect(getMemoryVersions(memory.id)).toEqual(historyBefore);
  });

  test("rejects case-insensitive name and exact path collisions", () => {
    const source = registerProject("Source Project", "/projects/source");
    const target = registerProject("Taken Project", "/projects/taken");

    expect(() => updateProject(source.id, { name: "taken project" })).toThrow(
      /project name already exists/i
    );
    expect(() => updateProject(source.id, { path: target.path })).toThrow(
      /project path already exists/i
    );

    expect(getProject(source.id)).toMatchObject({
      id: source.id,
      name: "Source Project",
      path: "/projects/source",
    });
    expect(getProject(target.id)).toMatchObject({
      id: target.id,
      name: "Taken Project",
      path: "/projects/taken",
    });
  });

  test("returns null for a missing stable project ID", () => {
    expect(
      updateProject("00000000-0000-0000-0000-000000000000", {
        name: "Does Not Exist",
      })
    ).toBeNull();
    expect(listProjects()).toEqual([]);
  });
});
