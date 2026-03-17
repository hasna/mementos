/**
 * Focus mode — agents can "focus" on a project, which auto-scopes
 * memory operations to that project's shared memories + their own private
 * memories + all global memories.
 *
 * Priority for project_id resolution:
 * 1. Per-call param (explicit override)
 * 2. Session focus (in-memory Map, fastest)
 * 3. DB active_project_id on agent record
 * 4. No filter
 */

import { getAgent, updateAgent } from "../db/agents.js";
import { hookRegistry } from "./hooks.js";

// In-memory session focus: agent_id → project_id | null
const sessionFocus = new Map<string, string | null>();

/**
 * Set focus for an agent. Persists to DB + sets in-memory session focus.
 * Pass project_id=null to unfocus.
 */
export function setFocus(agentId: string, projectId: string | null): void {
  const previous = getFocusCached(agentId);
  sessionFocus.set(agentId, projectId);
  // Persist to DB for durability across sessions
  updateAgent(agentId, { active_project_id: projectId });

  if (projectId && projectId !== previous) {
    // Focusing on a new project = session start
    void hookRegistry.runHooks("OnSessionStart", {
      agentId,
      projectId,
      timestamp: Date.now(),
    });
  } else if (!projectId && previous) {
    // Clearing focus = session end
    void hookRegistry.runHooks("OnSessionEnd", {
      agentId,
      projectId: previous,
      timestamp: Date.now(),
    });
  }
}

/** Internal: get cached focus without DB fallback */
function getFocusCached(agentId: string): string | null {
  return sessionFocus.get(agentId) ?? null;
}

/**
 * Get the current focus project_id for an agent.
 * Checks session cache first, then DB.
 */
export function getFocus(agentId: string): string | null {
  // Session cache hit
  if (sessionFocus.has(agentId)) {
    return sessionFocus.get(agentId) ?? null;
  }
  // DB fallback
  const agent = getAgent(agentId);
  const projectId = agent?.active_project_id ?? null;
  // Warm the session cache
  sessionFocus.set(agentId, projectId);
  return projectId;
}

/**
 * Remove focus for an agent (sets to null).
 */
export function unfocus(agentId: string): void {
  setFocus(agentId, null);
}

/**
 * Resolve the effective project_id for a memory operation.
 * Priority: explicit per-call param > session/DB focus > null
 */
export function resolveProjectId(
  agentId: string | undefined | null,
  explicitProjectId: string | undefined | null
): string | null {
  // Per-call explicit override
  if (explicitProjectId !== undefined && explicitProjectId !== null) {
    return explicitProjectId;
  }
  // Agent focus
  if (agentId) {
    return getFocus(agentId);
  }
  return null;
}

/**
 * Build the scope filter for memory queries when an agent is focused.
 *
 * When focused on project P:
 *   - private memories of this agent (scope=private, agent_id=agentId)
 *   - shared memories of project P (scope=shared, project_id=P)
 *   - global memories (scope=global)
 *
 * When not focused: no automatic scope restriction (existing behavior).
 */
export interface FocusScopeFilter {
  /** If set, apply this multi-scope filter instead of a single scope */
  focusMode: true;
  agentId: string;
  projectId: string;
}

export function buildFocusFilter(
  agentId: string | undefined | null,
  explicitProjectId: string | undefined | null,
  explicitScope: string | undefined | null
): FocusScopeFilter | null {
  // If caller already specified an explicit scope/project, don't override
  if (explicitScope || explicitProjectId) return null;
  if (!agentId) return null;

  const focusedProjectId = getFocus(agentId);
  if (!focusedProjectId) return null;

  return {
    focusMode: true,
    agentId,
    projectId: focusedProjectId,
  };
}

/**
 * Apply focus filter to a SQL WHERE clause builder.
 * Returns SQL fragment + params for the focused scope filter.
 *
 * Generates: (scope = 'global') OR (scope = 'private' AND agent_id = ?) OR (scope = 'shared' AND project_id = ?)
 */
export function focusFilterSQL(
  agentId: string,
  projectId: string
): { sql: string; params: string[] } {
  return {
    sql: "(scope = 'global' OR (scope = 'private' AND agent_id = ?) OR (scope = 'shared' AND project_id = ?))",
    params: [agentId, projectId],
  };
}
