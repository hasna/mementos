import { listMemories, createMemory, cleanExpiredMemories, touchMemory, getMemoryBriefing, listLowTrustMemories } from "../../db/memories.js";
import { getDbPath, loadConfig } from "../../lib/config.js";
import { runCleanup } from "../../lib/retention.js";
import {
  resolveVisibleMachineId,
  visibleToMachineFilter,
} from "../../lib/machine-visibility.js";
import type { Memory, MemoryCategory, CreateMemoryInput } from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, readJson, errorResponse, getSearchParams } from "../helpers.js";

// GET /api/health — simple health
addRoute("GET", "/api/health", () => {
  return json({ ok: true, version: "1", db: getDbPath() });
});

// GET /api/memories/briefing — delta briefing (new/updated/expired since a ts).
// The client sends its own resolved machine visibility so cross-machine callers
// see machine-agnostic + their-own-machine memories, never the server's.
addRoute("GET", "/api/memories/briefing", (_req, url) => {
  const q = getSearchParams(url);
  const since = q["since"];
  if (!since) return errorResponse("Missing required field: since", 400);
  let visibleMachineId: string | null | undefined;
  if (q["machine_agnostic"] === "true") visibleMachineId = null;
  else if (q["visible_machine_id"]) visibleMachineId = q["visible_machine_id"];
  const result = getMemoryBriefing({
    since,
    scope: q["scope"] || undefined,
    project_id: q["project_id"] || undefined,
    visible_machine_id: visibleMachineId,
    limit: q["limit"] ? parseInt(q["limit"], 10) : undefined,
  });
  return json(result);
});

// GET /api/memories/audit — low-trust memories for poisoning review
addRoute("GET", "/api/memories/audit", (_req, url) => {
  const q = getSearchParams(url);
  const memories = listLowTrustMemories({
    threshold: q["threshold"] ? parseFloat(q["threshold"]) : undefined,
    project_id: q["project_id"] || undefined,
    limit: q["limit"] ? parseInt(q["limit"], 10) : undefined,
    offset: q["offset"] ? parseInt(q["offset"], 10) : undefined,
  });
  return json({ memories, count: memories.length });
});

// POST /api/memories/extract — extract memories from a session summary
addRoute("POST", "/api/memories/extract", async (req) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const sessionId = body["session_id"] as string | undefined;
  const agentId = body["agent_id"] as string | undefined;
  const projectId = body["project_id"] as string | undefined;
  const title = body["title"] as string | undefined;
  const project = body["project"] as string | undefined;
  const model = body["model"] as string | undefined;
  const messages = body["messages"] as number | undefined;
  const keyTopics = Array.isArray(body["key_topics"]) ? (body["key_topics"] as string[]) : [];
  const summary = body["summary"] as string | undefined;
  const extraMemories = Array.isArray(body["memories"]) ? (body["memories"] as Record<string, unknown>[]) : [];

  const created: string[] = [];
  const errors: string[] = [];

  function saveExtracted(key: string, value: string, category: MemoryCategory, importance: number): void {
    try {
      const mem = createMemory({
        key,
        value,
        category,
        scope: "shared",
        importance,
        source: "auto",
        agent_id: agentId,
        project_id: projectId,
        session_id: sessionId,
      });
      created.push(mem.id);
    } catch (e) {
      errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Extract session title as a history memory
  if (title && sessionId) {
    const meta = [
      `title: ${title}`,
      project ? `project: ${project}` : null,
      model ? `model: ${model}` : null,
      messages ? `messages: ${messages}` : null,
    ].filter(Boolean).join(", ");
    saveExtracted(`session-${sessionId}-summary`, `${title} (${meta})`, "history", 6);
  }

  // Extract key topics as knowledge memories
  if (keyTopics.length > 0 && sessionId) {
    saveExtracted(
      `session-${sessionId}-topics`,
      `Key topics: ${keyTopics.join(", ")}`,
      "knowledge",
      5
    );
  }

  // Extract free-form summary text
  if (summary && sessionId) {
    saveExtracted(`session-${sessionId}-notes`, summary, "knowledge", 7);
  }

  // Extract any additional memories passed explicitly
  for (const mem of extraMemories) {
    if (!mem["key"] || !mem["value"]) continue;
    try {
      const created_mem = createMemory({
        ...(mem as Record<string, unknown>),
        source: "auto",
        agent_id: agentId,
        project_id: projectId,
        session_id: sessionId,
      } as CreateMemoryInput);
      created.push(created_mem.id);
    } catch (e) {
      errors.push(`${String(mem["key"])}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return json({ created: created.length, memory_ids: created, errors, session_id: sessionId }, 201);
});

// POST /api/memories/clean — cleanup expired (legacy: expired-only, kept stable)
addRoute("POST", "/api/memories/clean", () => {
  const cleaned = cleanExpiredMemories();
  return json({ cleaned });
});

// POST /api/maintenance/cleanup — full retention sweep against the shared cloud
// store: remove expired, enforce per-scope quotas, archive stale/unused, and
// deprioritize stale memories. This is the server-side execution of the client
// `mementos clean` command in API mode (no local SQLite island). Runs against
// the server's own config + cloud Postgres via runCleanup().
addRoute("POST", "/api/maintenance/cleanup", () => {
  const result = runCleanup(loadConfig());
  return json(result);
});

// GET /api/inject — get injection context
addRoute("GET", "/api/inject", (_req, url) => {
  const q = getSearchParams(url);
  const maxTokens = q["max_tokens"] ? parseInt(q["max_tokens"], 10) : 500;
  const minImportance = 3;
  const categories: MemoryCategory[] = [
    "preference",
    "fact",
    "knowledge",
  ];
  const visibleMachineId = resolveVisibleMachineId(q["machine_id"]);

  // Collect memories from all visible scopes
  const allMemories: Memory[] = [];

  // Global memories
  const globalMems = listMemories({
    scope: "global",
    category: categories,
    min_importance: minImportance,
    status: "active",
    project_id: q["project_id"],
    ...visibleToMachineFilter(visibleMachineId),
    limit: 50,
  });
  allMemories.push(...globalMems);

  // Shared memories (project-scoped)
  if (q["project_id"]) {
    const sharedMems = listMemories({
      scope: "shared",
      category: categories,
      min_importance: minImportance,
      status: "active",
      project_id: q["project_id"],
      ...visibleToMachineFilter(visibleMachineId),
      limit: 50,
    });
    allMemories.push(...sharedMems);
  }

  // Private memories (agent-scoped)
  if (q["agent_id"]) {
    const privateMems = listMemories({
      scope: "private",
      category: categories,
      min_importance: minImportance,
      status: "active",
      agent_id: q["agent_id"],
      ...visibleToMachineFilter(visibleMachineId),
      limit: 50,
    });
    allMemories.push(...privateMems);
  }

  // Deduplicate by ID
  const seen = new Set<string>();
  const unique = allMemories.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Sort by importance DESC, then recency
  unique.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return (
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  });

  // Build context within token budget (~4 chars per token estimate)
  const charBudget = maxTokens * 4;
  const lines: string[] = [];
  let totalChars = 0;

  const format = q["format"] || "xml"; // xml | markdown | compact | json

  for (const m of unique) {
    let line: string;
    if (format === "compact") {
      line = `${m.key}: ${m.value}`;
    } else if (format === "json") {
      line = JSON.stringify({ key: m.key, value: m.value, scope: m.scope, category: m.category, importance: m.importance });
    } else {
      // xml (default) and markdown use same line format
      line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
    }
    if (totalChars + line.length > charBudget) break;
    lines.push(line);
    totalChars += line.length;
    touchMemory(m.id);
  }

  if (lines.length === 0) {
    return json({ context: "", memories_count: 0 });
  }

  let context: string;
  if (format === "compact") {
    context = lines.join("\n");
  } else if (format === "json") {
    context = `[${lines.join(",")}]`;
  } else if (format === "markdown") {
    context = `## Agent Memories\n\n${lines.join("\n")}`;
  } else {
    context = `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;
  }
  return json({ context, memories_count: lines.length });
});
