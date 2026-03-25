import { SqliteAdapter as Database } from "@hasna/cloud";
type SQLQueryBindings = string | number | null | boolean;
import { getDatabase, now, shortUuid } from "./database.js";
import type {
  Entity,
  CreateEntityInput,
  UpdateEntityInput,
  EntityType,
} from "../types/index.js";
import { EntityNotFoundError } from "../types/index.js";
import { hookRegistry } from "../lib/hooks.js";

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

  void hookRegistry.runHooks("PostEntityCreate", {
    entityId: id,
    name: input.name,
    entityType: input.type,
    projectId: input.project_id,
    timestamp: Date.now(),
  });

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

// ============================================================================
// Entity disambiguation — find duplicate entities by name similarity
// ============================================================================

/**
 * Compute trigram similarity between two strings (0–1).
 * Uses character trigrams with Jaccard similarity coefficient.
 */
function trigramSimilarity(a: string, b: string): number {
  const trigramsOf = (s: string): Set<string> => {
    const padded = `  ${s.toLowerCase()}  `;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) {
      set.add(padded.slice(i, i + 3));
    }
    return set;
  };

  const triA = trigramsOf(a);
  const triB = trigramsOf(b);

  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }

  const union = triA.size + triB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateEntityPair {
  entity_a: Entity;
  entity_b: Entity;
  similarity: number;
}

/**
 * Find potential duplicate entities by name similarity within same type+project.
 * Returns pairs above the threshold (default 0.8) sorted by similarity descending.
 */
export function findDuplicateEntities(
  threshold: number = 0.8,
  db?: Database
): DuplicateEntityPair[] {
  const d = db || getDatabase();

  // Group entities by type+project for comparison
  const entities = d
    .query("SELECT * FROM entities ORDER BY type, project_id, name")
    .all() as Record<string, unknown>[];

  const parsed = entities.map(parseEntityRow);

  // Group by type+project_id
  const groups = new Map<string, Entity[]>();
  for (const e of parsed) {
    const groupKey = `${e.type}:${e.project_id || ""}`;
    const group = groups.get(groupKey);
    if (group) {
      group.push(e);
    } else {
      groups.set(groupKey, [e]);
    }
  }

  const duplicates: DuplicateEntityPair[] = [];

  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const sim = trigramSimilarity(group[i]!.name, group[j]!.name);
        if (sim >= threshold) {
          duplicates.push({
            entity_a: group[i]!,
            entity_b: group[j]!,
            similarity: sim,
          });
        }
      }
    }
  }

  // Sort by similarity descending
  duplicates.sort((a, b) => b.similarity - a.similarity);

  return duplicates;
}

// ============================================================================
// Graph Traversal (multi-hop recursive CTE)
// ============================================================================

export interface GraphTraversalPath {
  entities: Array<{ id: string; name: string; type: string }>;
  relations: Array<{ id: string; relation_type: string; weight: number }>;
  depth: number;
}

export interface GraphTraversalResult {
  paths: GraphTraversalPath[];
  visited_entities: Array<{ id: string; name: string; type: string }>;
  total_paths: number;
}

/**
 * Multi-hop graph traversal using a recursive CTE.
 *
 * Starts from `startEntityId` and follows relations up to `max_depth` hops,
 * returning all discovered paths. Handles cycles by tracking visited entities
 * in each path. Supports direction filtering and relation-type filtering.
 */
export function graphTraverse(
  startEntityId: string,
  options: {
    max_depth?: number;
    relation_types?: string[];
    direction?: "outgoing" | "incoming" | "both";
    limit?: number;
  } = {},
  db?: Database,
): GraphTraversalResult {
  const d = db || getDatabase();
  const maxDepth = options.max_depth ?? 2;
  const direction = options.direction ?? "both";
  const limit = options.limit ?? 50;

  // Verify start entity exists
  getEntity(startEntityId, d);

  // Build the direction-aware join condition
  let joinCondition: string;
  let nextEntityExpr: string;

  if (direction === "outgoing") {
    joinCondition = "r.source_entity_id = t.entity_id";
    nextEntityExpr = "r.target_entity_id";
  } else if (direction === "incoming") {
    joinCondition = "r.target_entity_id = t.entity_id";
    nextEntityExpr = "r.source_entity_id";
  } else {
    // both
    joinCondition = "(r.source_entity_id = t.entity_id OR r.target_entity_id = t.entity_id)";
    nextEntityExpr = "CASE WHEN r.source_entity_id = t.entity_id THEN r.target_entity_id ELSE r.source_entity_id END";
  }

  // Build optional relation_type filter
  let relationTypeFilter = "";
  const params: SQLQueryBindings[] = [startEntityId, startEntityId];

  if (options.relation_types && options.relation_types.length > 0) {
    const placeholders = options.relation_types.map(() => "?").join(",");
    relationTypeFilter = `AND r.relation_type IN (${placeholders})`;
  }

  // Build the recursive CTE query
  // path_entities stores comma-separated entity IDs
  // path_relations stores a JSON array of {id, relation_type, weight} objects
  const sql = `
    WITH RECURSIVE traverse(entity_id, depth, path_entities, path_relations) AS (
      -- Base case: start entity
      SELECT ?, 0, ?, '[]'
      UNION ALL
      -- Recursive step: follow relations
      SELECT
        ${nextEntityExpr},
        t.depth + 1,
        t.path_entities || ',' || ${nextEntityExpr},
        t.path_relations || '|' || r.id || ':' || r.relation_type || ':' || r.weight
      FROM traverse t
      JOIN relations r ON ${joinCondition}
      WHERE t.depth < ?
        AND INSTR(t.path_entities, ${nextEntityExpr}) = 0
        ${relationTypeFilter}
    )
    SELECT entity_id, depth, path_entities, path_relations
    FROM traverse
    WHERE depth > 0
    ORDER BY depth ASC
    LIMIT ?
  `;

  // Bind params: startEntityId (base), startEntityId (trail seed), maxDepth, [relation_types...], limit
  params.push(maxDepth);
  if (options.relation_types && options.relation_types.length > 0) {
    params.push(...options.relation_types);
  }
  params.push(limit);

  const rows = d.query(sql).all(...params) as Array<{
    entity_id: string;
    depth: number;
    path_entities: string;
    path_relations: string;
  }>;

  // Collect all unique visited entity IDs
  const visitedIds = new Set<string>();
  visitedIds.add(startEntityId);

  const paths: GraphTraversalPath[] = [];

  for (const row of rows) {
    const entityIds = row.path_entities.split(",");
    for (const eid of entityIds) {
      visitedIds.add(eid);
    }

    // Parse relation data from the compact format: id:type:weight|id:type:weight
    const relationEntries: Array<{ id: string; relation_type: string; weight: number }> = [];
    if (row.path_relations && row.path_relations !== "[]") {
      // The first element is always "[]" from the base case, followed by "|id:type:weight" segments
      const segments = row.path_relations.split("|").filter((s) => s !== "[]" && s !== "");
      for (const seg of segments) {
        const parts = seg.split(":");
        if (parts.length >= 3) {
          relationEntries.push({
            id: parts[0]!,
            relation_type: parts[1]!,
            weight: parseFloat(parts[2]!),
          });
        }
      }
    }

    // Fetch entity details for each entity in the path
    const pathEntities: Array<{ id: string; name: string; type: string }> = [];
    for (const eid of entityIds) {
      try {
        const e = getEntity(eid, d);
        pathEntities.push({ id: e.id, name: e.name, type: e.type });
      } catch {
        // Entity may have been deleted — skip
        pathEntities.push({ id: eid, name: "(unknown)", type: "concept" });
      }
    }

    paths.push({
      entities: pathEntities,
      relations: relationEntries,
      depth: row.depth,
    });
  }

  // Build visited entities list with details
  const visitedEntities: Array<{ id: string; name: string; type: string }> = [];
  for (const eid of visitedIds) {
    try {
      const e = getEntity(eid, d);
      visitedEntities.push({ id: e.id, name: e.name, type: e.type });
    } catch {
      visitedEntities.push({ id: eid, name: "(unknown)", type: "concept" });
    }
  }

  return {
    paths,
    visited_entities: visitedEntities,
    total_paths: paths.length,
  };
}
