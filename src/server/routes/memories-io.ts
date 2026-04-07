import { createMemory, listMemories } from "../../db/memories.js";
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
