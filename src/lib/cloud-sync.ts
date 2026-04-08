import {
  type DbAdapter,
  type SyncMeta,
  type IncrementalSyncStats,
  SqliteAdapter,
  PgAdapter,
  getCloudConfig,
  getConnectionString,
  incrementalSyncPull,
  incrementalSyncPush,
  getSyncMetaAll,
  isSyncExcludedTable,
  listSqliteTables,
} from "@hasna/cloud";
import { getCurrentMachineId } from "../db/machines.js";
import { uuid } from "../db/database.js";
import { getDbPath } from "./config.js";

const MEMORY_TABLE = "memories";
const MEMORY_SYNC_META_TABLE = "_mementos_cloud_sync_meta";
const SOURCE_MACHINE_METADATA_KEY = "last_synced_source_machine";
const TABLE_CONFLICT_COLUMNS: Record<string, string> = {
  agents: "last_seen_at",
  machines: "last_seen_at",
  sessions: "last_activity",
};

const TABLE_SYNC_ORDER = [
  "projects",
  "agents",
  "machines",
  "sessions",
  "entities",
  "memories",
  "relations",
  "entity_memories",
  "memory_tags",
  "memory_versions",
  "memory_embeddings",
  "tool_events",
  "resource_locks",
  "memory_ratings",
];

export interface MemoryCloudSyncMeta {
  table_name: string;
  direction: "push" | "pull";
  last_synced_at: string | null;
  last_synced_row_count: number;
}

export interface MemoryCloudSyncStats {
  table: string;
  total_rows: number;
  synced_rows: number;
  skipped_rows: number;
  conflicts: number;
  errors: string[];
  first_sync: boolean;
}

export interface MementosCloudSyncResult {
  direction: "push" | "pull";
  mode: string;
  current_machine_id: string | null;
  tables: MemoryCloudSyncStats[];
  total_synced: number;
  total_conflicts: number;
  errors: string[];
}

export interface MementosCloudStatus {
  mode: string;
  enabled: boolean;
  db_path: string;
  current_machine_id: string | null;
  generic_sync_meta: SyncMeta[];
  memory_sync_meta: MemoryCloudSyncMeta[];
}

interface RunCloudSyncOptions {
  tables?: string[];
  local?: DbAdapter;
  remote?: DbAdapter;
  current_machine_id?: string | null;
}

interface RawMemoryRow {
  [key: string]: unknown;
}

interface InternalSyncMeta extends MemoryCloudSyncMeta {}

function ensureMemorySyncMetaTable(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MEMORY_SYNC_META_TABLE} (
      table_name TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('push', 'pull')),
      last_synced_at TEXT,
      last_synced_row_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (table_name, direction)
    )
  `);
}

function getMemorySyncMeta(
  db: DbAdapter,
  table: string,
  direction: "push" | "pull"
): InternalSyncMeta | null {
  ensureMemorySyncMetaTable(db);
  return (
    db.get(
      `SELECT table_name, direction, last_synced_at, last_synced_row_count
       FROM ${MEMORY_SYNC_META_TABLE}
       WHERE table_name = ? AND direction = ?`,
      table,
      direction
    ) ?? null
  ) as InternalSyncMeta | null;
}

function upsertMemorySyncMeta(
  db: DbAdapter,
  meta: InternalSyncMeta
): void {
  ensureMemorySyncMetaTable(db);
  const existing = db.get(
    `SELECT table_name FROM ${MEMORY_SYNC_META_TABLE}
     WHERE table_name = ? AND direction = ?`,
    meta.table_name,
    meta.direction
  );

  if (existing) {
    db.run(
      `UPDATE ${MEMORY_SYNC_META_TABLE}
       SET last_synced_at = ?, last_synced_row_count = ?
       WHERE table_name = ? AND direction = ?`,
      meta.last_synced_at,
      meta.last_synced_row_count,
      meta.table_name,
      meta.direction
    );
    return;
  }

  db.run(
    `INSERT INTO ${MEMORY_SYNC_META_TABLE}
      (table_name, direction, last_synced_at, last_synced_row_count)
     VALUES (?, ?, ?, ?)`,
    meta.table_name,
    meta.direction,
    meta.last_synced_at,
    meta.last_synced_row_count
  );
}

function listMemorySyncMeta(db: DbAdapter): MemoryCloudSyncMeta[] {
  ensureMemorySyncMetaTable(db);
  return db.all(
    `SELECT table_name, direction, last_synced_at, last_synced_row_count
     FROM ${MEMORY_SYNC_META_TABLE}
     ORDER BY table_name, direction`
  ) as MemoryCloudSyncMeta[];
}

function orderTables(tables: string[]): string[] {
  const unique = Array.from(
    new Set(tables.filter((table) => !isSyncExcludedTable(table)))
  );
  return unique.sort((left, right) => {
    const leftIndex = TABLE_SYNC_ORDER.indexOf(left);
    const rightIndex = TABLE_SYNC_ORDER.indexOf(right);
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }
    return left.localeCompare(right);
  });
}

function ensureArrayValue(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function ensureObjectValue(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function rowTimestamp(row: RawMemoryRow): number {
  const raw = row["updated_at"];
  if (typeof raw !== "string" || raw.trim() === "") {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowChangedSince(row: RawMemoryRow, since: string | null): boolean {
  if (!since) return true;
  const sinceTs = Date.parse(since);
  if (!Number.isFinite(sinceTs)) return true;
  return rowTimestamp(row) > sinceTs;
}

function sourceMachineRef(
  row: RawMemoryRow,
  fallback?: string | null
): string {
  const metadata = ensureObjectValue(row["metadata"]);
  const source =
    metadata["source_machine"] ??
    metadata[SOURCE_MACHINE_METADATA_KEY] ??
    row["machine_id"] ??
    fallback;
  if (source == null || String(source).trim() === "") {
    return "unknown";
  }
  return String(source);
}

function normalizeMemoryForCompare(row: RawMemoryRow): Record<string, unknown> {
  const metadata = ensureObjectValue(row["metadata"]);
  delete metadata[SOURCE_MACHINE_METADATA_KEY];
  delete metadata["sync_conflict"];
  delete metadata["conflict_detected_at"];
  delete metadata["conflict_original_id"];
  delete metadata["conflict_winner_id"];
  delete metadata["conflict_source_machine"];

  return {
    key: row["key"] ?? null,
    value: row["value"] ?? null,
    category: row["category"] ?? null,
    scope: row["scope"] ?? null,
    summary: row["summary"] ?? null,
    tags: ensureArrayValue(row["tags"]).sort(),
    importance: row["importance"] ?? null,
    source: row["source"] ?? null,
    status: row["status"] ?? null,
    pinned: row["pinned"] ?? null,
    agent_id: row["agent_id"] ?? null,
    project_id: row["project_id"] ?? null,
    session_id: row["session_id"] ?? null,
    machine_id: row["machine_id"] ?? null,
    flag: row["flag"] ?? null,
    when_to_use: row["when_to_use"] ?? null,
    sequence_group: row["sequence_group"] ?? null,
    sequence_order: row["sequence_order"] ?? null,
    namespace: row["namespace"] ?? null,
    created_by_agent: row["created_by_agent"] ?? null,
    updated_by_agent: row["updated_by_agent"] ?? null,
    trust_score: row["trust_score"] ?? null,
    content_type: row["content_type"] ?? null,
    expires_at: row["expires_at"] ?? null,
    valid_from: row["valid_from"] ?? null,
    valid_until: row["valid_until"] ?? null,
    metadata,
  };
}

function rowsDiffer(left: RawMemoryRow, right: RawMemoryRow): boolean {
  return JSON.stringify(normalizeMemoryForCompare(left)) !== JSON.stringify(normalizeMemoryForCompare(right));
}

function replaceMemoryTags(
  db: DbAdapter,
  memoryId: string,
  rawTags: unknown
): void {
  try {
    db.run("DELETE FROM memory_tags WHERE memory_id = ?", memoryId);
    for (const tag of ensureArrayValue(rawTags)) {
      db.run(
        "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)",
        memoryId,
        tag
      );
    }
  } catch {
    // memory_tags may not exist in every schema during tests
  }
}

function clearMemoryEmbedding(db: DbAdapter, memoryId: string): void {
  try {
    db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", memoryId);
  } catch {
    // memory_embeddings is optional in older schemas
  }
}

function enrichRowWithSourceMachine(
  row: RawMemoryRow,
  sourceMachine: string
): RawMemoryRow {
  const metadata = ensureObjectValue(row["metadata"]);
  metadata[SOURCE_MACHINE_METADATA_KEY] = sourceMachine;
  return {
    ...row,
    tags: JSON.stringify(ensureArrayValue(row["tags"])),
    metadata: JSON.stringify(metadata),
  };
}

function writeRow(db: DbAdapter, table: string, row: Record<string, unknown>): "inserted" | "updated" {
  const existing = db.get(
    `SELECT id FROM "${table}" WHERE id = ?`,
    row["id"]
  );
  const columns = Object.keys(row);

  if (existing) {
    const setClauses = columns
      .filter((column) => column !== "id")
      .map((column) => `"${column}" = ?`)
      .join(", ");
    const values = columns
      .filter((column) => column !== "id")
      .map((column) => row[column]);
    values.push(row["id"]);

    db.run(
      `UPDATE "${table}" SET ${setClauses} WHERE id = ?`,
      ...values
    );
    return "updated";
  }

  const placeholders = columns.map(() => "?").join(", ");
  db.run(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")})
     VALUES (${placeholders})`,
    ...columns.map((column) => row[column])
  );
  return "inserted";
}

function normalizeMachineSegment(sourceMachine: string): string {
  const normalized = sourceMachine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

function buildConflictKey(
  key: string,
  sourceMachine: string,
  updatedAt: string | null
): string {
  const machineSegment = normalizeMachineSegment(sourceMachine).slice(0, 32);
  const timestampSegment = (updatedAt ?? new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 14);
  return `${key}__conflict__${machineSegment}__${timestampSegment || "0"}`;
}

function buildConflictClone(
  loser: RawMemoryRow,
  sourceMachine: string,
  winnerId: string
): RawMemoryRow {
  const timestamp = new Date().toISOString();
  const tags = new Set(ensureArrayValue(loser["tags"]));
  tags.add("sync-conflict");
  tags.add(`source_machine:${sourceMachine}`);

  const metadata = ensureObjectValue(loser["metadata"]);
  metadata["sync_conflict"] = true;
  metadata["conflict_detected_at"] = timestamp;
  metadata["conflict_original_id"] = loser["id"];
  metadata["conflict_winner_id"] = winnerId;
  metadata["conflict_source_machine"] = sourceMachine;

  return enrichRowWithSourceMachine(
    {
      ...loser,
      id: uuid(),
      key: buildConflictKey(
        String(loser["key"] ?? "memory"),
        sourceMachine,
        typeof loser["updated_at"] === "string" ? loser["updated_at"] : null
      ),
      tags: JSON.stringify(Array.from(tags)),
      metadata: JSON.stringify(metadata),
      access_count: 0,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      ...("accessed_at" in loser ? { accessed_at: null } : {}),
      ...("ingested_at" in loser ? { ingested_at: timestamp } : {}),
    },
    sourceMachine
  );
}

function insertConflictCloneIfMissing(db: DbAdapter, clone: RawMemoryRow): void {
  const existing = db.get(
    `SELECT id FROM memories
     WHERE key = ?
       AND scope = ?
       AND COALESCE(agent_id, '') = ?
       AND COALESCE(project_id, '') = ?
       AND COALESCE(session_id, '') = ?`,
    clone["key"],
    clone["scope"],
    clone["agent_id"] ?? "",
    clone["project_id"] ?? "",
    clone["session_id"] ?? ""
  );

  if (!existing) {
    writeRow(db, MEMORY_TABLE, clone);
  }

  replaceMemoryTags(db, String(clone["id"]), clone["tags"]);
  clearMemoryEmbedding(db, String(clone["id"]));
}

function syncMemoriesTable(
  source: DbAdapter,
  target: DbAdapter,
  local: DbAdapter,
  direction: "push" | "pull",
  currentMachineId: string | null
): MemoryCloudSyncStats {
  const stat: MemoryCloudSyncStats = {
    table: MEMORY_TABLE,
    total_rows: 0,
    synced_rows: 0,
    skipped_rows: 0,
    conflicts: 0,
    errors: [],
    first_sync: false,
  };

  ensureMemorySyncMetaTable(local);

  const syncMeta = getMemorySyncMeta(local, MEMORY_TABLE, direction);
  const since = syncMeta?.last_synced_at ?? null;
  stat.first_sync = !since;

  try {
    const countResult = source.get(
      `SELECT COUNT(*) as cnt FROM "${MEMORY_TABLE}"`
    ) as { cnt?: number } | null;
    stat.total_rows = countResult?.cnt ?? 0;

    const rows = since
      ? (source.all(
          `SELECT * FROM "${MEMORY_TABLE}" WHERE updated_at > ?`,
          since
        ) as RawMemoryRow[])
      : (source.all(`SELECT * FROM "${MEMORY_TABLE}"`) as RawMemoryRow[]);

    for (const row of rows) {
      try {
        const sourceMachine = sourceMachineRef(row, currentMachineId);
        const sourceRow = enrichRowWithSourceMachine(row, sourceMachine);
        const targetExisting = target.get(
          `SELECT * FROM "${MEMORY_TABLE}" WHERE id = ?`,
          row["id"]
        ) as RawMemoryRow | null;

        if (!targetExisting) {
          writeRow(target, MEMORY_TABLE, sourceRow);
          replaceMemoryTags(target, String(sourceRow["id"]), sourceRow["tags"]);
          clearMemoryEmbedding(target, String(sourceRow["id"]));
          stat.synced_rows++;
          continue;
        }

        const targetMachine = sourceMachineRef(targetExisting, currentMachineId);
        const targetRow = enrichRowWithSourceMachine(targetExisting, targetMachine);

        if (!rowsDiffer(sourceRow, targetRow)) {
          const sourceTime = rowTimestamp(sourceRow);
          const targetTime = rowTimestamp(targetRow);
          if (sourceTime > targetTime) {
            writeRow(target, MEMORY_TABLE, sourceRow);
            replaceMemoryTags(target, String(sourceRow["id"]), sourceRow["tags"]);
            clearMemoryEmbedding(target, String(sourceRow["id"]));
            stat.synced_rows++;
          } else {
            stat.skipped_rows++;
          }
          continue;
        }

        const sourceChanged = rowChangedSince(sourceRow, since);
        const targetChanged = rowChangedSince(targetRow, since);
        const conflict = !since || (sourceChanged && targetChanged);

        if (conflict) {
          stat.conflicts++;

          const sourceWins = rowTimestamp(sourceRow) >= rowTimestamp(targetRow);
          const winner = sourceWins ? sourceRow : targetRow;
          const loser = sourceWins ? targetRow : sourceRow;
          const winnerMachine = sourceWins ? sourceMachine : targetMachine;
          const loserMachine = sourceWins ? targetMachine : sourceMachine;
          const canonicalRow = enrichRowWithSourceMachine(
            { ...winner, id: row["id"] },
            winnerMachine
          );

          writeRow(source, MEMORY_TABLE, canonicalRow);
          replaceMemoryTags(source, String(canonicalRow["id"]), canonicalRow["tags"]);
          clearMemoryEmbedding(source, String(canonicalRow["id"]));

          writeRow(target, MEMORY_TABLE, canonicalRow);
          replaceMemoryTags(target, String(canonicalRow["id"]), canonicalRow["tags"]);
          clearMemoryEmbedding(target, String(canonicalRow["id"]));

          const loserClone = buildConflictClone(
            loser,
            loserMachine,
            String(canonicalRow["id"])
          );
          insertConflictCloneIfMissing(source, loserClone);
          insertConflictCloneIfMissing(target, loserClone);

          stat.synced_rows++;
          continue;
        }

        const sourceWins = rowTimestamp(sourceRow) >= rowTimestamp(targetRow);
        const winner = sourceWins ? sourceRow : targetRow;
        const winnerDb = sourceWins ? target : source;
        writeRow(winnerDb, MEMORY_TABLE, winner);
        replaceMemoryTags(winnerDb, String(winner["id"]), winner["tags"]);
        clearMemoryEmbedding(winnerDb, String(winner["id"]));
        stat.synced_rows++;
      } catch (error) {
        stat.errors.push(
          `Memory ${String(row["id"] ?? "unknown")}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (rows.length === 0) {
      stat.skipped_rows = stat.total_rows;
    }

    upsertMemorySyncMeta(local, {
      table_name: MEMORY_TABLE,
      direction,
      last_synced_at: new Date().toISOString(),
      last_synced_row_count: stat.synced_rows,
    });
  } catch (error) {
    stat.errors.push(error instanceof Error ? error.message : String(error));
  }

  return stat;
}

function wrapIncrementalStat(
  stat: IncrementalSyncStats
): MemoryCloudSyncStats {
  return {
    table: stat.table,
    total_rows: stat.total_rows,
    synced_rows: stat.synced_rows,
    skipped_rows: stat.skipped_rows,
    conflicts: 0,
    errors: [...stat.errors],
    first_sync: stat.first_sync,
  };
}

function runGenericTableSync(
  direction: "push" | "pull",
  table: string,
  local: DbAdapter,
  remote: DbAdapter
): MemoryCloudSyncStats {
  const conflictColumn = TABLE_CONFLICT_COLUMNS[table] ?? "updated_at";
  const results = direction === "push"
    ? incrementalSyncPush(local, remote, [table], { conflictColumn })
    : incrementalSyncPull(remote, local, [table], { conflictColumn });
  const [result] = results;
  return wrapIncrementalStat(result ?? {
    table,
    total_rows: 0,
    synced_rows: 0,
    skipped_rows: 0,
    errors: [`No sync result returned for table "${table}".`],
    first_sync: false,
  });
}

function resolveTables(local: DbAdapter, tables?: string[]): string[] {
  return orderTables(tables ?? listSqliteTables(local));
}

function withManagedAdapters<T>(
  options: RunCloudSyncOptions,
  fn: (local: DbAdapter, remote: DbAdapter, currentMachineId: string | null) => T
): T {
  const localOwned = !options.local;
  const remoteOwned = !options.remote;
  const local = options.local ?? new SqliteAdapter(getDbPath());
  const remote = options.remote ?? new PgAdapter(getConnectionString("mementos"));

  try {
    const currentMachineId = options.current_machine_id ?? getCurrentMachineId(local as any);
    return fn(local, remote, currentMachineId);
  } finally {
    if (localOwned) {
      local.close();
    }
    if (remoteOwned) {
      remote.close();
    }
  }
}

function runCloudSync(
  direction: "push" | "pull",
  options: RunCloudSyncOptions = {}
): MementosCloudSyncResult {
  const config = getCloudConfig();
  if (config.mode === "local" && !options.remote) {
    throw new Error("Cloud mode is not configured. Run `cloud setup` or set mode to hybrid/cloud.");
  }

  return withManagedAdapters(options, (local, remote, currentMachineId) => {
    const tables = resolveTables(local, options.tables);
    const stats: MemoryCloudSyncStats[] = [];

    for (const table of tables) {
      const stat = table === MEMORY_TABLE
        ? syncMemoriesTable(
            direction === "push" ? local : remote,
            direction === "push" ? remote : local,
            local,
            direction,
            currentMachineId
          )
        : runGenericTableSync(direction, table, local, remote);
      stats.push(stat);
    }

    const errors = stats.flatMap((stat) => stat.errors);
    return {
      direction,
      mode: config.mode,
      current_machine_id: currentMachineId,
      tables: stats,
      total_synced: stats.reduce((sum, stat) => sum + stat.synced_rows, 0),
      total_conflicts: stats.reduce((sum, stat) => sum + stat.conflicts, 0),
      errors,
    };
  });
}

export function pushCloudChanges(
  options: RunCloudSyncOptions = {}
): MementosCloudSyncResult {
  return runCloudSync("push", options);
}

export function pullCloudChanges(
  options: RunCloudSyncOptions = {}
): MementosCloudSyncResult {
  return runCloudSync("pull", options);
}

export function getCloudSyncStatus(
  options: Pick<RunCloudSyncOptions, "local" | "current_machine_id"> = {}
): MementosCloudStatus {
  const config = getCloudConfig();
  const localOwned = !options.local;
  const local = options.local ?? new SqliteAdapter(getDbPath());

  try {
    const currentMachineId = options.current_machine_id ?? getCurrentMachineId(local as any);
    return {
      mode: config.mode,
      enabled: config.mode === "hybrid" || config.mode === "cloud",
      db_path: getDbPath(),
      current_machine_id: currentMachineId,
      generic_sync_meta: getSyncMetaAll(local),
      memory_sync_meta: listMemorySyncMeta(local),
    };
  } finally {
    if (localOwned) {
      local.close();
    }
  }
}
