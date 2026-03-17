import { Database } from "bun:sqlite";
import type { Memory } from "../../types/index.js";
import { getDatabase, now } from "../../db/database.js";
import { listMemories } from "../../db/memories.js";
import { listSynthesisEvents } from "../../db/synthesis.js";

// ============================================================================
// Types
// ============================================================================

export interface MemoryCorpusItem {
  memory: Memory;
  recallCount: number;
  lastRecalled: string | null;
  searchHits: number;
  similarMemoryIds: string[];
}

export interface AnalysisCorpus {
  projectId: string | null;
  totalMemories: number;
  items: MemoryCorpusItem[];
  staleMemories: Memory[];
  duplicateCandidates: Array<{ a: Memory; b: Memory; similarity: number }>;
  lowImportanceHighRecall: Memory[];
  highImportanceLowRecall: Memory[];
  generatedAt: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract significant words from a key/value string for term overlap comparison.
 * Strips common stop words, lowercases, deduplicates.
 */
function extractTerms(text: string): Set<string> {
  const stopWords = new Set([
    "a", "an", "the", "is", "it", "in", "of", "for", "to", "and", "or",
    "but", "not", "with", "this", "that", "are", "was", "be", "by", "at",
    "as", "on", "has", "have", "had", "do", "did", "does", "will", "would",
    "can", "could", "should", "may", "might", "shall", "from", "into", "then",
    "than", "so", "if", "up", "out", "about", "its", "my", "we", "i", "you",
  ]);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s\-_]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );
}

/**
 * Compute Jaccard similarity between two sets of terms.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

/**
 * Check if a memory is stale:
 * - status is active
 * - importance < 7
 * - accessed_at is null OR more than 30 days ago
 */
function isStale(memory: Memory): boolean {
  if (memory.status !== "active") return false;
  if (memory.importance >= 7) return false;
  if (!memory.accessed_at) return true;

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return new Date(memory.accessed_at).getTime() < thirtyDaysAgo;
}

// ============================================================================
// Main builder
// ============================================================================

export async function buildCorpus(options: {
  projectId?: string;
  agentId?: string;
  limit?: number;
  db?: Database;
}): Promise<AnalysisCorpus> {
  const d = options.db || getDatabase();
  const limit = options.limit ?? 500;
  const projectId = options.projectId ?? null;

  // 1. Fetch active memories
  const memories = listMemories(
    {
      status: "active",
      project_id: options.projectId,
      agent_id: options.agentId,
      limit,
    },
    d
  );

  // 2. Build recall count map from synthesis_events
  const recallEvents = listSynthesisEvents(
    {
      event_type: "recalled",
      project_id: options.projectId,
    },
    d
  );

  const recallCounts = new Map<string, number>();
  const lastRecalledMap = new Map<string, string>();

  for (const event of recallEvents) {
    if (!event.memory_id) continue;
    recallCounts.set(event.memory_id, (recallCounts.get(event.memory_id) ?? 0) + 1);
    const existing = lastRecalledMap.get(event.memory_id);
    if (!existing || event.created_at > existing) {
      lastRecalledMap.set(event.memory_id, event.created_at);
    }
  }

  // 3. Build search hit counts (times a memory appeared in a searched event)
  const searchEvents = listSynthesisEvents(
    {
      event_type: "searched",
      project_id: options.projectId,
    },
    d
  );

  const searchHits = new Map<string, number>();
  for (const event of searchEvents) {
    if (!event.memory_id) continue;
    searchHits.set(event.memory_id, (searchHits.get(event.memory_id) ?? 0) + 1);
  }

  // 4. Pre-compute terms for each memory
  const termSets = new Map<string, Set<string>>();
  for (const m of memories) {
    termSets.set(m.id, extractTerms(`${m.key} ${m.value} ${m.summary ?? ""}`));
  }

  // 5. Find similar memory pairs (O(n²) but capped at limit=500)
  const duplicateCandidates: AnalysisCorpus["duplicateCandidates"] = [];
  const similarityThreshold = 0.5;
  const similarIds = new Map<string, string[]>();

  for (let i = 0; i < memories.length; i++) {
    const a = memories[i]!;
    const termsA = termSets.get(a.id)!;
    const aSimIds: string[] = [];

    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j]!;
      const termsB = termSets.get(b.id)!;
      const sim = jaccardSimilarity(termsA, termsB);

      if (sim >= similarityThreshold) {
        duplicateCandidates.push({ a, b, similarity: sim });
        aSimIds.push(b.id);
        const bSimIds = similarIds.get(b.id) ?? [];
        bSimIds.push(a.id);
        similarIds.set(b.id, bSimIds);
      }
    }

    if (aSimIds.length > 0) {
      const existing = similarIds.get(a.id) ?? [];
      similarIds.set(a.id, [...existing, ...aSimIds]);
    }
  }

  // Sort duplicate candidates by similarity descending
  duplicateCandidates.sort((a, b) => b.similarity - a.similarity);

  // 6. Build corpus items
  const items: MemoryCorpusItem[] = memories.map((memory) => ({
    memory,
    recallCount: recallCounts.get(memory.id) ?? 0,
    lastRecalled: lastRecalledMap.get(memory.id) ?? null,
    searchHits: searchHits.get(memory.id) ?? 0,
    similarMemoryIds: similarIds.get(memory.id) ?? [],
  }));

  // 7. Categorize memories
  const staleMemories = memories.filter(isStale);

  const lowImportanceHighRecall = memories.filter(
    (m) => m.importance < 5 && (recallCounts.get(m.id) ?? 0) > 3
  );

  const highImportanceLowRecall = memories.filter(
    (m) => m.importance > 7 && (recallCounts.get(m.id) ?? 0) === 0
  );

  return {
    projectId,
    totalMemories: memories.length,
    items,
    staleMemories,
    duplicateCandidates,
    lowImportanceHighRecall,
    highImportanceLowRecall,
    generatedAt: now(),
  };
}
