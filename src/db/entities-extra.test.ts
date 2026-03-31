// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { resetDatabase, getDatabase } from "./database.js";
import { createEntity, graphTraverse } from "./entities.js";
import { createRelation } from "./relations.js";

// ============================================================================
// entities.ts line 525 — catch block in graphTraverse when getEntity throws
// Triggered when an entity appears in a path but has been deleted.
// Strategy:
//   1. Create entities A and B
//   2. Create relation A → B
//   3. Disable FK constraints
//   4. Delete entity B (without cascading the relation)
//   5. Call graphTraverse(A) — the CTE finds A→B path,
//      but when getEntity(B) is called, it throws EntityNotFoundError
//      → line 525 fires, path entry gets "(unknown)" name
// ============================================================================

function freshDb(): Database {
  resetDatabase();
  return getDatabase(":memory:");
}

describe("graphTraverse - catch when entity deleted from path (line 525)", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("handles deleted entity in graph path with (unknown) fallback (line 525)", () => {
    // Create two entities
    const entityA = createEntity({ name: "Entity-A", type: "concept" }, db);
    const entityB = createEntity({ name: "Entity-B", type: "concept" }, db);

    // Create a relation A → B
    createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "related_to" }, db);

    // Disable FK constraints so we can delete entity B without cascading the relation
    db.run("PRAGMA foreign_keys = OFF");

    // Delete entity B — the relation A→B still exists but B is gone
    db.run("DELETE FROM entities WHERE id = ?", [entityB.id]);

    // Re-enable FK constraints (optional, but good hygiene)
    db.run("PRAGMA foreign_keys = ON");

    // graphTraverse(A) — CTE finds path A→B, but getEntity(B) throws
    // → line 525 catch fires: pushes { id: B_id, name: "(unknown)", type: "concept" }
    const result = graphTraverse(entityA.id, { direction: "outgoing", max_depth: 2 }, db);

    // The path should exist with entity A (found) and entity B (unknown)
    expect(result.paths.length).toBeGreaterThanOrEqual(1);

    // Find the path containing the unknown entity
    const hasUnknown = result.paths.some(
      (path) => path.entities.some((e) => e.name === "(unknown)")
    );
    expect(hasUnknown).toBe(true);
  });
});
