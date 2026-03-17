/**
 * Auto-resolve agent_id and project_id from session metadata.
 * When a session is ingested without explicit agent/project context,
 * try to detect them from available metadata fields.
 */

import type { Database } from "bun:sqlite";
import { getAgent } from "../db/agents.js";
import { getProject, listProjects } from "../db/projects.js";

// ============================================================================
// Types
// ============================================================================

export interface AutoResolveResult {
  agentId: string | null;
  projectId: string | null;
  confidence: "high" | "low" | "none";
  method: string;
}

// ============================================================================
// Auto-resolve
// ============================================================================

/**
 * Attempt to resolve agent_id and project_id from metadata fields.
 *
 * Strategy:
 * 1. If metadata.agentName matches an existing agent → agentId = agent.id, confidence=high
 * 2. If metadata.workingDir matches a registered project path → projectId = project.id, confidence=high
 * 3. If metadata.gitRemote contains a repo name that matches a project name → confidence=low
 * 4. Otherwise confidence=none
 */
export function autoResolveAgentProject(
  metadata: {
    workingDir?: string;
    agentName?: string;
    gitRemote?: string;
    sessionSource?: string;
  },
  db?: Database
): AutoResolveResult {
  let agentId: string | null = null;
  let projectId: string | null = null;
  let confidence: "high" | "low" | "none" = "none";
  const methods: string[] = [];

  // 1. Resolve agent by name
  if (metadata.agentName) {
    try {
      const agent = getAgent(metadata.agentName, db);
      if (agent) {
        agentId = agent.id;
        confidence = "high";
        methods.push(`agent-by-name:${metadata.agentName}`);

        // If agent has an active project, use that too
        if (agent.active_project_id && !projectId) {
          projectId = agent.active_project_id;
          methods.push("project-from-agent-active");
        }
      }
    } catch {
      // Agent lookup failed — ignore
    }
  }

  // 2. Resolve project by working directory (exact path match)
  if (metadata.workingDir && !projectId) {
    try {
      const project = getProject(metadata.workingDir, db);
      if (project) {
        projectId = project.id;
        if (confidence !== "high") confidence = "high";
        methods.push(`project-by-path:${metadata.workingDir}`);
      } else {
        // Try prefix match — workingDir may be a subdirectory of a registered project
        const allProjects = listProjects(db);
        for (const p of allProjects) {
          if (p.path && metadata.workingDir.startsWith(p.path)) {
            projectId = p.id;
            if (confidence !== "high") confidence = "high";
            methods.push(`project-by-path-prefix:${p.path}`);
            break;
          }
        }
      }
    } catch {
      // Project lookup failed — ignore
    }
  }

  // 3. Resolve project by git remote (repo name heuristic)
  if (metadata.gitRemote && !projectId) {
    try {
      // Extract repo name from git remote URL
      // e.g. "git@github.com:user/my-repo.git" → "my-repo"
      // e.g. "https://github.com/user/my-repo" → "my-repo"
      const repoName = metadata.gitRemote
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .filter(Boolean)
        .pop();

      if (repoName) {
        const project = getProject(repoName, db);
        if (project) {
          projectId = project.id;
          if (confidence === "none") confidence = "low";
          methods.push(`project-by-git-remote:${repoName}`);
        }
      }
    } catch {
      // Git remote lookup failed — ignore
    }
  }

  if (methods.length === 0) {
    confidence = "none";
  }

  return {
    agentId,
    projectId,
    confidence,
    method: methods.join(", ") || "none",
  };
}
