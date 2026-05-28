process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase } from "./database.js";
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
} from "./synthesis.js";

beforeEach(() => {
  resetDatabase();
});

describe("SynthesisRun CRUD", () => {
  test("creates a synthesis run", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    expect(run.id).toBeTruthy();
    expect(run.triggered_by).toBe("manual");
    expect(run.status).toBe("pending");
    expect(run.proposals_generated).toBe(0);
    expect(run.proposals_accepted).toBe(0);
    expect(run.proposals_rejected).toBe(0);
    expect(run.started_at).toBeTruthy();
  });

  test("creates with project_id and agent_id", () => {
    const run = createSynthesisRun({
      triggered_by: "threshold",
      project_id: "proj-1",
      agent_id: "agent-1",
      corpus_size: 42,
    });
    expect(run.project_id).toBe("proj-1");
    expect(run.agent_id).toBe("agent-1");
    expect(run.corpus_size).toBe(42);
  });

  test("gets a synthesis run by id", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const fetched = getSynthesisRun(run.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(run.id);
  });

  test("returns null for non-existent run", () => {
    expect(getSynthesisRun("nonexistent")).toBeNull();
  });

  test("lists synthesis runs", () => {
    createSynthesisRun({ triggered_by: "manual" });
    createSynthesisRun({ triggered_by: "scheduler" });
    const runs = listSynthesisRuns({});
    expect(runs).toHaveLength(2);
  });

  test("lists by project_id", () => {
    createSynthesisRun({ triggered_by: "manual", project_id: "proj-1" });
    createSynthesisRun({ triggered_by: "manual", project_id: "proj-2" });
    const runs = listSynthesisRuns({ project_id: "proj-1" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.project_id).toBe("proj-1");
  });

  test("lists by status", () => {
    createSynthesisRun({ triggered_by: "manual" });
    const runs = listSynthesisRuns({ status: "pending" });
    expect(runs).toHaveLength(1);
  });

  test("lists with limit", () => {
    createSynthesisRun({ triggered_by: "manual" });
    createSynthesisRun({ triggered_by: "manual" });
    createSynthesisRun({ triggered_by: "manual" });
    const runs = listSynthesisRuns({ limit: 2 });
    expect(runs).toHaveLength(2);
  });

  test("updates synthesis run fields", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const updated = updateSynthesisRun(run.id, {
      status: "completed",
      corpus_size: 100,
      proposals_generated: 5,
      proposals_accepted: 3,
      proposals_rejected: 2,
      completed_at: new Date().toISOString(),
    });
    expect(updated.status).toBe("completed");
    expect(updated.corpus_size).toBe(100);
    expect(updated.proposals_generated).toBe(5);
    expect(updated.proposals_accepted).toBe(3);
    expect(updated.proposals_rejected).toBe(2);
    expect(updated.completed_at).toBeTruthy();
  });

  test("update with error field", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const updated = updateSynthesisRun(run.id, { status: "failed", error: "Something broke" });
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("Something broke");
  });
});

describe("SynthesisProposal CRUD", () => {
  test("creates a proposal linked to a run", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const prop = createProposal({
      run_id: run.id,
      proposal_type: "merge",
      memory_ids: ["mem-1", "mem-2"],
      proposed_changes: { new_value: "merged content" },
      reasoning: "These are duplicates",
      confidence: 0.95,
    });
    expect(prop.id).toBeTruthy();
    expect(prop.run_id).toBe(run.id);
    expect(prop.proposal_type).toBe("merge");
    expect(prop.memory_ids).toEqual(["mem-1", "mem-2"]);
    expect(prop.confidence).toBe(0.95);
    expect(prop.status).toBe("pending");
  });

  test("gets a proposal by id", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const prop = createProposal({
      run_id: run.id,
      proposal_type: "archive",
      memory_ids: ["mem-3"],
      proposed_changes: { new_status: "archived" },
      confidence: 0.8,
    });
    const fetched = getProposal(prop.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.proposal_type).toBe("archive");
  });

  test("lists proposals for a run", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    createProposal({
      run_id: run.id, proposal_type: "merge", memory_ids: ["a"],
      proposed_changes: {}, confidence: 0.5,
    });
    createProposal({
      run_id: run.id, proposal_type: "archive", memory_ids: ["b"],
      proposed_changes: {}, confidence: 0.5,
    });
    const props = listProposals(run.id);
    expect(props).toHaveLength(2);
  });

  test("lists proposals by status", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    createProposal({
      run_id: run.id, proposal_type: "merge", memory_ids: ["a"],
      proposed_changes: {}, confidence: 0.5,
    });
    const pending = listProposals(run.id, { status: "pending" });
    expect(pending).toHaveLength(1);
    const accepted = listProposals(run.id, { status: "accepted" });
    expect(accepted).toHaveLength(0);
  });

  test("updates proposal status", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const prop = createProposal({
      run_id: run.id, proposal_type: "promote", memory_ids: ["mem-1"],
      proposed_changes: { new_importance: 8 }, confidence: 0.7,
    });
    const updated = updateProposal(prop.id, {
      status: "accepted",
      executed_at: new Date().toISOString(),
    });
    expect(updated.status).toBe("accepted");
    expect(updated.executed_at).toBeTruthy();
  });

  test("updates proposal with rollback_data", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const prop = createProposal({
      run_id: run.id, proposal_type: "merge", memory_ids: ["mem-1"],
      proposed_changes: {}, confidence: 0.5,
    });
    const updated = updateProposal(prop.id, {
      rollback_data: { previous_value: "old" },
    });
    expect(updated.rollback_data).toEqual({ previous_value: "old" });
  });
});

describe("SynthesisMetric CRUD", () => {
  test("creates a metric", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    const metric = createMetric({
      run_id: run.id,
      metric_type: "corpus_reduction_pct",
      value: 12.5,
      baseline: 0,
    });
    expect(metric.id).toBeTruthy();
    expect(metric.metric_type).toBe("corpus_reduction_pct");
    expect(metric.value).toBe(12.5);
    expect(metric.baseline).toBe(0);
  });

  test("lists metrics for a run", () => {
    const run = createSynthesisRun({ triggered_by: "manual" });
    createMetric({ run_id: run.id, metric_type: "a", value: 1 });
    createMetric({ run_id: run.id, metric_type: "b", value: 2 });
    const metrics = listMetrics(run.id);
    expect(metrics).toHaveLength(2);
  });

  test("only returns metrics for the specified run", () => {
    const run1 = createSynthesisRun({ triggered_by: "manual" });
    const run2 = createSynthesisRun({ triggered_by: "manual" });
    createMetric({ run_id: run1.id, metric_type: "a", value: 1 });
    createMetric({ run_id: run2.id, metric_type: "b", value: 2 });
    expect(listMetrics(run1.id)).toHaveLength(1);
    expect(listMetrics(run2.id)).toHaveLength(1);
  });
});
