/**
 * 6-Vector Memory Categorization for ASMR ingestion.
 *
 * Classifies memories into one of 6 vector categories using fast heuristic
 * rules (no LLM calls). Designed to match supermemory's ASMR ingestion vectors.
 */

export type VectorCategory = "personal" | "preferences" | "events" | "temporal" | "updates" | "assistant";

interface CategorizableMemory {
  key: string;
  value: string;
  category?: string;
  importance?: number;
  version?: number;
  valid_until?: string | null;
}

// ── Keyword patterns per vector ─────────────────────────────────────────────

const PERSONAL_KEYWORDS = /\b(name|role|title|background|identity|email|phone|bio|about|age|birthday|location|address|occupation|employer|company)\b/i;
const PREFERENCES_KEYWORDS = /\b(prefer|like|dislike|style|always|never|want|hate|favorite|favourite|avoid|enjoy|love|opinion|wish|rather)\b/i;
const EVENTS_KEYWORDS = /\b(meeting|deadline|event|milestone|date|schedule|conference|appointment|launch|release|demo|review|standup|sprint|retrospective|ceremony)\b/i;
const TEMPORAL_KEYWORDS = /\b(deadline|expires|until|temporary|week|month|schedule|remind|reminder|due|countdown|ephemeral|ttl|valid_until|expir)\b/i;
const UPDATES_KEYWORDS = /\b(update|change|correction|new|replace|migrate|migration|upgrade|deprecat|fix|patch|refactor|rename|breaking)\b/i;
const ASSISTANT_KEYWORDS = /\b(agent|assistant|tool|mcp|claude|prompt|workflow|system|bot|automation|pipeline|hook|plugin|skill|model|llm|gpt|ai)\b/i;

/**
 * Categorize a single memory into one of 6 vector categories using heuristic rules.
 * Pure heuristic — no LLM calls.
 */
export async function categorizeMemory(
  key: string,
  value: string,
  category?: string,
): Promise<VectorCategory> {
  return categorizeSync(key, value, category);
}

/**
 * Synchronous categorization (the actual implementation).
 */
function categorizeSync(
  key: string,
  value: string,
  category?: string,
  importance?: number,
  version?: number,
  validUntil?: string | null,
): VectorCategory {
  const combined = `${key} ${value}`;

  // ── Stage 1: Strong keyword matches on key ──────────────────────────────

  if (PERSONAL_KEYWORDS.test(key)) return "personal";
  if (PREFERENCES_KEYWORDS.test(key)) return "preferences";
  if (EVENTS_KEYWORDS.test(key)) return "events";
  if (TEMPORAL_KEYWORDS.test(key)) return "temporal";
  if (UPDATES_KEYWORDS.test(key)) return "updates";
  if (ASSISTANT_KEYWORDS.test(key)) return "assistant";

  // ── Stage 2: Category + metadata heuristics ─────────────────────────────

  if (category === "preference") return "preferences";
  if (category === "fact" && importance !== undefined && importance >= 8) return "personal";
  if (category === "knowledge" && version !== undefined && version > 1) return "updates";
  if (validUntil) return "temporal";

  // ── Stage 3: Broader keyword matches on combined key+value ──────────────

  if (PERSONAL_KEYWORDS.test(combined)) return "personal";
  if (PREFERENCES_KEYWORDS.test(combined)) return "preferences";
  if (EVENTS_KEYWORDS.test(combined)) return "events";
  if (TEMPORAL_KEYWORDS.test(combined)) return "temporal";
  if (UPDATES_KEYWORDS.test(combined)) return "updates";
  if (ASSISTANT_KEYWORDS.test(combined)) return "assistant";

  // ── Stage 4: Fallback using category field ──────────────────────────────

  if (category) {
    const fallbackMap: Record<string, VectorCategory> = {
      preference: "preferences",
      fact: "personal",
      knowledge: "events",
      history: "temporal",
      procedural: "assistant",
      resource: "assistant",
    };
    const mapped = fallbackMap[category];
    if (mapped) return mapped;
  }

  // Default: treat as personal (most general bucket)
  return "personal";
}

/**
 * Categorize a batch of memories. Returns parallel array of vector categories.
 */
export async function categorizeMemoryBatch(
  memories: CategorizableMemory[],
): Promise<VectorCategory[]> {
  return memories.map((m) =>
    categorizeSync(m.key, m.value, m.category, m.importance, m.version, m.valid_until),
  );
}

/**
 * Get the full tag string for a memory's vector category.
 * Returns `vector:${category}` for use as a memory tag.
 */
export function vectorTag(category: VectorCategory): string {
  return `vector:${category}`;
}
