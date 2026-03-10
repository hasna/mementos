import { Database } from "bun:sqlite";
import type { Agent } from "../types/index.js";
import { getDatabase, now, shortUuid } from "./database.js";

function parseAgentRow(row: Record<string, unknown>): Agent {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    description: (row["description"] as string) || null,
    role: (row["role"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    created_at: row["created_at"] as string,
    last_seen_at: row["last_seen_at"] as string,
  };
}

export function registerAgent(
  name: string,
  description?: string,
  role?: string,
  db?: Database
): Agent {
  const d = db || getDatabase();
  const timestamp = now();

  // Idempotent: same name returns existing agent, updates last_seen_at
  const existing = d
    .query("SELECT * FROM agents WHERE name = ?")
    .get(name) as Record<string, unknown> | null;

  if (existing) {
    const existingId = existing["id"] as string;
    d.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", [
      timestamp,
      existingId,
    ]);
    if (description) {
      d.run("UPDATE agents SET description = ? WHERE id = ?", [
        description,
        existingId,
      ]);
    }
    if (role) {
      d.run("UPDATE agents SET role = ? WHERE id = ?", [
        role,
        existingId,
      ]);
    }
    return getAgent(existingId, d)!;
  }

  const id = shortUuid();
  d.run(
    "INSERT INTO agents (id, name, description, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, name, description || null, role || "agent", timestamp, timestamp]
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

  // Try by name
  row = d.query("SELECT * FROM agents WHERE name = ?").get(idOrName) as
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
