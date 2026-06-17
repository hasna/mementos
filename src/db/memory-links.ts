import { SqliteAdapter as Database } from "../storage.js";
import { getDatabase, now, shortUuid } from "./database.js";

type SQLValue = string | number | null | boolean;

export type MemoryLinkRelation =
  | "summarizes"
  | "merged_from"
  | "promotes"
  | "reflects_on"
  | "supersedes"
  | "related_to";

export interface MemoryLink {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation_type: MemoryLinkRelation;
  run_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

function parseMemoryLink(row: Record<string, unknown>): MemoryLink {
  return {
    id: row["id"] as string,
    source_memory_id: row["source_memory_id"] as string,
    target_memory_id: row["target_memory_id"] as string,
    relation_type: row["relation_type"] as MemoryLinkRelation,
    run_id: (row["run_id"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    created_at: row["created_at"] as string,
  };
}

export function createMemoryLink(
  input: {
    source_memory_id: string;
    target_memory_id: string;
    relation_type: MemoryLinkRelation;
    run_id?: string | null;
    metadata?: Record<string, unknown>;
  },
  db?: Database,
): MemoryLink {
  const d = db || getDatabase();
  const id = shortUuid();
  const timestamp = now();

  d.run(
    `INSERT OR IGNORE INTO memory_links (id, source_memory_id, target_memory_id, relation_type, run_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.source_memory_id,
      input.target_memory_id,
      input.relation_type,
      input.run_id ?? null,
      JSON.stringify(input.metadata ?? {}),
      timestamp,
    ],
  );

  const row = d
    .query(
      `SELECT * FROM memory_links
       WHERE source_memory_id = ? AND target_memory_id = ? AND relation_type = ? AND COALESCE(run_id, '') = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(
      input.source_memory_id,
      input.target_memory_id,
      input.relation_type,
      input.run_id ?? "",
    ) as Record<string, unknown> | null;

  if (!row) {
    throw new Error("Failed to create memory link");
  }
  return parseMemoryLink(row);
}

export function getMemoryLinks(
  memoryId: string,
  relationType?: MemoryLinkRelation,
  db?: Database,
): MemoryLink[] {
  const d = db || getDatabase();
  const conditions = ["source_memory_id = ?"];
  const params: SQLValue[] = [memoryId];
  if (relationType) {
    conditions.push("relation_type = ?");
    params.push(relationType);
  }

  const rows = d
    .query(`SELECT * FROM memory_links WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(parseMemoryLink);
}

export function getMemoryBacklinks(
  memoryId: string,
  relationType?: MemoryLinkRelation,
  db?: Database,
): MemoryLink[] {
  const d = db || getDatabase();
  const conditions = ["target_memory_id = ?"];
  const params: SQLValue[] = [memoryId];
  if (relationType) {
    conditions.push("relation_type = ?");
    params.push(relationType);
  }

  const rows = d
    .query(`SELECT * FROM memory_links WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(parseMemoryLink);
}
