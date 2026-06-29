import { getDatabase, resolvePartialId } from "../../db/database.js";
import { detectProject } from "../../lib/project-detect.js";
import type { Memory } from "../../types/index.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
  DuplicateMemoryError,
  InvalidScopeError,
} from "../../types/index.js";

// ============================================================================
// Auto-project initialization
// ============================================================================

let _autoProjectInitialized = false;

export function ensureAutoProject(): void {
  if (_autoProjectInitialized) return;
  _autoProjectInitialized = true;
  try {
    detectProject();
  } catch {
    // Silently ignore — auto-detection is best-effort
  }
}

// ============================================================================
// Error formatting
// ============================================================================

export function formatError(error: unknown): string {
  if (error instanceof VersionConflictError) return `Version conflict: ${error.message}`;
  if (error instanceof MemoryNotFoundError) return `Not found: ${error.message}`;
  if (error instanceof DuplicateMemoryError) return `Duplicate: ${error.message}`;
  if (error instanceof InvalidScopeError) return `Invalid scope: ${error.message}`;
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("UNIQUE constraint failed: projects.")) {
      return `Project already registered at this path. Use list_projects to find it.`;
    }
    if (msg.includes("UNIQUE constraint failed")) {
      const table = msg.match(/UNIQUE constraint failed: (\w+)\./)?.[1] ?? "unknown";
      return `Duplicate entry in ${table}. The record already exists — use the list or get tool to find it.`;
    }
    if (msg.includes("FOREIGN KEY constraint failed")) {
      return `Referenced record not found. Check that the project_id or agent_id exists.`;
    }
    return msg;
  }
  return String(error);
}

// ============================================================================
// ID resolution
// ============================================================================

export function resolveId(partialId: string, table = "memories"): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) throw new Error(`Could not resolve ID: ${partialId}`);
  return id;
}

// ============================================================================
// Memory formatting
// ============================================================================

export function formatMemory(m: Memory): string {
  const parts = [
    `ID: ${m.id}`,
    `Key: ${m.key}`,
    `Value: ${m.value}`,
    `Scope: ${m.scope}`,
    `Category: ${m.category}`,
    `Importance: ${m.importance}/10`,
    `Source: ${m.source}`,
    `Status: ${m.status}`,
  ];
  if (m.summary) parts.push(`Summary: ${m.summary}`);
  if (m.tags.length > 0) parts.push(`Tags: ${m.tags.join(", ")}`);
  if (m.pinned) parts.push(`Pinned: yes`);
  if (m.agent_id) parts.push(`Agent: ${m.agent_id}`);
  if (m.project_id) parts.push(`Project: ${m.project_id}`);
  if (m.session_id) parts.push(`Session: ${m.session_id}`);
  if (m.expires_at) parts.push(`Expires: ${m.expires_at}`);
  parts.push(`Access count: ${m.access_count}`);
  parts.push(`Version: ${m.version}`);
  parts.push(`Created: ${m.created_at}`);
  parts.push(`Updated: ${m.updated_at}`);
  if (m.accessed_at) parts.push(`Last accessed: ${m.accessed_at}`);
  return parts.join("\n");
}

export const MCP_DEFAULT_LIMIT = 10;
export const MCP_MAX_COMPACT_LIMIT = 50;

export function positiveLimit(value: unknown, fallback = MCP_DEFAULT_LIMIT): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), MCP_MAX_COMPACT_LIMIT);
}

export function compactText(value: string | null | undefined, max = 100): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  if (max <= 3) return normalized.slice(0, max);
  return `${normalized.slice(0, max - 3)}...`;
}

export function formatMemorySummary(m: Memory, index?: number, maxValue = 100): string {
  const prefix = index === undefined ? "" : `${index}. `;
  return `${prefix}[${m.scope}/${m.category}] ${m.key} = ${compactText(m.summary || m.value, maxValue)} (imp:${m.importance} id:${m.id.slice(0, 8)})`;
}

export function compactPageHint(args: {
  shown: number;
  limit: number;
  offset?: number;
  hasMore: boolean;
  moreCall: string;
  detailHint?: string;
}): string {
  const hints: string[] = [];
  if (args.hasMore) {
    hints.push(`more available: call ${args.moreCall} with offset=${(args.offset ?? 0) + args.shown}, limit=${args.limit}`);
  }
  if (args.detailHint) hints.push(args.detailHint);
  return hints.length > 0 ? `\n\nHint: ${hints.join("; ")}.` : "";
}

// ============================================================================
// ASMR result formatting
// ============================================================================

export function formatAsmrResult(result: import("../../lib/asmr/types.js").AsmrResult, query: string): string {
  const sections: string[] = [];

  sections.push(`[deep] ASMR recall for "${query}" (${result.duration_ms}ms, agents: ${result.agents_used.join(", ")})`);

  if (result.memories.length > 0) {
    const visibleMemories = result.memories.slice(0, MCP_MAX_COMPACT_LIMIT);
    const memLines = visibleMemories.map((m, i) =>
      `${i + 1}. [${m.source_agent}] [score:${m.score.toFixed(3)}] ${formatMemorySummary(m.memory, undefined, 120)}`,
    );
    sections.push(`Memories (${result.memories.length}):\n${memLines.join("\n")}`);
  }

  if (result.facts.length > 0) {
    const facts = result.facts.slice(0, MCP_MAX_COMPACT_LIMIT).map((f) => `- ${compactText(f, 180)}`);
    sections.push(`Facts (${facts.length}${result.facts.length > facts.length ? `/${result.facts.length}` : ""}):\n${facts.join("\n")}`);
  }

  if (result.timeline.length > 0) {
    const timeline = result.timeline.slice(0, MCP_MAX_COMPACT_LIMIT).map((t) => `- ${compactText(t, 180)}`);
    sections.push(`Timeline (${timeline.length}${result.timeline.length > timeline.length ? `/${result.timeline.length}` : ""}):\n${timeline.join("\n")}`);
  }

  if (result.reasoning) {
    sections.push(`Reasoning: ${compactText(result.reasoning, 500)}`);
  }

  return sections.join("\n\n");
}
