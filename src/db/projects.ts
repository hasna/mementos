import { Database } from "bun:sqlite";
import type { Project } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

function parseProjectRow(row: Record<string, unknown>): Project {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    path: row["path"] as string,
    description: (row["description"] as string) || null,
    memory_prefix: (row["memory_prefix"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

export function registerProject(
  name: string,
  path: string,
  description?: string,
  memoryPrefix?: string,
  db?: Database
): Project {
  const d = db || getDatabase();
  const timestamp = now();

  // Idempotent: same path returns existing
  const existing = d
    .query("SELECT * FROM projects WHERE path = ?")
    .get(path) as Record<string, unknown> | null;

  if (existing) {
    const existingId = existing["id"] as string;
    d.run("UPDATE projects SET updated_at = ? WHERE id = ?", [
      timestamp,
      existingId,
    ]);
    return parseProjectRow(existing);
  }

  const id = uuid();
  d.run(
    "INSERT INTO projects (id, name, path, description, memory_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, name, path, description || null, memoryPrefix || null, timestamp, timestamp]
  );

  return getProject(id, d)!;
}

export function getProject(
  idOrPath: string,
  db?: Database
): Project | null {
  const d = db || getDatabase();

  let row = d.query("SELECT * FROM projects WHERE id = ?").get(idOrPath) as
    | Record<string, unknown>
    | null;
  if (row) return parseProjectRow(row);

  row = d.query("SELECT * FROM projects WHERE path = ?").get(idOrPath) as
    | Record<string, unknown>
    | null;
  if (row) return parseProjectRow(row);

  return null;
}

export function listProjects(db?: Database): Project[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(parseProjectRow);
}
