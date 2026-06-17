import { SqliteAdapter as Database } from "../storage.js";
import type { Memory, MemoryScope } from "../types/index.js";
import { getDatabase, now, shortUuid } from "../db/database.js";
import { createMemory, getMemory, listMemories, updateMemory } from "../db/memories.js";
import { createMemoryLink } from "../db/memory-links.js";
import { computeDecayScore } from "./decay.js";

type SQLValue = string | number | null | boolean;

export type ConsolidationActionType =
  | "merge_duplicate"
  | "promote_semantic"
  | "summarize_cluster"
  | "decay_forget";

export interface ConsolidationRun {
  id: string;
  scope: string | null;
  project_id: string | null;
  agent_id: string | null;
  dry_run: boolean;
  status: "pending" | "running" | "completed" | "failed";
  summary: Record<string, unknown>;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface ConsolidationAction {
  id: string;
  runId: string;
  type: ConsolidationActionType;
  sourceMemoryIds: string[];
  targetMemoryId: string | null;
  createdMemoryId: string | null;
  reason: string;
  plannedChanges: Record<string, unknown>;
  applied: boolean;
}

export interface ConsolidationOptions {
  dryRun?: boolean;
  scope?: MemoryScope;
  projectId?: string;
  agentId?: string;
  duplicateThreshold?: number;
  staleDays?: number;
  decayThreshold?: number;
  limit?: number;
  db?: Database;
}

export interface ConsolidationResult {
  run: ConsolidationRun;
  actions: ConsolidationAction[];
  dryRun: boolean;
  summary: {
    planned: number;
    applied: number;
    mergeDuplicates: number;
    promoteSemantic: number;
    summarizeClusters: number;
    decayForget: number;
  };
}

interface MemoryCluster {
  id: string;
  memories: Memory[];
  similarity: number;
}

const STOP_WORDS = new Set([
  "about", "after", "again", "agent", "also", "another", "before", "being",
  "between", "could", "during", "every", "feature", "found", "from", "have",
  "into", "learned", "memory", "must", "should", "that", "this", "through",
  "uses", "with", "work", "would", "session", "the", "and", "for", "was",
  "are", "but", "not", "you", "your", "our", "their",
]);

function parseRun(row: Record<string, unknown>): ConsolidationRun {
  return {
    id: row["id"] as string,
    scope: (row["scope"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    agent_id: (row["agent_id"] as string) || null,
    dry_run: !!row["dry_run"],
    status: row["status"] as ConsolidationRun["status"],
    summary: JSON.parse((row["summary"] as string) || "{}") as Record<string, unknown>,
    error: (row["error"] as string) || null,
    started_at: row["started_at"] as string,
    completed_at: (row["completed_at"] as string) || null,
  };
}

function createRun(options: ConsolidationOptions, db: Database): ConsolidationRun {
  const id = shortUuid();
  db.run(
    `INSERT INTO memory_consolidation_runs (id, scope, project_id, agent_id, dry_run, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    [
      id,
      options.scope ?? null,
      options.projectId ?? null,
      options.agentId ?? null,
      (options.dryRun ?? true) ? 1 : 0,
      now(),
    ],
  );
  return getRun(id, db)!;
}

function getRun(id: string, db: Database): ConsolidationRun | null {
  const row = db.query("SELECT * FROM memory_consolidation_runs WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? parseRun(row) : null;
}

function updateRun(
  id: string,
  updates: { status?: ConsolidationRun["status"]; summary?: Record<string, unknown>; error?: string | null; completed_at?: string | null },
  db: Database,
): ConsolidationRun {
  const sets: string[] = [];
  const params: SQLValue[] = [];
  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.summary !== undefined) {
    sets.push("summary = ?");
    params.push(JSON.stringify(updates.summary));
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
  db.run(`UPDATE memory_consolidation_runs SET ${sets.join(", ")} WHERE id = ?`, params);
  return getRun(id, db)!;
}

function persistAction(action: ConsolidationAction, db: Database): void {
  db.run(
    `INSERT INTO memory_consolidation_actions (id, run_id, action_type, memory_ids, target_memory_id, created_memory_id, reason, planned_changes, applied, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      action.id,
      action.runId,
      action.type,
      JSON.stringify(action.sourceMemoryIds),
      action.targetMemoryId,
      action.createdMemoryId,
      action.reason,
      JSON.stringify(action.plannedChanges),
      action.applied ? 1 : 0,
      now(),
    ],
  );
}

function markActionApplied(action: ConsolidationAction, db: Database): void {
  db.run(
    "UPDATE memory_consolidation_actions SET applied = ?, created_memory_id = ?, target_memory_id = ? WHERE id = ?",
    [action.applied ? 1 : 0, action.createdMemoryId, action.targetMemoryId, action.id],
  );
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .replace(/-/g, " ")
      .split(/\s+/)
      .map((word) => word.replace(/^-+|-+$/g, ""))
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

function similarity(a: Memory, b: Memory): number {
  const termsA = tokenize(`${a.key} ${a.value} ${a.summary ?? ""}`);
  const termsB = tokenize(`${b.key} ${b.value} ${b.summary ?? ""}`);
  if (termsA.size === 0 || termsB.size === 0) return 0;
  const intersection = [...termsA].filter((term) => termsB.has(term)).length;
  const union = new Set([...termsA, ...termsB]).size;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(termsA.size, termsB.size);
  return Math.max(jaccard, containment);
}

function shouldSkipMemory(memory: Memory): boolean {
  return memory.tags.includes("consolidated") || memory.tags.includes("reflection");
}

function findClusters(memories: Memory[], threshold: number): MemoryCluster[] {
  const parent = new Map<string, string>();
  const scores = new Map<string, number[]>();
  for (const memory of memories) parent.set(memory.id, memory.id);

  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return current;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const unite = (a: string, b: string, score: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) {
      scores.set(rootA, [...(scores.get(rootA) ?? []), score]);
      return;
    }
    const root = rootA < rootB ? rootA : rootB;
    const other = root === rootA ? rootB : rootA;
    parent.set(other, root);
    scores.set(root, [...(scores.get(rootA) ?? []), ...(scores.get(rootB) ?? []), score]);
  };

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]!;
      const b = memories[j]!;
      const score = similarity(a, b);
      if (score >= threshold) unite(a.id, b.id, score);
    }
  }

  const grouped = new Map<string, Memory[]>();
  for (const memory of memories) {
    const root = find(memory.id);
    grouped.set(root, [...(grouped.get(root) ?? []), memory]);
  }

  return [...grouped.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([id, items]) => ({
      id,
      memories: items.sort((a, b) => b.importance - a.importance || b.value.length - a.value.length || a.created_at.localeCompare(b.created_at)),
      similarity: average(scores.get(id) ?? [threshold]),
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function chooseKeeper(memories: Memory[]): Memory {
  return [...memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.importance - a.importance || b.value.length - a.value.length || a.created_at.localeCompare(b.created_at);
  })[0]!;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function clusterKey(prefix: string, memories: Memory[]): string {
  const terms = [...tokenize(memories.map((m) => `${m.key} ${m.value}`).join(" "))]
    .slice(0, 4)
    .join("-");
  const hash = stableHash(memories.map((m) => m.id).sort().join(":"));
  return `${prefix}-${terms || "cluster"}-${hash}`;
}

function summarizeCluster(memories: Memory[]): string {
  const keys = memories.map((m) => m.key).join(", ");
  const strongest = chooseKeeper(memories);
  return `Summary of ${memories.length} related memories (${keys}): ${strongest.value}`;
}

function semanticLesson(memories: Memory[]): string {
  const terms = [...tokenize(memories.map((m) => m.value).join(" "))].slice(0, 8);
  const strongest = chooseKeeper(memories);
  if (terms.length >= 3) {
    return `Repeated observation: ${terms.join(" ")}. Evidence: ${strongest.value}`;
  }
  return `Repeated observation across ${memories.length} memories: ${strongest.value}`;
}

function buildMergedValue(keeper: Memory, sources: Memory[]): string {
  const values = [keeper, ...sources]
    .map((memory) => memory.value.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(values));
  return unique.join("\n---\n");
}

function planActions(runId: string, options: ConsolidationOptions, db: Database): ConsolidationAction[] {
  const duplicateThreshold = options.duplicateThreshold ?? 0.82;
  const staleDays = options.staleDays ?? 90;
  const decayThreshold = options.decayThreshold ?? 2;
  const limit = options.limit ?? 500;

  const corpus = listMemories(
    {
      status: "active",
      scope: options.scope,
      project_id: options.projectId,
      agent_id: options.agentId,
      limit,
    },
    db,
  ).filter((memory) => memory.scope !== "working" && !shouldSkipMemory(memory));

  const actions: ConsolidationAction[] = [];
  const plannedArchived = new Set<string>();
  const clusters = findClusters(corpus, duplicateThreshold);

  for (const cluster of clusters) {
    const keeper = chooseKeeper(cluster.memories);
    const archivableSources = cluster.memories.filter((memory) => memory.id !== keeper.id && !memory.pinned);
    if (archivableSources.length > 0) {
      for (const source of archivableSources) plannedArchived.add(source.id);
      actions.push({
        id: shortUuid(),
        runId,
        type: "merge_duplicate",
        sourceMemoryIds: cluster.memories.map((memory) => memory.id),
        targetMemoryId: keeper.id,
        createdMemoryId: null,
        reason: `Near-duplicate cluster detected with average similarity ${cluster.similarity.toFixed(2)}; keeping ${keeper.key}.`,
        plannedChanges: {
          merged_value: buildMergedValue(keeper, archivableSources),
          archive_memory_ids: archivableSources.map((memory) => memory.id),
          similarity: Number(cluster.similarity.toFixed(3)),
        },
        applied: false,
      });
    }

    const episodicCount = cluster.memories.filter((memory) => memory.category === "history").length;
    if (episodicCount >= 2) {
      actions.push({
        id: shortUuid(),
        runId,
        type: "promote_semantic",
        sourceMemoryIds: cluster.memories.map((memory) => memory.id),
        targetMemoryId: null,
        createdMemoryId: null,
        reason: `Repeated episodic observation appeared in ${episodicCount} history memories.`,
        plannedChanges: {
          key: clusterKey("semantic", cluster.memories),
          value: semanticLesson(cluster.memories),
          category: "fact",
          tags: ["consolidated", "semantic", "promoted"],
          importance: Math.min(10, Math.max(7, Math.round(average(cluster.memories.map((m) => m.importance)) + 1))),
        },
        applied: false,
      });
    }

    actions.push({
      id: shortUuid(),
      runId,
      type: "summarize_cluster",
      sourceMemoryIds: cluster.memories.map((memory) => memory.id),
      targetMemoryId: null,
      createdMemoryId: null,
      reason: `Cluster of ${cluster.memories.length} related memories summarized for higher-level recall.`,
      plannedChanges: {
        key: clusterKey("summary", cluster.memories),
        value: summarizeCluster(cluster.memories),
        category: "knowledge",
        tags: ["consolidated", "summary"],
        importance: Math.min(10, Math.max(...cluster.memories.map((memory) => memory.importance))),
      },
      applied: false,
    });
  }

  const staleCutoffMs = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  for (const memory of corpus) {
    if (plannedArchived.has(memory.id) || memory.pinned) continue;
    const reference = memory.accessed_at ?? memory.updated_at ?? memory.created_at;
    const referenceMs = Date.parse(reference);
    if (!Number.isFinite(referenceMs) || referenceMs > staleCutoffMs) continue;
    const score = computeDecayScore(memory);
    if (score <= decayThreshold && memory.importance <= 3) {
      actions.push({
        id: shortUuid(),
        runId,
        type: "decay_forget",
        sourceMemoryIds: [memory.id],
        targetMemoryId: memory.id,
        createdMemoryId: null,
        reason: `Soft-deleted by consolidation decay: stale low-value memory, score ${score.toFixed(2)} after ${staleDays}+ days.`,
        plannedChanges: {
          status: "archived",
          archive_reason: `consolidation decay: stale low-value memory (score ${score.toFixed(2)})`,
          decay_score: Number(score.toFixed(3)),
        },
        applied: false,
      });
    }
  }

  return actions;
}

function applyMergeDuplicate(action: ConsolidationAction, db: Database): void {
  if (!action.targetMemoryId) return;
  const target = getMemory(action.targetMemoryId, db);
  if (!target) return;

  const mergedValue = typeof action.plannedChanges["merged_value"] === "string"
    ? action.plannedChanges["merged_value"] as string
    : target.value;
  const nextTags = Array.from(new Set([...target.tags, "merged"]));
  updateMemory(
    target.id,
    {
      value: mergedValue,
      tags: nextTags,
      metadata: {
        ...target.metadata,
        consolidation_run_id: action.runId,
        consolidated_source_ids: action.sourceMemoryIds,
      },
      version: target.version,
    },
    db,
  );

  for (const sourceId of action.sourceMemoryIds) {
    createMemoryLink({
      source_memory_id: target.id,
      target_memory_id: sourceId,
      relation_type: sourceId === target.id ? "related_to" : "merged_from",
      run_id: action.runId,
      metadata: { action_id: action.id },
    }, db);

    if (sourceId === target.id) continue;
    const source = getMemory(sourceId, db);
    if (!source || source.status !== "active" || source.pinned) continue;
    updateMemory(
      source.id,
      {
        status: "archived",
        metadata: {
          ...source.metadata,
          archive_reason: `consolidation merge_duplicate: merged into ${target.key}`,
          consolidated_into: target.id,
          consolidation_run_id: action.runId,
        },
        version: source.version,
      },
      db,
    );
  }
}

function applyCreateDerivedMemory(action: ConsolidationAction, relation: "summarizes" | "promotes", db: Database): string | null {
  const key = action.plannedChanges["key"];
  const value = action.plannedChanges["value"];
  if (typeof key !== "string" || typeof value !== "string") return null;

  const firstSource = action.sourceMemoryIds
    .map((id) => getMemory(id, db))
    .find((memory): memory is Memory => memory !== null);

  const memory = createMemory({
    key,
    value,
    category: action.plannedChanges["category"] === "fact" ? "fact" : "knowledge",
    scope: firstSource?.scope ?? "shared",
    importance: typeof action.plannedChanges["importance"] === "number" ? action.plannedChanges["importance"] : 7,
    tags: Array.isArray(action.plannedChanges["tags"])
      ? (action.plannedChanges["tags"] as unknown[]).filter((tag): tag is string => typeof tag === "string")
      : ["consolidated"],
    source: "system",
    agent_id: firstSource?.agent_id ?? undefined,
    project_id: firstSource?.project_id ?? undefined,
    session_id: firstSource?.session_id ?? undefined,
    metadata: {
      consolidation_run_id: action.runId,
      consolidation_action_id: action.id,
      source_memory_ids: action.sourceMemoryIds,
      derivation: action.type,
    },
  }, "merge", db);

  for (const sourceId of action.sourceMemoryIds) {
    createMemoryLink({
      source_memory_id: memory.id,
      target_memory_id: sourceId,
      relation_type: relation,
      run_id: action.runId,
      metadata: { action_id: action.id },
    }, db);
  }
  return memory.id;
}

function applyDecayForget(action: ConsolidationAction, db: Database): void {
  const memoryId = action.sourceMemoryIds[0];
  if (!memoryId) return;
  const memory = getMemory(memoryId, db);
  if (!memory || memory.status !== "active" || memory.pinned) return;
  updateMemory(
    memory.id,
    {
      status: "archived",
      metadata: {
        ...memory.metadata,
        archive_reason: action.plannedChanges["archive_reason"] ?? action.reason,
        consolidation_run_id: action.runId,
        consolidation_action_id: action.id,
        decay_score: action.plannedChanges["decay_score"],
      },
      version: memory.version,
    },
    db,
  );
}

function applyAction(action: ConsolidationAction, db: Database): ConsolidationAction {
  switch (action.type) {
    case "merge_duplicate":
      applyMergeDuplicate(action, db);
      return { ...action, applied: true };
    case "promote_semantic": {
      const createdMemoryId = applyCreateDerivedMemory(action, "promotes", db);
      return { ...action, createdMemoryId, applied: Boolean(createdMemoryId) };
    }
    case "summarize_cluster": {
      const createdMemoryId = applyCreateDerivedMemory(action, "summarizes", db);
      return { ...action, createdMemoryId, applied: Boolean(createdMemoryId) };
    }
    case "decay_forget":
      applyDecayForget(action, db);
      return { ...action, applied: true };
  }
}

function buildSummary(actions: ConsolidationAction[]): ConsolidationResult["summary"] {
  return {
    planned: actions.length,
    applied: actions.filter((action) => action.applied).length,
    mergeDuplicates: actions.filter((action) => action.type === "merge_duplicate").length,
    promoteSemantic: actions.filter((action) => action.type === "promote_semantic").length,
    summarizeClusters: actions.filter((action) => action.type === "summarize_cluster").length,
    decayForget: actions.filter((action) => action.type === "decay_forget").length,
  };
}

export async function runConsolidation(options: ConsolidationOptions = {}): Promise<ConsolidationResult> {
  const db = options.db || getDatabase();
  const dryRun = options.dryRun ?? false;
  let run = createRun({ ...options, dryRun }, db);

  try {
    let actions = planActions(run.id, { ...options, dryRun }, db);
    for (const action of actions) persistAction(action, db);

    if (!dryRun) {
      const applied: ConsolidationAction[] = [];
      db.transaction(() => {
        for (const action of actions) {
          const next = applyAction(action, db);
          markActionApplied(next, db);
          applied.push(next);
        }
      });
      actions = applied;
    }

    const summary = buildSummary(actions);
    run = updateRun(run.id, { status: "completed", summary, completed_at: now() }, db);
    return { run, actions, dryRun, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run = updateRun(run.id, { status: "failed", error: message, completed_at: now() }, db);
    return {
      run,
      actions: [],
      dryRun,
      summary: {
        planned: 0,
        applied: 0,
        mergeDuplicates: 0,
        promoteSemantic: 0,
        summarizeClusters: 0,
        decayForget: 0,
      },
    };
  }
}
