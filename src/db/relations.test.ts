import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { shortUuid, now } from "./database.js";
import {
  createRelation,
  getRelation,
  listRelations,
  deleteRelation,
  getRelatedEntities,
  getEntityGraph,
  findPath,
  parseRelationRow,
} from "./relations.js";
import type { Entity } from "../types/index.js";

let db: Database;

function freshDb(): Database {
  const d = new Database(":memory:", { create: true });
  d.run("PRAGMA journal_mode = WAL");
  d.run("PRAGMA busy_timeout = 5000");
  d.run("PRAGMA foreign_keys = ON");

  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT UNIQUE NOT NULL,
      description TEXT,
      memory_prefix TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('person','project','tool','concept','file','api','pattern','organization')),
      description TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_unique_name ON entities(name, type, COALESCE(project_id, ''));
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL CHECK (relation_type IN ('uses','knows','depends_on','created_by','related_to','contradicts','part_of','implements')),
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_entity_id, target_entity_id, relation_type),
      FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
  `);
  return d;
}

function createTestEntity(name: string, type: string = "concept", projectId?: string): Entity {
  const id = shortUuid();
  const timestamp = now();
  db.run(
    `INSERT INTO entities (id, name, type, description, metadata, project_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, '{}', ?, ?, ?)`,
    [id, name, type, projectId ?? null, timestamp, timestamp]
  );
  return {
    id,
    name,
    type: type as Entity["type"],
    description: null,
    metadata: {},
    project_id: projectId ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

let entityA: Entity;
let entityB: Entity;
let entityC: Entity;
let entityD: Entity;
let entityE: Entity;

beforeEach(() => {
  db = freshDb();
  entityA = createTestEntity("alpha", "concept");
  entityB = createTestEntity("beta", "tool");
  entityC = createTestEntity("gamma", "person");
  entityD = createTestEntity("delta", "project");
  entityE = createTestEntity("epsilon", "api");
});

describe("createRelation", () => {
  test("creates relation with correct fields", () => {
    const rel = createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "uses" }, db);
    expect(rel.id).toHaveLength(8);
    expect(rel.source_entity_id).toBe(entityA.id);
    expect(rel.target_entity_id).toBe(entityB.id);
    expect(rel.relation_type).toBe("uses");
    expect(rel.weight).toBe(1.0);
    expect(rel.metadata).toEqual({});
    expect(rel.created_at).toBeTruthy();
  });

  test("creates relation with custom weight and metadata", () => {
    const rel = createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "depends_on", weight: 0.8, metadata: { reason: "critical" } }, db);
    expect(rel.weight).toBe(0.8);
    expect(rel.metadata).toEqual({ reason: "critical" });
  });

  test("upsert — same source+target+type updates weight", () => {
    const first = createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "uses", weight: 1.0 }, db);
    const second = createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "uses", weight: 5.0, metadata: { updated: true } }, db);
    expect(second.id).toBe(first.id);
    expect(second.weight).toBe(5.0);
    expect(second.metadata).toEqual({ updated: true });
  });
});

describe("getRelation", () => {
  test("retrieves by id", () => {
    const created = createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "knows" }, db);
    const fetched = getRelation(created.id, db);
    expect(fetched.id).toBe(created.id);
    expect(fetched.relation_type).toBe("knows");
  });

  test("throws for non-existent id", () => {
    expect(() => getRelation("nonexist", db)).toThrow("Relation not found");
  });
});

describe("listRelations", () => {
  beforeEach(() => {
    createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "uses" }, db);
    createRelation({ source_entity_id: entityB.id, target_entity_id: entityA.id, relation_type: "knows" }, db);
    createRelation({ source_entity_id: entityC.id, target_entity_id: entityA.id, relation_type: "uses" }, db);
  });

  test("list by entity_id outgoing", () => {
    const rels = listRelations({ entity_id: entityA.id, direction: "outgoing" }, db);
    expect(rels).toHaveLength(1);
    expect(rels[0]!.target_entity_id).toBe(entityB.id);
  });

  test("list by entity_id incoming", () => {
    const rels = listRelations({ entity_id: entityA.id, direction: "incoming" }, db);
    expect(rels).toHaveLength(2);
  });

  test("list by entity_id both (default)", () => {
    const rels = listRelations({ entity_id: entityA.id }, db);
    expect(rels).toHaveLength(3);
  });

  test("list by relation_type", () => {
    const rels = listRelations({ relation_type: "uses" }, db);
    expect(rels).toHaveLength(2);
  });

  test("list by entity_id and relation_type", () => {
    const rels = listRelations({ entity_id: entityA.id, relation_type: "uses", direction: "both" }, db);
    expect(rels).toHaveLength(2);
  });
});

describe("deleteRelation", () => {
  test("deletes existing relation", () => {
    const rel = createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "uses" }, db);
    deleteRelation(rel.id, db);
    expect(() => getRelation(rel.id, db)).toThrow("Relation not found");
  });

  test("throws for non-existent id", () => {
    expect(() => deleteRelation("nonexist", db)).toThrow("Relation not found");
  });
});

describe("getRelatedEntities", () => {
  beforeEach(() => {
    createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "uses" }, db);
    createRelation({ source_entity_id: entityA.id, target_entity_id: entityE.id, relation_type: "related_to" }, db);
    createRelation({ source_entity_id: entityC.id, target_entity_id: entityA.id, relation_type: "knows" }, db);
  });

  test("returns all direct neighbors", () => {
    const neighbors = getRelatedEntities(entityA.id, undefined, db);
    const names = neighbors.map((e) => e.name).sort();
    expect(names).toEqual(["beta", "epsilon", "gamma"]);
  });

  test("filters by relation type", () => {
    const neighbors = getRelatedEntities(entityA.id, "uses", db);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]!.name).toBe("beta");
  });

  test("returns empty for isolated entity", () => {
    const neighbors = getRelatedEntities(entityD.id, undefined, db);
    expect(neighbors).toHaveLength(0);
  });
});

describe("getEntityGraph", () => {
  beforeEach(() => {
    createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "uses" }, db);
    createRelation({ source_entity_id: entityB.id, target_entity_id: entityC.id, relation_type: "depends_on" }, db);
    createRelation({ source_entity_id: entityC.id, target_entity_id: entityD.id, relation_type: "related_to" }, db);
    createRelation({ source_entity_id: entityA.id, target_entity_id: entityE.id, relation_type: "knows" }, db);
  });

  test("depth 1 — returns direct neighbors", () => {
    const graph = getEntityGraph(entityA.id, 1, db);
    const names = graph.entities.map((e) => e.name).sort();
    expect(names).toEqual(["alpha", "beta", "epsilon"]);
    expect(graph.relations.length).toBeGreaterThanOrEqual(2);
  });

  test("depth 2 — includes 2-hop neighbors", () => {
    const graph = getEntityGraph(entityA.id, 2, db);
    const names = graph.entities.map((e) => e.name).sort();
    expect(names).toEqual(["alpha", "beta", "epsilon", "gamma"]);
    expect(graph.relations.length).toBeGreaterThanOrEqual(3);
  });

  test("depth 3 — includes full chain A->B->C->D", () => {
    const graph = getEntityGraph(entityA.id, 3, db);
    const names = graph.entities.map((e) => e.name).sort();
    expect(names).toEqual(["alpha", "beta", "delta", "epsilon", "gamma"]);
  });

  test("traverses both directions", () => {
    // D is 3 hops from A, and E is 4 hops from D (D->C->B->A->E), so use depth 4
    const graph = getEntityGraph(entityD.id, 4, db);
    const names = graph.entities.map((e) => e.name).sort();
    expect(names).toEqual(["alpha", "beta", "delta", "epsilon", "gamma"]);
  });
});

describe("findPath", () => {
  beforeEach(() => {
    createRelation({ source_entity_id: entityA.id, target_entity_id: entityB.id, relation_type: "uses" }, db);
    createRelation({ source_entity_id: entityB.id, target_entity_id: entityC.id, relation_type: "depends_on" }, db);
    createRelation({ source_entity_id: entityC.id, target_entity_id: entityD.id, relation_type: "related_to" }, db);
    createRelation({ source_entity_id: entityA.id, target_entity_id: entityE.id, relation_type: "knows" }, db);
  });

  test("direct connection (1 hop)", () => {
    const path = findPath(entityA.id, entityB.id, 5, db);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(2);
    expect(path![0]!.name).toBe("alpha");
    expect(path![1]!.name).toBe("beta");
  });

  test("2-hop path", () => {
    const path = findPath(entityA.id, entityC.id, 5, db);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(3);
    expect(path![0]!.name).toBe("alpha");
    expect(path![1]!.name).toBe("beta");
    expect(path![2]!.name).toBe("gamma");
  });

  test("3-hop path", () => {
    const path = findPath(entityA.id, entityD.id, 5, db);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(4);
    expect(path![0]!.name).toBe("alpha");
    expect(path![3]!.name).toBe("delta");
  });

  test("reverse direction path", () => {
    const path = findPath(entityD.id, entityA.id, 5, db);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(4);
    expect(path![0]!.name).toBe("delta");
    expect(path![3]!.name).toBe("alpha");
  });

  test("no path returns null", () => {
    const isolated = createTestEntity("isolated", "concept");
    const path = findPath(entityA.id, isolated.id, 5, db);
    expect(path).toBeNull();
  });

  test("respects maxDepth", () => {
    const path = findPath(entityA.id, entityD.id, 2, db);
    expect(path).toBeNull();
  });

  test("same entity returns self", () => {
    const path = findPath(entityA.id, entityA.id, 5, db);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(1);
    expect(path![0]!.name).toBe("alpha");
  });
});

describe("parseRelationRow", () => {
  test("parses raw row into Relation", () => {
    const raw = {
      id: "abc12345",
      source_entity_id: "src1",
      target_entity_id: "tgt1",
      relation_type: "uses",
      weight: 2.5,
      metadata: '{"foo":"bar"}',
      created_at: "2025-01-01T00:00:00.000Z",
    };
    const rel = parseRelationRow(raw);
    expect(rel.id).toBe("abc12345");
    expect(rel.weight).toBe(2.5);
    expect(rel.metadata).toEqual({ foo: "bar" });
  });
});
