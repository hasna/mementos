import { createEntity, getEntity, listEntities, updateEntity, deleteEntity, mergeEntities } from "../../db/entities.js";
import { createRelation, getRelation, listRelations, deleteRelation, getEntityGraph, findPath } from "../../db/relations.js";
import { linkEntityToMemory, unlinkEntityFromMemory, getMemoriesForEntity } from "../../db/entity-memories.js";
import { getDatabase } from "../../db/database.js";
import {
  EntityNotFoundError,
} from "../../types/index.js";
import type {
  EntityType,
  CreateEntityInput,
  UpdateEntityInput,
  CreateRelationInput,
  RelationType,
  EntityRole,
} from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson, getSearchParams } from "../helpers.js";

// GET /api/entities — list entities
addRoute("GET", "/api/entities", (_req: Request, url: URL) => {
  const q = getSearchParams(url);
  const filter: { type?: EntityType; project_id?: string; search?: string; limit?: number; offset?: number } = {};

  if (q["type"]) filter.type = q["type"] as EntityType;
  if (q["project_id"]) filter.project_id = q["project_id"];
  if (q["search"]) filter.search = q["search"];
  if (q["limit"]) filter.limit = parseInt(q["limit"], 10);
  if (q["offset"]) filter.offset = parseInt(q["offset"], 10);

  const entities = listEntities(filter);
  if (q["fields"]) {
    const fields = q["fields"].split(",").map((f: string) => f.trim());
    const filtered = entities.map(e => Object.fromEntries(fields.map((f: string) => [f, (e as unknown as Record<string, unknown>)[f]]).filter(([, v]) => v !== undefined)));
    return json({ entities: filtered, count: filtered.length });
  }
  return json({ entities, count: entities.length });
});

// POST /api/entities/merge — merge entities (must be before :id routes)
addRoute("POST", "/api/entities/merge", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["source_id"] || !body["target_id"]) {
    return errorResponse("Missing required fields: source_id, target_id", 400);
  }

  try {
    const merged = mergeEntities(body["source_id"] as string, body["target_id"] as string);
    return json(merged);
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// POST /api/entities — create entity
addRoute("POST", "/api/entities", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["name"] || !body["type"]) {
    return errorResponse("Missing required fields: name, type", 400);
  }

  try {
    const entity = createEntity(body as unknown as CreateEntityInput);
    return json(entity, 201);
  } catch (e) {
    throw e;
  }
});

// GET /api/entities/:id/memories — get memories linked to entity
addRoute("GET", "/api/entities/:id/memories", (_req, _url, params) => {
  try {
    getEntity(params["id"]!); // verify entity exists
    const memories = getMemoriesForEntity(params["id"]!);
    return json({ memories, count: memories.length });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// POST /api/entities/:id/memories — link memory to entity
addRoute("POST", "/api/entities/:id/memories", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["memory_id"]) {
    return errorResponse("Missing required field: memory_id", 400);
  }

  try {
    const link = linkEntityToMemory(
      params["id"]!,
      body["memory_id"] as string,
      (body["role"] as EntityRole | undefined) || undefined
    );
    return json(link, 201);
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// GET /api/entities/:id/relations — list relations for entity
addRoute("GET", "/api/entities/:id/relations", (_req, url, params) => {
  const q = getSearchParams(url);
  try {
    getEntity(params["id"]!); // verify entity exists
    const relations = listRelations({
      entity_id: params["id"]!,
      relation_type: q["type"] as RelationType | undefined,
      direction: q["direction"] as "outgoing" | "incoming" | "both" | undefined,
    });
    return json({ relations, count: relations.length });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// DELETE /api/entities/:entityId/memories/:memoryId — unlink memory from entity
addRoute("DELETE", "/api/entities/:entityId/memories/:memoryId", (_req, _url, params) => {
  unlinkEntityFromMemory(params["entityId"]!, params["memoryId"]!);
  return json({ deleted: true });
});

// GET /api/entities/:id — get entity with relations + memories
addRoute("GET", "/api/entities/:id", (_req, _url, params) => {
  try {
    const entity = getEntity(params["id"]!);
    const relations = listRelations({ entity_id: params["id"]! });
    const memories = getMemoriesForEntity(params["id"]!);
    return json({ ...entity, relations, memories });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// PATCH /api/entities/:id — update entity
addRoute("PATCH", "/api/entities/:id", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) {
    return errorResponse("Invalid JSON body", 400);
  }

  try {
    const entity = updateEntity(params["id"]!, body as unknown as UpdateEntityInput);
    return json(entity);
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// DELETE /api/entities/:id — delete entity (cascade)
addRoute("DELETE", "/api/entities/:id", (_req, _url, params) => {
  try {
    deleteEntity(params["id"]!);
    return json({ deleted: true });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// POST /api/relations — create relation
addRoute("POST", "/api/relations", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !body["source_entity_id"] || !body["target_entity_id"] || !body["relation_type"]) {
    return errorResponse("Missing required fields: source_entity_id, target_entity_id, relation_type", 400);
  }

  try {
    const relation = createRelation(body as unknown as CreateRelationInput);
    return json(relation, 201);
  } catch (e) {
    throw e;
  }
});

// GET /api/relations/:id — get relation
addRoute("GET", "/api/relations/:id", (_req, _url, params) => {
  try {
    const relation = getRelation(params["id"]!);
    return json(relation);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Relation not found")) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// DELETE /api/relations/:id — delete relation
addRoute("DELETE", "/api/relations/:id", (_req, _url, params) => {
  try {
    deleteRelation(params["id"]!);
    return json({ deleted: true });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Relation not found")) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// GET /api/graph/path — find path between entities
addRoute("GET", "/api/graph/path", (_req, url) => {
  const q = getSearchParams(url);
  if (!q["from"] || !q["to"]) {
    return errorResponse("Missing required query params: from, to", 400);
  }

  const maxDepth = q["max_depth"] ? parseInt(q["max_depth"], 10) : 5;

  try {
    const path = findPath(q["from"], q["to"], maxDepth);
    if (!path) {
      return json({ path: null, found: false });
    }
    return json({ path, found: true, length: path.length });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});

// GET /api/graph/stats — entity/relation counts by type
addRoute("GET", "/api/graph/stats", () => {
  const db = getDatabase();

  const entityCount = (
    db.query("SELECT COUNT(*) as c FROM entities").get() as { c: number }
  ).c;
  const relationCount = (
    db.query("SELECT COUNT(*) as c FROM relations").get() as { c: number }
  ).c;
  const entitiesByType = db
    .query("SELECT type, COUNT(*) as c FROM entities GROUP BY type")
    .all() as { type: string; c: number }[];
  const relationsByType = db
    .query("SELECT relation_type, COUNT(*) as c FROM relations GROUP BY relation_type")
    .all() as { relation_type: string; c: number }[];

  return json({
    entities: {
      total: entityCount,
      by_type: Object.fromEntries(entitiesByType.map((r) => [r.type, r.c])),
    },
    relations: {
      total: relationCount,
      by_type: Object.fromEntries(relationsByType.map((r) => [r.relation_type, r.c])),
    },
  });
});

// GET /api/graph/:entityId — get connected graph
addRoute("GET", "/api/graph/:entityId", (_req, url, params) => {
  const q = getSearchParams(url);
  const depth = q["depth"] ? parseInt(q["depth"], 10) : 2;

  try {
    const graph = getEntityGraph(params["entityId"]!, depth);
    return json(graph);
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return errorResponse(e.message, 404);
    }
    throw e;
  }
});
