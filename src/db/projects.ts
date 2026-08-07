import { SqliteAdapter as Database } from "../storage.js";
import type { Project, UpdateProjectInput } from "../types/index.js";
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

export class ProjectCollisionError extends Error {
  constructor(
    public readonly field: "name" | "path",
    public readonly value: string
  ) {
    super(`Project ${field} already exists: ${value}`);
    this.name = "ProjectCollisionError";
  }
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

export function updateProject(
  id: string,
  input: UpdateProjectInput,
  db?: Database
): Project | null {
  const normalizedInput: UpdateProjectInput = {};
  if (input.name !== undefined) normalizedInput.name = input.name.trim();
  if (input.path !== undefined) normalizedInput.path = input.path.trim();
  if (input.description !== undefined) normalizedInput.description = input.description;
  if (input.memory_prefix !== undefined) normalizedInput.memory_prefix = input.memory_prefix;
  if (Object.keys(normalizedInput).length === 0) {
    throw new Error("At least one project field must be provided");
  }
  if (normalizedInput.name !== undefined && normalizedInput.name.length === 0) {
    throw new Error("Project name cannot be empty");
  }
  if (normalizedInput.path !== undefined && normalizedInput.path.length === 0) {
    throw new Error("Project path cannot be empty");
  }

  if (!db && isApiMode()) {
    const { status, data } = apiJson<Project>(
      "PATCH",
      `/projects/${encodeURIComponent(id)}`,
      normalizedInput,
      { allow404: true }
    );
    if (status === 404 || !data) return null;
    if (data.id !== id) {
      throw new Error(
        `Project update did not persist for ${id}: server returned a different stable ID (${data.id})`
      );
    }
    for (const field of ["name", "path", "description", "memory_prefix"] as const) {
      if (normalizedInput[field] !== undefined && data[field] !== normalizedInput[field]) {
        throw new Error(
          `Project update did not persist for ${id}: ${field} remained ${JSON.stringify(data[field])}`
        );
      }
    }
    return data;
  }

  const d = db || getDatabase();
  return d.transaction(() => {
    const existingRow = d.query("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | null;
    if (!existingRow) return null;

    const existing = parseProjectRow(existingRow);
    const nextName = normalizedInput.name;
    const nextPath = normalizedInput.path;

    if (nextName !== undefined) {
      const collision = d
        .query("SELECT id FROM projects WHERE LOWER(name) = LOWER(?) AND id != ?")
        .get(nextName, existing.id) as Record<string, unknown> | null;
      if (collision) throw new ProjectCollisionError("name", nextName);
    }
    if (nextPath !== undefined) {
      const collision = d
        .query("SELECT id FROM projects WHERE path = ? AND id != ?")
        .get(nextPath, existing.id) as Record<string, unknown> | null;
      if (collision) throw new ProjectCollisionError("path", nextPath);
    }

    const sets = ["updated_at = ?"];
    const values: unknown[] = [now()];
    if (nextName !== undefined) {
      sets.push("name = ?");
      values.push(nextName);
    }
    if (nextPath !== undefined) {
      sets.push("path = ?");
      values.push(nextPath);
    }
    if (normalizedInput.description !== undefined) {
      sets.push("description = ?");
      values.push(normalizedInput.description);
    }
    if (normalizedInput.memory_prefix !== undefined) {
      sets.push("memory_prefix = ?");
      values.push(normalizedInput.memory_prefix);
    }
    values.push(existing.id);

    d.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, values);
    const updated = d.query("SELECT * FROM projects WHERE id = ?").get(existing.id) as
      | Record<string, unknown>
      | null;
    return updated ? parseProjectRow(updated) : null;
  });
}
