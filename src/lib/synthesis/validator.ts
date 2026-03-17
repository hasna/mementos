import type { AnalysisCorpus } from "./corpus-builder.js";
import type { SynthesisAnalysisResult } from "./llm-analyzer.js";

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  rejectedProposals: Array<{ proposalId: string; reason: string }>;
  warnings: string[];
}

export interface SafetyConfig {
  maxArchivePercent: number;
  maxMergePercent: number;
  minConfidence: number;
  protectPinned: boolean;
  protectHighImportance: number;
}

const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  maxArchivePercent: 20,
  maxMergePercent: 30,
  minConfidence: 0.6,
  protectPinned: true,
  protectHighImportance: 9,
};

// ============================================================================
// Validator
// ============================================================================

export function validateProposals(
  proposals: SynthesisAnalysisResult["proposals"],
  corpus: AnalysisCorpus,
  config?: Partial<SafetyConfig>
): ValidationResult {
  const cfg: SafetyConfig = { ...DEFAULT_SAFETY_CONFIG, ...config };

  // Build lookup sets for fast access
  const memoryMap = new Map(corpus.items.map((item) => [item.memory.id, item.memory]));
  const rejectedProposals: ValidationResult["rejectedProposals"] = [];
  const warnings: string[] = [];

  // Pre-scan counts for bulk safety checks
  let archiveCount = 0;
  let mergeCount = 0;

  for (const proposal of proposals) {
    if (proposal.type === "archive" || proposal.type === "remove_duplicate") {
      archiveCount++;
    }
    if (proposal.type === "merge") {
      mergeCount++;
    }
  }

  const corpusSize = corpus.totalMemories;
  const archivePercent = corpusSize > 0 ? (archiveCount / corpusSize) * 100 : 0;
  const mergePercent = corpusSize > 0 ? (mergeCount / corpusSize) * 100 : 0;

  if (archivePercent > cfg.maxArchivePercent) {
    warnings.push(
      `Archive proposals (${archiveCount}) exceed ${cfg.maxArchivePercent}% of corpus (${archivePercent.toFixed(1)}%). Some will be rejected.`
    );
  }
  if (mergePercent > cfg.maxMergePercent) {
    warnings.push(
      `Merge proposals (${mergeCount}) exceed ${cfg.maxMergePercent}% of corpus (${mergePercent.toFixed(1)}%). Some will be rejected.`
    );
  }

  // Validate each proposal individually
  let remainingArchiveSlots = Math.floor((cfg.maxArchivePercent / 100) * corpusSize);
  let remainingMergeSlots = Math.floor((cfg.maxMergePercent / 100) * corpusSize);

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i]!;
    // Use index as a stable reference — real IDs come from DB after insertion
    const proposalRef = `proposal[${i}]`;

    // Rule 1: Confidence threshold
    if (proposal.confidence < cfg.minConfidence) {
      rejectedProposals.push({
        proposalId: proposalRef,
        reason: `Confidence ${proposal.confidence.toFixed(2)} below minimum ${cfg.minConfidence}`,
      });
      continue;
    }

    // Rule 2: All referenced memory IDs must exist
    const missingIds = proposal.memory_ids.filter((id) => !memoryMap.has(id));
    if (missingIds.length > 0) {
      rejectedProposals.push({
        proposalId: proposalRef,
        reason: `References unknown memory IDs: ${missingIds.join(", ")}`,
      });
      continue;
    }

    // Rule 3: Never touch pinned memories
    if (cfg.protectPinned) {
      const pinnedIds = proposal.memory_ids.filter((id) => {
        const m = memoryMap.get(id);
        return m?.pinned === true;
      });
      if (pinnedIds.length > 0) {
        rejectedProposals.push({
          proposalId: proposalRef,
          reason: `Attempts to modify pinned memories: ${pinnedIds.join(", ")}`,
        });
        continue;
      }
    }

    // Rule 4: Never archive/delete high-importance memories
    if (
      proposal.type === "archive" ||
      proposal.type === "remove_duplicate" ||
      proposal.type === "merge"
    ) {
      const highImportanceIds = proposal.memory_ids.filter((id) => {
        const m = memoryMap.get(id);
        return m && m.importance >= cfg.protectHighImportance;
      });
      if (highImportanceIds.length > 0) {
        rejectedProposals.push({
          proposalId: proposalRef,
          reason: `Attempts to archive/merge memories with importance ≥ ${cfg.protectHighImportance}: ${highImportanceIds.join(", ")}`,
        });
        continue;
      }
    }

    // Rule 5: Archive/remove_duplicate quota
    if (proposal.type === "archive" || proposal.type === "remove_duplicate") {
      if (remainingArchiveSlots <= 0) {
        rejectedProposals.push({
          proposalId: proposalRef,
          reason: `Archive quota exhausted (max ${cfg.maxArchivePercent}% of corpus)`,
        });
        continue;
      }
      remainingArchiveSlots--;
    }

    // Rule 6: Merge quota
    if (proposal.type === "merge") {
      if (remainingMergeSlots <= 0) {
        rejectedProposals.push({
          proposalId: proposalRef,
          reason: `Merge quota exhausted (max ${cfg.maxMergePercent}% of corpus)`,
        });
        continue;
      }
      remainingMergeSlots--;
    }

    // Rule 7: target_memory_id must exist if provided
    if (proposal.target_memory_id && !memoryMap.has(proposal.target_memory_id)) {
      rejectedProposals.push({
        proposalId: proposalRef,
        reason: `target_memory_id "${proposal.target_memory_id}" does not exist in corpus`,
      });
      continue;
    }
  }

  return {
    valid: rejectedProposals.length === 0,
    rejectedProposals,
    warnings,
  };
}
