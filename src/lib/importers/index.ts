/**
 * Memory importers — parse export formats from Mem0, Zep, and LangMem into mementos memories.
 */

import type { CreateMemoryInput } from "../../types/index.js";

// ============================================================================
// Common types
// ============================================================================

export interface ImportResult {
  memories: CreateMemoryInput[];
  warnings: string[];
  source_format: string;
}

// ============================================================================
// Mem0 importer
// ============================================================================

interface Mem0Export {
  id?: string;
  memory?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  categories?: string[];
}

export function importMem0(data: Mem0Export[]): ImportResult {
  const warnings: string[] = [];
  const memories: CreateMemoryInput[] = [];

  for (const item of data) {
    if (!item.memory) {
      warnings.push(`Skipped item without memory field: ${item.id || "unknown"}`);
      continue;
    }
    memories.push({
      key: item.id || `mem0-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      value: item.memory,
      category: "knowledge",
      scope: "shared",
      source: "imported",
      tags: item.categories || [],
      metadata: { ...item.metadata, imported_from: "mem0", original_id: item.id },
    });
  }

  return { memories, warnings, source_format: "mem0" };
}

// ============================================================================
// Zep importer
// ============================================================================

interface ZepExport {
  uuid?: string;
  fact?: string;
  rating?: number;
  valid_at?: string;
  invalid_at?: string;
  source_node_name?: string;
  target_node_name?: string;
}

export function importZep(data: ZepExport[]): ImportResult {
  const warnings: string[] = [];
  const memories: CreateMemoryInput[] = [];

  for (const item of data) {
    if (!item.fact) {
      warnings.push(`Skipped item without fact field: ${item.uuid || "unknown"}`);
      continue;
    }
    const key = item.source_node_name && item.target_node_name
      ? `${item.source_node_name}-${item.target_node_name}`.toLowerCase().replace(/\s+/g, "-")
      : `zep-${item.uuid || Date.now()}`;

    memories.push({
      key,
      value: item.fact,
      category: "fact",
      scope: "shared",
      source: "imported",
      importance: item.rating ? Math.min(10, Math.max(1, Math.round(item.rating * 10))) : 5,
      metadata: {
        imported_from: "zep",
        original_id: item.uuid,
        valid_at: item.valid_at,
        invalid_at: item.invalid_at,
      },
    });
  }

  return { memories, warnings, source_format: "zep" };
}

// ============================================================================
// LangMem importer
// ============================================================================

interface LangMemExport {
  id?: string;
  content?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export function importLangMem(data: LangMemExport[]): ImportResult {
  const warnings: string[] = [];
  const memories: CreateMemoryInput[] = [];

  for (const item of data) {
    if (!item.content) {
      warnings.push(`Skipped item without content field: ${item.id || "unknown"}`);
      continue;
    }
    memories.push({
      key: item.id || `langmem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      value: item.content,
      category: "knowledge",
      scope: "shared",
      source: "imported",
      namespace: item.namespace,
      metadata: { ...item.metadata, imported_from: "langmem", original_id: item.id },
    });
  }

  return { memories, warnings, source_format: "langmem" };
}

// ============================================================================
// Auto-detect format
// ============================================================================

export function detectFormat(data: unknown[]): "mem0" | "zep" | "langmem" | "unknown" {
  if (data.length === 0) return "unknown";
  const sample = data[0] as Record<string, unknown>;
  if ("memory" in sample) return "mem0";
  if ("fact" in sample) return "zep";
  if ("content" in sample && "namespace" in sample) return "langmem";
  return "unknown";
}
