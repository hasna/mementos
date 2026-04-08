/**
 * Activation Matcher — finds memories whose when_to_use activates for a given context.
 * Used by the auto-inject pipeline to proactively push relevant memories.
 */

import { semanticSearch, listMemories } from "../db/memories.js";
import { computeDecayScore } from "./decay.js";
import {
  isMemoryVisibleToMachine,
  visibleToMachineFilter,
} from "./machine-visibility.js";
import type { Memory } from "../types/index.js";

// Recently pushed memory IDs — don't push the same memory twice within the window
const _recentlyPushed = new Map<string, number>(); // id → timestamp
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function cleanRecentlyPushed(): void {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [id, ts] of _recentlyPushed) {
    if (ts < cutoff) _recentlyPushed.delete(id);
  }
}

export function markAsPushed(memoryIds: string[]): void {
  const now = Date.now();
  for (const id of memoryIds) {
    _recentlyPushed.set(id, now);
  }
}

export function wasRecentlyPushed(id: string): boolean {
  cleanRecentlyPushed();
  return _recentlyPushed.has(id);
}

export async function findActivatedMemories(
  contextText: string,
  options?: {
    project_id?: string;
    agent_id?: string;
    machine_id?: string | null;
    min_similarity?: number;
    max_results?: number;
  }
): Promise<Memory[]> {
  if (!contextText || contextText.length < 10) return [];

  const minSimilarity = options?.min_similarity || 0.4;
  const maxResults = options?.max_results || 5;

  try {
    // 1. Semantic search against when_to_use embeddings
    const results = await semanticSearch(contextText, {
      threshold: minSimilarity,
      limit: maxResults * 2, // fetch extra for filtering
      project_id: options?.project_id,
      agent_id: options?.agent_id,
    });

    if (!results || results.length === 0) {
      // Fallback: keyword match on when_to_use field via SQL
      return fallbackKeywordMatch(contextText, options);
    }

    // 2. Filter out recently pushed
    cleanRecentlyPushed();
    let filtered = results
      .map(r => r.memory)
      .filter(m => isMemoryVisibleToMachine(m, options?.machine_id))
      .filter(m => !_recentlyPushed.has(m.id))
      .filter(m => m.status === "active");

    // 3. Apply decay scoring and re-sort
    filtered = filtered
      .map(m => ({
        memory: m,
        score: computeDecayScore({
          importance: m.importance,
          access_count: m.access_count,
          accessed_at: m.accessed_at,
          created_at: m.created_at,
          pinned: m.pinned,
        }),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(r => r.memory);

    return filtered;
  } catch {
    // Semantic search not available — fall back to keyword
    return fallbackKeywordMatch(contextText, options);
  }
}

function fallbackKeywordMatch(
  contextText: string,
  options?: { project_id?: string; machine_id?: string | null; max_results?: number }
): Memory[] {
  try {
    // Get memories that have when_to_use set and do simple keyword overlap
    const allMemories = listMemories({
      project_id: options?.project_id,
      status: "active",
      ...visibleToMachineFilter(options?.machine_id),
      limit: 100,
    });

    const contextWords = new Set(
      contextText.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );

    const scored = allMemories
      .filter(m => m.when_to_use)
      .filter(m => !_recentlyPushed.has(m.id))
      .map(m => {
        const wtuWords = m.when_to_use!.toLowerCase().split(/\s+/);
        const overlap = wtuWords.filter(w => contextWords.has(w)).length;
        return { memory: m, score: overlap };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options?.max_results || 5);

    return scored.map(r => r.memory);
  } catch {
    return [];
  }
}

export function resetRecentlyPushed(): void {
  _recentlyPushed.clear();
}

export function getRecentlyPushedCount(): number {
  cleanRecentlyPushed();
  return _recentlyPushed.size;
}
