import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";
import { registerProject, getProject } from "../db/projects.js";
import type { Project } from "../types/index.js";

/**
 * Find the git root directory by walking up from startDir.
 */
function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let _cachedProject: Project | null | undefined = undefined;

/**
 * Auto-detect the current project from cwd's git root.
 * - Finds the git root directory
 * - Extracts the repo name from the directory basename
 * - Checks if a project is already registered by path
 * - If not, registers it automatically
 * - Returns the Project object, or null if not in a git repo
 *
 * Results are cached for the lifetime of the process.
 */
export function detectProject(db?: Database): Project | null {
  if (_cachedProject !== undefined) return _cachedProject;

  const d = db || getDatabase();
  const cwd = process.cwd();
  const gitRoot = findGitRoot(cwd);

  if (!gitRoot) {
    _cachedProject = null;
    return null;
  }

  const repoName = basename(gitRoot);
  const absPath = resolve(gitRoot);

  // Check if already registered by path
  const existing = getProject(absPath, d);
  if (existing) {
    _cachedProject = existing;
    return existing;
  }

  // Auto-register
  const project = registerProject(repoName, absPath, undefined, undefined, d);
  _cachedProject = project;
  return project;
}

/**
 * Reset the cached project (useful for tests).
 */
export function resetProjectCache(): void {
  _cachedProject = undefined;
}
