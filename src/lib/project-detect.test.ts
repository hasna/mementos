process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resetProjectCache, detectProject } from "./project-detect.js";
import { getDatabase, resetDatabase } from "../db/database.js";
import { registerProject } from "../db/projects.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("detectProject", () => {
  let repoDir: string;
  let originalCwd: string;

  beforeEach(() => {
    resetDatabase();
    resetProjectCache();
    originalCwd = process.cwd();

    repoDir = join(tmpdir(), `mementos-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetProjectCache();
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("auto-registers project from git root", () => {
    const db = getDatabase();
    const project = detectProject(db);

    expect(project).not.toBeNull();
    expect(project!.name).toBe(repoDir.split("/").pop());
    expect(project!.path).toBe(repoDir);
  });

  it("returns cached project on subsequent calls", () => {
    const db = getDatabase();
    const first = detectProject(db);
    const second = detectProject(db);
    expect(second).toBe(first);
  });

  it("returns existing project when already registered by path", () => {
    const db = getDatabase();
    const existing = registerProject("existing-repo", repoDir, "desc", undefined, db);
    resetProjectCache();

    const detected = detectProject(db);
    expect(detected!.id).toBe(existing.id);
    expect(detected!.name).toBe("existing-repo");
  });
});
