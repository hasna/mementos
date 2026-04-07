import { listMemories, createMemory, cleanExpiredMemories, touchMemory } from "../../db/memories.js";
import { getDbPath } from "../../lib/config.js";
import type { Memory, MemoryCategory, CreateMemoryInput } from "../../types/index.js";
import { addRoute } from "../router.js";
import { json, readJson, getSearchParams } from "../helpers.js";

// GET /api/health — simple health
addRoute("GET", "/api/health", () => {
  return json({ ok: true, version: "1", db: getDbPath() });
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

// POST /api/memories/clean — cleanup expired
addRoute("POST", "/api/memories/clean", () => {
  const cleaned = cleanExpiredMemories();
  return json({ cleaned });
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

  // Collect memories from all visible scopes
  const allMemories: Memory[] = [];

  // Global memories
  const globalMems = listMemories({
    scope: "global",
    category: categories,
    min_importance: minImportance,
    status: "active",
    project_id: q["project_id"],
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
