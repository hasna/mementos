import { Database } from "bun:sqlite";
import type { Agent } from "../types/index.js";
import { AgentConflictError } from "../types/index.js";
import { getDatabase, now, shortUuid } from "./database.js";

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
  db?: Database
): Agent {
  const d = db || getDatabase();
  const timestamp = now();
  const normalizedName = name.trim().toLowerCase();

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
    return getAgent(existingId, d)!;
  }

  const id = shortUuid();
  d.run(
    "INSERT INTO agents (id, name, session_id, description, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, normalizedName, sessionId ?? null, description || null, role || "agent", timestamp, timestamp]
  );

  return getAgent(id, d)!;
}

export function getAgent(
  idOrName: string,
  db?: Database
): Agent | null {
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
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM agents ORDER BY last_seen_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(parseAgentRow);
}

export function touchAgent(idOrName: string, db?: Database): void {
  const d = db || getDatabase();
  const agent = getAgent(idOrName, d);
  if (!agent) return;
  d.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", [now(), agent.id]);
}

export function listAgentsByProject(projectId: string, db?: Database): Agent[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM agents WHERE active_project_id = ? ORDER BY last_seen_at DESC")
    .all(projectId) as Record<string, unknown>[];
  return rows.map(parseAgentRow);
}

export function updateAgent(
  id: string,
  updates: { name?: string; description?: string; role?: string; metadata?: Record<string, unknown>; active_project_id?: string | null },
  db?: Database
): Agent | null {
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
    d.run("UPDATE agents SET active_project_id = ? WHERE id = ?", [updates.active_project_id ?? null, agent.id]);
  }

  // Always update last_seen_at
  d.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", [timestamp, agent.id]);

  return getAgent(agent.id, d)!;
}
