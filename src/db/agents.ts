import { SqliteAdapter as Database } from "../storage.js";
import type { Agent } from "../types/index.js";
import { AgentConflictError } from "../types/index.js";
import { getDatabase, now, shortUuid, resolvePartialId } from "./database.js";
import { isApiMode, apiJson, toQuery } from "./api-mode.js";

const CONFLICT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function parseAgentRow(row: Record<string, unknown>): Agent {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    session_id: (row["session_id"] as string) || null,
    description: (row["description"] as string) || null,
    role: (row["role"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    active_project_id: (row["active_project_id"] as string) || null,
    created_at: row["created_at"] as string,
    last_seen_at: row["last_seen_at"] as string,
  };
}

export function registerAgent(
  name: string,
  sessionId?: string,
  description?: string,
  role?: string,
  projectId?: string,
  db?: Database
): Agent {
  if (!db && isApiMode()) {
    const { data } = apiJson<Agent>("POST", "/agents", {
      name,
      session_id: sessionId,
      description,
      role,
      project_id: projectId,
    });
    return data;
  }
  const d = db || getDatabase();
  const timestamp = now();
  const normalizedName = name.trim().toLowerCase();

  // Resolve partial project ID to full UUID for FK constraint
  if (projectId) {
    const resolvedProjectId = resolvePartialId(d, "projects", projectId);
    if (!resolvedProjectId) {
      throw new Error(`Project not found: ${projectId}`);
    }
    projectId = resolvedProjectId;
  }

  const existing = d
    .query("SELECT * FROM agents WHERE LOWER(name) = ?")
    .get(normalizedName) as Record<string, unknown> | null;

  if (existing) {
    const existingId = existing["id"] as string;
    const existingSessionId = (existing["session_id"] as string) || null;
    const existingLastSeen = existing["last_seen_at"] as string;

    // Conflict detection: if a different session is active within the 30-min window, reject
    if (sessionId && existingSessionId && existingSessionId !== sessionId) {
      const lastSeenMs = new Date(existingLastSeen).getTime();
      const nowMs = Date.now();
      if (nowMs - lastSeenMs < CONFLICT_WINDOW_MS) {
        throw new AgentConflictError({
          existing_id: existingId,
          existing_name: normalizedName,
          last_seen_at: existingLastSeen,
          session_hint: existingSessionId.slice(0, 8),
          working_dir: null,
        });
      }
    }

    // Same session or expired — update and take over
    d.run("UPDATE agents SET last_seen_at = ?, session_id = ? WHERE id = ?", [
      timestamp,
      sessionId ?? existingSessionId,
      existingId,
    ]);
    if (description) {
      d.run("UPDATE agents SET description = ? WHERE id = ?", [description, existingId]);
    }
    if (role) {
      d.run("UPDATE agents SET role = ? WHERE id = ?", [role, existingId]);
    }
    // Lock agent to project if provided
    if (projectId !== undefined) {
      d.run("UPDATE agents SET active_project_id = ? WHERE id = ?", [projectId, existingId]);
    }
    return getAgent(existingId, d)!;
  }

  const id = shortUuid();
  d.run(
    "INSERT INTO agents (id, name, session_id, description, role, active_project_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, normalizedName, sessionId ?? null, description || null, role || "agent", projectId ?? null, timestamp, timestamp]
  );

  return getAgent(id, d)!;
}

export function getAgent(
  idOrName: string,
  db?: Database
): Agent | null {
  if (!db && isApiMode()) {
    const { status, data } = apiJson<Agent>("GET", `/agents/${encodeURIComponent(idOrName)}`, undefined, { allow404: true });
    if (status === 404 || !data) return null;
    return data;
  }
  const d = db || getDatabase();

  // Try by ID first
  let row = d.query("SELECT * FROM agents WHERE id = ?").get(idOrName) as
    | Record<string, unknown>
    | null;
  if (row) return parseAgentRow(row);

  // Try by name (case-insensitive)
  row = d.query("SELECT * FROM agents WHERE LOWER(name) = ?").get(idOrName.trim().toLowerCase()) as
    | Record<string, unknown>
    | null;
  if (row) return parseAgentRow(row);

  // Try partial ID
  const rows = d
    .query("SELECT * FROM agents WHERE id LIKE ?")
    .all(`${idOrName}%`) as Record<string, unknown>[];
  if (rows.length === 1) return parseAgentRow(rows[0]!);

  return null;
}

export function listAgents(db?: Database): Agent[] {
  if (!db && isApiMode()) {
    const { data } = apiJson<{ agents: Agent[] }>("GET", "/agents");
    return data?.agents ?? [];
  }
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM agents ORDER BY last_seen_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(parseAgentRow);
}

export function touchAgent(idOrName: string, db?: Database): void {
  if (!db && isApiMode()) {
    // No dedicated "touch" endpoint; PATCH with an empty body bumps last_seen_at
    // server-side (updateAgent always refreshes last_seen_at). Best-effort.
    const agent = getAgent(idOrName);
    if (!agent) return;
    apiJson("PATCH", `/agents/${encodeURIComponent(agent.id)}`, {});
    return;
  }
  const d = db || getDatabase();
  const agent = getAgent(idOrName, d);
  if (!agent) return;
  d.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", [now(), agent.id]);
}

export function listAgentsByProject(projectId: string, db?: Database): Agent[] {
  if (!db && isApiMode()) {
    const q = toQuery({ project_id: projectId });
    const { data } = apiJson<{ agents: Agent[] }>("GET", `/agents${q}`);
    return data?.agents ?? [];
  }
  const d = db || getDatabase();
  // Resolve partial project ID to full UUID
  const resolvedId = resolvePartialId(d, "projects", projectId) || projectId;
  const rows = d
    .query("SELECT * FROM agents WHERE active_project_id = ? ORDER BY last_seen_at DESC")
    .all(resolvedId) as Record<string, unknown>[];
  return rows.map(parseAgentRow);
}

export function updateAgent(
  id: string,
  updates: { name?: string; description?: string; role?: string; metadata?: Record<string, unknown>; active_project_id?: string | null },
  db?: Database
): Agent | null {
  if (!db && isApiMode()) {
    const { status, data } = apiJson<Agent>("PATCH", `/agents/${encodeURIComponent(id)}`, updates, { allow404: true });
    if (status === 404 || !data) return null;
    return data;
  }
  const d = db || getDatabase();
  const agent = getAgent(id, d);
  if (!agent) return null;

  const timestamp = now();

  // If name is being changed, normalize and check uniqueness (case-insensitive)
  if (updates.name) {
    const normalizedNewName = updates.name.trim().toLowerCase();
    if (normalizedNewName !== agent.name) {
      const existing = d
        .query("SELECT id FROM agents WHERE LOWER(name) = ? AND id != ?")
        .get(normalizedNewName, agent.id) as Record<string, unknown> | null;
      if (existing) {
        throw new Error(`Agent name already taken: ${normalizedNewName}`);
      }
      d.run("UPDATE agents SET name = ? WHERE id = ?", [normalizedNewName, agent.id]);
    }
  }

  if (updates.description !== undefined) {
    d.run("UPDATE agents SET description = ? WHERE id = ?", [updates.description, agent.id]);
  }

  if (updates.role !== undefined) {
    d.run("UPDATE agents SET role = ? WHERE id = ?", [updates.role, agent.id]);
  }

  if (updates.metadata !== undefined) {
    d.run("UPDATE agents SET metadata = ? WHERE id = ?", [JSON.stringify(updates.metadata), agent.id]);
  }

  if ("active_project_id" in updates) {
    let resolvedProjectId = updates.active_project_id ?? null;
    if (resolvedProjectId) {
      const fullId = resolvePartialId(d, "projects", resolvedProjectId);
      if (!fullId) {
        throw new Error(`Project not found: ${resolvedProjectId}`);
      }
      resolvedProjectId = fullId;
    }
    d.run("UPDATE agents SET active_project_id = ? WHERE id = ?", [resolvedProjectId, agent.id]);
  }

  // Always update last_seen_at
  d.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", [timestamp, agent.id]);

  return getAgent(agent.id, d)!;
}
