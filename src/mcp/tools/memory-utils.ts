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

// ============================================================================
// ASMR result formatting
// ============================================================================

export function formatAsmrResult(result: import("../../lib/asmr/types.js").AsmrResult, query: string): string {
  const sections: string[] = [];

  sections.push(`[deep] ASMR recall for "${query}" (${result.duration_ms}ms, agents: ${result.agents_used.join(", ")})`);

  if (result.memories.length > 0) {
    const memLines = result.memories.map((m, i) =>
      `${i + 1}. [${m.source_agent}] [score:${m.score.toFixed(3)}] [${m.memory.scope}/${m.memory.category}] ${m.memory.key} = ${m.memory.value.slice(0, 120)}${m.memory.value.length > 120 ? "..." : ""}`,
    );
    sections.push(`Memories (${result.memories.length}):\n${memLines.join("\n")}`);
  }

  if (result.facts.length > 0) {
    sections.push(`Facts:\n${result.facts.map((f) => `- ${f}`).join("\n")}`);
  }

  if (result.timeline.length > 0) {
    sections.push(`Timeline:\n${result.timeline.map((t) => `- ${t}`).join("\n")}`);
  }

  if (result.reasoning) {
    sections.push(`Reasoning: ${result.reasoning}`);
  }

  return sections.join("\n\n");
}
