import { SqliteAdapter as Database } from "../storage.js";
import type { Project } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { isApiMode, apiJson } from "./api-mode.js";

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
  if (!db && isApiMode()) {
    const { data } = apiJson<Project>("POST", "/projects", {
      name,
      path,
      description,
      memory_prefix: memoryPrefix,
    });
    return data;
  }
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
  if (!db && isApiMode()) {
    const { status, data } = apiJson<Project>("GET", `/projects/${encodeURIComponent(idOrPath)}`, undefined, { allow404: true });
    if (status === 404 || !data) return null;
    return data;
  }
  const d = db || getDatabase();

  let row = d.query("SELECT * FROM projects WHERE id = ?").get(idOrPath) as
    | Record<string, unknown>
    | null;
  if (row) return parseProjectRow(row);

  row = d.query("SELECT * FROM projects WHERE path = ?").get(idOrPath) as
    | Record<string, unknown>
    | null;
  if (row) return parseProjectRow(row);

  // Try by name (case-insensitive)
  row = d.query("SELECT * FROM projects WHERE LOWER(name) = ?").get(idOrPath.toLowerCase()) as
    | Record<string, unknown>
    | null;
  if (row) return parseProjectRow(row);

  return null;
}

export function listProjects(db?: Database): Project[] {
  if (!db && isApiMode()) {
    const { data } = apiJson<{ projects: Project[] }>("GET", "/projects");
    return data?.projects ?? [];
  }
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(parseProjectRow);
}
