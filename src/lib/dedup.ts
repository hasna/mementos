/**
 * Smart deduplication for auto-extracted memories.
 * FTS5-based similarity check — no LLM needed, pure SQLite.
 * Prevents memory bloat from repeated similar extractions.
 */

import { searchMemories } from "./search.js";
import { updateMemory, getMemory } from "../db/memories.js";
import type { MemoryFilter } from "../types/index.js";

export interface DedupConfig {
  /** Jaccard similarity threshold 0-1. Above this = duplicate. Default: 0.8 */
  threshold: number;
  /** If near-duplicate found, keep the longer/more specific one. Default: true */
  keepLonger: boolean;
}

export interface DedupStats {
  checked: number;
  skipped: number;   // exact/near duplicates — not saved
  updated: number;   // existing memory updated with better content
}

const DEFAULT_CONFIG: DedupConfig = {
  threshold: 0.8,
  keepLonger: true,
};

let _stats: DedupStats = { checked: 0, skipped: 0, updated: 0 };

export function getDedupStats(): Readonly<DedupStats> {
  return { ..._stats };
}

export function resetDedupStats(): void {
  _stats = { checked: 0, skipped: 0, updated: 0 };
}

/**
 * Check if content is a near-duplicate of an existing memory.
 * Returns: 'unique' | 'duplicate' | { updateId: string } (update existing with better content)
 */
export function checkDuplicate(
  content: string,
  filter: Pick<MemoryFilter, "agent_id" | "project_id" | "scope">,
  config: DedupConfig = DEFAULT_CONFIG
): "unique" | "duplicate" | { updateId: string; existingContent: string } {
  _stats.checked++;

  const query = content
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 12)
    .join(" ");

  if (!query) return "unique";

  let results: ReturnType<typeof searchMemories>;
  try {
    results = searchMemories(query, { ...filter, limit: 5 });
  } catch {
    return "unique";
  }

  if (results.length === 0) return "unique";

  const contentWords = tokenize(content);
  if (contentWords.size === 0) return "unique";

  for (const result of results) {
    const existingWords = tokenize(result.memory.value);
    if (existingWords.size === 0) continue;

    const similarity = jaccardSimilarity(contentWords, existingWords);

    if (similarity >= config.threshold) {
      // Near-duplicate found
      if (config.keepLonger && content.length > result.memory.value.length) {
        // New content is more specific — update existing
        return { updateId: result.memory.id, existingContent: result.memory.value };
      }
      return "duplicate";
    }
  }

  return "unique";
}

/**
 * Full dedup pipeline: check and optionally update existing memory.
 * Returns: null = save as new | string = skipped/updated (reason)
 */
export function dedup(
  content: string,
  filter: Pick<MemoryFilter, "agent_id" | "project_id" | "scope">,
  config: DedupConfig = DEFAULT_CONFIG
): "save" | "skip" {
  const result = checkDuplicate(content, filter, config);

  if (result === "unique") return "save";

  if (result === "duplicate") {
    _stats.skipped++;
    return "skip";
  }

  // Update existing with better (longer) content
  try {
    const existing = getMemory(result.updateId);
    if (!existing) return "save";
    updateMemory(result.updateId, { value: content, version: existing.version });
    _stats.updated++;
  } catch {
    // Update failed — save as new rather than lose the memory
    return "save";
  }
  return "skip";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}
