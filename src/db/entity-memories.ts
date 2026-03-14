import { Database } from "bun:sqlite";
import { getDatabase, now } from "./database.js";
import type { Entity, Memory, EntityMemory, EntityRole } from "../types/index.js";
import { parseMemoryRow } from "./memories.js";

// ============================================================================
// Helpers
// ============================================================================

function parseEntityRow(row: Record<string, unknown>): Entity {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    type: row["type"] as Entity["type"],
    description: (row["description"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}"),
    project_id: (row["project_id"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

function parseEntityMemoryRow(row: Record<string, unknown>): EntityMemory {
  return {
    entity_id: row["entity_id"] as string,
    memory_id: row["memory_id"] as string,
    role: row["role"] as EntityRole,
    created_at: row["created_at"] as string,
  };
}

// ============================================================================
// Link / Unlink
// ============================================================================

/**
 * Link an entity to a memory. Uses INSERT OR IGNORE so duplicate links
 * are silently ignored rather than throwing an error.
 */
export function linkEntityToMemory(
  entityId: string,
  memoryId: string,
  role: EntityRole = "context",
  db?: Database
): EntityMemory {
  const d = db || getDatabase();
  const timestamp = now();

  d.run(
    `INSERT OR IGNORE INTO entity_memories (entity_id, memory_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
    [entityId, memoryId, role, timestamp]
  );

  // Return the link (may already exist with a different created_at)
  const row = d
    .query(
      "SELECT * FROM entity_memories WHERE entity_id = ? AND memory_id = ?"
    )
    .get(entityId, memoryId) as Record<string, unknown>;

  return parseEntityMemoryRow(row);
}

/**
 * Remove the link between an entity and a memory.
 */
export function unlinkEntityFromMemory(
  entityId: string,
  memoryId: string,
  db?: Database
): void {
  const d = db || getDatabase();
  d.run(
    "DELETE FROM entity_memories WHERE entity_id = ? AND memory_id = ?",
    [entityId, memoryId]
  );
}

// ============================================================================
// Query
// ============================================================================

/**
 * Get all memories linked to a given entity.
 * Performs a JOIN with the memories table to return full Memory objects.
 */
export function getMemoriesForEntity(
  entityId: string,
  db?: Database
): Memory[] {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT m.* FROM memories m
       INNER JOIN entity_memories em ON em.memory_id = m.id
       WHERE em.entity_id = ?
       ORDER BY m.importance DESC, m.created_at DESC`
    )
    .all(entityId) as Record<string, unknown>[];

  return rows.map(parseMemoryRow);
}

/**
 * Get all entities linked to a given memory.
 * Performs a JOIN with the entities table to return full Entity objects.
 */
export function getEntitiesForMemory(
  memoryId: string,
  db?: Database
): Entity[] {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT e.* FROM entities e
       INNER JOIN entity_memories em ON em.entity_id = e.id
       WHERE em.memory_id = ?
       ORDER BY e.name ASC`
    )
    .all(memoryId) as Record<string, unknown>[];

  return rows.map(parseEntityRow);
}

// ============================================================================
// Bulk operations
// ============================================================================

/**
 * Link multiple entities to a single memory inside a transaction.
 */
export function bulkLinkEntities(
  entityIds: string[],
  memoryId: string,
  role: EntityRole = "context",
  db?: Database
): void {
  const d = db || getDatabase();
  const timestamp = now();

  const tx = d.transaction(() => {
    const stmt = d.prepare(
      `INSERT OR IGNORE INTO entity_memories (entity_id, memory_id, role, created_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const entityId of entityIds) {
      stmt.run(entityId, memoryId, role, timestamp);
    }
  });

  tx();
}

// ============================================================================
// Flexible query
// ============================================================================

/**
 * Query entity-memory links with optional filters.
 * - Pass entityId only to get all links for that entity.
 * - Pass memoryId only to get all links for that memory.
 * - Pass both to get the specific link (if it exists).
 * - Pass neither to get all links.
 */
export function getEntityMemoryLinks(
  entityId?: string,
  memoryId?: string,
  db?: Database
): EntityMemory[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: string[] = [];

  if (entityId) {
    conditions.push("entity_id = ?");
    params.push(entityId);
  }
  if (memoryId) {
    conditions.push("memory_id = ?");
    params.push(memoryId);
  }

  let sql = "SELECT * FROM entity_memories";
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  sql += " ORDER BY created_at DESC";

  const rows = d.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseEntityMemoryRow);
}
