import { z } from "zod";
import { SqliteAdapter as Database } from "../storage.js";
import type { Memory } from "../types/index.js";
import { getDatabase, now, shortUuid } from "../db/database.js";
import { createMemory, listMemories } from "../db/memories.js";
import { createMemoryLink } from "../db/memory-links.js";

type SQLValue = string | number | null | boolean;

export const DEFAULT_REFLECTION_PROVIDER = "anthropic";
export const DEFAULT_REFLECTION_MODEL = "claude-fable-5";

export type ReflectionTarget = "session" | "task" | "range";
export type ReflectionLessonKind = "worked" | "failed" | "do_differently";

export interface ReflectionLessonInput {
  lesson: string;
  evidence?: string[];
  importance?: number;
}

export interface ReflectionCriticResult {
  summary: string;
  whatWorked: ReflectionLessonInput[];
  whatFailed: ReflectionLessonInput[];
  doDifferently: ReflectionLessonInput[];
}

export interface ReflectionTrajectory {
  on: ReflectionTarget;
  source?: string;
  since?: string;
  until?: string;
  memories: Memory[];
  toolEvents: Array<Record<string, unknown>>;
  text: string;
}

export type ReflectionCritic = (trajectory: ReflectionTrajectory) => Promise<ReflectionCriticResult>;

export interface ReflectionRun {
  id: string;
  on_type: ReflectionTarget;
  source: string | null;
  project_id: string | null;
  agent_id: string | null;
  dry_run: boolean;
  provider: string | null;
  model: string | null;
  status: "pending" | "running" | "completed" | "failed";
  trajectory_memory_ids: string[];
  summary: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface ReflectionLesson {
  kind: ReflectionLessonKind;
  lesson: string;
  evidence: string[];
  importance: number;
  memory_id: string | null;
}

export interface ReflectionOptions {
  on: ReflectionTarget;
  source?: string;
  dryRun?: boolean;
  projectId?: string;
  agentId?: string;
  since?: string;
  until?: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
  critic?: ReflectionCritic;
  db?: Database;
}

export interface ReflectionResult {
  run: ReflectionRun;
  dryRun: boolean;
  trajectory: {
    memoryIds: string[];
    toolEventCount: number;
    text: string;
  };
  lessons: ReflectionLesson[];
  createdMemories: Memory[];
}

const CriticSchema = z.object({
  summary: z.string().default(""),
  whatWorked: z.array(z.object({
    lesson: z.string(),
    evidence: z.array(z.string()).default([]),
    importance: z.coerce.number().min(1).max(10).default(7),
  })).default([]),
  whatFailed: z.array(z.object({
    lesson: z.string(),
    evidence: z.array(z.string()).default([]),
    importance: z.coerce.number().min(1).max(10).default(6),
  })).default([]),
  doDifferently: z.array(z.object({
    lesson: z.string(),
    evidence: z.array(z.string()).default([]),
    importance: z.coerce.number().min(1).max(10).default(8),
  })).default([]),
});

function parseRun(row: Record<string, unknown>): ReflectionRun {
  return {
    id: row["id"] as string,
    on_type: row["on_type"] as ReflectionTarget,
    source: (row["source"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    agent_id: (row["agent_id"] as string) || null,
    dry_run: !!row["dry_run"],
    provider: (row["provider"] as string) || null,
    model: (row["model"] as string) || null,
    status: row["status"] as ReflectionRun["status"],
    trajectory_memory_ids: JSON.parse((row["trajectory_memory_ids"] as string) || "[]") as string[],
    summary: (row["summary"] as string) || null,
    error: (row["error"] as string) || null,
    started_at: row["started_at"] as string,
    completed_at: (row["completed_at"] as string) || null,
  };
}

function createRun(options: ReflectionOptions, memoryIds: string[], db: Database): ReflectionRun {
  const id = shortUuid();
  db.run(
    `INSERT INTO memory_reflection_runs (id, on_type, source, project_id, agent_id, dry_run, provider, model, status, trajectory_memory_ids, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    [
      id,
      options.on,
      options.source ?? null,
      options.projectId ?? null,
      options.agentId ?? null,
      (options.dryRun ?? true) ? 1 : 0,
      options.provider ?? null,
      options.model ?? null,
      JSON.stringify(memoryIds),
      now(),
    ],
  );
  return getRun(id, db)!;
}

function getRun(id: string, db: Database): ReflectionRun | null {
  const row = db.query("SELECT * FROM memory_reflection_runs WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? parseRun(row) : null;
}

function updateRun(
  id: string,
  updates: { status?: ReflectionRun["status"]; summary?: string | null; error?: string | null; completed_at?: string | null },
  db: Database,
): ReflectionRun {
  const sets: string[] = [];
  const params: SQLValue[] = [];
  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.summary !== undefined) {
    sets.push("summary = ?");
    params.push(updates.summary);
  }
  if (updates.error !== undefined) {
    sets.push("error = ?");
    params.push(updates.error);
  }
  if (updates.completed_at !== undefined) {
    sets.push("completed_at = ?");
    params.push(updates.completed_at);
  }
  if (sets.length === 0) return getRun(id, db)!;
  params.push(id);
  db.run(`UPDATE memory_reflection_runs SET ${sets.join(", ")} WHERE id = ?`, params);
  return getRun(id, db)!;
}

function insertLessonRow(runId: string, lesson: ReflectionLesson, db: Database): void {
  db.run(
    `INSERT INTO memory_reflection_lessons (id, run_id, memory_id, kind, lesson, evidence, importance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      shortUuid(),
      runId,
      lesson.memory_id,
      lesson.kind,
      lesson.lesson,
      JSON.stringify(lesson.evidence),
      lesson.importance,
      now(),
    ],
  );
}

function listToolEventsForTrajectory(options: ReflectionOptions, db: Database): Array<Record<string, unknown>> {
  try {
    const conditions: string[] = [];
    const params: SQLValue[] = [];
    if (options.on === "session" && options.source) {
      conditions.push("session_id = ?");
      params.push(options.source);
    }
    if (options.projectId) {
      conditions.push("project_id = ?");
      params.push(options.projectId);
    }
    if (options.agentId) {
      conditions.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options.since) {
      conditions.push("created_at >= ?");
      params.push(options.since);
    }
    if (options.until) {
      conditions.push("created_at <= ?");
      params.push(options.until);
    }
    if (conditions.length === 0) return [];
    const rows = db
      .query(`SELECT * FROM tool_events WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC LIMIT 200`)
      .all(...params) as Record<string, unknown>[];
    return rows;
  } catch {
    return [];
  }
}

function parseRangeSource(source?: string): { since?: string; until?: string } {
  if (!source) return {};
  const [since, until] = source.split("..", 2);
  return { since: since || undefined, until: until || undefined };
}

function buildTrajectory(options: ReflectionOptions, db: Database): ReflectionTrajectory {
  const range = options.on === "range" ? parseRangeSource(options.source) : {};
  const since = options.since ?? range.since;
  const until = options.until ?? range.until;
  const memoryLimit = 200;

  let memories: Memory[];
  if (options.on === "session") {
    memories = listMemories({
      status: "active",
      session_id: options.source,
      project_id: options.projectId,
      agent_id: options.agentId,
      limit: memoryLimit,
    }, db);
  } else if (options.on === "task") {
    memories = listMemories({
      status: "active",
      project_id: options.projectId,
      agent_id: options.agentId,
      limit: memoryLimit,
    }, db).filter((memory) =>
      memory.session_id === options.source ||
      memory.metadata["task_id"] === options.source ||
      memory.metadata["taskId"] === options.source,
    );
  } else {
    memories = listMemories({
      status: "active",
      project_id: options.projectId,
      agent_id: options.agentId,
      limit: memoryLimit,
    }, db).filter((memory) => {
      const ts = memory.updated_at ?? memory.created_at;
      return (!since || ts >= since) && (!until || ts <= until);
    });
  }

  const toolEvents = listToolEventsForTrajectory({ ...options, since, until }, db);
  const memoryLines = memories.map((memory) =>
    `MEMORY ${memory.id} key=${memory.key} category=${memory.category} importance=${memory.importance}: ${memory.value}`,
  );
  const toolLines = toolEvents.map((event) =>
    `TOOL ${event["id"] ?? ""} ${event["tool_name"] ?? ""} success=${event["success"] ?? ""}: ${event["lesson"] ?? event["error_message"] ?? event["context"] ?? ""}`,
  );

  return {
    on: options.on,
    source: options.source,
    since,
    until,
    memories,
    toolEvents,
    text: [...memoryLines, ...toolLines].join("\n").slice(0, 40_000),
  };
}

function clampImportance(value: number | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function normalizeLessons(result: ReflectionCriticResult): ReflectionLesson[] {
  const toLesson = (kind: ReflectionLessonKind, item: ReflectionLessonInput, fallbackImportance: number): ReflectionLesson => ({
    kind,
    lesson: item.lesson.trim(),
    evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry) => typeof entry === "string") : [],
    importance: clampImportance(item.importance, fallbackImportance),
    memory_id: null,
  });

  return [
    ...(result.whatWorked ?? []).map((item) => toLesson("worked", item, 7)),
    ...(result.whatFailed ?? []).map((item) => toLesson("failed", item, 6)),
    ...(result.doDifferently ?? []).map((item) => toLesson("do_differently", item, 8)),
  ].filter((lesson) => lesson.lesson.length > 0);
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44);
  return slug || "lesson";
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function lessonTag(kind: ReflectionLessonKind): string {
  return kind === "do_differently" ? "do-differently" : kind;
}

function saveLessonMemory(
  run: ReflectionRun,
  trajectory: ReflectionTrajectory,
  lesson: ReflectionLesson,
  db: Database,
): Memory {
  const first = trajectory.memories[0];
  const sourcePart = slugify(run.source ?? `${run.on_type}-${run.started_at}`);
  const key = `reflection-${run.on_type}-${sourcePart}-${lessonTag(lesson.kind)}-${stableHash(lesson.lesson)}`;
  const memory = createMemory({
    key,
    value: lesson.lesson,
    category: "knowledge",
    scope: first?.scope ?? "shared",
    importance: lesson.importance,
    tags: ["reflection", "lesson", lessonTag(lesson.kind)],
    source: "system",
    agent_id: run.agent_id ?? first?.agent_id ?? undefined,
    project_id: run.project_id ?? first?.project_id ?? undefined,
    session_id: run.on_type === "session" ? run.source ?? undefined : first?.session_id ?? undefined,
    metadata: {
      reflection_run_id: run.id,
      reflection_kind: lesson.kind,
      source_type: run.on_type,
      source: run.source,
      source_memory_ids: trajectory.memories.map((memory) => memory.id),
      evidence: lesson.evidence,
      critic_provider: run.provider,
      critic_model: run.model,
    },
  }, "merge", db);

  for (const sourceMemory of trajectory.memories) {
    createMemoryLink({
      source_memory_id: memory.id,
      target_memory_id: sourceMemory.id,
      relation_type: "reflects_on",
      run_id: run.id,
      metadata: { kind: lesson.kind },
    }, db);
  }

  return memory;
}

export function heuristicReflectionCritic(trajectory: ReflectionTrajectory): ReflectionCriticResult {
  const text = trajectory.text.toLowerCase();
  const hasTests = /\b(test|tests|tdd|verification|verified)\b/.test(text);
  const hasParity = /\b(cli|mcp|sdk|server|parity)\b/.test(text);
  const hasFailure = /\b(fail|failed|error|wrong|regression|conflict|noise)\b/.test(text);

  return {
    summary: `Reviewed ${trajectory.memories.length} memories and ${trajectory.toolEvents.length} tool events for ${trajectory.on}${trajectory.source ? ` ${trajectory.source}` : ""}.`,
    whatWorked: [
      {
        lesson: hasTests
          ? "Using tests and verification as the session backbone made the work easier to audit."
          : "Capturing trajectory memories made the session reviewable after the fact.",
        evidence: trajectory.memories.slice(0, 3).map((memory) => memory.key),
        importance: hasTests ? 8 : 6,
      },
    ],
    whatFailed: [
      {
        lesson: hasFailure
          ? "Failure and error signals should be converted into explicit correction memories while the evidence is fresh."
          : "The trajectory did not capture concrete failure evidence, which limits critic quality.",
        evidence: trajectory.memories.slice(0, 3).map((memory) => memory.key),
        importance: hasFailure ? 7 : 5,
      },
    ],
    doDifferently: [
      {
        lesson: hasParity
          ? "For memory-layer changes, map CLI, MCP, SDK, server, and schema parity before implementation."
          : "Start future reflection-worthy work by naming the target boundary and the evidence needed to judge it.",
        evidence: trajectory.memories.slice(0, 3).map((memory) => memory.key),
        importance: hasParity ? 9 : 7,
      },
    ],
  };
}

async function resolveAISDKModel(provider: string, model: string): Promise<unknown | null> {
  if (provider === "anthropic") {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (!key) return null;
    const mod = await import("@ai-sdk/anthropic") as Record<string, unknown>;
    const anthropic = mod["anthropic"] as ((model: string) => unknown) | undefined;
    return anthropic ? anthropic(model) : null;
  }
  if (provider === "openai") {
    const key = process.env["OPENAI_API_KEY"];
    if (!key) return null;
    const mod = await import("@ai-sdk/openai") as Record<string, unknown>;
    const openai = mod["openai"] as ((model: string) => unknown) | undefined;
    return openai ? openai(model) : null;
  }
  if (provider === "cerebras" || provider === "grok") {
    const apiKey = provider === "cerebras" ? process.env["CEREBRAS_API_KEY"] : process.env["XAI_API_KEY"];
    if (!apiKey) return null;
    const baseURL = provider === "cerebras" ? "https://api.cerebras.ai/v1" : "https://api.x.ai/v1";
    const mod = await import("@ai-sdk/openai-compatible") as Record<string, unknown>;
    const createOpenAICompatible = mod["createOpenAICompatible"] as
      | ((options: { name: string; apiKey: string; baseURL: string }) => (model: string) => unknown)
      | undefined;
    if (!createOpenAICompatible) return null;
    return createOpenAICompatible({ name: provider, apiKey, baseURL })(model);
  }
  return null;
}

export function createAISDKReflectionCritic(options: {
  provider?: string;
  model?: string;
  maxTokens?: number;
} = {}): ReflectionCritic {
  return async (trajectory) => {
    const provider = options.provider ?? process.env["MEMENTOS_REFLECT_PROVIDER"] ?? DEFAULT_REFLECTION_PROVIDER;
    const model = options.model ?? process.env["MEMENTOS_REFLECT_MODEL"] ?? DEFAULT_REFLECTION_MODEL;
    const resolvedModel = await resolveAISDKModel(provider, model);
    if (!resolvedModel) return heuristicReflectionCritic(trajectory);

    try {
      const ai = await import("ai") as Record<string, unknown>;
      const generateObject = ai["generateObject"] as ((args: Record<string, unknown>) => Promise<{ object: unknown }>) | undefined;
      if (!generateObject) return heuristicReflectionCritic(trajectory);

      const prompt = `Reflect on this agent trajectory and extract durable lessons.

Target: ${trajectory.on}
Source: ${trajectory.source ?? "(range)"}
Since: ${trajectory.since ?? "(unset)"}
Until: ${trajectory.until ?? "(unset)"}

Trajectory:
${trajectory.text || "(no trajectory text)"}

Return concise lessons. Each lesson must be actionable, evidence-backed, and useful to future agents.`;

      const response = await generateObject({
        model: resolvedModel,
        schema: CriticSchema,
        system: "You are an LLM-judge critic for an agent memory system. Extract what worked, what failed, and what to do differently. Prefer specific durable lessons over summaries.",
        prompt,
        temperature: 0,
        maxOutputTokens: options.maxTokens ?? 1200,
      });

      return CriticSchema.parse(response.object);
    } catch {
      return heuristicReflectionCritic(trajectory);
    }
  };
}

export async function reflectOnTrajectory(options: ReflectionOptions): Promise<ReflectionResult> {
  const db = options.db || getDatabase();
  const dryRun = options.dryRun ?? false;
  const provider = options.provider ?? process.env["MEMENTOS_REFLECT_PROVIDER"] ?? DEFAULT_REFLECTION_PROVIDER;
  const model = options.model ?? process.env["MEMENTOS_REFLECT_MODEL"] ?? DEFAULT_REFLECTION_MODEL;
  const trajectory = buildTrajectory(options, db);
  let run = createRun({ ...options, dryRun, provider, model }, trajectory.memories.map((memory) => memory.id), db);

  try {
    const critic = options.critic ?? createAISDKReflectionCritic({ provider, model, maxTokens: options.maxTokens });
    const criticResult = await critic(trajectory);
    const lessons = normalizeLessons(criticResult);
    const createdMemories: Memory[] = [];

    if (!dryRun) {
      db.transaction(() => {
        for (let i = 0; i < lessons.length; i++) {
          const memory = saveLessonMemory(run, trajectory, lessons[i]!, db);
          lessons[i] = { ...lessons[i]!, memory_id: memory.id };
          insertLessonRow(run.id, lessons[i]!, db);
          createdMemories.push(memory);
        }
      });
    }

    run = updateRun(run.id, { status: "completed", summary: criticResult.summary, completed_at: now() }, db);
    return {
      run,
      dryRun,
      trajectory: {
        memoryIds: trajectory.memories.map((memory) => memory.id),
        toolEventCount: trajectory.toolEvents.length,
        text: trajectory.text,
      },
      lessons,
      createdMemories,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run = updateRun(run.id, { status: "failed", error: message, completed_at: now() }, db);
    return {
      run,
      dryRun,
      trajectory: {
        memoryIds: trajectory.memories.map((memory) => memory.id),
        toolEventCount: trajectory.toolEvents.length,
        text: trajectory.text,
      },
      lessons: [],
      createdMemories: [],
    };
  }
}
