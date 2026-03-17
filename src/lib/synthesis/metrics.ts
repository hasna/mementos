import { Database } from "bun:sqlite";
import { getDatabase } from "../../db/database.js";
import {
  createMetric,
  listMetrics,
  listProposals,
  type SynthesisMetric,
} from "../../db/synthesis.js";
import { listMemories } from "../../db/memories.js";
import type { AnalysisCorpus } from "./corpus-builder.js";

// ============================================================================
// Types
// ============================================================================

export interface EffectivenessReport {
  runId: string;
  corpusReduction: number;
  importanceDrift: number;
  deduplicationRate: number;
  estimatedRecallImprovement: number;
  metrics: SynthesisMetric[];
}

// ============================================================================
// Measure effectiveness
// ============================================================================

export async function measureEffectiveness(
  runId: string,
  preCorpus: AnalysisCorpus,
  db?: Database
): Promise<EffectivenessReport> {
  const d = db || getDatabase();

  // --- Post-run corpus snapshot ---
  const postMemories = listMemories(
    {
      status: "active",
      project_id: preCorpus.projectId ?? undefined,
    },
    d
  );
  const postCount = postMemories.length;
  const preCount = preCorpus.totalMemories;

  // 1. Corpus reduction — % decrease in active memory count
  const corpusReduction =
    preCount > 0 ? ((preCount - postCount) / preCount) * 100 : 0;

  // 2. Importance drift — average importance before vs after
  const preAvgImportance =
    preCorpus.items.length > 0
      ? preCorpus.items.reduce((sum, i) => sum + i.memory.importance, 0) /
        preCorpus.items.length
      : 0;
  const postAvgImportance =
    postMemories.length > 0
      ? postMemories.reduce((sum, m) => sum + m.importance, 0) /
        postMemories.length
      : 0;
  const importanceDrift = postAvgImportance - preAvgImportance;

  // 3. Deduplication rate — % of duplicate pairs resolved
  const preDuplicatePairs = preCorpus.duplicateCandidates.length;
  const acceptedProposals = listProposals(runId, { status: "accepted" }, d);
  const deduplicationProposals = acceptedProposals.filter(
    (p) =>
      p.proposal_type === "remove_duplicate" || p.proposal_type === "merge"
  );
  const deduplicationRate =
    preDuplicatePairs > 0
      ? (deduplicationProposals.length / preDuplicatePairs) * 100
      : 0;

  // 4. Estimated recall improvement — heuristic based on:
  //    - corpus reduction (fewer memories = less noise)
  //    - importance drift (higher avg importance = better signal)
  //    - deduplication rate (resolved dupes = cleaner corpus)
  //
  // Formula: weighted sum clamped 0-100
  const recallWeight = {
    corpusReduction: 0.3,
    importanceDrift: 0.4,  // normalized 0-10 scale → ×10 to match %
    deduplicationRate: 0.3,
  };
  const estimatedRecallImprovement = Math.max(
    0,
    Math.min(
      100,
      corpusReduction * recallWeight.corpusReduction +
        Math.max(0, importanceDrift * 10) * recallWeight.importanceDrift +
        deduplicationRate * recallWeight.deduplicationRate
    )
  );

  // --- Persist metrics to DB ---
  const metricDefs: Array<{ metric_type: string; value: number; baseline?: number }> = [
    { metric_type: "corpus_reduction_pct", value: corpusReduction, baseline: 0 },
    { metric_type: "importance_drift", value: importanceDrift, baseline: 0 },
    { metric_type: "deduplication_rate_pct", value: deduplicationRate, baseline: 0 },
    { metric_type: "estimated_recall_improvement_pct", value: estimatedRecallImprovement, baseline: 0 },
    { metric_type: "pre_corpus_size", value: preCount, baseline: preCount },
    { metric_type: "post_corpus_size", value: postCount, baseline: preCount },
    { metric_type: "proposals_accepted", value: acceptedProposals.length, baseline: 0 },
    { metric_type: "pre_avg_importance", value: preAvgImportance, baseline: preAvgImportance },
    { metric_type: "post_avg_importance", value: postAvgImportance, baseline: preAvgImportance },
  ];

  for (const def of metricDefs) {
    createMetric(
      {
        run_id: runId,
        metric_type: def.metric_type,
        value: def.value,
        baseline: def.baseline ?? null,
      },
      d
    );
  }

  const metrics = listMetrics(runId, d);

  return {
    runId,
    corpusReduction,
    importanceDrift,
    deduplicationRate,
    estimatedRecallImprovement,
    metrics,
  };
}
