process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase } from "./database.js";
import { registerProject, getProject, listProjects } from "./projects.js";

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
