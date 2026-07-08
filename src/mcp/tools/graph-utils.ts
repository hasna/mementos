import { getDatabase, resolvePartialId } from "../../db/database.js";
import { isApiMode } from "../../db/api-mode.js";
import { getEntity, getEntityByName } from "../../db/entities.js";
import type { Entity, EntityType } from "../../types/index.js";

export function formatGraphError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveGraphId(partialId: string, table = "memories"): string {
  // Cloud path: no local table to prefix-match against, so trust the caller's id
  // as-is (cloud list/search/save return full UUIDs); the server validates it.
  if (isApiMode()) return partialId;
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) throw new Error(`Could not resolve ID: ${partialId}`);
  return id;
}

export function resolveEntityParam(nameOrId: string, type?: string): Entity {
  const byName = getEntityByName(nameOrId, type as EntityType | undefined);
  if (byName) return byName;
  try { return getEntity(nameOrId); } catch { /* not found */ }
  // In API mode getEntityByName/getEntity are the only routes; there is no local
  // table to prefix-match a partial id against, so fail clearly instead of
  // opening sqlite on the client.
  if (!isApiMode()) {
    const db = getDatabase();
    const id = resolvePartialId(db, "entities", nameOrId);
    if (id) return getEntity(id);
  }
  throw new Error(`Entity not found: ${nameOrId}`);
}
