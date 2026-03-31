// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect } from "bun:test";
import { validateProposals } from "./validator.js";
import type { SynthesisAnalysisResult } from "./llm-analyzer.js";
import type { AnalysisCorpus } from "./corpus-builder.js";

// ============================================================================
// Helpers
// ============================================================================

function makeCorpus(memories: Array<{
  id: string;
  pinned?: boolean;
  importance?: number;
}>): AnalysisCorpus {
  return {
    items: memories.map((m) => ({
      memory: {
        id: m.id,
        key: `key-${m.id}`,
        value: `value-${m.id}`,
        category: "knowledge" as const,
        scope: "shared" as const,
        importance: m.importance ?? 5,
        source: "agent" as const,
        status: "active" as const,
        pinned: m.pinned ?? false,
        tags: [],
        access_count: 0,
        version: 1,
        metadata: {},
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
      recallCount: 0,
      daysSinceCreated: 10,
      daysSinceAccessed: 5,
    })),
    totalMemories: memories.length,
    buildTime: 0,
  };
}

function makeProposal(
  overrides: Partial<SynthesisAnalysisResult["proposals"][0]> = {}
): SynthesisAnalysisResult["proposals"][0] {
  return {
    type: "add_tag",
    memory_ids: ["mem-1"],
    target_memory_id: null,
    proposed_changes: {},
    reasoning: "test",
    confidence: 0.8,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("validateProposals", () => {
  it("accepts valid proposals", () => {
    const corpus = makeCorpus([{ id: "mem-1" }]);
    const proposals = [makeProposal({ memory_ids: ["mem-1"] })];
    const result = validateProposals(proposals, corpus);
    expect(result.valid).toBe(true);
    expect(result.rejectedProposals).toHaveLength(0);
  });

  it("rejects proposals below confidence threshold", () => {
    const corpus = makeCorpus([{ id: "mem-1" }]);
    const proposals = [makeProposal({ memory_ids: ["mem-1"], confidence: 0.4 })];
    const result = validateProposals(proposals, corpus, { minConfidence: 0.6 });
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals).toHaveLength(1);
    expect(result.rejectedProposals[0]!.reason).toContain("Confidence");
  });

  it("rejects proposals referencing unknown memory IDs", () => {
    const corpus = makeCorpus([{ id: "mem-1" }]);
    const proposals = [makeProposal({ memory_ids: ["nonexistent-id"] })];
    const result = validateProposals(proposals, corpus);
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals[0]!.reason).toContain("unknown memory IDs");
  });

  it("rejects proposals that touch pinned memories", () => {
    const corpus = makeCorpus([{ id: "pinned-1", pinned: true }]);
    const proposals = [makeProposal({ memory_ids: ["pinned-1"], type: "archive" })];
    const result = validateProposals(proposals, corpus, { protectPinned: true });
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals[0]!.reason).toContain("pinned");
  });

  it("allows pinned memory proposals when protectPinned is false", () => {
    const corpus = makeCorpus([{ id: "pinned-1", pinned: true }]);
    const proposals = [makeProposal({ memory_ids: ["pinned-1"], type: "add_tag" })];
    const result = validateProposals(proposals, corpus, { protectPinned: false });
    // add_tag doesn't check importance, so this should pass
    expect(result.rejectedProposals.filter(r => r.reason.includes("pinned"))).toHaveLength(0);
  });

  it("rejects archive proposals for high-importance memories", () => {
    const corpus = makeCorpus([{ id: "important-1", importance: 9 }]);
    const proposals = [makeProposal({ memory_ids: ["important-1"], type: "archive" })];
    const result = validateProposals(proposals, corpus, { protectHighImportance: 9 });
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals[0]!.reason).toContain("importance");
  });

  it("rejects merge proposals for high-importance memories", () => {
    const corpus = makeCorpus([{ id: "important-1", importance: 10 }]);
    const proposals = [makeProposal({ memory_ids: ["important-1"], type: "merge" })];
    const result = validateProposals(proposals, corpus, { protectHighImportance: 9 });
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals[0]!.reason).toContain("importance");
  });

  it("rejects remove_duplicate proposals for high-importance memories", () => {
    const corpus = makeCorpus([{ id: "important-1", importance: 9 }]);
    const proposals = [makeProposal({ memory_ids: ["important-1"], type: "remove_duplicate" })];
    const result = validateProposals(proposals, corpus, { protectHighImportance: 9 });
    expect(result.valid).toBe(false);
  });

  it("enforces archive quota and adds warning", () => {
    // Create corpus with 5 memories, max archive = 20% = 1
    const corpus = makeCorpus([
      { id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }
    ]);
    // Try to archive all 5 — only 1 (20%) should be allowed
    const proposals = [
      makeProposal({ memory_ids: ["m1"], type: "archive", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m2"], type: "archive", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m3"], type: "archive", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m4"], type: "archive", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m5"], type: "archive", confidence: 0.9 }),
    ];
    const result = validateProposals(proposals, corpus, { maxArchivePercent: 20 });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Archive proposals");
    // Some should be rejected due to quota
    const quotaRejections = result.rejectedProposals.filter(r => r.reason.includes("quota"));
    expect(quotaRejections.length).toBeGreaterThan(0);
  });

  it("enforces merge quota and adds warning", () => {
    const corpus = makeCorpus([
      { id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }
    ]);
    // Try to merge all 5 — with maxMergePercent=20, only 1 is allowed
    const proposals = [
      makeProposal({ memory_ids: ["m1"], type: "merge", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m2"], type: "merge", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m3"], type: "merge", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m4"], type: "merge", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m5"], type: "merge", confidence: 0.9 }),
    ];
    const result = validateProposals(proposals, corpus, { maxMergePercent: 20 });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Merge proposals");
  });

  it("rejects proposal with invalid target_memory_id", () => {
    // Use 'update_value' type (no quota) and a large corpus so merge quota doesn't exhaust first
    const corpus = makeCorpus([{ id: "mem-1" }]);
    const proposals = [makeProposal({
      memory_ids: ["mem-1"],
      type: "update_value",
      target_memory_id: "nonexistent-target",
      confidence: 0.9,
    })];
    const result = validateProposals(proposals, corpus);
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals[0]!.reason).toContain("target_memory_id");
  });

  it("accepts proposal with valid target_memory_id", () => {
    const corpus = makeCorpus([{ id: "mem-1" }, { id: "mem-2" }]);
    const proposals = [makeProposal({
      memory_ids: ["mem-1"],
      type: "merge",
      target_memory_id: "mem-2",
      confidence: 0.9,
    })];
    const result = validateProposals(proposals, corpus);
    expect(result.rejectedProposals.filter(r => r.reason.includes("target_memory_id"))).toHaveLength(0);
  });

  it("returns valid=true with empty proposals", () => {
    const corpus = makeCorpus([{ id: "mem-1" }]);
    const result = validateProposals([], corpus);
    expect(result.valid).toBe(true);
    expect(result.rejectedProposals).toHaveLength(0);
  });

  it("handles empty corpus", () => {
    const corpus: AnalysisCorpus = {
      items: [],
      totalMemories: 0,
      buildTime: 0,
    };
    const result = validateProposals([], corpus);
    expect(result.valid).toBe(true);
  });

  it("counts archive and remove_duplicate together for quota", () => {
    const corpus = makeCorpus([
      { id: "m1" }, { id: "m2" }, { id: "m3" }
    ]);
    // 1 archive + 1 remove_duplicate = 2 out of 3 = 67%, exceeds 20% max
    const proposals = [
      makeProposal({ memory_ids: ["m1"], type: "archive", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m2"], type: "remove_duplicate", confidence: 0.9 }),
      makeProposal({ memory_ids: ["m3"], type: "remove_duplicate", confidence: 0.9 }),
    ];
    const result = validateProposals(proposals, corpus, { maxArchivePercent: 20 });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
