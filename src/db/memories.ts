import { Database, type SQLQueryBindings } from "bun:sqlite";
import type {
  CreateMemoryInput,
  DedupeMode,
  Memory,
  MemoryFilter,
  UpdateMemoryInput,
} from "../types/index.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
} from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";

// ============================================================================
// Helpers
// ============================================================================

export function parseMemoryRow(row: Record<string, unknown>): Memory {
  return {
    id: row["id"] as string,
    key: row["key"] as string,
    value: row["value"] as string,
    category: row["category"] as Memory["category"],
    scope: row["scope"] as Memory["scope"],
    summary: (row["summary"] as string) || null,
    tags: JSON.parse((row["tags"] as string) || "[]") as string[],
    importance: row["importance"] as number,
    source: row["source"] as Memory["source"],
    status: row["status"] as Memory["status"],
    pinned: !!(row["pinned"] as number),
    agent_id: (row["agent_id"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    session_id: (row["session_id"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    access_count: row["access_count"] as number,
    version: row["version"] as number,
    expires_at: (row["expires_at"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    accessed_at: (row["accessed_at"] as string) || null,
  };
}

// ============================================================================
// Create
// ============================================================================

export function createMemory(
  input: CreateMemoryInput,
  dedupeMode: DedupeMode = "merge",
  db?: Database
): Memory {
  const d = db || getDatabase();
  const timestamp = now();

  // Handle TTL
  let expiresAt = input.expires_at || null;
  if (input.ttl_ms && !expiresAt) {
    expiresAt = new Date(Date.now() + input.ttl_ms).toISOString();
  }

  const id = uuid();
  const tags = input.tags || [];
  const tagsJson = JSON.stringify(tags);
  const metadataJson = JSON.stringify(input.metadata || {});

  if (dedupeMode === "merge") {
    // Try upsert: if key+scope+agent+project+session already exists, update value
    const existing = d
      .query(
        `SELECT id, version FROM memories
         WHERE key = ? AND scope = ?
           AND COALESCE(agent_id, '') = ?
           AND COALESCE(project_id, '') = ?
           AND COALESCE(session_id, '') = ?`
      )
      .get(
        input.key,
        input.scope || "private",
        input.agent_id || "",
        input.project_id || "",
        input.session_id || ""
      ) as { id: string; version: number } | null;

    if (existing) {
      d.run(
        `UPDATE memories SET
           value = ?, category = ?, summary = ?, tags = ?,
           importance = ?, metadata = ?, expires_at = ?,
           pinned = COALESCE(pinned, 0),
           version = version + 1, updated_at = ?
         WHERE id = ?`,
        [
          input.value,
          input.category || "knowledge",
          input.summary || null,
          tagsJson,
          input.importance ?? 5,
          metadataJson,
          expiresAt,
          timestamp,
          existing.id,
        ]
      );

      // Update tags
      d.run("DELETE FROM memory_tags WHERE memory_id = ?", [existing.id]);
      const insertTag = d.prepare(
        "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
      );
      for (const tag of tags) {
        insertTag.run(existing.id, tag);
      }

      return getMemory(existing.id, d)!;
    }
  }

  // Insert new
  d.run(
    `INSERT INTO memories (id, key, value, category, scope, summary, tags, importance, source, status, pinned, agent_id, project_id, session_id, metadata, access_count, version, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
    [
      id,
      input.key,
      input.value,
      input.category || "knowledge",
      input.scope || "private",
      input.summary || null,
      tagsJson,
      input.importance ?? 5,
      input.source || "agent",
      input.agent_id || null,
      input.project_id || null,
      input.session_id || null,
      metadataJson,
      expiresAt,
      timestamp,
      timestamp,
    ]
  );

  // Insert tags
  const insertTag = d.prepare(
    "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
  );
  for (const tag of tags) {
    insertTag.run(id, tag);
  }

  return getMemory(id, d)!;
}

// ============================================================================
// Read
// ============================================================================

export function getMemory(id: string, db?: Database): Memory | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM memories WHERE id = ?").get(id) as
    | Record<string, unknown>
    | null;
  if (!row) return null;
  return parseMemoryRow(row);
}

export function getMemoryByKey(
  key: string,
  scope?: string,
  agentId?: string,
  projectId?: string,
  sessionId?: string,
  db?: Database
): Memory | null {
  const d = db || getDatabase();

  let sql = "SELECT * FROM memories WHERE key = ?";
  const params: SQLQueryBindings[] = [key];

  if (scope) {
    sql += " AND scope = ?";
    params.push(scope);
  }
  if (agentId) {
    sql += " AND agent_id = ?";
    params.push(agentId);
  }
  if (projectId) {
    sql += " AND project_id = ?";
    params.push(projectId);
  }
  if (sessionId) {
    sql += " AND session_id = ?";
    params.push(sessionId);
  }

  sql += " AND status = 'active' ORDER BY importance DESC LIMIT 1";

  const row = d.query(sql).get(...params) as Record<string, unknown> | null;
  if (!row) return null;
  return parseMemoryRow(row);
}

// ============================================================================
// List
// ============================================================================

export function listMemories(filter?: MemoryFilter, db?: Database): Memory[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter) {
    if (filter.scope) {
      if (Array.isArray(filter.scope)) {
        conditions.push(`scope IN (${filter.scope.map(() => "?").join(",")})`);
        params.push(...filter.scope);
      } else {
        conditions.push("scope = ?");
        params.push(filter.scope);
      }
    }
    if (filter.category) {
      if (Array.isArray(filter.category)) {
        conditions.push(
          `category IN (${filter.category.map(() => "?").join(",")})`
        );
        params.push(...filter.category);
      } else {
        conditions.push("category = ?");
        params.push(filter.category);
      }
    }
    if (filter.source) {
      if (Array.isArray(filter.source)) {
        conditions.push(
          `source IN (${filter.source.map(() => "?").join(",")})`
        );
        params.push(...filter.source);
      } else {
        conditions.push("source = ?");
        params.push(filter.source);
      }
    }
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        conditions.push(
          `status IN (${filter.status.map(() => "?").join(",")})`
        );
        params.push(...filter.status);
      } else {
        conditions.push("status = ?");
        params.push(filter.status);
      }
    } else {
      // Default: only active memories
      conditions.push("status = 'active'");
    }
    if (filter.project_id) {
      conditions.push("project_id = ?");
      params.push(filter.project_id);
    }
    if (filter.agent_id) {
      conditions.push("agent_id = ?");
      params.push(filter.agent_id);
    }
    if (filter.session_id) {
      conditions.push("session_id = ?");
      params.push(filter.session_id);
    }
    if (filter.min_importance) {
      conditions.push("importance >= ?");
      params.push(filter.min_importance);
    }
    if (filter.pinned !== undefined) {
      conditions.push("pinned = ?");
      params.push(filter.pinned ? 1 : 0);
    }
    if (filter.tags && filter.tags.length > 0) {
      // AND match: memory must have ALL specified tags
      for (const tag of filter.tags) {
        conditions.push(
          "id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)"
        );
        params.push(tag);
      }
    }
    if (filter.search) {
      conditions.push(
        "(key LIKE ? OR value LIKE ? OR summary LIKE ?)"
      );
      const term = `%${filter.search}%`;
      params.push(term, term, term);
    }
  } else {
    conditions.push("status = 'active'");
  }

  let sql = "SELECT * FROM memories";
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  sql += " ORDER BY importance DESC, created_at DESC";

  if (filter?.limit) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }
  if (filter?.offset) {
    sql += " OFFSET ?";
    params.push(filter.offset);
  }

  const rows = d.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseMemoryRow);
}

// ============================================================================
// Update
// ============================================================================

export function updateMemory(
  id: string,
  input: UpdateMemoryInput,
  db?: Database
): Memory {
  const d = db || getDatabase();
  const existing = getMemory(id, d);
  if (!existing) throw new MemoryNotFoundError(id);

  if (existing.version !== input.version) {
    throw new VersionConflictError(id, input.version, existing.version);
  }

  const sets: string[] = ["version = version + 1", "updated_at = ?"];
  const params: SQLQueryBindings[] = [now()];

  if (input.value !== undefined) {
    sets.push("value = ?");
    params.push(input.value);
  }
  if (input.category !== undefined) {
    sets.push("category = ?");
    params.push(input.category);
  }
  if (input.scope !== undefined) {
    sets.push("scope = ?");
    params.push(input.scope);
  }
  if (input.summary !== undefined) {
    sets.push("summary = ?");
    params.push(input.summary);
  }
  if (input.importance !== undefined) {
    sets.push("importance = ?");
    params.push(input.importance);
  }
  if (input.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(input.pinned ? 1 : 0);
  }
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }
  if (input.metadata !== undefined) {
    sets.push("metadata = ?");
    params.push(JSON.stringify(input.metadata));
  }
  if (input.expires_at !== undefined) {
    sets.push("expires_at = ?");
    params.push(input.expires_at);
  }
  if (input.tags !== undefined) {
    sets.push("tags = ?");
    params.push(JSON.stringify(input.tags));
    // Update tags table
    d.run("DELETE FROM memory_tags WHERE memory_id = ?", [id]);
    const insertTag = d.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );
    for (const tag of input.tags) {
      insertTag.run(id, tag);
    }
  }

  params.push(id);
  d.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params);

  return getMemory(id, d)!;
}

// ============================================================================
// Delete
// ============================================================================

export function deleteMemory(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM memories WHERE id = ?", [id]);
  return result.changes > 0;
}

export function bulkDeleteMemories(ids: string[], db?: Database): number {
  const d = db || getDatabase();
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(",");
  const result = d.run(
    `DELETE FROM memories WHERE id IN (${placeholders})`,
    ids as SQLQueryBindings[]
  );
  return result.changes;
}

// ============================================================================
// Touch (update access tracking)
// ============================================================================

export function touchMemory(id: string, db?: Database): void {
  const d = db || getDatabase();
  d.run(
    "UPDATE memories SET access_count = access_count + 1, accessed_at = ? WHERE id = ?",
    [now(), id]
  );
}

// ============================================================================
// Cleanup
// ============================================================================

export function cleanExpiredMemories(db?: Database): number {
  const d = db || getDatabase();
  const timestamp = now();
  const result = d.run(
    "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?",
    [timestamp]
  );
  return result.changes;
}
