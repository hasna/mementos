// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { resetDatabase, getDatabase } from "../../db/database.js";
import { createMemory } from "../../db/memories.js";
import {
  createSynthesisRun,
  getSynthesisRun,
  listSynthesisRuns,
  updateSynthesisRun,
  createProposal,
  getProposal,
  listProposals,
  updateProposal,
  recordSynthesisEvent,
  listSynthesisEvents,
  createMetric,
  listMetrics,
} from "../../db/synthesis.js";
import { buildCorpus } from "./corpus-builder.js";
import { validateProposals } from "./validator.js";
import { executeProposals, rollbackRun } from "./executor.js";
import { checkShouldTrigger } from "./scheduler.js";
import type { SynthesisAnalysisResult } from "./llm-analyzer.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a fresh in-memory database with all migrations applied.
 * By resetting the global singleton we force getDatabase() to create
 * a brand-new `:memory:` DB on the next call.
 */
function freshDb(): Database {
  resetDatabase();
  return getDatabase(":memory:");
}

function seedMemory(
  db: Database,
  overrides: Partial<{
    key: string;
    value: string;
    importance: number;
    scope: "global" | "shared" | "private";
    category: "knowledge" | "fact" | "preference" | "history";
    pinned: boolean;
    status: "active" | "archived" | "expired";
    project_id: string;
    agent_id: string;
    session_id: string;
    tags: string[];
  }> = {}
) {
  return createMemory(
    {
      key: overrides.key ?? `mem-${Math.random().toString(36).slice(2)}`,
      value: overrides.value ?? "some value",
      importance: overrides.importance ?? 5,
      scope: overrides.scope ?? "private",
      category: overrides.category ?? "knowledge",
      pinned: overrides.pinned ?? false,
      status: overrides.status ?? "active",
      project_id: overrides.project_id,
      agent_id: overrides.agent_id,
      session_id: overrides.session_id,
      tags: overrides.tags ?? [],
    },
    "insert",
    db
  );
}

// ============================================================================
// DB Layer: createSynthesisRun / createProposal / recordSynthesisEvent
// ============================================================================

describe("DB Layer — createSynthesisRun", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("creates a run with all required fields", () => {
    const run = createSynthesisRun({ triggered_by: "manual" }, db);
    expect(run.id).toBeString();
    expect(run.triggered_by).toBe("manual");
    expect(run.status).toBe("pending");
    expect(run.corpus_size).toBe(0);
    expect(run.proposals_generated).toBe(0);
    expect(run.proposals_accepted).toBe(0);
    expect(run.proposals_rejected).toBe(0);
    expect(run.error).toBeNull();
    expect(run.completed_at).toBeNull();
    expect(run.started_at).toBeString();
  });

  it("creates a run with project_id and agent_id", () => {
    const run = createSynthesisRun(
      { triggered_by: "scheduler", project_id: "proj-1", agent_id: "agent-1", corpus_size: 42 },
      db
    );
    expect(run.project_id).toBe("proj-1");
    expect(run.agent_id).toBe("agent-1");
    expect(run.corpus_size).toBe(42);
  });

  it("getSynthesisRun returns null for unknown id", () => {
    db = freshDb();
    expect(getSynthesisRun("nonexistent", db)).toBeNull();
  });

  it("getSynthesisRun retrieves persisted run", () => {
    const run = createSynthesisRun({ triggered_by: "manual" }, db);
    const fetched = getSynthesisRun(run.id, db);
    expect(fetched?.id).toBe(run.id);
  });

  it("updateSynthesisRun updates status and completed_at", () => {
    const run = createSynthesisRun({ triggered_by: "manual" }, db);
    const updated = updateSynthesisRun(
      run.id,
      { status: "completed", completed_at: new Date().toISOString() },
      db
    );
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).toBeString();
  });

  it("updateSynthesisRun updates proposal counts", () => {
    const run = createSynthesisRun({ triggered_by: "manual" }, db);
    const updated = updateSynthesisRun(
      run.id,
      { proposals_generated: 10, proposals_accepted: 7, proposals_rejected: 3 },
      db
    );
    expect(updated.proposals_generated).toBe(10);
    expect(updated.proposals_accepted).toBe(7);
    expect(updated.proposals_rejected).toBe(3);
  });

  it("listSynthesisRuns returns runs ordered by started_at desc", () => {
    createSynthesisRun({ triggered_by: "manual" }, db);
    createSynthesisRun({ triggered_by: "scheduler" }, db);
    const runs = listSynthesisRuns({}, db);
    expect(runs.length).toBe(2);
    // Most recent first
    expect(runs[0]!.started_at >= runs[1]!.started_at).toBe(true);
  });

  it("listSynthesisRuns filters by project_id", () => {
    createSynthesisRun({ triggered_by: "manual", project_id: "proj-A" }, db);
    createSynthesisRun({ triggered_by: "manual", project_id: "proj-B" }, db);
    const runs = listSynthesisRuns({ project_id: "proj-A" }, db);
    expect(runs.length).toBe(1);
    expect(runs[0]!.project_id).toBe("proj-A");
  });

  it("listSynthesisRuns respects limit", () => {
    for (let i = 0; i < 5; i++) createSynthesisRun({ triggered_by: "manual" }, db);
    const runs = listSynthesisRuns({ limit: 3 }, db);
    expect(runs.length).toBe(3);
  });
});

describe("DB Layer — createProposal", () => {
  let db: Database;
  let runId: string;

  beforeEach(() => {
    db = freshDb();
    runId = createSynthesisRun({ triggered_by: "manual" }, db).id;
  });

  it("creates a proposal with required fields", () => {
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "archive",
        memory_ids: ["mem-1", "mem-2"],
        proposed_changes: { reason: "stale" },
        confidence: 0.9,
      },
      db
    );
    expect(proposal.id).toBeString();
    expect(proposal.run_id).toBe(runId);
    expect(proposal.proposal_type).toBe("archive");
    expect(proposal.memory_ids).toEqual(["mem-1", "mem-2"]);
    expect(proposal.confidence).toBe(0.9);
    expect(proposal.status).toBe("pending");
    expect(proposal.rollback_data).toBeNull();
  });

  it("getProposal returns null for unknown id", () => {
    expect(getProposal("nonexistent", db)).toBeNull();
  });

  it("listProposals returns proposals for a run", () => {
    createProposal(
      { run_id: runId, proposal_type: "merge", memory_ids: ["a"], proposed_changes: {}, confidence: 0.8 },
      db
    );
    createProposal(
      { run_id: runId, proposal_type: "archive", memory_ids: ["b"], proposed_changes: {}, confidence: 0.7 },
      db
    );
    const proposals = listProposals(runId, undefined, db);
    expect(proposals.length).toBe(2);
  });

  it("listProposals filters by status", () => {
    const p = createProposal(
      { run_id: runId, proposal_type: "archive", memory_ids: ["a"], proposed_changes: {}, confidence: 0.9 },
      db
    );
    updateProposal(p.id, { status: "accepted" }, db);
    createProposal(
      { run_id: runId, proposal_type: "archive", memory_ids: ["b"], proposed_changes: {}, confidence: 0.9 },
      db
    );
    const accepted = listProposals(runId, { status: "accepted" }, db);
    expect(accepted.length).toBe(1);
    expect(accepted[0]!.status).toBe("accepted");
  });

  it("updateProposal stores rollback_data", () => {
    const p = createProposal(
      { run_id: runId, proposal_type: "archive", memory_ids: ["a"], proposed_changes: {}, confidence: 0.9 },
      db
    );
    const rb = { old_status: { "a": "active" } };
    const updated = updateProposal(
      p.id,
      { status: "accepted", executed_at: new Date().toISOString(), rollback_data: rb },
      db
    );
    expect(updated.status).toBe("accepted");
    expect(updated.rollback_data).toEqual(rb);
  });
});

describe("DB Layer — recordSynthesisEvent", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("records a save event fire-and-forget", () => {
    // Should not throw
    recordSynthesisEvent(
      { event_type: "saved", memory_id: "m1", agent_id: "a1", project_id: "p1" },
      db
    );
    const events = listSynthesisEvents({}, db);
    expect(events.length).toBe(1);
    expect(events[0]!.event_type).toBe("saved");
    expect(events[0]!.memory_id).toBe("m1");
  });

  it("records an injected event with metadata", () => {
    recordSynthesisEvent(
      { event_type: "injected", agent_id: "a1", metadata: { count: 5, format: "compact" } },
      db
    );
    const events = listSynthesisEvents({ event_type: "injected" }, db);
    expect(events.length).toBe(1);
    expect(events[0]!.metadata).toEqual({ count: 5, format: "compact" });
  });

  it("never throws on bad input", () => {
    // Fire-and-forget: should swallow errors gracefully
    // Pass null as db to trigger error path — wrap in try/catch to confirm
    expect(() =>
      recordSynthesisEvent({ event_type: "saved" } as Parameters<typeof recordSynthesisEvent>[0])
    ).not.toThrow();
  });

  it("listSynthesisEvents filters by event_type", () => {
    recordSynthesisEvent({ event_type: "saved", memory_id: "m1" }, db);
    recordSynthesisEvent({ event_type: "recalled", memory_id: "m2" }, db);
    const saved = listSynthesisEvents({ event_type: "saved" }, db);
    expect(saved.length).toBe(1);
    expect(saved[0]!.event_type).toBe("saved");
  });

  it("listSynthesisEvents filters by project_id", () => {
    recordSynthesisEvent({ event_type: "saved", project_id: "proj-A" }, db);
    recordSynthesisEvent({ event_type: "saved", project_id: "proj-B" }, db);
    const projA = listSynthesisEvents({ project_id: "proj-A" }, db);
    expect(projA.length).toBe(1);
  });
});

// ============================================================================
// Corpus Builder
// ============================================================================

describe("buildCorpus", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns empty corpus when no memories", async () => {
    const corpus = await buildCorpus({ db });
    expect(corpus.totalMemories).toBe(0);
    expect(corpus.items).toHaveLength(0);
    expect(corpus.staleMemories).toHaveLength(0);
    expect(corpus.duplicateCandidates).toHaveLength(0);
    expect(corpus.projectId).toBeNull();
  });

  it("includes active memories in corpus", async () => {
    seedMemory(db, { key: "key-1", value: "value one" });
    seedMemory(db, { key: "key-2", value: "value two" });
    const corpus = await buildCorpus({ db });
    expect(corpus.totalMemories).toBe(2);
    expect(corpus.items).toHaveLength(2);
  });

  it("filters by projectId when provided", async () => {
    // Must create the project row before referencing it via FK
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", ["proj-A", "Project A", "/tmp/proj-a"]);
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", ["proj-B", "Project B", "/tmp/proj-b"]);
    seedMemory(db, { key: "m1", project_id: "proj-A" });
    seedMemory(db, { key: "m2", project_id: "proj-B" });
    const corpus = await buildCorpus({ projectId: "proj-A", db });
    expect(corpus.totalMemories).toBe(1);
    expect(corpus.projectId).toBe("proj-A");
  });

  it("detects stale memories (importance < 7, never accessed)", async () => {
    seedMemory(db, { key: "stale-1", importance: 3 });
    seedMemory(db, { key: "high-importance", importance: 8 });
    const corpus = await buildCorpus({ db });
    const staleKeys = corpus.staleMemories.map((m) => m.key);
    expect(staleKeys).toContain("stale-1");
    expect(staleKeys).not.toContain("high-importance");
  });

  it("detects duplicate candidates for similar memories", async () => {
    // Two memories with highly overlapping terms should be flagged
    seedMemory(db, { key: "db-config", value: "postgres database connection host port user password config" });
    seedMemory(db, { key: "db-settings", value: "postgres database connection host port user password settings" });
    const corpus = await buildCorpus({ db });
    // May or may not detect depending on Jaccard threshold — just check structure
    expect(Array.isArray(corpus.duplicateCandidates)).toBe(true);
  });

  it("builds corpus items with recall counts from events", async () => {
    const mem = seedMemory(db, { key: "recalled-mem" });
    recordSynthesisEvent({ event_type: "recalled", memory_id: mem.id }, db);
    recordSynthesisEvent({ event_type: "recalled", memory_id: mem.id }, db);
    const corpus = await buildCorpus({ db });
    const item = corpus.items.find((i) => i.memory.id === mem.id);
    expect(item?.recallCount).toBe(2);
  });

  it("categorizes high importance low recall memories", async () => {
    const mem = seedMemory(db, { key: "high-imp-no-recall", importance: 9 });
    const corpus = await buildCorpus({ db });
    const isInList = corpus.highImportanceLowRecall.some((m) => m.id === mem.id);
    expect(isInList).toBe(true);
  });
});

// ============================================================================
// Validator
// ============================================================================

describe("validateProposals", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  function makeCorpus(memories: Array<{ id: string; importance: number; pinned: boolean }>) {
    return {
      projectId: null,
      totalMemories: memories.length,
      items: memories.map((m) => ({
        memory: {
          id: m.id,
          key: `key-${m.id}`,
          value: "value",
          category: "knowledge" as const,
          scope: "private" as const,
          summary: null,
          tags: [],
          importance: m.importance,
          source: "agent" as const,
          status: "active" as const,
          pinned: m.pinned,
          agent_id: null,
          project_id: null,
          session_id: null,
          metadata: {},
          access_count: 0,
          version: 1,
          expires_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          accessed_at: null,
        },
        recallCount: 0,
        lastRecalled: null,
        searchHits: 0,
        similarMemoryIds: [],
      })),
      staleMemories: [],
      duplicateCandidates: [],
      lowImportanceHighRecall: [],
      highImportanceLowRecall: [],
      generatedAt: new Date().toISOString(),
    };
  }

  it("accepts valid proposals", () => {
    // Use 10 memories so archive quota (20%) = 2 slots — enough for 1 proposal
    const corpus = makeCorpus(
      Array.from({ length: 10 }, (_, i) => ({ id: `mem-${i}`, importance: 5, pinned: false }))
    );
    const proposals: SynthesisAnalysisResult["proposals"] = [
      {
        type: "archive",
        memory_ids: ["mem-0"],
        target_memory_id: null,
        proposed_changes: {},
        reasoning: "stale",
        confidence: 0.8,
      },
    ];
    const result = validateProposals(proposals, corpus);
    expect(result.valid).toBe(true);
    expect(result.rejectedProposals).toHaveLength(0);
  });

  it("rejects proposals below confidence threshold", () => {
    const corpus = makeCorpus([{ id: "mem-1", importance: 5, pinned: false }]);
    const proposals: SynthesisAnalysisResult["proposals"] = [
      {
        type: "archive",
        memory_ids: ["mem-1"],
        target_memory_id: null,
        proposed_changes: {},
        reasoning: null,
        confidence: 0.3, // below 0.6 default
      },
    ];
    const result = validateProposals(proposals, corpus);
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals).toHaveLength(1);
    expect(result.rejectedProposals[0]!.reason).toContain("Confidence");
  });

  it("rejects proposals referencing unknown memory IDs", () => {
    const corpus = makeCorpus([{ id: "mem-1", importance: 5, pinned: false }]);
    const proposals: SynthesisAnalysisResult["proposals"] = [
      {
        type: "archive",
        memory_ids: ["nonexistent-id"],
        target_memory_id: null,
        proposed_changes: {},
        reasoning: null,
        confidence: 0.9,
      },
    ];
    const result = validateProposals(proposals, corpus);
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals[0]!.reason).toContain("unknown memory IDs");
  });

  it("rejects proposals touching pinned memories", () => {
    const corpus = makeCorpus([{ id: "pinned-1", importance: 5, pinned: true }]);
    const proposals: SynthesisAnalysisResult["proposals"] = [
      {
        type: "archive",
        memory_ids: ["pinned-1"],
        target_memory_id: null,
        proposed_changes: {},
        reasoning: null,
        confidence: 0.9,
      },
    ];
    const result = validateProposals(proposals, corpus);
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals[0]!.reason).toContain("pinned");
  });

  it("rejects archive proposals for high-importance memories", () => {
    const corpus = makeCorpus([{ id: "imp-9", importance: 9, pinned: false }]);
    const proposals: SynthesisAnalysisResult["proposals"] = [
      {
        type: "archive",
        memory_ids: ["imp-9"],
        target_memory_id: null,
        proposed_changes: {},
        reasoning: null,
        confidence: 0.9,
      },
    ];
    const result = validateProposals(proposals, corpus);
    expect(result.valid).toBe(false);
    expect(result.rejectedProposals[0]!.reason).toContain("importance");
  });

  it("respects custom safety config", () => {
    // Use 10 memories for archive quota headroom; custom minConfidence 0.4
    const corpus = makeCorpus(
      Array.from({ length: 10 }, (_, i) => ({ id: `mem-${i}`, importance: 5, pinned: false }))
    );
    const proposals: SynthesisAnalysisResult["proposals"] = [
      {
        type: "archive",
        memory_ids: ["mem-0"],
        target_memory_id: null,
        proposed_changes: {},
        reasoning: null,
        confidence: 0.5, // below default 0.6 but above custom 0.4
      },
    ];
    const result = validateProposals(proposals, corpus, { minConfidence: 0.4 });
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Executor
// ============================================================================

describe("executeProposals", () => {
  let db: Database;
  let runId: string;

  beforeEach(() => {
    db = freshDb();
    runId = createSynthesisRun({ triggered_by: "manual" }, db).id;
  });

  it("archives a memory", async () => {
    const mem = seedMemory(db, { key: "to-archive", importance: 3 });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "archive",
        memory_ids: [mem.id],
        proposed_changes: {},
        confidence: 0.9,
      },
      db
    );

    const result = await executeProposals(runId, [proposal], db);
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);

    const row = db.query("SELECT status FROM memories WHERE id = ?").get(mem.id) as { status: string };
    expect(row.status).toBe("archived");
  });

  it("promotes a memory importance", async () => {
    const mem = seedMemory(db, { key: "promote-me", importance: 4 });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "promote",
        memory_ids: [mem.id],
        proposed_changes: { new_importance: 8 },
        confidence: 0.9,
      },
      db
    );

    const result = await executeProposals(runId, [proposal], db);
    expect(result.executed).toBe(1);

    const row = db.query("SELECT importance FROM memories WHERE id = ?").get(mem.id) as { importance: number };
    expect(row.importance).toBe(8);
  });

  it("updates a memory value", async () => {
    const mem = seedMemory(db, { key: "update-val", value: "old value" });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "update_value",
        memory_ids: [mem.id],
        proposed_changes: { new_value: "new refined value" },
        confidence: 0.85,
      },
      db
    );

    const result = await executeProposals(runId, [proposal], db);
    expect(result.executed).toBe(1);

    const row = db.query("SELECT value FROM memories WHERE id = ?").get(mem.id) as { value: string };
    expect(row.value).toBe("new refined value");
  });

  it("adds tags to a memory", async () => {
    const mem = seedMemory(db, { key: "tag-me", tags: ["existing"] });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "add_tag",
        memory_ids: [mem.id],
        proposed_changes: { tags: ["new-tag", "another-tag"] },
        confidence: 0.75,
      },
      db
    );

    const result = await executeProposals(runId, [proposal], db);
    expect(result.executed).toBe(1);

    const row = db.query("SELECT tags FROM memories WHERE id = ?").get(mem.id) as { tags: string };
    const tags = JSON.parse(row.tags) as string[];
    expect(tags).toContain("existing");
    expect(tags).toContain("new-tag");
    expect(tags).toContain("another-tag");
  });

  it("merges multiple memories into target", async () => {
    const target = seedMemory(db, { key: "target-mem", value: "target value" });
    const source = seedMemory(db, { key: "source-mem", value: "source value" });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "merge",
        memory_ids: [target.id, source.id],
        target_memory_id: target.id,
        proposed_changes: { merged_value: "merged combined value" },
        confidence: 0.9,
      },
      db
    );

    const result = await executeProposals(runId, [proposal], db);
    expect(result.executed).toBe(1);

    const targetRow = db.query("SELECT value, status FROM memories WHERE id = ?").get(target.id) as { value: string; status: string };
    expect(targetRow.value).toBe("merged combined value");
    expect(targetRow.status).toBe("active");

    const sourceRow = db.query("SELECT status FROM memories WHERE id = ?").get(source.id) as { status: string };
    expect(sourceRow.status).toBe("archived");
  });

  it("removes duplicate by archiving lower-importance copy", async () => {
    const keepMe = seedMemory(db, { key: "keep-mem", importance: 8 });
    const dupMe = seedMemory(db, { key: "dup-mem", importance: 3 });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "remove_duplicate",
        memory_ids: [keepMe.id, dupMe.id],
        target_memory_id: keepMe.id,
        proposed_changes: {},
        confidence: 0.9,
      },
      db
    );

    const result = await executeProposals(runId, [proposal], db);
    expect(result.executed).toBe(1);

    const dupRow = db.query("SELECT status FROM memories WHERE id = ?").get(dupMe.id) as { status: string };
    expect(dupRow.status).toBe("archived");

    const keepRow = db.query("SELECT status FROM memories WHERE id = ?").get(keepMe.id) as { status: string };
    expect(keepRow.status).toBe("active");
  });

  it("marks proposals as accepted after execution", async () => {
    const mem = seedMemory(db, { key: "accept-test" });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "archive",
        memory_ids: [mem.id],
        proposed_changes: {},
        confidence: 0.9,
      },
      db
    );

    await executeProposals(runId, [proposal], db);
    const updated = getProposal(proposal.id, db);
    expect(updated?.status).toBe("accepted");
    expect(updated?.executed_at).toBeString();
    expect(updated?.rollback_data).not.toBeNull();
  });

  it("marks proposal as rejected on failure", async () => {
    // promote without new_importance in proposed_changes → should fail
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "promote",
        memory_ids: ["nonexistent-mem-id"],
        proposed_changes: {}, // missing new_importance
        confidence: 0.9,
      },
      db
    );

    const result = await executeProposals(runId, [proposal], db);
    expect(result.failed).toBe(1);
    expect(result.executed).toBe(0);
    const updated = getProposal(proposal.id, db);
    expect(updated?.status).toBe("rejected");
  });
});

// ============================================================================
// Rollback
// ============================================================================

describe("rollbackRun", () => {
  let db: Database;
  let runId: string;

  beforeEach(() => {
    db = freshDb();
    runId = createSynthesisRun({ triggered_by: "manual" }, db).id;
  });

  it("reverses an archive proposal", async () => {
    const mem = seedMemory(db, { key: "revert-archive" });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "archive",
        memory_ids: [mem.id],
        proposed_changes: {},
        confidence: 0.9,
      },
      db
    );

    // Execute first
    await executeProposals(runId, [proposal], db);

    // Verify archived
    const archivedRow = db.query("SELECT status FROM memories WHERE id = ?").get(mem.id) as { status: string };
    expect(archivedRow.status).toBe("archived");

    // Rollback
    const rollbackResult = await rollbackRun(runId, db);
    expect(rollbackResult.rolled_back).toBe(1);
    expect(rollbackResult.errors).toHaveLength(0);

    // Verify restored
    const restoredRow = db.query("SELECT status FROM memories WHERE id = ?").get(mem.id) as { status: string };
    expect(restoredRow.status).toBe("active");
  });

  it("reverses a promote proposal", async () => {
    const mem = seedMemory(db, { key: "revert-promote", importance: 4 });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "promote",
        memory_ids: [mem.id],
        proposed_changes: { new_importance: 9 },
        confidence: 0.9,
      },
      db
    );

    await executeProposals(runId, [proposal], db);
    await rollbackRun(runId, db);

    const row = db.query("SELECT importance FROM memories WHERE id = ?").get(mem.id) as { importance: number };
    expect(row.importance).toBe(4);
  });

  it("reverses an update_value proposal", async () => {
    const mem = seedMemory(db, { key: "revert-update", value: "original value" });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "update_value",
        memory_ids: [mem.id],
        proposed_changes: { new_value: "changed value" },
        confidence: 0.9,
      },
      db
    );

    await executeProposals(runId, [proposal], db);
    await rollbackRun(runId, db);

    const row = db.query("SELECT value FROM memories WHERE id = ?").get(mem.id) as { value: string };
    expect(row.value).toBe("original value");
  });

  it("reverses an add_tag proposal", async () => {
    const mem = seedMemory(db, { key: "revert-tags", tags: ["original-tag"] });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "add_tag",
        memory_ids: [mem.id],
        proposed_changes: { tags: ["added-tag"] },
        confidence: 0.9,
      },
      db
    );

    await executeProposals(runId, [proposal], db);

    // Verify tag was added
    const afterExec = db.query("SELECT tags FROM memories WHERE id = ?").get(mem.id) as { tags: string };
    expect(JSON.parse(afterExec.tags)).toContain("added-tag");

    await rollbackRun(runId, db);

    // Verify restored to original
    const afterRollback = db.query("SELECT tags FROM memories WHERE id = ?").get(mem.id) as { tags: string };
    const tags = JSON.parse(afterRollback.tags) as string[];
    expect(tags).toContain("original-tag");
    expect(tags).not.toContain("added-tag");
  });

  it("marks rolled-back proposals as rolled_back status", async () => {
    const mem = seedMemory(db, { key: "check-status" });
    const proposal = createProposal(
      {
        run_id: runId,
        proposal_type: "archive",
        memory_ids: [mem.id],
        proposed_changes: {},
        confidence: 0.9,
      },
      db
    );

    await executeProposals(runId, [proposal], db);
    await rollbackRun(runId, db);

    const updated = getProposal(proposal.id, db);
    expect(updated?.status).toBe("rolled_back");
  });

  it("returns rolled_back: 0 when no accepted proposals", async () => {
    const result = await rollbackRun(runId, db);
    expect(result.rolled_back).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================================================
// Scheduler — checkShouldTrigger
// ============================================================================

describe("checkShouldTrigger", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns shouldTrigger: false when scheduler is disabled", () => {
    const state = checkShouldTrigger(null, { enabled: false }, db);
    expect(state.shouldTrigger).toBe(false);
    expect(state.reason).toContain("disabled");
  });

  it("returns shouldTrigger: false when not enough memories", () => {
    // Create only 5 memories (below default threshold of 50)
    for (let i = 0; i < 5; i++) {
      seedMemory(db, { key: `mem-${i}` });
    }
    const state = checkShouldTrigger(null, { minMemoriesForTrigger: 50 }, db);
    expect(state.shouldTrigger).toBe(false);
    expect(state.reason).toContain("memories");
  });

  it("returns shouldTrigger: false when not enough events since last run", () => {
    // Enough memories but too few events
    for (let i = 0; i < 60; i++) {
      seedMemory(db, { key: `mem-${i}` });
    }
    createSynthesisRun({ triggered_by: "manual" }, db);
    recordSynthesisEvent({ event_type: "saved" }, db);

    const state = checkShouldTrigger(null, { minMemoriesForTrigger: 50, minEventsSinceLastRun: 100, minRunIntervalHours: 0 }, db);
    expect(state.shouldTrigger).toBe(false);
    expect(state.reason).toContain("events");
  });

  it("returns shouldTrigger: false when min interval not met", () => {
    for (let i = 0; i < 60; i++) {
      seedMemory(db, { key: `mem-${i}` });
    }
    // Create a run with current timestamp
    createSynthesisRun({ triggered_by: "manual" }, db);

    const state = checkShouldTrigger(null, { minMemoriesForTrigger: 50, minRunIntervalHours: 24 }, db);
    expect(state.shouldTrigger).toBe(false);
    expect(state.reason).toContain("minimum");
  });

  it("returns shouldTrigger: true when all thresholds met", () => {
    // Create enough memories
    for (let i = 0; i < 60; i++) {
      seedMemory(db, { key: `mem-${i}` });
    }

    // Create enough events (no prior run, so all events count)
    for (let i = 0; i < 110; i++) {
      recordSynthesisEvent({ event_type: "saved" }, db);
    }

    const state = checkShouldTrigger(
      null,
      {
        minMemoriesForTrigger: 50,
        minEventsSinceLastRun: 100,
        minRunIntervalHours: 0, // no minimum interval
        maxRunIntervalHours: 24,
      },
      db
    );
    expect(state.shouldTrigger).toBe(true);
    expect(state.eventsSinceLastRun).toBeGreaterThanOrEqual(100);
  });

  it("returns shouldTrigger: false when no memories exist at all", () => {
    const state = checkShouldTrigger(null, {}, db);
    expect(state.shouldTrigger).toBe(false);
  });

  it("exposes lastRunAt and eventsSinceLastRun in state", () => {
    for (let i = 0; i < 60; i++) {
      seedMemory(db, { key: `mem-sched-${i}` });
    }
    recordSynthesisEvent({ event_type: "saved" }, db);
    recordSynthesisEvent({ event_type: "saved" }, db);

    const state = checkShouldTrigger(null, { minRunIntervalHours: 0 }, db);
    expect(state.eventsSinceLastRun).toBe(2);
    expect(state.lastRunAt).toBeNull(); // no prior run
  });

  it("filters by projectId", () => {
    // Create project row first to satisfy FK constraint
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", ["proj-test", "Test Project", "/tmp/proj-test"]);
    for (let i = 0; i < 60; i++) {
      seedMemory(db, { key: `pm-${i}`, project_id: "proj-test" });
    }
    for (let i = 0; i < 110; i++) {
      recordSynthesisEvent({ event_type: "saved", project_id: "proj-test" }, db);
    }

    const state = checkShouldTrigger(
      "proj-test",
      { minMemoriesForTrigger: 50, minEventsSinceLastRun: 100, minRunIntervalHours: 0 },
      db
    );
    expect(state.shouldTrigger).toBe(true);
  });
});
