import { getMemory, updateMemory, deleteMemory } from "../../db/memories.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson } from "../helpers.js";

// POST /api/memories/bulk-forget — delete multiple memories
addRoute("POST", "/api/memories/bulk-forget", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body["ids"])) {
    return errorResponse("Missing required field: ids (array)", 400);
  }
  const ids = body["ids"] as string[];
  let deleted = 0;
  for (const id of ids) {
    try {
      if (deleteMemory(id)) deleted++;
    } catch { /* skip not found */ }
  }
  return json({ deleted, total: ids.length });
});

// POST /api/memories/bulk-update — update multiple memories with same changes
addRoute("POST", "/api/memories/bulk-update", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body["ids"])) {
    return errorResponse("Missing required fields: ids (array)", 400);
  }
  const ids = body["ids"] as string[];
  const { ids: _ids, ...fields } = body as Record<string, unknown>;

  let updated = 0;
  const errors: string[] = [];
  for (const id of ids) {
    try {
      const memory = getMemory(id);
      if (memory) {
        updateMemory(id, { ...(fields as Record<string, unknown>), version: memory.version } as Parameters<typeof updateMemory>[1]);
        updated++;
      } else {
        errors.push(`Memory not found: ${id}`);
      }
    } catch (e) {
      errors.push(`Failed ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return json({ updated, errors, total: ids.length });
});
