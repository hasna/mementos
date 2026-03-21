/**
 * Memory quality auto-scoring.
 * Heuristic scoring based on specificity, actionability, freshness, consistency.
 */

import type { Memory } from "../types/index.js";

export interface QualityScore {
  total: number; // 0-1
  specificity: number; // 0-1
  actionability: number; // 0-1
  freshness: number; // 0-1
}

const ACTION_VERBS = new Set([
  "use", "run", "install", "configure", "deploy", "build", "test", "create",
  "add", "remove", "update", "fix", "set", "enable", "disable", "start",
  "stop", "restart", "check", "verify", "migrate", "import", "export",
]);

/**
 * Compute a quality score for a memory.
 */
export function computeQualityScore(memory: Memory): QualityScore {
  // Specificity: based on value length and detail
  const valueLen = memory.value.length;
  const specificity = Math.min(1, valueLen / 200); // Full score at 200+ chars

  // Actionability: contains action verbs or step-like patterns
  const words = memory.value.toLowerCase().split(/\s+/);
  const actionWordCount = words.filter(w => ACTION_VERBS.has(w)).length;
  const hasSteps = /\d+[\.\)]\s|step\s*\d|first|then|finally/i.test(memory.value);
  const actionability = Math.min(1, (actionWordCount * 0.2) + (hasSteps ? 0.4 : 0));

  // Freshness: how recently updated
  const daysSinceUpdate = (Date.now() - Date.parse(memory.updated_at)) / (1000 * 60 * 60 * 24);
  const freshness = Math.max(0, 1 - daysSinceUpdate / 90); // Decays over 90 days

  // Total: weighted average
  const total = specificity * 0.4 + actionability * 0.3 + freshness * 0.3;

  return {
    total: Math.round(total * 100) / 100,
    specificity: Math.round(specificity * 100) / 100,
    actionability: Math.round(actionability * 100) / 100,
    freshness: Math.round(freshness * 100) / 100,
  };
}
