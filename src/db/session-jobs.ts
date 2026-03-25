import { SqliteAdapter as Database } from "@hasna/cloud";
type SQLQueryBindings = string | number | null | boolean;
import { getDatabase, now, uuid } from "./database.js";

export type SessionJobSource = "claude-code" | "codex" | "manual" | "open-sessions";
export type SessionJobStatus = "pending" | "processing" | "completed" | "failed";

export interface SessionMemoryJob {
  id: string;
  session_id: string;
  agent_id: string | null;
  project_id: string | null;
  source: SessionJobSource;
  status: SessionJobStatus;
  transcript: string;
  chunk_count: number;
  memories_extracted: number;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateSessionJobInput {
  session_id: string;
  transcript: string;
  source?: SessionJobSource;
  agent_id?: string;
  project_id?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionJobFilter {
  agent_id?: string;
  project_id?: string;
  status?: SessionJobStatus;
  session_id?: string;
  limit?: number;
  offset?: number;
}

export interface UpdateSessionJobInput {
  status?: SessionJobStatus;
  chunk_count?: number;
  memories_extracted?: number;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

// ============================================================================
// Parsers
// ============================================================================

function parseJobRow(row: Record<string, unknown>): SessionMemoryJob {
  return {
    id: row["id"] as string,
    session_id: row["session_id"] as string,
    agent_id: (row["agent_id"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    source: row["source"] as SessionJobSource,
    status: row["status"] as SessionJobStatus,
    transcript: row["transcript"] as string,
    chunk_count: row["chunk_count"] as number,
    memories_extracted: row["memories_extracted"] as number,
    error: (row["error"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    created_at: row["created_at"] as string,
    started_at: (row["started_at"] as string) || null,
    completed_at: (row["completed_at"] as string) || null,
  };
}

// ============================================================================
// CRUD
// ============================================================================

export function createSessionJob(
  input: CreateSessionJobInput,
  db?: Database
): SessionMemoryJob {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  const source = input.source ?? "manual";
  const metadata = JSON.stringify(input.metadata ?? {});

  d.run(
    `INSERT INTO session_memory_jobs
      (id, session_id, agent_id, project_id, source, status, transcript, chunk_count, memories_extracted, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?)`,
    [
      id,
      input.session_id,
      input.agent_id ?? null,
      input.project_id ?? null,
      source,
      input.transcript,
      metadata,
      timestamp,
    ]
  );

  return getSessionJob(id, d)!;
}

export function getSessionJob(id: string, db?: Database): SessionMemoryJob | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM session_memory_jobs WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return parseJobRow(row);
}

export function listSessionJobs(
  filter?: SessionJobFilter,
  db?: Database
): SessionMemoryJob[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter?.agent_id) {
    conditions.push("agent_id = ?");
    params.push(filter.agent_id);
  }
  if (filter?.project_id) {
    conditions.push("project_id = ?");
    params.push(filter.project_id);
  }
  if (filter?.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.session_id) {
    conditions.push("session_id = ?");
    params.push(filter.session_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter?.limit ?? 20;
  const offset = filter?.offset ?? 0;

  const rows = d
    .query(
      `SELECT * FROM session_memory_jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(parseJobRow);
}

export function updateSessionJob(
  id: string,
  updates: UpdateSessionJobInput,
  db?: Database
): SessionMemoryJob | null {
  const d = db || getDatabase();

  const setClauses: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    params.push(updates.status);
  }
  if (updates.chunk_count !== undefined) {
    setClauses.push("chunk_count = ?");
    params.push(updates.chunk_count);
  }
  if (updates.memories_extracted !== undefined) {
    setClauses.push("memories_extracted = ?");
    params.push(updates.memories_extracted);
  }
  if ("error" in updates) {
    setClauses.push("error = ?");
    params.push(updates.error ?? null);
  }
  if ("started_at" in updates) {
    setClauses.push("started_at = ?");
    params.push(updates.started_at ?? null);
  }
  if ("completed_at" in updates) {
    setClauses.push("completed_at = ?");
    params.push(updates.completed_at ?? null);
  }

  if (setClauses.length === 0) return getSessionJob(id, d);

  params.push(id);
  d.run(
    `UPDATE session_memory_jobs SET ${setClauses.join(", ")} WHERE id = ?`,
    params
  );

  return getSessionJob(id, d);
}

export function getNextPendingJob(db?: Database): SessionMemoryJob | null {
  const d = db || getDatabase();
  const row = d
    .query(
      "SELECT * FROM session_memory_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    )
    .get() as Record<string, unknown> | null;
  if (!row) return null;
  return parseJobRow(row);
}
