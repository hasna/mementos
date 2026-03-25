import { SqliteAdapter as Database } from "@hasna/cloud";
import { getDatabase, now } from "../../db/database.js";
import {
  createSynthesisRun,
  createProposal,
  listProposals,
  listSynthesisRuns,
  updateSynthesisRun,
  type SynthesisProposal,
  type SynthesisRun,
} from "../../db/synthesis.js";
import { buildCorpus } from "./corpus-builder.js";
import { analyzeCorpus } from "./llm-analyzer.js";
import { validateProposals, type SafetyConfig } from "./validator.js";
import { executeProposals, rollbackRun as _rollbackRun } from "./executor.js";
import { measureEffectiveness, type EffectivenessReport } from "./metrics.js";

// ============================================================================
// Re-exports
// ============================================================================

export type { SafetyConfig } from "./validator.js";
export type { EffectivenessReport } from "./metrics.js";
export type { AnalysisCorpus, MemoryCorpusItem } from "./corpus-builder.js";
export type { SynthesisAnalysisResult } from "./llm-analyzer.js";
export type { ValidationResult, SafetyConfig as SafetyConfigType } from "./validator.js";
export type { ExecutionResult } from "./executor.js";
export type { SchedulerConfig, SchedulerState } from "./scheduler.js";

// ============================================================================
// Types
// ============================================================================

export interface SynthesisOptions {
  projectId?: string;
  agentId?: string;
  provider?: string;
  maxProposals?: number;
  dryRun?: boolean;
  safetyConfig?: Partial<SafetyConfig>;
  db?: Database;
}

export interface SynthesisResult {
  run: SynthesisRun;
  proposals: SynthesisProposal[];
  executed: number;
  metrics: EffectivenessReport | null;
  dryRun: boolean;
}

// ============================================================================
// Main orchestrator
// ============================================================================

export async function runSynthesis(options: SynthesisOptions = {}): Promise<SynthesisResult> {
  const d = options.db || getDatabase();
  const projectId = options.projectId ?? null;
  const agentId = options.agentId ?? null;
  const dryRun = options.dryRun ?? false;

  // 1. Create the synthesis run record
  const run = createSynthesisRun(
    {
      triggered_by: "manual",
      project_id: projectId,
      agent_id: agentId,
    },
    d
  );

  // 2. Mark as running
  updateSynthesisRun(run.id, { status: "running" }, d);

  try {
    // 3. Build analysis corpus
    const corpus = await buildCorpus(
      {
        projectId: projectId ?? undefined,
        agentId: agentId ?? undefined,
        db: d,
      }
    );

    updateSynthesisRun(run.id, { corpus_size: corpus.totalMemories }, d);

    // 4. Analyze corpus with LLM
    const analysisResult = await analyzeCorpus(corpus, {
      provider: options.provider,
      maxProposals: options.maxProposals ?? 20,
    });

    // 5. Validate proposals against safety rules
    const validation = validateProposals(
      analysisResult.proposals,
      corpus,
      options.safetyConfig
    );

    // Filter to only non-rejected proposals
    const rejectedIndices = new Set(
      validation.rejectedProposals.map((r) => {
        const match = r.proposalId.match(/\[(\d+)\]/);
        return match ? parseInt(match[1]!, 10) : -1;
      })
    );

    const validProposals = analysisResult.proposals.filter((_, idx) => !rejectedIndices.has(idx));

    // 6. Persist proposals to DB
    const savedProposals: SynthesisProposal[] = [];
    for (const p of validProposals) {
      const saved = createProposal(
        {
          run_id: run.id,
          proposal_type: p.type,
          memory_ids: p.memory_ids,
          target_memory_id: p.target_memory_id ?? null,
          proposed_changes: p.proposed_changes,
          reasoning: p.reasoning,
          confidence: p.confidence,
        },
        d
      );
      savedProposals.push(saved);
    }

    // Update proposals_generated count (includes both valid and rejected)
    updateSynthesisRun(
      run.id,
      {
        proposals_generated: analysisResult.proposals.length,
        proposals_rejected: validation.rejectedProposals.length,
      },
      d
    );

    // 7. Execute (unless dry run)
    let executedCount = 0;

    if (!dryRun && savedProposals.length > 0) {
      const execResult = await executeProposals(run.id, savedProposals, d);
      executedCount = execResult.executed;

      updateSynthesisRun(
        run.id,
        {
          proposals_accepted: execResult.executed,
          proposals_rejected: validation.rejectedProposals.length + execResult.failed,
          status: "completed",
          completed_at: now(),
        },
        d
      );
    } else {
      updateSynthesisRun(
        run.id,
        {
          status: "completed",
          completed_at: now(),
        },
        d
      );
    }

    // 8. Measure effectiveness (only if actually executed something)
    let effectivenessReport: EffectivenessReport | null = null;
    if (!dryRun && executedCount > 0) {
      try {
        effectivenessReport = await measureEffectiveness(run.id, corpus, d);
      } catch {
        // Non-fatal — metrics are nice-to-have
      }
    }

    const finalRun = listSynthesisRuns({ project_id: projectId, limit: 1 }, d)[0] ?? run;
    const finalProposals = listProposals(run.id, undefined, d);

    return {
      run: finalRun,
      proposals: finalProposals,
      executed: executedCount,
      metrics: effectivenessReport,
      dryRun,
    };
  } catch (err) {
    // Mark run as failed
    updateSynthesisRun(
      run.id,
      {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completed_at: now(),
      },
      d
    );

    const failedRun = listSynthesisRuns({ project_id: projectId, limit: 1 }, d)[0] ?? run;

    return {
      run: failedRun,
      proposals: [],
      executed: 0,
      metrics: null,
      dryRun,
    };
  }
}

// ============================================================================
// Rollback
// ============================================================================

export async function rollbackSynthesis(
  runId: string,
  db?: Database
): Promise<{ rolled_back: number; errors: string[] }> {
  const d = db || getDatabase();

  const result = await _rollbackRun(runId, d);

  if (result.errors.length === 0) {
    updateSynthesisRun(runId, { status: "rolled_back", completed_at: now() }, d);
  }

  return result;
}

// ============================================================================
// Status
// ============================================================================

export function getSynthesisStatus(
  runId?: string,
  projectId?: string,
  db?: Database
): { lastRun: SynthesisRun | null; recentRuns: SynthesisRun[] } {
  const d = db || getDatabase();

  if (runId) {
    const recentRuns = listSynthesisRuns(
      { project_id: projectId ?? null, limit: 10 },
      d
    );
    const specificRun = recentRuns.find((r) => r.id === runId) ?? null;
    return {
      lastRun: specificRun ?? recentRuns[0] ?? null,
      recentRuns,
    };
  }

  const recentRuns = listSynthesisRuns(
    { project_id: projectId ?? null, limit: 10 },
    d
  );

  return {
    lastRun: recentRuns[0] ?? null,
    recentRuns,
  };
}
