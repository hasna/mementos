import { Database, type SQLQueryBindings } from "bun:sqlite";
import { getDatabase, now, shortUuid } from "./database.js";
import type {
  Entity,
  CreateEntityInput,
  UpdateEntityInput,
  EntityType,
} from "../types/index.js";
import { EntityNotFoundError } from "../types/index.js";

// ============================================================================
// Helpers
// ============================================================================

export function parseEntityRow(row: Record<string, unknown>): Entity {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    type: row["type"] as EntityType,
    description: (row["description"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    project_id: (row["project_id"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

// ============================================================================
// Create
// ============================================================================

export function createEntity(input: CreateEntityInput, db?: Database): Entity {
  const d = db || getDatabase();
  const timestamp = now();
  const metadataJson = JSON.stringify(input.metadata || {});

  // Upsert: if name+type+project_id already exists, return existing
  const existing = d
    .query(
      `SELECT * FROM entities
       WHERE name = ? AND type = ? AND COALESCE(project_id, '') = ?`
    )
    .get(
      input.name,
      input.type,
      input.project_id || ""
    ) as Record<string, unknown> | null;

  if (existing) {
    // Update description/metadata if provided, bump updated_at
    const sets: string[] = ["updated_at = ?"];
    const params: SQLQueryBindings[] = [timestamp];

    if (input.description !== undefined) {
      sets.push("description = ?");
      params.push(input.description);
    }
    if (input.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(metadataJson);
    }

    const existingId = existing["id"] as string;
    params.push(existingId);
    d.run(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`, params);

    return getEntity(existingId, d);
  }

  const id = shortUuid();
  d.run(
    `INSERT INTO entities (id, name, type, description, metadata, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.type,
      input.description || null,
      metadataJson,
      input.project_id || null,
      timestamp,
      timestamp,
    ]
  );

  return getEntity(id, d);
}

// ============================================================================
// Read
// ============================================================================

export function getEntity(id: string, db?: Database): Entity {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM entities WHERE id = ?").get(id) as
    | Record<string, unknown>
    | null;
  if (!row) throw new EntityNotFoundError(id);
  return parseEntityRow(row);
}

export function getEntityByName(
  name: string,
  type?: EntityType,
  projectId?: string,
  db?: Database
): Entity | null {
  const d = db || getDatabase();

  let sql = "SELECT * FROM entities WHERE name = ?";
  const params: SQLQueryBindings[] = [name];

  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  if (projectId !== undefined) {
    sql += " AND project_id = ?";
    params.push(projectId);
  }

  sql += " LIMIT 1";

  const row = d.query(sql).get(...params) as Record<string, unknown> | null;
  if (!row) return null;
  return parseEntityRow(row);
}

// ============================================================================
// List
// ============================================================================

export function listEntities(
  filter: {
    type?: EntityType;
    project_id?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
  db?: Database
): Entity[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.type) {
    conditions.push("type = ?");
    params.push(filter.type);
  }
  if (filter.project_id) {
    conditions.push("project_id = ?");
    params.push(filter.project_id);
  }
  if (filter.search) {
    conditions.push("(name LIKE ? OR description LIKE ?)");
    const term = `%${filter.search}%`;
    params.push(term, term);
  }

  let sql = "SELECT * FROM entities";
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  sql += " ORDER BY updated_at DESC";

  if (filter.limit) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }
  if (filter.offset) {
    sql += " OFFSET ?";
    params.push(filter.offset);
  }

  const rows = d.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseEntityRow);
}

// ============================================================================
// Update
// ============================================================================

export function updateEntity(
  id: string,
  input: UpdateEntityInput,
  db?: Database
): Entity {
  const d = db || getDatabase();

  // Verify entity exists
  const existing = d.query("SELECT id FROM entities WHERE id = ?").get(id) as
    | Record<string, unknown>
    | null;
  if (!existing) throw new EntityNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: SQLQueryBindings[] = [now()];

  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name);
  }
  if (input.type !== undefined) {
    sets.push("type = ?");
    params.push(input.type);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    params.push(input.description);
  }
  if (input.metadata !== undefined) {
    sets.push("metadata = ?");
    params.push(JSON.stringify(input.metadata));
  }

  params.push(id);
  d.run(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`, params);

  return getEntity(id, d);
}

// ============================================================================
// Delete
// ============================================================================

export function deleteEntity(id: string, db?: Database): void {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM entities WHERE id = ?", [id]);
  if (result.changes === 0) throw new EntityNotFoundError(id);
}

// ============================================================================
// Merge
// ============================================================================

export function mergeEntities(
  sourceId: string,
  targetId: string,
  db?: Database
): Entity {
  const d = db || getDatabase();

  // Verify both exist
  getEntity(sourceId, d);
  getEntity(targetId, d);

  // Move relations where source is the source_entity_id
  // Skip duplicates (unique constraint on source_entity_id, target_entity_id, relation_type)
  d.run(
    `UPDATE OR IGNORE relations SET source_entity_id = ? WHERE source_entity_id = ?`,
    [targetId, sourceId]
  );

  // Move relations where source is the target_entity_id
  d.run(
    `UPDATE OR IGNORE relations SET target_entity_id = ? WHERE target_entity_id = ?`,
    [targetId, sourceId]
  );

  // Clean up any remaining relations that couldn't be moved (duplicates)
  d.run("DELETE FROM relations WHERE source_entity_id = ? OR target_entity_id = ?", [
    sourceId,
    sourceId,
  ]);

  // Move entity_memories — skip duplicates (PK on entity_id, memory_id)
  d.run(
    `UPDATE OR IGNORE entity_memories SET entity_id = ? WHERE entity_id = ?`,
    [targetId, sourceId]
  );

  // Clean up remaining entity_memories that couldn't be moved
  d.run("DELETE FROM entity_memories WHERE entity_id = ?", [sourceId]);

  // Delete the source entity
  d.run("DELETE FROM entities WHERE id = ?", [sourceId]);

  // Update target's updated_at
  d.run("UPDATE entities SET updated_at = ? WHERE id = ?", [now(), targetId]);

  return getEntity(targetId, d);
}
