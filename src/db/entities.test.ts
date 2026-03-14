process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase, shortUuid, uuid } from "./database.js";
import {
  createEntity,
  getEntity,
  getEntityByName,
  listEntities,
  updateEntity,
  deleteEntity,
  mergeEntities,
} from "./entities.js";
import { EntityNotFoundError } from "../types/index.js";

/** Helper: insert a real project row so FK constraints pass */
function createProject(id: string, name: string): void {
  const db = getDatabase();
  db.run(
    "INSERT OR IGNORE INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
    [id, name, `/tmp/${name}`]
  );
}

beforeEach(() => {
  resetDatabase();
});

// ============================================================================
// createEntity
// ============================================================================

describe("createEntity", () => {
  test("creates entity with 8-char ID", () => {
    const entity = createEntity({ name: "TypeScript", type: "tool" });
    expect(entity.id).toHaveLength(8);
    expect(entity.name).toBe("TypeScript");
    expect(entity.type).toBe("tool");
    expect(entity.description).toBeNull();
    expect(entity.metadata).toEqual({});
    expect(entity.project_id).toBeNull();
    expect(entity.created_at).toBeTruthy();
    expect(entity.updated_at).toBeTruthy();
  });

  test("creates entity with all fields", () => {
    createProject("proj-1", "project-one");
    const entity = createEntity({
      name: "Alice",
      type: "person",
      description: "A developer",
      metadata: { team: "backend" },
      project_id: "proj-1",
    });
    expect(entity.name).toBe("Alice");
    expect(entity.type).toBe("person");
    expect(entity.description).toBe("A developer");
    expect(entity.metadata).toEqual({ team: "backend" });
    expect(entity.project_id).toBe("proj-1");
  });

  test("upsert — same name+type+project returns existing", () => {
    const first = createEntity({ name: "React", type: "tool" });
    const second = createEntity({ name: "React", type: "tool" });
    expect(second.id).toBe(first.id);
  });

  test("upsert updates description and metadata", () => {
    const first = createEntity({ name: "Vue", type: "tool", description: "old" });
    const second = createEntity({
      name: "Vue",
      type: "tool",
      description: "new",
      metadata: { version: 3 },
    });
    expect(second.id).toBe(first.id);
    expect(second.description).toBe("new");
    expect(second.metadata).toEqual({ version: 3 });
  });

  test("different type creates separate entity", () => {
    const tool = createEntity({ name: "Python", type: "tool" });
    const concept = createEntity({ name: "Python", type: "concept" });
    expect(tool.id).not.toBe(concept.id);
  });

  test("different project_id creates separate entity", () => {
    createProject("p1", "proj-p1");
    createProject("p2", "proj-p2");
    const a = createEntity({ name: "Config", type: "file", project_id: "p1" });
    const b = createEntity({ name: "Config", type: "file", project_id: "p2" });
    expect(a.id).not.toBe(b.id);
  });
});

// ============================================================================
// getEntity
// ============================================================================

describe("getEntity", () => {
  test("retrieves entity by ID", () => {
    const created = createEntity({ name: "Bun", type: "tool" });
    const found = getEntity(created.id);
    expect(found.id).toBe(created.id);
    expect(found.name).toBe("Bun");
  });

  test("throws EntityNotFoundError for missing ID", () => {
    expect(() => getEntity("nonexistent")).toThrow(EntityNotFoundError);
  });
});

// ============================================================================
// getEntityByName
// ============================================================================

describe("getEntityByName", () => {
  test("finds entity by name", () => {
    const created = createEntity({ name: "Docker", type: "tool" });
    const found = getEntityByName("Docker");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  test("filters by type", () => {
    createEntity({ name: "Node", type: "tool" });
    createEntity({ name: "Node", type: "concept" });
    const found = getEntityByName("Node", "concept");
    expect(found).not.toBeNull();
    expect(found!.type).toBe("concept");
  });

  test("filters by project_id", () => {
    createProject("p1", "proj-p1");
    createProject("p2", "proj-p2");
    createEntity({ name: "Schema", type: "file", project_id: "p1" });
    createEntity({ name: "Schema", type: "file", project_id: "p2" });
    const found = getEntityByName("Schema", "file", "p1");
    expect(found).not.toBeNull();
    expect(found!.project_id).toBe("p1");
  });

  test("returns null for non-existent name", () => {
    const found = getEntityByName("DoesNotExist");
    expect(found).toBeNull();
  });
});

// ============================================================================
// listEntities
// ============================================================================

describe("listEntities", () => {
  test("returns empty list when no entities exist", () => {
    const entities = listEntities();
    expect(entities).toEqual([]);
  });

  test("returns all entities", () => {
    createEntity({ name: "A", type: "tool" });
    createEntity({ name: "B", type: "concept" });
    createEntity({ name: "C", type: "person" });
    const entities = listEntities();
    expect(entities).toHaveLength(3);
  });

  test("filters by type", () => {
    createEntity({ name: "X", type: "tool" });
    createEntity({ name: "Y", type: "tool" });
    createEntity({ name: "Z", type: "person" });
    const tools = listEntities({ type: "tool" });
    expect(tools).toHaveLength(2);
    expect(tools.every((e) => e.type === "tool")).toBe(true);
  });

  test("filters by project_id", () => {
    createProject("proj-a", "project-a");
    createProject("proj-b", "project-b");
    createEntity({ name: "A", type: "tool", project_id: "proj-a" });
    createEntity({ name: "B", type: "tool", project_id: "proj-b" });
    const filtered = listEntities({ project_id: "proj-a" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.name).toBe("A");
  });

  test("filters by search term", () => {
    createEntity({ name: "TypeScript", type: "tool" });
    createEntity({ name: "JavaScript", type: "tool" });
    createEntity({ name: "Rust", type: "tool" });
    const results = listEntities({ search: "Script" });
    expect(results).toHaveLength(2);
  });

  test("respects limit and offset", () => {
    createEntity({ name: "E1", type: "tool" });
    createEntity({ name: "E2", type: "tool" });
    createEntity({ name: "E3", type: "tool" });
    const page = listEntities({ limit: 2 });
    expect(page).toHaveLength(2);
    const page2 = listEntities({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
  });
});

// ============================================================================
// updateEntity
// ============================================================================

describe("updateEntity", () => {
  test("updates name", () => {
    const entity = createEntity({ name: "OldName", type: "tool" });
    const updated = updateEntity(entity.id, { name: "NewName" });
    expect(updated.name).toBe("NewName");
  });

  test("updates description", () => {
    const entity = createEntity({ name: "Desc", type: "concept" });
    const updated = updateEntity(entity.id, { description: "A new description" });
    expect(updated.description).toBe("A new description");
  });

  test("clears description with null", () => {
    const entity = createEntity({ name: "Clear", type: "concept", description: "has desc" });
    const updated = updateEntity(entity.id, { description: null });
    expect(updated.description).toBeNull();
  });

  test("updates metadata", () => {
    const entity = createEntity({ name: "Meta", type: "tool" });
    const updated = updateEntity(entity.id, { metadata: { version: "2.0" } });
    expect(updated.metadata).toEqual({ version: "2.0" });
  });

  test("updates type", () => {
    const entity = createEntity({ name: "Morph", type: "tool" });
    const updated = updateEntity(entity.id, { type: "concept" });
    expect(updated.type).toBe("concept");
  });

  test("updates updated_at", () => {
    const entity = createEntity({ name: "Time", type: "tool" });
    const original = entity.updated_at;
    const updated = updateEntity(entity.id, { description: "bump" });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(original).getTime()
    );
  });

  test("throws EntityNotFoundError for missing ID", () => {
    expect(() => updateEntity("nonexistent", { name: "x" })).toThrow(EntityNotFoundError);
  });
});

// ============================================================================
// deleteEntity
// ============================================================================

describe("deleteEntity", () => {
  test("deletes entity", () => {
    const entity = createEntity({ name: "ToDelete", type: "tool" });
    deleteEntity(entity.id);
    expect(() => getEntity(entity.id)).toThrow(EntityNotFoundError);
  });

  test("throws EntityNotFoundError for missing ID", () => {
    expect(() => deleteEntity("nonexistent")).toThrow(EntityNotFoundError);
  });

  test("cascade deletes relations", () => {
    const db = getDatabase(":memory:");
    const a = createEntity({ name: "A", type: "tool" }, db);
    const b = createEntity({ name: "B", type: "tool" }, db);

    // Create a relation between A and B
    db.run(
      "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type) VALUES (?, ?, ?, ?)",
      [shortUuid(), a.id, b.id, "uses"]
    );

    const relsBefore = db
      .query("SELECT COUNT(*) as c FROM relations WHERE source_entity_id = ?")
      .get(a.id) as { c: number };
    expect(relsBefore.c).toBe(1);

    deleteEntity(a.id, db);

    const relsAfter = db
      .query("SELECT COUNT(*) as c FROM relations WHERE source_entity_id = ?")
      .get(a.id) as { c: number };
    expect(relsAfter.c).toBe(0);
  });

  test("cascade deletes entity_memories", () => {
    const db = getDatabase(":memory:");
    const entity = createEntity({ name: "Linked", type: "concept" }, db);

    // Create a memory to link
    const memId = shortUuid();
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, importance, source, status, pinned, access_count, version, created_at, updated_at)
       VALUES (?, 'test-key', 'test-value', 'knowledge', 'shared', 5, 'agent', 'active', 0, 0, 1, datetime('now'), datetime('now'))`,
      [memId]
    );
    db.run(
      "INSERT INTO entity_memories (entity_id, memory_id, role) VALUES (?, ?, 'context')",
      [entity.id, memId]
    );

    const linksBefore = db
      .query("SELECT COUNT(*) as c FROM entity_memories WHERE entity_id = ?")
      .get(entity.id) as { c: number };
    expect(linksBefore.c).toBe(1);

    deleteEntity(entity.id, db);

    const linksAfter = db
      .query("SELECT COUNT(*) as c FROM entity_memories WHERE entity_id = ?")
      .get(entity.id) as { c: number };
    expect(linksAfter.c).toBe(0);
  });
});

// ============================================================================
// mergeEntities
// ============================================================================

describe("mergeEntities", () => {
  test("merges source into target and deletes source", () => {
    const db = getDatabase(":memory:");
    const source = createEntity({ name: "Source", type: "tool" }, db);
    const target = createEntity({ name: "Target", type: "tool" }, db);
    const other = createEntity({ name: "Other", type: "tool" }, db);

    // Create relations from source
    db.run(
      "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type) VALUES (?, ?, ?, ?)",
      [shortUuid(), source.id, other.id, "uses"]
    );
    // Create relation to source
    db.run(
      "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type) VALUES (?, ?, ?, ?)",
      [shortUuid(), other.id, source.id, "depends_on"]
    );

    const merged = mergeEntities(source.id, target.id, db);
    expect(merged.id).toBe(target.id);

    // Source should be deleted
    expect(() => getEntity(source.id, db)).toThrow(EntityNotFoundError);

    // Relations should point to target now
    const rels = db
      .query(
        "SELECT * FROM relations WHERE source_entity_id = ? OR target_entity_id = ?"
      )
      .all(target.id, target.id) as Record<string, unknown>[];
    expect(rels).toHaveLength(2);
  });

  test("transfers entity_memories from source to target", () => {
    const db = getDatabase(":memory:");
    const source = createEntity({ name: "Src", type: "concept" }, db);
    const target = createEntity({ name: "Tgt", type: "concept" }, db);

    // Create memories
    const memId1 = shortUuid();
    const memId2 = shortUuid();
    for (const memId of [memId1, memId2]) {
      db.run(
        `INSERT INTO memories (id, key, value, category, scope, importance, source, status, pinned, access_count, version, created_at, updated_at)
         VALUES (?, ?, 'v', 'knowledge', 'shared', 5, 'agent', 'active', 0, 0, 1, datetime('now'), datetime('now'))`,
        [memId, `key-${memId}`]
      );
    }

    // Link memories to source
    db.run(
      "INSERT INTO entity_memories (entity_id, memory_id, role) VALUES (?, ?, 'subject')",
      [source.id, memId1]
    );
    db.run(
      "INSERT INTO entity_memories (entity_id, memory_id, role) VALUES (?, ?, 'context')",
      [source.id, memId2]
    );

    mergeEntities(source.id, target.id, db);

    // Memories should now be linked to target
    const links = db
      .query("SELECT * FROM entity_memories WHERE entity_id = ?")
      .all(target.id) as Record<string, unknown>[];
    expect(links).toHaveLength(2);
  });

  test("handles duplicate relation conflicts gracefully", () => {
    const db = getDatabase(":memory:");
    const source = createEntity({ name: "S", type: "tool" }, db);
    const target = createEntity({ name: "T", type: "tool" }, db);
    const other = createEntity({ name: "O", type: "tool" }, db);

    // Both source and target have a "uses" relation to other
    db.run(
      "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type) VALUES (?, ?, ?, ?)",
      [shortUuid(), source.id, other.id, "uses"]
    );
    db.run(
      "INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type) VALUES (?, ?, ?, ?)",
      [shortUuid(), target.id, other.id, "uses"]
    );

    // Should not throw — duplicate is skipped
    const merged = mergeEntities(source.id, target.id, db);
    expect(merged.id).toBe(target.id);

    // Only one "uses" relation should remain (the target's original)
    const rels = db
      .query(
        "SELECT * FROM relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = 'uses'"
      )
      .all(target.id, other.id) as Record<string, unknown>[];
    expect(rels).toHaveLength(1);
  });

  test("handles duplicate entity_memory conflicts gracefully", () => {
    const db = getDatabase(":memory:");
    const source = createEntity({ name: "S2", type: "concept" }, db);
    const target = createEntity({ name: "T2", type: "concept" }, db);

    const memId = shortUuid();
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, importance, source, status, pinned, access_count, version, created_at, updated_at)
       VALUES (?, 'k', 'v', 'knowledge', 'shared', 5, 'agent', 'active', 0, 0, 1, datetime('now'), datetime('now'))`,
      [memId]
    );

    // Both source and target linked to the same memory
    db.run(
      "INSERT INTO entity_memories (entity_id, memory_id, role) VALUES (?, ?, 'subject')",
      [source.id, memId]
    );
    db.run(
      "INSERT INTO entity_memories (entity_id, memory_id, role) VALUES (?, ?, 'subject')",
      [target.id, memId]
    );

    // Should not throw
    const merged = mergeEntities(source.id, target.id, db);
    expect(merged.id).toBe(target.id);

    // Only one link should remain
    const links = db
      .query("SELECT * FROM entity_memories WHERE entity_id = ? AND memory_id = ?")
      .all(target.id, memId) as Record<string, unknown>[];
    expect(links).toHaveLength(1);
  });

  test("throws EntityNotFoundError if source does not exist", () => {
    const target = createEntity({ name: "T3", type: "tool" });
    expect(() => mergeEntities("nonexistent", target.id)).toThrow(EntityNotFoundError);
  });

  test("throws EntityNotFoundError if target does not exist", () => {
    const source = createEntity({ name: "S3", type: "tool" });
    expect(() => mergeEntities(source.id, "nonexistent")).toThrow(EntityNotFoundError);
  });
});
