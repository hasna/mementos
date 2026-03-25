import { SqliteAdapter as Database } from "@hasna/cloud";
type SQLQueryBindings = string | number | null | boolean;
import { getDatabase, now, shortUuid } from "./database.js";

// ============================================================================
// Types
// ============================================================================

export interface SynthesisRun {
  id: string;
  triggered_by: "scheduler" | "manual" | "threshold" | "hook";
  project_id: string | null;
  agent_id: string | null;
  corpus_size: number;
  proposals_generated: number;
  proposals_accepted: number;
  proposals_rejected: number;
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface SynthesisProposal {
  id: string;
  run_id: string;
  proposal_type: "merge" | "archive" | "promote" | "update_value" | "add_tag" | "remove_duplicate";
  memory_ids: string[];
  target_memory_id: string | null;
  proposed_changes: Record<string, unknown>;
  reasoning: string | null;
  confidence: number;
  status: "pending" | "accepted" | "rejected" | "rolled_back";
  created_at: string;
  executed_at: string | null;
  rollback_data: Record<string, unknown> | null;
}

export interface SynthesisMetric {
  id: string;
  run_id: string;
  metric_type: string;
  value: number;
  baseline: number | null;
  created_at: string;
}

export interface SynthesisEvent {
  id: string;
  event_type: "recalled" | "searched" | "saved" | "updated" | "deleted" | "injected";
  memory_id: string | null;
  agent_id: string | null;
  project_id: string | null;
  session_id: string | null;
  query: string | null;
  importance_at_time: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ============================================================================
// Row parsers
// ============================================================================

function parseRunRow(row: Record<string, unknown>): SynthesisRun {
  return {
    id: row["id"] as string,
    triggered_by: row["triggered_by"] as SynthesisRun["triggered_by"],
    project_id: (row["project_id"] as string) || null,
    agent_id: (row["agent_id"] as string) || null,
    corpus_size: row["corpus_size"] as number,
    proposals_generated: row["proposals_generated"] as number,
    proposals_accepted: row["proposals_accepted"] as number,
    proposals_rejected: row["proposals_rejected"] as number,
    status: row["status"] as SynthesisRun["status"],
    error: (row["error"] as string) || null,
    started_at: row["started_at"] as string,
    completed_at: (row["completed_at"] as string) || null,
  };
}

function parseProposalRow(row: Record<string, unknown>): SynthesisProposal {
  return {
    id: row["id"] as string,
    run_id: row["run_id"] as string,
    proposal_type: row["proposal_type"] as SynthesisProposal["proposal_type"],
    memory_ids: JSON.parse((row["memory_ids"] as string) || "[]") as string[],
    target_memory_id: (row["target_memory_id"] as string) || null,
    proposed_changes: JSON.parse((row["proposed_changes"] as string) || "{}") as Record<string, unknown>,
    reasoning: (row["reasoning"] as string) || null,
    confidence: row["confidence"] as number,
    status: row["status"] as SynthesisProposal["status"],
    created_at: row["created_at"] as string,
    executed_at: (row["executed_at"] as string) || null,
    rollback_data: row["rollback_data"]
      ? (JSON.parse(row["rollback_data"] as string) as Record<string, unknown>)
      : null,
  };
}

function parseMetricRow(row: Record<string, unknown>): SynthesisMetric {
  return {
    id: row["id"] as string,
    run_id: row["run_id"] as string,
    metric_type: row["metric_type"] as string,
    value: row["value"] as number,
    baseline: row["baseline"] != null ? (row["baseline"] as number) : null,
    created_at: row["created_at"] as string,
  };
}

function parseEventRow(row: Record<string, unknown>): SynthesisEvent {
  return {
    id: row["id"] as string,
    event_type: row["event_type"] as SynthesisEvent["event_type"],
    memory_id: (row["memory_id"] as string) || null,
    agent_id: (row["agent_id"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    session_id: (row["session_id"] as string) || null,
    query: (row["query"] as string) || null,
    importance_at_time: row["importance_at_time"] != null ? (row["importance_at_time"] as number) : null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    created_at: row["created_at"] as string,
  };
}

// ============================================================================
// SynthesisRun CRUD
// ============================================================================

export function createSynthesisRun(
  input: {
    triggered_by: SynthesisRun["triggered_by"];
    project_id?: string | null;
    agent_id?: string | null;
    corpus_size?: number;
  },
  db?: Database
): SynthesisRun {
  const d = db || getDatabase();
  const id = shortUuid();
  const timestamp = now();

  d.run(
    `INSERT INTO synthesis_runs (id, triggered_by, project_id, agent_id, corpus_size, proposals_generated, proposals_accepted, proposals_rejected, status, started_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'pending', ?)`,
    [
      id,
      input.triggered_by,
      input.project_id ?? null,
      input.agent_id ?? null,
      input.corpus_size ?? 0,
      timestamp,
    ]
  );

  return getSynthesisRun(id, d)!;
}

export function getSynthesisRun(id: string, db?: Database): SynthesisRun | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM synthesis_runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | null;
  if (!row) return null;
  return parseRunRow(row);
}

export function listSynthesisRuns(
  filter: { project_id?: string | null; status?: SynthesisRun["status"]; limit?: number },
  db?: Database
): SynthesisRun[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.project_id !== undefined) {
    if (filter.project_id === null) {
      conditions.push("project_id IS NULL");
    } else {
      conditions.push("project_id = ?");
      params.push(filter.project_id);
    }
  }
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }

  let sql = "SELECT * FROM synthesis_runs";
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  sql += " ORDER BY started_at DESC";
  if (filter.limit) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }

  const rows = d.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseRunRow);
}

export function updateSynthesisRun(
  id: string,
  updates: Partial<Pick<SynthesisRun, "status" | "error" | "corpus_size" | "proposals_generated" | "proposals_accepted" | "proposals_rejected" | "completed_at">>,
  db?: Database
): SynthesisRun {
  const d = db || getDatabase();
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
  if (updates.error !== undefined) { sets.push("error = ?"); params.push(updates.error); }
  if (updates.corpus_size !== undefined) { sets.push("corpus_size = ?"); params.push(updates.corpus_size); }
  if (updates.proposals_generated !== undefined) { sets.push("proposals_generated = ?"); params.push(updates.proposals_generated); }
  if (updates.proposals_accepted !== undefined) { sets.push("proposals_accepted = ?"); params.push(updates.proposals_accepted); }
  if (updates.proposals_rejected !== undefined) { sets.push("proposals_rejected = ?"); params.push(updates.proposals_rejected); }
  if (updates.completed_at !== undefined) { sets.push("completed_at = ?"); params.push(updates.completed_at); }

  if (sets.length === 0) return getSynthesisRun(id, d)!;

  params.push(id);
  d.run(`UPDATE synthesis_runs SET ${sets.join(", ")} WHERE id = ?`, params);

  return getSynthesisRun(id, d)!;
}

// ============================================================================
// SynthesisProposal CRUD
// ============================================================================

export function createProposal(
  input: {
    run_id: string;
    proposal_type: SynthesisProposal["proposal_type"];
    memory_ids: string[];
    target_memory_id?: string | null;
    proposed_changes: Record<string, unknown>;
    reasoning?: string | null;
    confidence: number;
  },
  db?: Database
): SynthesisProposal {
  const d = db || getDatabase();
  const id = shortUuid();
  const timestamp = now();

  d.run(
    `INSERT INTO synthesis_proposals (id, run_id, proposal_type, memory_ids, target_memory_id, proposed_changes, reasoning, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id,
      input.run_id,
      input.proposal_type,
      JSON.stringify(input.memory_ids),
      input.target_memory_id ?? null,
      JSON.stringify(input.proposed_changes),
      input.reasoning ?? null,
      input.confidence,
      timestamp,
    ]
  );

  return getProposal(id, d)!;
}

export function getProposal(id: string, db?: Database): SynthesisProposal | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM synthesis_proposals WHERE id = ?").get(id) as
    | Record<string, unknown>
    | null;
  if (!row) return null;
  return parseProposalRow(row);
}

export function listProposals(
  run_id: string,
  filter?: { status?: SynthesisProposal["status"] },
  db?: Database
): SynthesisProposal[] {
  const d = db || getDatabase();
  const params: SQLQueryBindings[] = [run_id];
  let sql = "SELECT * FROM synthesis_proposals WHERE run_id = ?";

  if (filter?.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }
  sql += " ORDER BY created_at ASC";

  const rows = d.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseProposalRow);
}

export function updateProposal(
  id: string,
  updates: Partial<Pick<SynthesisProposal, "status" | "executed_at" | "rollback_data">>,
  db?: Database
): SynthesisProposal {
  const d = db || getDatabase();
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
  if (updates.executed_at !== undefined) { sets.push("executed_at = ?"); params.push(updates.executed_at); }
  if (updates.rollback_data !== undefined) {
    sets.push("rollback_data = ?");
    params.push(JSON.stringify(updates.rollback_data));
  }

  if (sets.length === 0) return getProposal(id, d)!;

  params.push(id);
  d.run(`UPDATE synthesis_proposals SET ${sets.join(", ")} WHERE id = ?`, params);

  return getProposal(id, d)!;
}

// ============================================================================
// SynthesisMetric CRUD
// ============================================================================

export function createMetric(
  input: {
    run_id: string;
    metric_type: string;
    value: number;
    baseline?: number | null;
  },
  db?: Database
): SynthesisMetric {
  const d = db || getDatabase();
  const id = shortUuid();
  const timestamp = now();

  d.run(
    `INSERT INTO synthesis_metrics (id, run_id, metric_type, value, baseline, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.run_id, input.metric_type, input.value, input.baseline ?? null, timestamp]
  );

  return { id, run_id: input.run_id, metric_type: input.metric_type, value: input.value, baseline: input.baseline ?? null, created_at: timestamp };
}

export function listMetrics(run_id: string, db?: Database): SynthesisMetric[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM synthesis_metrics WHERE run_id = ? ORDER BY created_at ASC")
    .all(run_id) as Record<string, unknown>[];
  return rows.map(parseMetricRow);
}

// ============================================================================
// SynthesisEvent — fire-and-forget
// ============================================================================

export function recordSynthesisEvent(
  input: {
    event_type: SynthesisEvent["event_type"];
    memory_id?: string | null;
    agent_id?: string | null;
    project_id?: string | null;
    session_id?: string | null;
    query?: string | null;
    importance_at_time?: number | null;
    metadata?: Record<string, unknown>;
  },
  db?: Database
): void {
  try {
    const d = db || getDatabase();
    const id = shortUuid();
    const timestamp = now();

    d.run(
      `INSERT INTO synthesis_events (id, event_type, memory_id, agent_id, project_id, session_id, query, importance_at_time, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.event_type,
        input.memory_id ?? null,
        input.agent_id ?? null,
        input.project_id ?? null,
        input.session_id ?? null,
        input.query ?? null,
        input.importance_at_time ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
      ]
    );
  } catch {
    // Fire-and-forget: never throw
  }
}

export function listSynthesisEvents(
  filter: {
    memory_id?: string;
    project_id?: string;
    event_type?: SynthesisEvent["event_type"];
    since?: string;
    limit?: number;
  },
  db?: Database
): SynthesisEvent[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.memory_id) { conditions.push("memory_id = ?"); params.push(filter.memory_id); }
  if (filter.project_id) { conditions.push("project_id = ?"); params.push(filter.project_id); }
  if (filter.event_type) { conditions.push("event_type = ?"); params.push(filter.event_type); }
  if (filter.since) { conditions.push("created_at >= ?"); params.push(filter.since); }

  let sql = "SELECT * FROM synthesis_events";
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  sql += " ORDER BY created_at DESC";
  if (filter.limit) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }

  const rows = d.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseEventRow);
}
