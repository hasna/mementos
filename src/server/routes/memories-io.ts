import { createMemory, listMemories, bulkUpsertMemories } from "../../db/memories.js";
import type { MemoryScope, MemoryCategory, MemoryFilter, CreateMemoryInput } from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson } from "../helpers.js";

// POST /api/memories/export — export memories
addRoute("POST", "/api/memories/export", async (req) => {
  const body = ((await readJson(req)) as Record<string, unknown>) || {};
  const filter: MemoryFilter = {};

  if (body["scope"]) filter.scope = body["scope"] as MemoryScope;
  if (body["category"]) filter.category = body["category"] as MemoryCategory;
  if (body["agent_id"]) filter.agent_id = body["agent_id"] as string;
  if (body["project_id"]) filter.project_id = body["project_id"] as string;
  if (body["tags"]) filter.tags = body["tags"] as string[];
  filter.limit = (body["limit"] as number) || 10000;

  const memories = listMemories(filter);
  return json({ memories, count: memories.length });
});

// POST /api/memories/import — import memories
addRoute("POST", "/api/memories/import", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body["memories"])) {
    return errorResponse("Missing required field: memories (array)", 400);
  }

  const overwrite = body["overwrite"] !== false;
  const dedupeMode = overwrite ? ("merge" as const) : ("create" as const);
  const memoriesArr = body["memories"] as Record<string, unknown>[];
  let imported = 0;
  const errors: string[] = [];

  for (const mem of memoriesArr) {
    try {
      createMemory(
        {
          ...mem,
          source: (mem["source"] as string) || "imported",
        } as CreateMemoryInput,
        dedupeMode
      );
      imported++;
    } catch (e) {
      errors.push(
        `Failed to import "${mem["key"]}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return json({ imported, errors, total: memoriesArr.length }, 201);
});

// POST /api/memories/bulk-upsert — faithful, idempotent bulk restore.
// Preserves each memory's original id + status (archived stays archived) and
// all core fields; upserts with ON CONFLICT DO NOTHING so re-runs never create
// duplicate rows and existing rows are never mutated.
// This is the cross-machine -> cloud backfill path for the fleet self-host cutover.
//
// Fails closed: a row the store refused did not persist, so the response must
// not read as success. `rejected` counts those rows (separately from `skipped`,
// which is an already-present no-op) and each has a line in `errors`; any
// rejection downgrades the status from 201 to 400. The write is idempotent, so
// an operator fixes the offending rows and re-runs the same payload.
addRoute("POST", "/api/memories/bulk-upsert", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body["memories"])) {
    return errorResponse("Missing required field: memories (array)", 400);
  }

  const memoriesArr = body["memories"] as Record<string, unknown>[];
  const result = bulkUpsertMemories(memoriesArr);

  if (result.rejected > 0) {
    return json(
      {
        ...result,
        error: `${result.rejected} of ${result.total} memories were rejected and did not persist. See errors.`,
      },
      400
    );
  }

  return json(result, 201);
});
