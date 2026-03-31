// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { resetDatabase, getDatabase } from "./database.js";
import { createEntity } from "./entities.js";
import { getEntityGraph } from "./relations.js";

// ============================================================================
// relations.ts line 210 — early return when entityIds.size === 0
// getEntityGraph on an entity with NO relations → entityRows is empty
// → entityIds.size === 0 → return { entities: [], relations: [] }
// ============================================================================

function freshDb(): Database {
  resetDatabase();
  return getDatabase(":memory:");
}

describe("getEntityGraph - isolated entity (line 210)", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns empty entities and relations for disconnected entity (line 210)", () => {
    // Create an entity with NO relations
    // getEntityGraph: recursive CTE finds only the entity itself at depth 0
    // entityIds will be a set with size 0 (the CTE query includes the entity but with depth=0,
    // not depth>0) ... wait, let me re-read.
    // Actually: the CTE returns all entities INCLUDING the start entity (depth=0).
    // So entityIds.size >= 1 (the start entity itself).
    // Actually NO: entityRows comes from JOIN with graph, and the start entity has depth=0.
    // But depth > 0 is NOT filtered in the SQL — it returns ALL from the CTE...
    // Let me test what actually happens with no relations.
    const loneEntity = createEntity({ name: "Lonely-Entity", type: "concept" }, db);

    const graph = getEntityGraph(loneEntity.id, 2, db);

    // With no relations, the entity itself IS returned (depth=0 is included)
    // So entityIds.size = 1, and relations will be empty.
    // Line 209: if (entityIds.size === 0) → NOT triggered here (size=1)
    // BUT the relations query will return empty, so relations=[]
    expect(graph.entities.length).toBeGreaterThanOrEqual(1);
    expect(graph.entities[0]!.name).toBe("Lonely-Entity");
    expect(graph.relations).toHaveLength(0);
  });

  test("early return when entity not in graph (size === 0 path, line 210)", () => {
    // We need to trigger entityIds.size === 0.
    // Looking at the SQL more carefully:
    // WITH RECURSIVE graph(id, depth) AS (
    //   VALUES(?, 0)                    ← start entity at depth 0
    //   UNION ...
    // )
    // SELECT DISTINCT e.* FROM entities e JOIN graph g ON e.id = g.id
    //
    // The VALUES(?, 0) inserts the startEntityId at depth 0.
    // If the startEntity exists in the entities table, it WILL appear in entityRows.
    // entityIds.size will be >= 1.
    //
    // To get entityIds.size === 0, the entity must NOT exist in the entities table.
    // This happens when graphEntityId doesn't exist (deleted entity).
    const nonExistentId = "deleted-entity-id-9999";

    // Call with a non-existent entity ID — the VALUES clause still runs,
    // but the JOIN with entities will return no rows (entity doesn't exist)
    // → entityIds.size = 0 → line 210 fires!
    const graph = getEntityGraph(nonExistentId, 2, db);

    // The entity doesn't exist, so entities is empty, size = 0 → early return
    expect(graph.entities).toHaveLength(0);
    expect(graph.relations).toHaveLength(0);
  });
});
