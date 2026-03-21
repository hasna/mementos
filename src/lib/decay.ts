// ============================================================================
// Forgetting curve decay — adjusts effective importance based on access
// patterns and time since last access.
//
// Model: effective_importance = importance * time_decay * access_boost
//   - time_decay: exponential decay exp(-lambda * days), lambda = 0.01
//   - access_boost: 1 + log(1 + access_count) * 0.1
//   - Pinned memories bypass decay entirely (return raw importance).
// ============================================================================

/**
 * Compute time decay factor (0–1).
 * Uses exponential forgetting curve: exp(-lambda * days_since_access).
 *
 * Returns 1.0 for today, ~0.9 for 10 days, ~0.74 for 30 days, ~0.37 for 100 days.
 *
 * @param daysSinceAccess  Non-negative number of days since last access.
 * @param lambda           Decay rate constant (default 0.01).
 */
export function timeDecay(daysSinceAccess: number, lambda: number = 0.01): number {
  if (daysSinceAccess <= 0) return 1.0;
  return Math.exp(-lambda * daysSinceAccess);
}

/**
 * Compute access frequency boost (>= 1.0).
 * Formula: 1 + log(1 + access_count) * 0.1
 *
 * Returns 1.0 for 0 accesses, ~1.07 for 1, ~1.11 for 2, ~1.24 for 10.
 *
 * @param accessCount  Non-negative number of times the memory was accessed.
 */
export function accessBoost(accessCount: number): number {
  if (accessCount <= 0) return 1.0;
  return 1 + Math.log(1 + accessCount) * 0.1;
}

/**
 * Compute effective importance using a forgetting curve model.
 *
 * effective_importance = importance * time_decay(days_since_access) * access_boost(access_count)
 *
 * Pinned memories always return their raw importance (no decay).
 * When accessed_at is null, falls back to created_at for age calculation.
 */
export function computeDecayScore(memory: {
  importance: number;
  access_count: number;
  accessed_at: string | null;
  created_at: string;
  pinned: boolean;
}): number {
  // Pinned memories are immune to decay
  if (memory.pinned) return memory.importance;

  // Determine how many days since the memory was last touched
  const referenceDate = memory.accessed_at || memory.created_at;
  const daysSinceAccess =
    (Date.now() - Date.parse(referenceDate)) / (1000 * 60 * 60 * 24);

  const decay = timeDecay(daysSinceAccess);
  const boost = accessBoost(memory.access_count);

  return memory.importance * decay * boost;
}
