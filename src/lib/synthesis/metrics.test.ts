process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../../db/database.js";
import { createMemory } from "../../db/memories.js";
import {
  createSynthesisRun,
  createProposal,
  updateProposal,
} from "../../db/synthesis.js";
import { measureEffectiveness } from "./metrics.js";
import type { AnalysisCorpus } from "./corpus-builder.js";
import type { Memory } from "../types/index.js";

function mockMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: "mem-1",
    key: "test",
    value: "value",
    category: "knowledge",
    scope: "shared",
    summary: null,
    tags: [],
    importance: 5,
    source: "agent",
    status: "active",
    pinned: false,
    agent_id: null,
    project_id: null,
    session_id: null,
    metadata: {},
    access_count: 0,
    version: 1,
    expires_at: null,
    valid_from: null,
    valid_until: null,
    ingested_at: null,
    created_at: now,
    updated_at: now,
    accessed_at: null,
    ...overrides,
  };
}

describe("measureEffectiveness", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("computes corpus metrics and persists them", async () => {
    const db = getDatabase();
    const memory = createMemory(
      { key: "kept", value: "Still active", scope: "global", importance: 8 },
      "merge",
      db
    );

    const preCorpus: AnalysisCorpus = {
      projectId: null,
      totalMemories: 2,
      items: [
        { memory: mockMemory({ id: memory.id, importance: 6 }), recallCount: 1, lastRecalled: null, searchHits: 0, similarMemoryIds: [] },
        { memory: mockMemory({ id: "old", importance: 4 }), recallCount: 0, lastRecalled: null, searchHits: 0, similarMemoryIds: [] },
      ],
      staleMemories: [],
      duplicateCandidates: [{ a: mockMemory({ id: "a" }), b: mockMemory({ id: "b" }), similarity: 0.9 }],
      lowImportanceHighRecall: [],
      highImportanceLowRecall: [],
      generatedAt: new Date().toISOString(),
    };

    const run = createSynthesisRun({ triggered_by: "manual" }, db);
    const proposal = createProposal(
      {
        run_id: run.id,
        proposal_type: "remove_duplicate",
        memory_ids: ["a", "b"],
        proposed_changes: {},
        confidence: 0.9,
      },
      db
    );
    updateProposal(proposal.id, { status: "accepted" }, db);

    const report = await measureEffectiveness(run.id, preCorpus, db);

    expect(report.runId).toBe(run.id);
    expect(report.corpusReduction).toBeGreaterThan(0);
    expect(report.metrics.length).toBeGreaterThanOrEqual(4);
    expect(report.metrics.some((m) => m.metric_type === "corpus_reduction_pct")).toBe(true);
    expect(report.estimatedRecallImprovement).toBeGreaterThanOrEqual(0);
    expect(report.estimatedRecallImprovement).toBeLessThanOrEqual(100);
  });

  it("handles empty pre-corpus without division errors", async () => {
    const db = getDatabase();
    const preCorpus: AnalysisCorpus = {
      projectId: null,
      totalMemories: 0,
      items: [],
      staleMemories: [],
      duplicateCandidates: [],
      lowImportanceHighRecall: [],
      highImportanceLowRecall: [],
      generatedAt: new Date().toISOString(),
    };

    const run = createSynthesisRun({ triggered_by: "scheduler" }, db);
    const report = await measureEffectiveness(run.id, preCorpus, db);

    expect(report.corpusReduction).toBe(0);
    expect(report.deduplicationRate).toBe(0);
  });
});
