import { SqliteAdapter as Database } from "../storage.js";
type SQLQueryBindings = string | number | null | boolean;
import { getDatabase, now, shortUuid } from "./database.js";
import { isApiMode, apiJson, toQuery } from "./api-mode.js";
import type { Entity, Relation, CreateRelationInput, RelationType } from "../types/index.js";
import { hookRegistry } from "../lib/hooks.js";

// ============================================================================
// Helpers
// ============================================================================

export function parseRelationRow(row: Record<string, unknown>): Relation {
  return {
    id: row["id"] as string,
    source_entity_id: row["source_entity_id"] as string,
    target_entity_id: row["target_entity_id"] as string,
    relation_type: row["relation_type"] as RelationType,
    weight: row["weight"] as number,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    created_at: row["created_at"] as string,
  };
}

export function parseEntityRow(row: Record<string, unknown>): Entity {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    type: row["type"] as Entity["type"],
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

export function createRelation(input: CreateRelationInput, db?: Database): Relation {
  if (!db && isApiMode()) {
    const { data } = apiJson<Relation>("POST", "/relations", input);
    return data;
  }
  const d = db || getDatabase();
  const id = shortUuid();
  const timestamp = now();
  const weight = input.weight ?? 1.0;
  const metadata = JSON.stringify(input.metadata ?? {});

  // Upsert: on conflict (source+target+type), update weight
  d.run(
    `INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, weight, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_entity_id, target_entity_id, relation_type)
     DO UPDATE SET weight = excluded.weight, metadata = excluded.metadata`,
    [id, input.source_entity_id, input.target_entity_id, input.relation_type, weight, metadata, timestamp]
  );

  // Return the actual row (may be existing if upserted)
  const row = d
    .query(
      `SELECT * FROM relations
       WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?`
    )
    .get(input.source_entity_id, input.target_entity_id, input.relation_type) as Record<string, unknown>;

  const relation = parseRelationRow(row);

  void hookRegistry.runHooks("PostRelationCreate", {
    relationId: relation.id,
    sourceEntityId: relation.source_entity_id,
    targetEntityId: relation.target_entity_id,
    relationType: relation.relation_type,
    timestamp: Date.now(),
  });

  return relation;
}

// ============================================================================
// Read
// ============================================================================

export function getRelation(id: string, db?: Database): Relation {
  if (!db && isApiMode()) {
    const { status, data } = apiJson<Relation>("GET", `/relations/${encodeURIComponent(id)}`, undefined, { allow404: true });
    if (status === 404 || !data) throw new Error(`Relation not found: ${id}`);
    return data;
  }
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM relations WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) throw new Error(`Relation not found: ${id}`);
  return parseRelationRow(row);
}

// ============================================================================
// List
// ============================================================================

export function listRelations(
  filter: {
    entity_id?: string;
    relation_type?: RelationType;
    direction?: "outgoing" | "incoming" | "both";
  },
  db?: Database
): Relation[] {
  if (!db && isApiMode()) {
    // The cloud exposes relations for a given entity at
    // GET /entities/:id/relations. A general (entity-less) relation listing has
    // no cloud endpoint; the fail-closed getDatabase() guard covers that case.
    if (filter.entity_id) {
      const q = toQuery({ type: filter.relation_type, direction: filter.direction });
      const { data } = apiJson<{ relations: Relation[] }>(
        "GET",
        `/entities/${encodeURIComponent(filter.entity_id)}/relations${q}`,
      );
      return data?.relations ?? [];
    }
  }
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.entity_id) {
    const dir = filter.direction || "both";
    if (dir === "outgoing") {
      conditions.push("source_entity_id = ?");
      params.push(filter.entity_id);
    } else if (dir === "incoming") {
      conditions.push("target_entity_id = ?");
      params.push(filter.entity_id);
    } else {
      conditions.push("(source_entity_id = ? OR target_entity_id = ?)");
      params.push(filter.entity_id, filter.entity_id);
    }
  }

  if (filter.relation_type) {
    conditions.push("relation_type = ?");
    params.push(filter.relation_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = d.query(`SELECT * FROM relations ${where} ORDER BY created_at DESC`).all(...params as SQLQueryBindings[]) as Record<string, unknown>[];
  return rows.map(parseRelationRow);
}

// ============================================================================
// Delete
// ============================================================================

export function deleteRelation(id: string, db?: Database): void {
  if (!db && isApiMode()) {
    const { status } = apiJson<{ deleted: boolean }>("DELETE", `/relations/${encodeURIComponent(id)}`, undefined, { allow404: true });
    if (status === 404) throw new Error(`Relation not found: ${id}`);
    return;
  }
  const d = db || getDatabase();
  const result = d.run("DELETE FROM relations WHERE id = ?", [id]);
  if (result.changes === 0) throw new Error(`Relation not found: ${id}`);
}

// ============================================================================
// Graph queries
// ============================================================================

/**
 * Get direct neighbors (1-hop) of an entity.
 */
export function getRelatedEntities(
  entityId: string,
  relationType?: RelationType,
  db?: Database
): Entity[] {
  if (!db && isApiMode()) {
    const q = toQuery({ type: relationType });
    const { data } = apiJson<{ entities: Entity[] }>(
      "GET",
      `/entities/${encodeURIComponent(entityId)}/related${q}`,
    );
    return data?.entities ?? [];
  }
  const d = db || getDatabase();

  let sql: string;
  const params: unknown[] = [];

  if (relationType) {
    sql = `
      SELECT DISTINCT e.* FROM entities e
      JOIN relations r ON (
        (r.source_entity_id = ? AND r.target_entity_id = e.id)
        OR (r.target_entity_id = ? AND r.source_entity_id = e.id)
      )
      WHERE r.relation_type = ?
    `;
    params.push(entityId, entityId, relationType);
  } else {
    sql = `
      SELECT DISTINCT e.* FROM entities e
      JOIN relations r ON (
        (r.source_entity_id = ? AND r.target_entity_id = e.id)
        OR (r.target_entity_id = ? AND r.source_entity_id = e.id)
      )
    `;
    params.push(entityId, entityId);
  }

  const rows = d.query(sql).all(...params as SQLQueryBindings[]) as Record<string, unknown>[];
  return rows.map(parseEntityRow);
}

/**
 * Recursive CTE graph traversal. Collect all entities and relations within N hops.
 * Traverses BOTH directions (source->target and target->source).
 */
export function getEntityGraph(
  entityId: string,
  depth: number = 2,
  db?: Database
): { entities: Entity[]; relations: Relation[] } {
  if (!db && isApiMode()) {
    const q = toQuery({ depth });
    const { data } = apiJson<{ entities: Entity[]; relations: Relation[] }>(
      "GET",
      `/graph/${encodeURIComponent(entityId)}${q}`,
    );
    return { entities: data?.entities ?? [], relations: data?.relations ?? [] };
  }
  const d = db || getDatabase();

  // Get entities via recursive CTE
  const entityRows = d
    .query(
      `WITH RECURSIVE graph(id, depth) AS (
        VALUES(?, 0)
        UNION
        SELECT CASE WHEN r.source_entity_id = g.id THEN r.target_entity_id ELSE r.source_entity_id END, g.depth + 1
        FROM relations r JOIN graph g ON (r.source_entity_id = g.id OR r.target_entity_id = g.id)
        WHERE g.depth < ?
      )
      SELECT DISTINCT e.* FROM entities e JOIN graph g ON e.id = g.id`
    )
    .all(entityId, depth) as Record<string, unknown>[];

  const entities = entityRows.map(parseEntityRow);
  const entityIds = new Set(entities.map((e) => e.id));

  // Get all relations between the discovered entities
  if (entityIds.size === 0) {
    return { entities: [], relations: [] };
  }

  const placeholders = Array.from(entityIds).map(() => "?").join(",");
  const relationRows = d
    .query(
      `SELECT * FROM relations
       WHERE source_entity_id IN (${placeholders})
         AND target_entity_id IN (${placeholders})`
    )
    .all(...Array.from(entityIds), ...Array.from(entityIds)) as Record<string, unknown>[];

  const relations = relationRows.map(parseRelationRow);

  return { entities, relations };
}

/**
 * BFS shortest path using recursive CTE. Return ordered entity list or null if no path.
 */
export function findPath(
  fromEntityId: string,
  toEntityId: string,
  maxDepth: number = 5,
  db?: Database
): Entity[] | null {
  if (!db && isApiMode()) {
    const q = toQuery({ from: fromEntityId, to: toEntityId, max_depth: maxDepth });
    const { data } = apiJson<{ path: Entity[] | null; found: boolean }>("GET", `/graph/path${q}`);
    if (!data || !data.found || !data.path) return null;
    return data.path;
  }
  const d = db || getDatabase();

  // Use recursive CTE that tracks the full path
  const rows = d
    .query(
      `WITH RECURSIVE path(id, trail, depth) AS (
        SELECT ?, ?, 0
        UNION
        SELECT
          CASE WHEN r.source_entity_id = p.id THEN r.target_entity_id ELSE r.source_entity_id END,
          p.trail || ',' || CASE WHEN r.source_entity_id = p.id THEN r.target_entity_id ELSE r.source_entity_id END,
          p.depth + 1
        FROM relations r JOIN path p ON (r.source_entity_id = p.id OR r.target_entity_id = p.id)
        WHERE p.depth < ?
          AND INSTR(p.trail, CASE WHEN r.source_entity_id = p.id THEN r.target_entity_id ELSE r.source_entity_id END) = 0
      )
      SELECT trail FROM path WHERE id = ? ORDER BY depth ASC LIMIT 1`
    )
    .get(fromEntityId, fromEntityId, maxDepth, toEntityId) as { trail: string } | null;

  if (!rows) return null;

  const ids = rows.trail.split(",");
  // Fetch each entity in order
  const entities: Entity[] = [];
  for (const id of ids) {
    const row = d.query("SELECT * FROM entities WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (row) entities.push(parseEntityRow(row));
  }

  return entities.length > 0 ? entities : null;
}

// ============================================================================
// Graph statistics
// ============================================================================

export interface GraphStats {
  entities: { total: number; by_type: Record<string, number> };
  relations: { total: number; by_type: Record<string, number> };
  memory_links: number;
  orphan_entities: number;
  avg_degree: number;
  most_connected: { id: string; name: string; type: string; degree: number }[];
}

export function getGraphStats(db?: Database): GraphStats {
  if (!db && isApiMode()) {
    const { data } = apiJson<GraphStats>("GET", "/graph/stats");
    return {
      entities: data?.entities ?? { total: 0, by_type: {} },
      relations: data?.relations ?? { total: 0, by_type: {} },
      memory_links: data?.memory_links ?? 0,
      orphan_entities: data?.orphan_entities ?? 0,
      avg_degree: data?.avg_degree ?? 0,
      most_connected: data?.most_connected ?? [],
    };
  }
  const d = db || getDatabase();
  const entityTotal = (d.query("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
  const byType = d.query("SELECT type, COUNT(*) as c FROM entities GROUP BY type").all() as { type: string; c: number }[];
  const relationTotal = (d.query("SELECT COUNT(*) as c FROM relations").get() as { c: number }).c;
  const byRelType = d.query("SELECT relation_type, COUNT(*) as c FROM relations GROUP BY relation_type").all() as { relation_type: string; c: number }[];
  const linkTotal = (d.query("SELECT COUNT(*) as c FROM entity_memories").get() as { c: number }).c;

  const mostConnected = d.query(`
    SELECT e.id, e.name, e.type,
      (SELECT COUNT(*) FROM relations WHERE source_entity_id = e.id) +
      (SELECT COUNT(*) FROM relations WHERE target_entity_id = e.id) as degree
    FROM entities e ORDER BY degree DESC LIMIT 10
  `).all() as { id: string; name: string; type: string; degree: number }[];

  const orphanCount = (d.query(`
    SELECT COUNT(*) as c FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM relations WHERE source_entity_id = e.id OR target_entity_id = e.id)
  `).get() as { c: number }).c;

  const avgDegree = entityTotal > 0 ? (relationTotal * 2) / entityTotal : 0;

  return {
    entities: { total: entityTotal, by_type: Object.fromEntries(byType.map((r) => [r.type, r.c])) },
    relations: { total: relationTotal, by_type: Object.fromEntries(byRelType.map((r) => [r.relation_type, r.c])) },
    memory_links: linkTotal,
    orphan_entities: orphanCount,
    avg_degree: avgDegree,
    most_connected: mostConnected,
  };
}
