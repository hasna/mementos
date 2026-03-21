/**
 * Memory poisoning detection.
 *
 * Computes a trust score (0.0 - 1.0) for incoming memories based on heuristic
 * checks. Low-trust memories are flagged for review.
 */

import type { Memory } from "../types/index.js";

// ============================================================================
// Instruction-like patterns: "always", "never", "you must", "you should"
// ============================================================================

const INSTRUCTION_PATTERNS = [
  /\byou\s+must\b/i,
  /\byou\s+should\b/i,
  /\byou\s+have\s+to\b/i,
  /\balways\b/i,
  /\bnever\b/i,
];

// ============================================================================
// Promotional patterns: "recommend", "buy", "best product"
// ============================================================================

const PROMOTIONAL_PATTERNS = [
  /\brecommend\b/i,
  /\bbuy\b/i,
  /\bbest\s+product\b/i,
  /\bpurchase\b/i,
  /\bdiscount\b/i,
  /\baffiliate\b/i,
];

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute a trust score for a memory value.
 *
 * Returns a float between 0.0 and 1.0 where 1.0 = fully trusted.
 * Heuristic penalties:
 *   - Instruction-like patterns (-0.2)
 *   - Promotional patterns (-0.3)
 *   - Contradicts existing high-importance memories (-0.3)
 *   - Very short value (<10 chars) with high importance claim (-0.1)
 */
export function computeTrustScore(
  value: string,
  key: string,
  existingMemories?: Memory[],
  claimedImportance?: number
): number {
  let score = 1.0;

  // 1. Instruction-like patterns
  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.test(value)) {
      score -= 0.2;
      break; // only apply once
    }
  }

  // 2. Promotional patterns
  for (const pattern of PROMOTIONAL_PATTERNS) {
    if (pattern.test(value)) {
      score -= 0.3;
      break; // only apply once
    }
  }

  // 3. Contradiction with existing high-importance memories
  if (existingMemories && existingMemories.length > 0) {
    for (const existing of existingMemories) {
      if (existing.key !== key) continue;
      if (existing.importance < 7) continue;
      if (existing.status !== "active") continue;

      // Simple heuristic: same key, different value, high importance existing memory
      const existingLower = existing.value.toLowerCase().trim();
      const newLower = value.toLowerCase().trim();

      if (existingLower === newLower) continue; // same value, no contradiction

      // Check word overlap — low overlap = likely contradiction
      const existingWords = new Set(existingLower.split(/\s+/));
      const newWords = new Set(newLower.split(/\s+/));
      let overlap = 0;
      for (const w of newWords) {
        if (existingWords.has(w)) overlap++;
      }
      const totalUnique = new Set([...newWords, ...existingWords]).size;
      const overlapRatio = totalUnique > 0 ? overlap / totalUnique : 0;

      if (overlapRatio < 0.3) {
        // Significant contradiction with high-importance memory
        score -= 0.3;
        break;
      }
    }
  }

  // 4. Very short value with high importance claim
  if (value.length < 10 && (claimedImportance ?? 5) >= 8) {
    score -= 0.1;
  }

  // Clamp to [0.0, 1.0]
  return Math.max(0.0, Math.min(1.0, score));
}
