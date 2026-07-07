import { SqliteAdapter as Database } from "../storage.js";
type SQLQueryBindings = string | number | null | boolean;
import type {
  CreateMemoryInput,
  DedupeMode,
  Memory,
  MemoryFilter,
  MemoryVersion,
  UpdateMemoryInput,
} from "../types/index.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
  MemoryConflictError,
} from "../types/index.js";
import { getDatabase, now, uuid, resolvePartialId } from "./database.js";
import { cloudStoreFor, isCloudMode } from "./cloud-store.js";
import { generateEmbedding, cosineSimilarity, serializeEmbedding, deserializeEmbedding } from "../lib/embeddings.js";
import { redactSecrets } from "../lib/redact.js";
import { hookRegistry } from "../lib/hooks.js";
import { computeTrustScore } from "../lib/poisoning.js";
// Entity extraction is now handled by the LLM auto-memory pipeline (src/lib/auto-memory.ts).
// The regex extractor has been removed. Extraction fires async via PostMemorySave hook.
// Keeping this comment so the migration intent is clear.
import { unlinkEntityFromMemory, getEntityMemoryLinks } from "./entity-memories.js";

// ============================================================================
// Entity extraction helper
// ============================================================================

// runEntityExtraction previously used regex-based extraction (extractor.ts).
// Now removed — LLM-based extraction fires async via auto-memory pipeline
// (src/lib/auto-memory.ts) after every memory save, triggered by PostMemorySave hook.
function runEntityExtraction(_memory: Memory, _projectId: string | undefined, _d: Database): void {
  // No-op: async LLM extraction handled by PostMemorySave hook in auto-memory pipeline.
  // See src/lib/auto-memory.ts → linkEntitiesToMemory()
}

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
    machine_id: (row["machine_id"] as string) || null,
    flag: (row["flag"] as string) || null,
    when_to_use: (row["when_to_use"] as string) || null,
    sequence_group: (row["sequence_group"] as string) || null,
    sequence_order: (row["sequence_order"] as number) ?? null,
    content_type: (row["content_type"] as string as Memory["content_type"]) || "text",
    namespace: (row["namespace"] as string) || null,
    created_by_agent: (row["created_by_agent"] as string) || null,
    updated_by_agent: (row["updated_by_agent"] as string) || null,
    trust_score: row["trust_score"] != null ? (row["trust_score"] as number) : null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<string, unknown>,
    access_count: row["access_count"] as number,
    version: row["version"] as number,
    expires_at: (row["expires_at"] as string) || null,
    valid_from: (row["valid_from"] as string) || null,
    valid_until: (row["valid_until"] as string) || null,
    ingested_at: (row["ingested_at"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    accessed_at: (row["accessed_at"] as string) || null,
  };
}

// ============================================================================
// Cloud (self_hosted) routing helpers
// ============================================================================

// When the client-flip resolves to cloud (mode=self_hosted + API_URL + API_KEY),
// the `memories` resource is served by the app's cloud HTTP API instead of the
// local SQLite store. An explicit `db` argument always means "use this local
// database" (tests, import/export, transactions), so cloud routing is skipped
// whenever a caller passes `db`.
const MEMORY_RESOURCE = "memories";

function cloudMemories(db?: Database) {
  if (db) return null;
  if (!isCloudMode()) return null;
  return cloudStoreFor(MEMORY_RESOURCE);
}

/** Map a cloud API entity (tags array, metadata object, pinned boolean) to a Memory. */
function apiEntityToMemory(entity: Record<string, unknown>): Memory {
  const row: Record<string, unknown> = { ...entity };
  if (Array.isArray(entity["tags"])) row["tags"] = JSON.stringify(entity["tags"]);
  else if (entity["tags"] == null) row["tags"] = "[]";
  if (entity["metadata"] && typeof entity["metadata"] === "object") {
    row["metadata"] = JSON.stringify(entity["metadata"]);
  } else if (entity["metadata"] == null) {
    row["metadata"] = "{}";
  }
  if (typeof entity["pinned"] === "boolean") row["pinned"] = entity["pinned"] ? 1 : 0;
  return parseMemoryRow(row);
}

/** Apply a MemoryFilter to an in-memory list, mirroring listMemories() SQL semantics. */
function applyMemoryFilter(memories: Memory[], filter?: MemoryFilter): Memory[] {
  const inSet = <T>(value: T, spec: T | T[] | undefined): boolean => {
    if (spec === undefined) return true;
    return Array.isArray(spec) ? (spec as T[]).includes(value) : spec === value;
  };

  let out = memories;
  const f = (filter ?? {}) as MemoryFilter & Record<string, unknown>;

  // Status: default to active when not specified.
  if (f.status !== undefined) out = out.filter((m) => inSet(m.status, f.status));
  else out = out.filter((m) => m.status === "active");

  if (f.scope !== undefined) out = out.filter((m) => inSet(m.scope, f.scope));
  if (f.category !== undefined) out = out.filter((m) => inSet(m.category, f.category));
  if (f.source !== undefined) out = out.filter((m) => inSet(m.source, f.source));
  if (f.project_id) out = out.filter((m) => m.project_id === f.project_id);
  if (f.agent_id) out = out.filter((m) => m.agent_id === f.agent_id);
  if (f.session_id) out = out.filter((m) => m.session_id === f.session_id);
  if ("machine_id" in f) {
    if (f.machine_id === null) out = out.filter((m) => m.machine_id == null);
    else if (f.machine_id) out = out.filter((m) => m.machine_id === f.machine_id);
  }
  if ("visible_to_machine_id" in f && f["visible_to_machine_id"] !== undefined) {
    const vis = f["visible_to_machine_id"] as string | null;
    if (vis === null) out = out.filter((m) => m.machine_id == null);
    else out = out.filter((m) => m.machine_id == null || m.machine_id === vis);
  }
  if (f.min_importance) out = out.filter((m) => m.importance >= (f.min_importance as number));
  if (f.pinned !== undefined) out = out.filter((m) => m.pinned === Boolean(f.pinned));
  if (f["flagged"] === true) out = out.filter((m) => m.flag != null);
  else if (f["flag"]) out = out.filter((m) => m.flag === f["flag"]);
  if (f.tags && f.tags.length > 0) {
    out = out.filter((m) => (f.tags as string[]).every((t) => m.tags.includes(t)));
  }
  if (f.namespace) out = out.filter((m) => m.namespace === f.namespace);
  if (f.search) {
    const term = String(f.search).toLowerCase();
    out = out.filter(
      (m) =>
        m.key.toLowerCase().includes(term) ||
        m.value.toLowerCase().includes(term) ||
        (m.summary ?? "").toLowerCase().includes(term),
    );
  }
  if (f.as_of) {
    const asOf = f.as_of as string;
    out = out.filter(
      (m) => (m.valid_from == null || m.valid_from <= asOf) && (m.valid_until == null || m.valid_until > asOf),
    );
  }

  // ORDER BY importance DESC, created_at DESC
  out = [...out].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  });

  const offset = f.offset ?? 0;
  const limit = f.limit;
  if (offset || limit !== undefined) {
    out = out.slice(offset, limit !== undefined ? offset + limit : undefined);
  }
  return out;
}

type CloudStore = NonNullable<ReturnType<typeof cloudStoreFor>>;

/** Create (or merge) a memory against the cloud HTTP API, honoring dedupe mode. */
function cloudCreateMemory(store: CloudStore, input: CreateMemoryInput, dedupeMode: DedupeMode): Memory {
  // Handle TTL / working-scope expiry identically to the local path.
  let expiresAt = input.expires_at || null;
  if (input.ttl_ms && !expiresAt) expiresAt = new Date(Date.now() + input.ttl_ms).toISOString();
  if (input.scope === "working" && !expiresAt) expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const safeValue = redactSecrets(input.value);
  const safeSummary = input.summary ? redactSecrets(input.summary) : null;

  const body: Record<string, unknown> = {
    key: input.key,
    value: safeValue,
    category: input.category ?? "knowledge",
    scope: input.scope ?? "private",
    summary: safeSummary,
    tags: input.tags ?? [],
    importance: input.importance ?? 5,
    metadata: input.metadata ?? {},
    expires_at: expiresAt,
    when_to_use: input.when_to_use ?? null,
    source: input.source,
    agent_id: input.agent_id,
    project_id: input.project_id,
    session_id: input.session_id,
  };

  const effectiveMode =
    dedupeMode === "overwrite" ? "merge" : dedupeMode === "version-fork" ? "create" : dedupeMode;

  if (effectiveMode !== "create") {
    // Find candidates with the same key (server filtering is best-effort; match client-side).
    const candidates = (store.list({ key: input.key, limit: 500 }) as Record<string, unknown>[])
      .map(apiEntityToMemory)
      .filter((m) => m.key === input.key && m.status === "active");

    if (effectiveMode === "error") {
      const clash = candidates.find(
        (m) => m.scope === (input.scope ?? "private") && (m.project_id ?? "") === (input.project_id ?? ""),
      );
      if (clash) {
        throw new MemoryConflictError(input.key, {
          id: clash.id,
          agent_id: clash.agent_id,
          updated_at: clash.updated_at,
        });
      }
    }

    if (effectiveMode === "merge") {
      const existing = candidates.find(
        (m) =>
          m.scope === (input.scope ?? "private") &&
          (m.agent_id ?? "") === (input.agent_id ?? "") &&
          (m.project_id ?? "") === (input.project_id ?? "") &&
          (m.session_id ?? "") === (input.session_id ?? ""),
      );
      if (existing) {
        const patch: Record<string, unknown> = {
          value: safeValue,
          category: input.category ?? "knowledge",
          summary: safeSummary,
          tags: input.tags ?? [],
          importance: input.importance ?? 5,
          metadata: input.metadata ?? {},
          expires_at: expiresAt,
          when_to_use: input.when_to_use ?? null,
        };
        const updated = store.update(existing.id, patch) as Record<string, unknown>;
        return apiEntityToMemory(updated);
      }
    }
  }

  const created = store.create(body) as Record<string, unknown>;
  return apiEntityToMemory(created);
}

/** Update a memory against the cloud HTTP API with the same optimistic-locking contract. */
function cloudUpdateMemory(store: CloudStore, id: string, input: UpdateMemoryInput): Memory {
  const existingEntity = store.get(id) as Record<string, unknown> | null;
  if (!existingEntity) throw new MemoryNotFoundError(id);
  const existing = apiEntityToMemory(existingEntity);
  if (existing.version !== input.version) {
    throw new VersionConflictError(id, input.version, existing.version);
  }

  const patch: Record<string, unknown> = {};
  if (input.value !== undefined) patch["value"] = redactSecrets(input.value);
  if (input.category !== undefined) patch["category"] = input.category;
  if (input.scope !== undefined) patch["scope"] = input.scope;
  if (input.summary !== undefined) patch["summary"] = input.summary;
  if (input.importance !== undefined) patch["importance"] = input.importance;
  if (input.pinned !== undefined) patch["pinned"] = input.pinned;
  if (input.status !== undefined) patch["status"] = input.status;
  if (input.metadata !== undefined) patch["metadata"] = input.metadata;
  if (input.expires_at !== undefined) patch["expires_at"] = input.expires_at;
  if (input.flag !== undefined) patch["flag"] = input.flag ?? null;
  if (input.when_to_use !== undefined) patch["when_to_use"] = input.when_to_use ?? null;
  if (input.tags !== undefined) patch["tags"] = input.tags;

  const updated = store.update(id, patch) as Record<string, unknown>;
  const memory = apiEntityToMemory(updated);
  void hookRegistry.runHooks("PostMemoryUpdate", {
    memory,
    previousValue: existing.value,
    agentId: existing.agent_id ?? undefined,
    projectId: existing.project_id ?? undefined,
    sessionId: existing.session_id ?? undefined,
    timestamp: Date.now(),
  });
  return memory;
}

/** Fetch the cloud page for the memories resource (server-side hints + client-side parity). */
function cloudListMemories(store: CloudStore, filter?: MemoryFilter): Memory[] {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (filter?.limit) query["limit"] = filter.limit;
  if (filter?.offset) query["offset"] = filter.offset;
  const entities = store.list(query) as Record<string, unknown>[];
  const mapped = entities.map(apiEntityToMemory);
  return applyMemoryFilter(mapped, filter);
}

// ============================================================================
// Create
// ============================================================================

export function createMemory(
  input: CreateMemoryInput,
  dedupeMode: DedupeMode = "merge",
  db?: Database
): Memory {
  const cloud = cloudMemories(db);
  if (cloud) {
    return cloudCreateMemory(cloud, input, dedupeMode);
  }

  const d = db || getDatabase();
  const timestamp = now();

  // Resolve partial project_id to full UUID to avoid FK constraint failures.
  // Agents often pass short IDs (first 8 chars) from list_projects output.
  if (input.project_id) {
    const resolved = resolvePartialId(d, "projects", input.project_id);
    if (resolved) {
      input = { ...input, project_id: resolved };
    }
  }

  // Handle TTL
  let expiresAt = input.expires_at || null;
  if (input.ttl_ms && !expiresAt) {
    expiresAt = new Date(Date.now() + input.ttl_ms).toISOString();
  }

  // Working scope: auto-set expires_at to 1 hour from now if not explicitly provided
  if (input.scope === "working" && !expiresAt) {
    expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }

  const id = uuid();
  const tags = input.tags || [];
  const tagsJson = JSON.stringify(tags);
  const metadataJson = JSON.stringify(input.metadata || {});

  // Auto-redact secrets from value and summary
  const safeValue = redactSecrets(input.value);
  const safeSummary = input.summary ? redactSecrets(input.summary) : null;

  // "overwrite" is an alias for "merge"; "version-fork" is an alias for "create"
  const effectiveMode = dedupeMode === "overwrite" ? "merge"
    : dedupeMode === "version-fork" ? "create"
    : dedupeMode;

  if (effectiveMode === "error") {
    // Fail if any memory with the same key exists in this scope (regardless of agent)
    const existing = d.query(
      `SELECT id, agent_id, updated_at FROM memories
       WHERE key = ? AND scope = ? AND COALESCE(project_id, '') = ? AND status = 'active'
       LIMIT 1`
    ).get(
      input.key,
      input.scope || "private",
      input.project_id || ""
    ) as { id: string; agent_id: string | null; updated_at: string } | null;

    if (existing) {
      throw new MemoryConflictError(input.key, existing);
    }
    // No conflict — fall through to insert below
  }

  if (effectiveMode === "merge") {
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
           when_to_use = ?,
           pinned = COALESCE(pinned, 0),
           version = version + 1, updated_at = ?
         WHERE id = ?`,
        [
          safeValue,
          input.category || "knowledge",
          safeSummary,
          tagsJson,
          input.importance ?? 5,
          metadataJson,
          expiresAt,
          input.when_to_use || null,
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

      const merged = getMemory(existing.id, d)!;

      // Compute and store trust_score for poisoning detection
      try {
        const existingMemories = listMemoriesByKey(input.key, d);
        const trustScore = computeTrustScore(safeValue, input.key, existingMemories, input.importance);
        d.run("UPDATE memories SET trust_score = ? WHERE id = ?", [trustScore, existing.id]);
      } catch {
        // trust_score column may not exist in test schemas — ignore
      }

      // Re-extract entities on merge (value changed)
      try {
        // Remove old entity links
        const oldLinks = getEntityMemoryLinks(undefined, merged.id, d);
        for (const link of oldLinks) {
          unlinkEntityFromMemory(link.entity_id, merged.id, d);
        }
        runEntityExtraction(merged, input.project_id, d);
      } catch {
        // Don't block save if extraction fails
      }

      return merged;
    }
  }

  // Ensure FK-referenced rows exist before inserting. On the cloud server and
  // during cross-machine imports, a memory can reference an agent/project/
  // session/machine id created on another machine that is absent here; with
  // `PRAGMA foreign_keys = ON` that INSERT throws a FK error (opaque HTTP 500)
  // and drops the write. Provision minimal stubs so authorship is preserved.
  ensureMemoryReferences(d, input);

  // Insert new
  d.run(
    `INSERT INTO memories (id, key, value, category, scope, summary, tags, importance, source, status, pinned, agent_id, project_id, session_id, machine_id, namespace, created_by_agent, when_to_use, sequence_group, sequence_order, metadata, access_count, version, expires_at, valid_from, valid_until, ingested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', FALSE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.key,
      safeValue,
      input.category || "knowledge",
      input.scope || "private",
      input.summary || null,
      tagsJson,
      input.importance ?? 5,
      input.source || "agent",
      input.agent_id || null,
      input.project_id || null,
      input.session_id || null,
      input.machine_id || null,
      input.namespace || null,
      input.agent_id || null, // created_by_agent
      input.when_to_use || null,
      input.sequence_group || null,
      input.sequence_order ?? null,
      metadataJson,
      expiresAt,
      (input.metadata as Record<string, unknown>)?.valid_from as string ?? timestamp,
      (input.metadata as Record<string, unknown>)?.valid_until as string ?? null,
      timestamp,
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

  const memory = getMemory(id, d)!;

  // Compute and store trust_score for poisoning detection
  try {
    const existingMemories = listMemoriesByKey(input.key, d);
    const trustScore = computeTrustScore(safeValue, input.key, existingMemories, input.importance);
    d.run("UPDATE memories SET trust_score = ? WHERE id = ?", [trustScore, id]);
  } catch {
    // trust_score column may not exist in test schemas — ignore
  }

  // Run entity extraction no-op (replaced by async LLM pipeline)
  runEntityExtraction(memory, input.project_id, d);

  // Fire PostMemorySave hook (non-blocking — never delays the caller)
  void hookRegistry.runHooks("PostMemorySave", {
    memory,
    wasUpdated: false,
    agentId: input.agent_id,
    projectId: input.project_id,
    sessionId: input.session_id,
    timestamp: Date.now(),
  });

  return memory;
}

// ============================================================================
// Bulk restore / backfill
// ============================================================================

export interface BulkUpsertResult {
  inserted: number;
  skipped: number;
  errors: string[];
  total: number;
}

/**
 * Faithful, idempotent bulk restore of memories into the current store.
 *
 * Unlike {@link createMemory}, this primitive:
 *  - PRESERVES the original `id` (does not regenerate a UUID);
 *  - PRESERVES `status` (archived stays archived — never resurrected to active);
 *  - PRESERVES timestamps, `version`, `pinned`, `access_count` and scope fields;
 *  - does NOT dedupe by key/scope/agent and does NOT fire hooks / entity
 *    extraction / embedding work (those run asynchronously elsewhere).
 *
 * Idempotency is by primary-key `id`: `INSERT OR IGNORE` maps to
 * `ON CONFLICT DO NOTHING` on Postgres, so a row whose `id` already exists is
 * left untouched and re-runs never create duplicate rows. This is the
 * cross-machine → cloud backfill path (see the fleet self-host cutover): a
 * machine's local memories are shipped to the cloud store verbatim without
 * mutating rows that are already present.
 *
 * FK-referenced agent/project/session/machine rows are stubbed via
 * {@link ensureMemoryReferences} so cross-machine authorship ids never fail the
 * write. Values and summaries are still passed through {@link redactSecrets}.
 */
export function bulkUpsertMemories(
  memories: Array<Record<string, unknown>>,
  db?: Database
): BulkUpsertResult {
  const d = db || getDatabase();
  let inserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  const insert = d.prepare(
    `INSERT OR IGNORE INTO memories (id, key, value, category, scope, summary, tags, importance, source, status, pinned, agent_id, project_id, session_id, machine_id, namespace, created_by_agent, when_to_use, sequence_group, sequence_order, metadata, access_count, version, expires_at, valid_from, valid_until, ingested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertTag = d.prepare(
    "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
  );

  for (const mem of memories) {
    const key = mem["key"] as string | undefined;
    const id = (mem["id"] as string) || uuid();
    try {
      if (!key) {
        errors.push(`skipped row without key (id=${id})`);
        continue;
      }
      const timestamp = now();

      // tags may arrive as an array (JSON body) or a serialized JSON string (row dump)
      let tags: string[] = [];
      const rawTags = mem["tags"];
      if (Array.isArray(rawTags)) {
        tags = rawTags as string[];
      } else if (typeof rawTags === "string" && rawTags.trim()) {
        try {
          const parsed = JSON.parse(rawTags);
          if (Array.isArray(parsed)) tags = parsed as string[];
        } catch {
          // leave tags empty on malformed input
        }
      }
      const tagsJson = JSON.stringify(tags);

      // metadata may arrive as an object or a serialized JSON string
      let metadataJson = "{}";
      const rawMeta = mem["metadata"];
      if (rawMeta && typeof rawMeta === "object") {
        metadataJson = JSON.stringify(rawMeta);
      } else if (typeof rawMeta === "string" && rawMeta.trim()) {
        metadataJson = rawMeta;
      }

      const safeValue = redactSecrets(String(mem["value"] ?? ""));
      const safeSummary = mem["summary"] ? redactSecrets(String(mem["summary"])) : null;

      const agentId = (mem["agent_id"] as string) ?? null;
      const projectId = (mem["project_id"] as string) ?? null;
      const sessionId = (mem["session_id"] as string) ?? null;
      const machineId = (mem["machine_id"] as string) ?? null;

      // Satisfy FK constraints for ids that were created on another machine.
      ensureMemoryReferences(d, {
        key,
        value: safeValue,
        agent_id: agentId ?? undefined,
        project_id: projectId ?? undefined,
        session_id: sessionId ?? undefined,
        machine_id: machineId ?? undefined,
      } as CreateMemoryInput);

      const res = insert.run(
        id,
        key,
        safeValue,
        (mem["category"] as string) || "knowledge",
        (mem["scope"] as string) || "private",
        safeSummary,
        tagsJson,
        (mem["importance"] as number) ?? 5,
        (mem["source"] as string) || "imported",
        (mem["status"] as string) || "active",
        Boolean(mem["pinned"]),
        agentId,
        projectId,
        sessionId,
        machineId,
        (mem["namespace"] as string) ?? null,
        (mem["created_by_agent"] as string) ?? agentId,
        (mem["when_to_use"] as string) ?? null,
        (mem["sequence_group"] as string) ?? null,
        (mem["sequence_order"] as number) ?? null,
        metadataJson,
        (mem["access_count"] as number) ?? 0,
        (mem["version"] as number) ?? 1,
        (mem["expires_at"] as string) ?? null,
        (mem["valid_from"] as string) ?? timestamp,
        (mem["valid_until"] as string) ?? null,
        (mem["ingested_at"] as string) ?? timestamp,
        (mem["created_at"] as string) ?? timestamp,
        (mem["updated_at"] as string) ?? timestamp
      );

      if ((res?.changes ?? 0) > 0) {
        inserted++;
        for (const tag of tags) {
          try {
            insertTag.run(id, tag);
          } catch {
            // tag table may be absent in reduced schemas — never block the row
          }
        }
      } else {
        // id already present — left untouched (idempotent, non-destructive)
        skipped++;
      }
    } catch (e) {
      errors.push(
        `Failed "${String(key)}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return { inserted, skipped, errors, total: memories.length };
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Ensure the agent/project/session/machine rows referenced by a memory exist,
 * inserting minimal stubs when they do not. Idempotent (INSERT OR IGNORE keyed
 * on the primary id, so existing real rows are never modified). This keeps the
 * FK constraints on `memories` satisfiable for writes that originate on another
 * machine (the cloud/self_hosted flip and cross-machine imports) instead of
 * failing the whole write with a foreign-key error.
 */
function ensureMemoryReferences(d: Database, input: CreateMemoryInput): void {
  const t = now();
  // Each stub is best-effort and independently guarded: a referenced table may
  // be absent in reduced/test schemas, and a missing stub must never block the
  // write (the FK, when present, is what we are satisfying).
  const tryRun = (sql: string, params: unknown[]): void => {
    try {
      d.run(sql, params as never[]);
    } catch {
      // Table/column may not exist in this schema variant — ignore.
    }
  };
  if (input.agent_id) {
    tryRun(
      "INSERT OR IGNORE INTO agents (id, name, role, created_at, last_seen_at) VALUES (?, ?, 'agent', ?, ?)",
      [input.agent_id, `imported-${input.agent_id}`, t, t]
    );
  }
  if (input.project_id) {
    tryRun(
      "INSERT OR IGNORE INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [input.project_id, `imported-${input.project_id}`, `imported://${input.project_id}`, t, t]
    );
  }
  if (input.machine_id) {
    tryRun(
      "INSERT OR IGNORE INTO machines (id, name, hostname, platform, created_at, last_seen_at) VALUES (?, ?, ?, 'unknown', ?, ?)",
      [input.machine_id, `imported-${input.machine_id}`, `imported-${input.machine_id}`, t, t]
    );
  }
  if (input.session_id) {
    // sessions.agent_id / project_id reference agents/projects (stubbed above).
    tryRun(
      "INSERT OR IGNORE INTO sessions (id, agent_id, project_id, started_at, last_activity) VALUES (?, ?, ?, ?, ?)",
      [input.session_id, input.agent_id ?? null, input.project_id ?? null, t, t]
    );
  }
}

/** List active memories with the same key (for trust_score contradiction check). */
function listMemoriesByKey(key: string, db: Database): Memory[] {
  const rows = db
    .query("SELECT * FROM memories WHERE key = ? AND status = 'active' ORDER BY importance DESC LIMIT 10")
    .all(key) as Record<string, unknown>[];
  return rows.map(parseMemoryRow);
}

// ============================================================================
// Read
// ============================================================================

export function getMemory(id: string, db?: Database): Memory | null {
  const cloud = cloudMemories(db);
  if (cloud) {
    const entity = cloud.get(id) as Record<string, unknown> | null;
    return entity ? apiEntityToMemory(entity) : null;
  }

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
  db?: Database,
  as_of?: string
): Memory | null {
  const cloud = cloudMemories(db);
  if (cloud) {
    const matches = applyMemoryFilter(
      (cloud.list({ key, limit: 500 }) as Record<string, unknown>[]).map(apiEntityToMemory),
      { scope: scope as MemoryFilter["scope"], agent_id: agentId, project_id: projectId, session_id: sessionId, as_of, status: "active" },
    ).filter((m) => m.key === key);
    // ORDER BY importance DESC LIMIT 1
    return matches[0] ?? null;
  }

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
  if (as_of) {
    sql += " AND (valid_from IS NULL OR valid_from <= ?)";
    params.push(as_of);
    sql += " AND (valid_until IS NULL OR valid_until > ?)";
    params.push(as_of);
  }

  sql += " AND status = 'active' ORDER BY importance DESC LIMIT 1";

  const row = d.query(sql).get(...params) as Record<string, unknown> | null;
  if (!row) return null;
  return parseMemoryRow(row);
}

/**
 * Return ALL active memories matching a key (across scopes/agents/projects).
 * Optional filters narrow the result set.
 */
export function getMemoriesByKey(
  key: string,
  scope?: string,
  agentId?: string,
  projectId?: string,
  db?: Database
): Memory[] {
  const cloud = cloudMemories(db);
  if (cloud) {
    return applyMemoryFilter(
      (cloud.list({ key, limit: 500 }) as Record<string, unknown>[]).map(apiEntityToMemory),
      { scope: scope as MemoryFilter["scope"], agent_id: agentId, project_id: projectId, status: "active" },
    ).filter((m) => m.key === key);
  }

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

  sql += " AND status = 'active' ORDER BY importance DESC";

  const rows = d.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseMemoryRow);
}

// ============================================================================
// List
// ============================================================================

export function listMemories(filter?: MemoryFilter, db?: Database): Memory[] {
  const cloud = cloudMemories(db);
  if (cloud) {
    return cloudListMemories(cloud, filter);
  }

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
    if ("machine_id" in filter) {
      if (filter.machine_id === null) {
        conditions.push("machine_id IS NULL");
      } else if (filter.machine_id) {
        conditions.push("machine_id = ?");
        params.push(filter.machine_id);
      }
    }
    if ("visible_to_machine_id" in filter) {
      if (filter.visible_to_machine_id === null) {
        conditions.push("machine_id IS NULL");
      } else if (filter.visible_to_machine_id !== undefined) {
        conditions.push("(machine_id IS NULL OR machine_id = ?)");
        params.push(filter.visible_to_machine_id);
      }
    }
    if (filter.min_importance) {
      conditions.push("importance >= ?");
      params.push(filter.min_importance);
    }
    if (filter.pinned !== undefined) {
      conditions.push("pinned = ?");
      params.push(filter.pinned ? 1 : 0);
    }
    if ((filter as Record<string, unknown>).flagged === true) {
      conditions.push("flag IS NOT NULL");
    } else if ((filter as Record<string, unknown>).flag) {
      conditions.push("flag = ?");
      params.push((filter as Record<string, unknown>).flag as string);
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
    if (filter.namespace) {
      conditions.push("namespace = ?");
      params.push(filter.namespace);
    }
    if (filter.search) {
      conditions.push(
        "(key LIKE ? OR value LIKE ? OR summary LIKE ?)"
      );
      const term = `%${filter.search}%`;
      params.push(term, term, term);
    }
    if (filter.as_of) {
      // Bi-temporal query: return memories that were valid at the given point in time
      // valid_from <= as_of AND (valid_until IS NULL OR valid_until > as_of)
      conditions.push("(valid_from IS NULL OR valid_from <= ?)");
      params.push(filter.as_of);
      conditions.push("(valid_until IS NULL OR valid_until > ?)");
      params.push(filter.as_of);
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
  const cloud = cloudMemories(db);
  if (cloud) {
    return cloudUpdateMemory(cloud, id, input);
  }

  const d = db || getDatabase();
  const existing = getMemory(id, d);
  if (!existing) throw new MemoryNotFoundError(id);

  if (existing.version !== input.version) {
    throw new VersionConflictError(id, input.version, existing.version);
  }

  // Snapshot current state into memory_versions before mutating
  try {
    d.run(
      `INSERT OR IGNORE INTO memory_versions (id, memory_id, version, value, importance, scope, category, tags, summary, pinned, status, when_to_use, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        existing.id,
        existing.version,
        existing.value,
        existing.importance,
        existing.scope,
        existing.category,
        JSON.stringify(existing.tags),
        existing.summary,
        existing.pinned ? 1 : 0,
        existing.status,
        existing.when_to_use || null,
        existing.updated_at,
      ]
    );
  } catch {
    // memory_versions table may not exist yet (pre-migration) — skip gracefully
  }

  const sets: string[] = ["version = version + 1", "updated_at = ?"];
  const params: SQLQueryBindings[] = [now()];

  if (input.value !== undefined) {
    sets.push("value = ?");
    params.push(redactSecrets(input.value));
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
  if (input.flag !== undefined) {
    sets.push("flag = ?");
    params.push(input.flag ?? null);
  }
  if ((input as any).when_to_use !== undefined) {
    sets.push("when_to_use = ?");
    params.push((input as any).when_to_use ?? null);
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

  const updated = getMemory(id, d)!;

  // Remove stale entity links if value changed (LLM pipeline re-links async)
  if (input.value !== undefined) {
    try {
      const oldLinks = getEntityMemoryLinks(undefined, updated.id, d);
      for (const link of oldLinks) {
        unlinkEntityFromMemory(link.entity_id, updated.id, d);
      }
    } catch {
      // Non-fatal
    }
  }

  // Fire PostMemoryUpdate hook (non-blocking)
  void hookRegistry.runHooks("PostMemoryUpdate", {
    memory: updated,
    previousValue: existing.value,
    agentId: existing.agent_id ?? undefined,
    projectId: existing.project_id ?? undefined,
    sessionId: existing.session_id ?? undefined,
    timestamp: Date.now(),
  });

  return updated;
}

// ============================================================================
// Delete
// ============================================================================

export function deleteMemory(id: string, db?: Database): boolean {
  const cloud = cloudMemories(db);
  if (cloud) {
    const existed = cloud.del(id);
    if (existed) {
      void hookRegistry.runHooks("PostMemoryDelete", { memoryId: id, timestamp: Date.now() });
    }
    return existed;
  }

  const d = db || getDatabase();
  // Fire PostMemoryDelete hook (non-blocking)
  const result = d.run("DELETE FROM memories WHERE id = ?", [id]);
  if (result.changes > 0) {
    void hookRegistry.runHooks("PostMemoryDelete", {
      memoryId: id,
      timestamp: Date.now(),
    });
  }
  return result.changes > 0;
}

export function bulkDeleteMemories(ids: string[], db?: Database): number {
  const cloud = cloudMemories(db);
  if (cloud) {
    let count = 0;
    for (const id of ids) {
      if (cloud.del(id)) count++;
    }
    return count;
  }

  const d = db || getDatabase();
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(",");
  // Count first — result.changes includes FTS5 trigger operations
  const countRow = d
    .query(
      `SELECT COUNT(*) as c FROM memories WHERE id IN (${placeholders})`
    )
    .get(...(ids as SQLQueryBindings[])) as { c: number };
  const count = countRow.c;
  if (count > 0) {
    d.run(
      `DELETE FROM memories WHERE id IN (${placeholders})`,
      ids as SQLQueryBindings[]
    );
  }
  return count;
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

/**
 * Increment recall_count for a memory and auto-promote importance if threshold reached.
 * Borrowed from nuggets: memories recalled frequently are more important.
 * Default threshold: 3 recalls → importance +1 (capped at 10).
 * Call this whenever a memory is returned to a user/agent.
 */
const RECALL_PROMOTE_THRESHOLD = 3;

export function incrementRecallCount(id: string, db?: Database): void {
  const d = db || getDatabase();
  try {
    // Increment recall_count and access_count atomically
    d.run(
      "UPDATE memories SET recall_count = recall_count + 1, access_count = access_count + 1, accessed_at = ? WHERE id = ?",
      [now(), id]
    );
    // Check if we should promote importance
    const row = d
      .query("SELECT recall_count, importance FROM memories WHERE id = ?")
      .get(id) as { recall_count: number; importance: number } | null;
    if (!row) return;
    // Auto-promote: every RECALL_PROMOTE_THRESHOLD recalls, importance goes up by 1
    const promotions = Math.floor(row.recall_count / RECALL_PROMOTE_THRESHOLD);
    if (promotions > 0 && row.importance < 10) {
      const newImportance = Math.min(10, row.importance + 1);
      d.run("UPDATE memories SET importance = ? WHERE id = ? AND importance < 10", [newImportance, id]);
    }
  } catch {
    // Non-fatal — recall tracking should never break a memory read
  }
}

// ============================================================================
// Cleanup
// ============================================================================

export function cleanExpiredMemories(db?: Database): number {
  const d = db || getDatabase();
  const timestamp = now();
  // Count first — result.changes includes FTS5 trigger operations
  const countRow = d
    .query(
      "SELECT COUNT(*) as c FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?"
    )
    .get(timestamp) as { c: number };
  const count = countRow.c;
  if (count > 0) {
    d.run(
      "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?",
      [timestamp]
    );
  }
  return count;
}

// ============================================================================
// Version history
// ============================================================================

export function getMemoryVersions(memoryId: string, db?: Database): MemoryVersion[] {
  const d = db || getDatabase();
  try {
    const rows = d
      .query("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version ASC")
      .all(memoryId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row["id"] as string,
      memory_id: row["memory_id"] as string,
      version: row["version"] as number,
      value: row["value"] as string,
      importance: row["importance"] as number,
      scope: row["scope"] as MemoryVersion["scope"],
      category: row["category"] as MemoryVersion["category"],
      tags: JSON.parse((row["tags"] as string) || "[]") as string[],
      summary: (row["summary"] as string) || null,
      pinned: !!(row["pinned"] as number),
      status: row["status"] as MemoryVersion["status"],
      created_at: row["created_at"] as string,
    }));
  } catch {
    // memory_versions table may not exist yet
    return [];
  }
}

// ============================================================================
// Semantic search via vector embeddings
// ============================================================================

export interface SemanticSearchResult {
  memory: Memory;
  score: number;
}

/**
 * Store or update the embedding for a memory. Called asynchronously after saves.
 * Non-blocking: failures are silently ignored.
 */
export async function indexMemoryEmbedding(memoryId: string, text: string, db?: Database): Promise<void> {
  try {
    const d = db || getDatabase();
    const { embedding, model, dimensions } = await generateEmbedding(text);
    const serialized = serializeEmbedding(embedding);
    d.run(
      `INSERT INTO memory_embeddings (memory_id, embedding, model, dimensions)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET embedding=excluded.embedding, model=excluded.model, dimensions=excluded.dimensions, created_at=datetime('now')`,
      [memoryId, serialized, model, dimensions]
    );
  } catch {
    // Non-critical: silently ignore embedding failures
  }
}

/**
 * Semantic search across memories using cosine similarity.
 * Falls back gracefully if no embeddings exist yet.
 */
export async function semanticSearch(
  queryText: string,
  options: {
    threshold?: number;
    limit?: number;
    scope?: string;
    agent_id?: string;
    project_id?: string;
  } = {},
  db?: Database
): Promise<SemanticSearchResult[]> {
  const d = db || getDatabase();
  const { threshold = 0.5, limit = 10, scope, agent_id, project_id } = options;

  // Generate query embedding
  const { embedding: queryEmbedding } = await generateEmbedding(queryText);

  // Load all embeddings with basic filters
  const conditions: string[] = ["m.status = 'active'", "e.embedding IS NOT NULL"];
  const params: (string | number)[] = [];
  if (scope) { conditions.push("m.scope = ?"); params.push(scope); }
  if (agent_id) { conditions.push("m.agent_id = ?"); params.push(agent_id); }
  if (project_id) { conditions.push("m.project_id = ?"); params.push(project_id); }

  const where = conditions.join(" AND ");
  const rows = d.prepare(
    `SELECT m.*, e.embedding FROM memories m
     JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE ${where}`
  ).all(...params) as Array<Record<string, unknown> & { embedding: string }>;

  // Compute cosine similarity and rank
  const scored: SemanticSearchResult[] = [];
  for (const row of rows) {
    try {
      const docEmbedding = deserializeEmbedding(row.embedding as string);
      const score = cosineSimilarity(queryEmbedding, docEmbedding);
      if (score >= threshold) {
        const { embedding: _, ...memRow } = row;
        scored.push({ memory: parseMemoryRow(memRow), score: Math.round(score * 1000) / 1000 });
      }
    } catch {
      // Skip malformed embeddings
    }
  }

  // Sort by score desc, return top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
