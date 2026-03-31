// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import {
  createSynthesisRun,
  getSynthesisRun,
  listSynthesisRuns,
  updateSynthesisRun,
  createProposal,
  getProposal,
  listProposals,
  updateProposal,
  createMetric,
  listMetrics,
  recordSynthesisEvent,
  listSynthesisEvents,
} from "./synthesis.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

// ============================================================================
// SynthesisMetric CRUD — lines 324-352
// ============================================================================

describe("createMetric + listMetrics", () => {
  it("creates and lists metrics for a run", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });

    const m1 = createMetric({ run_id: run.id, metric_type: "corpus_size", value: 100 });
    const m2 = createMetric({ run_id: run.id, metric_type: "compression_ratio", value: 0.75, baseline: 1.0 });

    expect(m1.metric_type).toBe("corpus_size");
    expect(m1.value).toBe(100);
    expect(m1.baseline).toBeNull();

    expect(m2.metric_type).toBe("compression_ratio");
    expect(m2.value).toBe(0.75);
    expect(m2.baseline).toBe(1.0);

    const metrics = listMetrics(run.id);
    expect(metrics.length).toBe(2);
  });

  it("returns empty array for run with no metrics", () => {
    const run = createSynthesisRun({ triggered_by: "scheduler" });
    const metrics = listMetrics(run.id);
    expect(metrics).toEqual([]);
  });

  it("only lists metrics for the specified run", () => {
    const run1 = createSynthesisRun({ triggered_by: "manual" });
    const run2 = createSynthesisRun({ triggered_by: "manual" });

    createMetric({ run_id: run1.id, metric_type: "m1", value: 10 });
    createMetric({ run_id: run2.id, metric_type: "m2", value: 20 });

    const metrics1 = listMetrics(run1.id);
    expect(metrics1.length).toBe(1);
    expect(metrics1[0]!.metric_type).toBe("m1");
  });
});

// ============================================================================
// recordSynthesisEvent + listSynthesisEvents — lines 358-428
// ============================================================================

describe("recordSynthesisEvent + listSynthesisEvents", () => {
  it("records an event and lists it", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });

    recordSynthesisEvent({
      event_type: "recalled",
      memory_id: "mem-123",
      agent_id: "agent-abc",
      project_id: "proj-xyz",
      query: "search query",
      importance_at_time: 7,
      metadata: { extra: "data" },
    });

    const events = listSynthesisEvents({ event_type: "recalled" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find((e) => e.memory_id === "mem-123");
    expect(ev).toBeTruthy();
    expect(ev!.agent_id).toBe("agent-abc");
    expect(ev!.query).toBe("search query");
    expect(ev!.importance_at_time).toBe(7);
  });

  it("lists events filtered by memory_id", () => {
    recordSynthesisEvent({ event_type: "saved", memory_id: "mem-A" });
    recordSynthesisEvent({ event_type: "saved", memory_id: "mem-B" });
    recordSynthesisEvent({ event_type: "saved", memory_id: "mem-A" });

    const results = listSynthesisEvents({ memory_id: "mem-A" });
    expect(results.length).toBe(2);
    expect(results.every((e) => e.memory_id === "mem-A")).toBe(true);
  });

  it("lists events filtered by project_id", () => {
    recordSynthesisEvent({ event_type: "injected", project_id: "proj-1" });
    recordSynthesisEvent({ event_type: "injected", project_id: "proj-2" });

    const results = listSynthesisEvents({ project_id: "proj-1" });
    expect(results.length).toBe(1);
    expect(results[0]!.project_id).toBe("proj-1");
  });

  it("filters by since timestamp", () => {
    recordSynthesisEvent({ event_type: "searched" });

    const future = new Date(Date.now() + 86400000).toISOString();
    const noResults = listSynthesisEvents({ since: future });
    expect(noResults.length).toBe(0);
  });

  it("respects limit in listSynthesisEvents", () => {
    for (let i = 0; i < 5; i++) {
      recordSynthesisEvent({ event_type: "recalled", memory_id: `mem-${i}` });
    }
    const limited = listSynthesisEvents({ event_type: "recalled", limit: 2 });
    expect(limited.length).toBe(2);
  });

  it("never throws on event recording (fire and forget)", () => {
    expect(() => {
      recordSynthesisEvent({ event_type: "saved" });
    }).not.toThrow();
  });
});

// ============================================================================
// listSynthesisRuns with null project_id filter — lines 186-187
// ============================================================================

describe("listSynthesisRuns - filter edge cases", () => {
  it("filters by null project_id", () => {
    createSynthesisRun({ triggered_by: "manual", project_id: null });
    createSynthesisRun({ triggered_by: "manual", project_id: "proj-xyz" });

    const nullProj = listSynthesisRuns({ project_id: null });
    expect(nullProj.some((r) => r.project_id === null)).toBe(true);
  });

  it("filters by status", () => {
    const run1 = createSynthesisRun({ triggered_by: "manual" });
    const run2 = createSynthesisRun({ triggered_by: "scheduler" });
    updateSynthesisRun(run1.id, { status: "completed" });

    const pending = listSynthesisRuns({ status: "pending" });
    const completed = listSynthesisRuns({ status: "completed" });

    expect(pending.every((r) => r.status === "pending")).toBe(true);
    expect(completed.every((r) => r.status === "completed")).toBe(true);
  });

  it("respects limit in listSynthesisRuns", () => {
    for (let i = 0; i < 5; i++) {
      createSynthesisRun({ triggered_by: "manual" });
    }
    const limited = listSynthesisRuns({ limit: 2 });
    expect(limited.length).toBe(2);
  });
});

// ============================================================================
// updateProposal with rollback_data — line 307-309
// ============================================================================

describe("updateProposal - rollback_data", () => {
  it("stores rollback_data in proposal", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const proposal = createProposal({
      run_id: run.id,
      proposal_type: "archive",
      memory_ids: ["mem-1"],
      confidence: 0.8,
      proposed_changes: {},
    });

    const rollbackData = { original_status: "active", original_importance: 7 };
    const updated = updateProposal(proposal.id, {
      status: "accepted",
      rollback_data: rollbackData,
    });

    expect(updated!.rollback_data).toEqual(rollbackData);
    expect(updated!.status).toBe("accepted");
  });

  it("returns proposal unchanged when no updates", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const proposal = createProposal({
      run_id: run.id,
      proposal_type: "add_tag",
      memory_ids: ["mem-2"],
      confidence: 0.9,
      proposed_changes: {},
    });

    const unchanged = updateProposal(proposal.id, {});
    expect(unchanged!.id).toBe(proposal.id);
  });
});
