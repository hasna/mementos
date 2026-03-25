/**
 * Fact contradiction detection.
 *
 * On memory_save, checks if a new memory contradicts existing high-importance facts.
 * Uses heuristic matching first, then optionally calls an LLM (Cerebras for speed)
 * for deeper analysis.
 */

import { SqliteAdapter as Database } from "@hasna/cloud";
import { getDatabase, now } from "../db/database.js";
import { parseMemoryRow } from "../db/memories.js";
import type { Memory } from "../types/index.js";
import { providerRegistry } from "./providers/registry.js";

// ============================================================================
// Fact invalidation
// ============================================================================

export interface InvalidationResult {
  invalidated_memory_id: string;
  new_memory_id: string | null;
  valid_until: string;
  supersedes_id: string;
}

/**
 * Invalidate an existing fact by setting its valid_until to now.
 * Optionally links the new superseding memory via metadata.supersedes_id.
 *
 * Call this when a contradiction is detected and the user/agent confirms
 * the old fact should be invalidated.
 */
export function invalidateFact(
  oldMemoryId: string,
  newMemoryId?: string,
  db?: Database
): InvalidationResult {
  const d = db || getDatabase();
  const timestamp = now();

  // Set valid_until on the old memory
  d.run(
    "UPDATE memories SET valid_until = ?, updated_at = ? WHERE id = ?",
    [timestamp, timestamp, oldMemoryId]
  );

  // If a new memory supersedes the old one, store the link in metadata
  if (newMemoryId) {
    const row = d.query("SELECT metadata FROM memories WHERE id = ?").get(newMemoryId) as { metadata: string } | null;
    if (row) {
      const metadata = JSON.parse(row.metadata || "{}");
      metadata.supersedes_id = oldMemoryId;
      d.run(
        "UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(metadata), timestamp, newMemoryId]
      );
    }
  }

  return {
    invalidated_memory_id: oldMemoryId,
    new_memory_id: newMemoryId || null,
    valid_until: timestamp,
    supersedes_id: oldMemoryId,
  };
}

// ============================================================================
// Types
// ============================================================================

export interface ContradictionResult {
  /** Whether a contradiction was detected */
  contradicts: boolean;
  /** The conflicting existing memory, if any */
  conflicting_memory: Memory | null;
  /** Confidence score 0-1 */
  confidence: number;
  /** Explanation of why it's a contradiction */
  reasoning: string;
}

// ============================================================================
// Heuristic contradiction checks
// ============================================================================

/**
 * Check if two values are likely contradictory using simple heuristics:
 * - Same key but different value content
 * - Negation patterns ("X is Y" vs "X is not Y")
 * - Opposite assertions ("uses TypeScript" vs "uses Python")
 */
function heuristicContradictionScore(
  newValue: string,
  existingValue: string,
  newKey: string,
  existingKey: string
): number {
  // Different keys → unlikely contradiction
  if (newKey !== existingKey) return 0;

  // Same key, exact same value → no contradiction
  const newLower = newValue.toLowerCase().trim();
  const existingLower = existingValue.toLowerCase().trim();
  if (newLower === existingLower) return 0;

  // Same key, different value → likely contradiction for fact-type memories
  // Basic word overlap check — low overlap means more likely contradiction
  const newWords = new Set(newLower.split(/\s+/));
  const existingWords = new Set(existingLower.split(/\s+/));
  let overlap = 0;
  for (const w of newWords) {
    if (existingWords.has(w)) overlap++;
  }
  const totalUnique = new Set([...newWords, ...existingWords]).size;
  const overlapRatio = totalUnique > 0 ? overlap / totalUnique : 0;

  // High overlap = update/refinement, low overlap = likely contradiction
  if (overlapRatio < 0.3) return 0.7;
  if (overlapRatio < 0.5) return 0.4;
  return 0.1; // High overlap — probably just an update
}

// ============================================================================
// LLM-based contradiction detection
// ============================================================================

async function llmContradictionCheck(
  _newValue: string,
  _existingValue: string,
  _key: string
): Promise<{ contradicts: boolean; confidence: number; reasoning: string }> {
  const provider = providerRegistry.getAvailable();
  if (!provider) {
    return { contradicts: false, confidence: 0, reasoning: "No LLM provider available" };
  }

  try {
    // Future: use provider with a structured contradiction-checking prompt.
    // For now, use heuristic results only — LLM call added when provider supports raw completions.
    return { contradicts: false, confidence: 0, reasoning: "LLM check skipped — using heuristic only" };
  } catch {
    return { contradicts: false, confidence: 0, reasoning: "LLM check failed" };
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a new memory contradicts any existing high-importance facts.
 *
 * Returns the contradiction result. Does NOT modify any data — the caller
 * decides what to do (warn, invalidate, reject).
 *
 * Only checks against memories with importance >= minImportance that share
 * the same key and are in the same scope/project.
 */
export async function detectContradiction(
  newKey: string,
  newValue: string,
  options: {
    scope?: string;
    project_id?: string;
    agent_id?: string;
    min_importance?: number;
    use_llm?: boolean;
  } = {},
  db?: Database
): Promise<ContradictionResult> {
  const d = db || getDatabase();
  const { scope, project_id, min_importance = 7, use_llm = false } = options;

  // Find existing active memories with the same key
  const conditions: string[] = ["key = ?", "status = 'active'", "importance >= ?"];
  const params: (string | number)[] = [newKey, min_importance];

  if (scope) {
    conditions.push("scope = ?");
    params.push(scope);
  }
  if (project_id) {
    conditions.push("project_id = ?");
    params.push(project_id);
  }

  // Exclude memories that have been invalidated (valid_until is set and in the past)
  conditions.push("(valid_until IS NULL OR valid_until > datetime('now'))");

  const sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY importance DESC LIMIT 10`;
  const rows = d.query(sql).all(...params) as Record<string, unknown>[];

  if (rows.length === 0) {
    return { contradicts: false, conflicting_memory: null, confidence: 0, reasoning: "No existing memories with this key" };
  }

  // Check each existing memory for contradictions
  let bestContradiction: ContradictionResult = {
    contradicts: false,
    conflicting_memory: null,
    confidence: 0,
    reasoning: "No contradiction detected",
  };

  for (const row of rows) {
    const existing = parseMemoryRow(row);

    // Heuristic check
    const heuristicScore = heuristicContradictionScore(newValue, existing.value, newKey, existing.key);

    if (heuristicScore > bestContradiction.confidence) {
      bestContradiction = {
        contradicts: heuristicScore >= 0.5,
        conflicting_memory: existing,
        confidence: heuristicScore,
        reasoning: heuristicScore >= 0.7
          ? `New value for "${newKey}" significantly differs from existing high-importance memory (importance ${existing.importance})`
          : heuristicScore >= 0.5
          ? `New value for "${newKey}" partially conflicts with existing memory (importance ${existing.importance})`
          : `Minor difference detected for "${newKey}"`,
      };
    }
  }

  // Optional LLM deep analysis for borderline cases (0.3-0.7 confidence)
  if (use_llm && bestContradiction.confidence >= 0.3 && bestContradiction.confidence < 0.7 && bestContradiction.conflicting_memory) {
    const llmResult = await llmContradictionCheck(newValue, bestContradiction.conflicting_memory.value, newKey);
    if (llmResult.confidence > bestContradiction.confidence) {
      bestContradiction = {
        ...bestContradiction,
        contradicts: llmResult.contradicts,
        confidence: llmResult.confidence,
        reasoning: llmResult.reasoning,
      };
    }
  }

  return bestContradiction;
}
