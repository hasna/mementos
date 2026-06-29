import {
  parseContract,
  SCHEMA_IDS,
  type ProjectPanel,
  type ProjectPanelInput,
} from "@hasna/contracts";
import { listMemories } from "../db/memories.js";
import { getProject, listProjects } from "../db/projects.js";
import type { Memory, Project } from "../types/index.js";

export interface MementosProjectPanelOptions {
  limit?: number;
}

const SOURCE_PACKAGE = "@hasna/mementos";

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? 0)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(limit ?? 20)));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "project";
}

function preview(value: unknown, max = 180): string {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3))}...`;
}

function toTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function resolveProject(ref: string): Project | null {
  const direct = getProject(ref);
  if (direct) return direct;
  const wanted = slugify(ref);
  return listProjects().find((project) => slugify(project.name) === wanted) ?? null;
}

function latestTimestamp(memories: Memory[]): string | undefined {
  return memories
    .flatMap((memory) => [memory.updated_at, memory.created_at, memory.accessed_at].map(toTimestamp))
    .filter(Boolean)
    .sort((left, right) => right!.localeCompare(left!))[0];
}

function freshnessFor(latest: string | undefined): ProjectPanelInput["freshness"] {
  if (!latest) return "unknown";
  const ageMs = Date.now() - new Date(latest).valueOf();
  if (!Number.isFinite(ageMs)) return "unknown";
  return ageMs > 1000 * 60 * 60 * 24 * 30 ? "stale" : "fresh";
}

function priorityFor(memory: Memory): "low" | "medium" | "high" | "critical" | "unknown" {
  if (memory.pinned || memory.importance >= 9) return "critical";
  if (memory.importance >= 7) return "high";
  if (memory.importance >= 4) return "medium";
  if (memory.importance >= 1) return "low";
  return "unknown";
}

function memoryResource(memory: Memory) {
  return {
    kind: "memento" as const,
    id: memory.id,
    name: memory.key,
    uri: `memento://memory/${memory.id}`,
    externalId: memory.id,
    sourcePackage: SOURCE_PACKAGE,
    tags: memory.tags,
  };
}

function projectResource(projectId: string, name: string, externalId: string) {
  return {
    kind: "project" as const,
    id: projectId,
    name,
    uri: `project://${projectId}`,
    externalId,
    sourcePackage: SOURCE_PACKAGE,
  };
}

function actionResource(id: string, name: string) {
  return {
    kind: "action" as const,
    id,
    name,
    externalId: id,
    sourcePackage: SOURCE_PACKAGE,
  };
}

function sortedMemories(projectId: string, limit: number): Memory[] {
  return listMemories({
    project_id: projectId,
    status: "active",
    limit: Math.max(limit, 100),
  }).sort((left, right) => {
    if (Number(right.pinned) !== Number(left.pinned)) return Number(right.pinned) - Number(left.pinned);
    if (right.importance !== left.importance) return right.importance - left.importance;
    return right.updated_at.localeCompare(left.updated_at);
  });
}

export function createMementosProjectPanel(projectRef: string, options: MementosProjectPanelOptions = {}): ProjectPanel {
  const limit = clampLimit(options.limit);
  const generatedAt = new Date().toISOString();
  const project = resolveProject(projectRef);
  const filterProjectId = project?.id ?? projectRef;
  const projectId = project ? slugify(project.name) : slugify(projectRef);
  const memories = sortedMemories(filterProjectId, limit);
  const latest = latestTimestamp(memories);
  const freshness = freshnessFor(latest);
  const pinned = memories.filter((memory) => memory.pinned).length;
  const highImportance = memories.filter((memory) => memory.importance >= 7).length;
  const preferences = memories.filter((memory) => memory.category === "preference").length;
  const decisions = memories.filter((memory) => memory.tags.includes("decision") || memory.key.toLowerCase().includes("decision")).length;
  const assumptions = memories.filter((memory) => memory.tags.includes("assumption") || memory.key.toLowerCase().includes("assumption")).length;
  const stale = memories.filter((memory) => {
    const updated = toTimestamp(memory.updated_at);
    return updated ? Date.now() - new Date(updated).valueOf() > 1000 * 60 * 60 * 24 * 30 : false;
  }).length;
  const state = memories.length === 0 ? "empty" : freshness === "stale" ? "stale" : "ready";
  const warnings = project ? [] : [`No mementos project matched "${projectRef}"; used the provided value as project_id filter.`];

  const draft: ProjectPanelInput = {
    schema: SCHEMA_IDS.projectPanel,
    id: `mementos_panel_${projectId}`,
    createdAt: generatedAt,
    projectId,
    provider: {
      kind: "mementos",
      id: `mementos_${projectId}`,
      name: "Mementos",
      sourcePackage: SOURCE_PACKAGE,
      externalId: project?.id ?? projectRef,
    },
    kind: "mementos",
    title: "Mementos",
    summary: memories.length === 0
      ? "No active memories are available for this project yet."
      : `${memories.length} active project memor${memories.length === 1 ? "y" : "ies"}, ${pinned} pinned, ${highImportance} high importance.`,
    state,
    stateReason: state === "stale" ? "Latest active project memory is older than 30 days." : undefined,
    generatedAt,
    freshness,
    metrics: [
      { id: "active_memories", label: "Active memories", value: memories.length, status: memories.length > 0 ? "good" : "unknown" },
      { id: "pinned", label: "Pinned", value: pinned, status: pinned > 0 ? "good" : "unknown" },
      { id: "high_importance", label: "High importance", value: highImportance, status: highImportance > 0 ? "good" : "unknown" },
      { id: "preferences", label: "Preferences", value: preferences, status: preferences > 0 ? "good" : "unknown" },
      { id: "decisions", label: "Decisions", value: decisions, status: decisions > 0 ? "good" : "unknown" },
      { id: "assumptions", label: "Assumptions", value: assumptions, status: assumptions > 0 ? "good" : "unknown" },
      { id: "stale_memories", label: "Stale", value: stale, status: stale > 0 ? "warning" : "good" },
    ],
    items: memories.slice(0, limit).map((memory) => ({
      id: memory.id,
      title: memory.key,
      summary: preview(memory.summary || memory.when_to_use || memory.value),
      status: memory.pinned ? "pinned" : memory.status,
      priority: priorityFor(memory),
      timestamp: toTimestamp(memory.updated_at ?? memory.created_at),
      resourceRefs: [memoryResource(memory)],
      metadata: {
        scope: memory.scope,
        category: memory.category,
        source: memory.source,
        importance: memory.importance,
        trust_score: memory.trust_score,
        tags: memory.tags,
        agent_id: memory.agent_id,
        session_id: memory.session_id,
        access_count: memory.access_count,
      },
    })),
    actions: [
      actionResource("mementos:list", "List project memories"),
      actionResource("mementos:inject", "Inject project memory context"),
      actionResource("mementos:save", "Save project memory"),
    ],
    resourceRefs: [
      projectResource(projectId, project?.name ?? projectRef, project?.id ?? projectRef),
      ...memories.slice(0, limit).map(memoryResource),
    ],
    renderFragment: {
      renderer: "json_render",
      title: "Mementos",
      spec: {
        component: "project.mementos.summary",
        metrics: ["active_memories", "pinned", "high_importance", "decisions", "assumptions"],
        itemLimit: limit,
      },
    },
    warnings,
    metadata: {
      project_found: Boolean(project),
      filter_project_id: filterProjectId,
      latest_activity_at: latest,
    },
  };

  return parseContract(SCHEMA_IDS.projectPanel, draft);
}

export function formatMementosProjectPanel(panel: ProjectPanel): string {
  const lines = [
    `${panel.title}: ${panel.state}`,
    panel.summary ?? "",
    ...panel.metrics.map((metric) => `${metric.label}: ${metric.value}`),
  ].filter(Boolean);

  if (panel.items.length > 0) {
    lines.push("Items:");
    for (const item of panel.items.slice(0, 10)) {
      lines.push(`- ${item.title}${item.status ? ` [${item.status}]` : ""}`);
      if (item.summary) lines.push(`  ${item.summary}`);
    }
  }

  return lines.join("\n");
}
