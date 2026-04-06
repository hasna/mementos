import { getDatabase, resolvePartialId } from "../../db/database.js";
import { getEntity, getEntityByName } from "../../db/entities.js";
import type { Entity, EntityType } from "../../types/index.js";

export function formatGraphError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveGraphId(partialId: string, table = "memories"): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) throw new Error(`Could not resolve ID: ${partialId}`);
  return id;
}

export function resolveEntityParam(nameOrId: string, type?: string): Entity {
  const byName = getEntityByName(nameOrId, type as EntityType | undefined);
  if (byName) return byName;
  try { return getEntity(nameOrId); } catch { /* not found */ }
  const db = getDatabase();
  const id = resolvePartialId(db, "entities", nameOrId);
  if (id) return getEntity(id);
  throw new Error(`Entity not found: ${nameOrId}`);
}
