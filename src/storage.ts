import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import pg from "pg";
import type { Pool, PoolClient } from "pg";

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...params: any[]): RunResult;
  get(...params: any[]): any;
  all(...params: any[]): any[];
  finalize(): void;
}

export interface DbAdapter {
  run(sql: string, ...params: any[]): RunResult;
  get(sql: string, ...params: any[]): any;
  all(sql: string, ...params: any[]): any[];
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
  transaction<T>(fn: () => T): T;
}

function normalizeParams(params: any[]): any[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map((value) => value === undefined ? null : value);
}

export class SqliteAdapter implements DbAdapter {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  run(sql: string, ...params: any[]): RunResult {
    const result = this.db.prepare(sql).run(...normalizeParams(params));
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get(sql: string, ...params: any[]): any {
    return this.db.prepare(sql).get(...normalizeParams(params));
  }

  all(sql: string, ...params: any[]): any[] {
    return this.db.prepare(sql).all(...normalizeParams(params));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query(sql: string) {
    return this.db.query(sql);
  }

  prepare(sql: string): PreparedStatement {
    const statement = this.db.prepare(sql);
    return {
      run: (...params: any[]): RunResult => {
        const result = statement.run(...normalizeParams(params));
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get: (...params: any[]): any => statement.get(...normalizeParams(params)),
      all: (...params: any[]): any[] => statement.all(...normalizeParams(params)),
      finalize: (): void => {
        statement.finalize();
      },
    };
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  get raw(): Database {
    return this.db;
  }
}

export function translateSql(sql: string): string {
  let parameterIndex = 0;
  let translated = sql.replace(/\?/g, () => `$${++parameterIndex}`);

  // Mementos stores timestamps as ISO-8601 UTC strings (JS `toISOString()`).
  // The cloud schema is mixed: some columns are `timestamptz`, others are
  // `text`. Emitting an ISO-8601 UTC *text* value for SQLite's `datetime('now')`
  // compares correctly against BOTH: text-vs-text is lexicographic (ISO ordering
  // == chronological), and timestamptz-vs-text implicitly casts the text.
  const ISO_FMT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
  translated = translated.replace(
    /datetime\s*\(\s*'now'\s*\)/gi,
    `to_char(now() AT TIME ZONE 'UTC', ${ISO_FMT})`
  );
  translated = translated.replace(
    /datetime\s*\(\s*'now'\s*,\s*'(-?\d+)\s+(minutes?|hours?|days?|seconds?)'\s*\)/gi,
    (_match, amount, unit) => {
      const parsed = parseInt(String(amount), 10);
      const absolute = Math.abs(parsed);
      const normalizedUnit = String(unit).toLowerCase().replace(/s$/, "");
      const pluralUnit = absolute === 1 ? normalizedUnit : `${normalizedUnit}s`;
      const op = parsed < 0 ? "-" : "+";
      return `to_char((now() ${op} INTERVAL '${absolute} ${pluralUnit}') AT TIME ZONE 'UTC', ${ISO_FMT})`;
    }
  );
  translated = translated.replace(
    /lower\s*\(\s*hex\s*\(\s*randomblob\s*\(\s*\d+\s*\)\s*\)\s*\)/gi,
    "gen_random_uuid()::text"
  );
  translated = translated.replace(/\bIFNULL\s*\(/gi, "COALESCE(");

  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(translated)) {
    translated = translated.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
    translated = translated.replace(/;?\s*$/, " ON CONFLICT DO NOTHING");
  }

  translated = translated.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, "INSERT INTO");

  // Postgres does not implicitly cast integer 0/1 to BOOLEAN. The SQLite schema
  // uses 0/1 for boolean-typed columns (e.g. memories.pinned). Rewrite the
  // known boolean-column assignment/default idioms so writes succeed against
  // the BOOLEAN columns in the cloud schema. Reads return JS booleans, which
  // `parseMemoryRow`'s `!!(...)` handles transparently.
  translated = translated.replace(
    /COALESCE\s*\(\s*pinned\s*,\s*0\s*\)/gi,
    "COALESCE(pinned, FALSE)"
  );

  return translated;
}

export function shouldUsePgSsl(connectionString: string): boolean {
  let params: URLSearchParams;

  try {
    params = new URL(connectionString).searchParams;
  } catch {
    params = new URLSearchParams(connectionString.split("?", 2)[1] ?? "");
  }

  const ssl = params.get("ssl")?.trim().toLowerCase();
  const sslMode = params.get("sslmode")?.trim().toLowerCase();

  return (
    ["1", "true", "yes", "on", "require"].includes(ssl ?? "") ||
    ["require", "verify-ca", "verify-full"].includes(sslMode ?? "")
  );
}

type PgSslConfig = boolean | { rejectUnauthorized: boolean };

/**
 * Resolve the `pg` SSL option from a connection string, following libpq
 * semantics rather than node-postgres' newer verify-full-by-default behavior:
 *
 * - `sslmode=verify-ca` / `verify-full` → verify the server certificate.
 * - `sslmode=require` (or `ssl=true|1|yes|on`) → encrypt but do NOT verify the
 *   certificate chain/hostname. This matches libpq `require` and is what lets a
 *   private RDS endpoint (or an SSM/Tailscale tunnel presenting the RDS cert on
 *   a localhost address) connect without a spurious hostname mismatch.
 * - otherwise → no SSL.
 */
function sslConfigFor(connectionString: string): PgSslConfig | undefined {
  if (!shouldUsePgSsl(connectionString)) return undefined;

  let sslMode: string | undefined;
  try {
    sslMode = new URL(connectionString).searchParams.get("sslmode")?.trim().toLowerCase() ?? undefined;
  } catch {
    sslMode = new URLSearchParams(connectionString.split("?", 2)[1] ?? "").get("sslmode")?.trim().toLowerCase() ?? undefined;
  }

  if (sslMode === "verify-ca" || sslMode === "verify-full") {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

/**
 * Strip `ssl`/`sslmode` query params from a connection string so the adapter's
 * explicit `ssl` option (from {@link sslConfigFor}) is authoritative. Newer
 * pg-connection-string versions parse `sslmode=require` as verify-full, which
 * clobbers the explicit option and breaks tunnelled/private-endpoint connects.
 */
function stripSslParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete("ssl");
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return connectionString;
  }
}

/** Build a pg Pool with adapter-controlled SSL from a connection string. */
function makePool(connectionString: string): Pool {
  return new pg.Pool({
    connectionString: stripSslParams(connectionString),
    ssl: sslConfigFor(connectionString),
  });
}

interface SyncQueryResult {
  rows: any[];
  rowCount: number;
}

/**
 * Synchronous Postgres access backed by a worker thread (see
 * `pg-sync-worker.ts`). The worker owns one long-lived `pg.Client` and runs
 * queries on its own event loop; the main thread blocks on `Atomics.wait`
 * against a SharedArrayBuffer until the worker writes the response. This is the
 * only way to expose a truly synchronous API (which the entire mementos data
 * layer requires) over async pg I/O without deadlocking the main event loop.
 */
export class PgSyncPool {
  private readonly worker: Worker;
  private readonly status: Int32Array;
  private readonly data: Uint8Array;
  private closed = false;
  private lastError: Error | null = null;
  private static readonly DATA_BYTES = 128 * 1024 * 1024; // 128 MiB response ceiling
  private static readonly QUERY_TIMEOUT_MS = 60_000;

  /**
   * Resolve the worker entry file. `storage` is bundled into several entry
   * points at different depths (dist/cli, dist/mcp, dist/server) as well as run
   * directly from source, so probe candidate locations relative to this module.
   */
  private static resolveWorkerPath(): string {
    const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const here = fileURLToPath(new URL(".", import.meta.url));
    const candidates = [
      join(here, `pg-sync-worker${ext}`),
      join(here, "..", `pg-sync-worker${ext}`),
      join(here, "..", "..", `pg-sync-worker${ext}`),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return candidates[0]!;
  }

  constructor(connectionString: string) {
    const control = new SharedArrayBuffer(8); // 2 x Int32: [0]=status, [1]=byteLength
    const dataSab = new SharedArrayBuffer(PgSyncPool.DATA_BYTES);
    this.status = new Int32Array(control);
    this.data = new Uint8Array(dataSab);

    this.worker = new Worker(PgSyncPool.resolveWorkerPath(), {
      workerData: {
        dsn: stripSslParams(connectionString),
        ssl: sslConfigFor(connectionString),
        control,
        data: dataSab,
      },
    });
    // Do not keep the process alive solely for this worker.
    this.worker.unref();
    this.worker.on("error", (err: Error) => {
      this.lastError = err;
    });
  }

  query(sql: string, params: any[]): SyncQueryResult {
    if (this.closed) throw new Error("PgSyncPool is closed");
    if (this.lastError) throw this.lastError;

    Atomics.store(this.status, 0, 0);
    this.worker.postMessage({ sql, params });
    const waitResult = Atomics.wait(this.status, 0, 0, PgSyncPool.QUERY_TIMEOUT_MS);
    const code = Atomics.load(this.status, 0);
    if (code === 0 || waitResult === "timed-out") {
      if (this.lastError) throw this.lastError;
      throw new Error("PostgreSQL query timed out after 60s");
    }

    const len = Atomics.load(this.status, 1);
    const payload = JSON.parse(new TextDecoder().decode(this.data.subarray(0, len)));
    if (code === 2) {
      throw new Error(payload.message ?? "PostgreSQL error");
    }
    return payload as SyncQueryResult;
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    void this.worker.terminate();
  }
}

export class PgAdapter implements DbAdapter {
  private readonly pool: PgSyncPool;

  constructor(connectionString: string);
  constructor(pool: PgSyncPool);
  constructor(input: string | PgSyncPool) {
    this.pool = typeof input === "string" ? new PgSyncPool(input) : input;
  }

  run(sql: string, ...params: any[]): RunResult {
    const result = this.pool.query(translateSql(sql), normalizeParams(params));
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows?.[0]?.id ?? 0,
    };
  }

  get(sql: string, ...params: any[]): any {
    const result = this.pool.query(translateSql(sql), normalizeParams(params));
    return result.rows[0] ?? null;
  }

  all(sql: string, ...params: any[]): any[] {
    return this.pool.query(translateSql(sql), normalizeParams(params)).rows;
  }

  exec(sql: string): void {
    // exec runs raw DDL/utility SQL (no `?` params). It is not used in cloud
    // runtime paths (no local schema/migrations in cloud mode), but honor it.
    this.pool.query(sql, []);
  }

  prepare(sql: string): PreparedStatement {
    return {
      run: (...params: any[]): RunResult => this.run(sql, ...params),
      get: (...params: any[]): any => this.get(sql, ...params),
      all: (...params: any[]): any[] => this.all(sql, ...params),
      finalize: (): void => {},
    };
  }

  /**
   * Bun-sqlite-style `query()` shim so the CLI/MCP/server call sites that do
   * `db.query(sql).get(...)` / `.all(...)` / `.run(...)` work unchanged against
   * Postgres in cloud mode. Behaves like {@link prepare}.
   */
  query(sql: string): PreparedStatement {
    return this.prepare(sql);
  }

  close(): void {
    this.pool.end();
  }

  transaction<T>(fn: () => T): T {
    // All statements serialize over the worker's single client, so BEGIN/COMMIT
    // wrap the synchronous fn() correctly.
    this.pool.query("BEGIN", []);
    try {
      const value = fn();
      this.pool.query("COMMIT", []);
      return value;
    } catch (error) {
      try {
        this.pool.query("ROLLBACK", []);
      } catch {
        // ignore rollback failure; surface the original error
      }
      throw error;
    }
  }

  get raw(): PgSyncPool {
    return this.pool;
  }
}

export class PgAdapterAsync {
  private readonly pool: Pool;

  constructor(connectionString: string);
  constructor(pool: Pool);
  constructor(input: string | Pool) {
    this.pool = typeof input === "string" ? makePool(input) : input;
  }

  async run(sql: string, ...params: any[]): Promise<RunResult> {
    const result = await this.pool.query(translateSql(sql), normalizeParams(params));
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows?.[0]?.id ?? 0,
    };
  }

  async get(sql: string, ...params: any[]): Promise<any> {
    const result = await this.pool.query(translateSql(sql), normalizeParams(params));
    return result.rows[0] ?? null;
  }

  async all(sql: string, ...params: any[]): Promise<any[]> {
    const result = await this.pool.query(translateSql(sql), normalizeParams(params));
    return result.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  get raw(): Pool {
    return this.pool;
  }
}

/**
 * Canonical storage-mode axis (aligned with the shared cloud-runtime contract).
 *
 * - `local`  — SQLite on disk. Default. Unchanged behavior.
 * - `cloud`  — pure remote: reads AND writes go directly to cloud Postgres.
 *
 * The legacy values `remote` and `hybrid` are still accepted as INPUT (env or
 * config file) for backwards compatibility, but they are DEPRECATED aliases
 * that normalize to `cloud`. See {@link DeprecatedStorageMode}. The historical
 * local<->remote sync engine (the "hybrid sync path") is retained only for
 * back-compat and is explicitly NOT the fleet cutover path.
 */
export type StorageMode = "local" | "cloud";

/** Deprecated storage-mode aliases accepted as input; all map to `cloud`. */
export type DeprecatedStorageMode = "remote" | "hybrid";

/** Any value accepted from env/config for the storage mode. */
export type StorageModeInput = StorageMode | DeprecatedStorageMode;

export const MEMENTOS_STORAGE_TABLES = [
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
] as const;

export const STORAGE_TABLES = MEMENTOS_STORAGE_TABLES;

export type MementosStorageTable = (typeof MEMENTOS_STORAGE_TABLES)[number];

export const MEMENTOS_STORAGE_ENV = {
  databaseUrl: "HASNA_MEMENTOS_DATABASE_URL",
  mode: "HASNA_MEMENTOS_STORAGE_MODE",
} as const;

export const MEMENTOS_STORAGE_FALLBACK_ENV = {
  databaseUrl: "MEMENTOS_DATABASE_URL",
  mode: "MEMENTOS_STORAGE_MODE",
} as const;

type MementosStorageEnvKey = keyof typeof MEMENTOS_STORAGE_ENV;

export interface StorageConfig {
  rds: {
    host: string;
    port: number;
    username: string;
    password_env: string;
    ssl: boolean;
  };
  mode: StorageMode;
  auto_sync_interval_minutes: number;
  feedback_endpoint: string;
  sync: {
    schedule_minutes: number;
  };
}

const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  rds: {
    host: "",
    port: 5432,
    username: "",
    password_env: "MEMENTOS_DATABASE_PASSWORD",
    ssl: true,
  },
  mode: "local",
  auto_sync_interval_minutes: 0,
  feedback_endpoint: "",
  sync: {
    schedule_minutes: 0,
  },
};
const STORAGE_CONFIG_DIR = join(homedir(), ".hasna", "mementos", "storage");
const STORAGE_CONFIG_PATH = join(STORAGE_CONFIG_DIR, "config.json");

const DATABASE_ENV_NAMES = [
  { name: MEMENTOS_STORAGE_ENV.databaseUrl, deprecated: false },
  { name: MEMENTOS_STORAGE_FALLBACK_ENV.databaseUrl, deprecated: false },
] as const;

const MODE_ENV_NAMES = [
  { name: MEMENTOS_STORAGE_ENV.mode, deprecated: false },
  { name: MEMENTOS_STORAGE_FALLBACK_ENV.mode, deprecated: false },
] as const;

export interface StorageEnv {
  name: string;
  deprecated: boolean;
}

export interface StorageEnvStatus {
  name: string;
  active_name: string;
  configured: boolean;
}

export interface NativeStorageStatus {
  ok: boolean;
  service: "mementos";
  mode: StorageMode;
  local_default: boolean;
  remote_enabled: boolean;
  database: {
    configured: boolean;
    redacted_url: string | null;
  };
  tables: readonly MementosStorageTable[];
  env: {
    databaseUrl: StorageEnvStatus;
    mode: StorageEnvStatus;
  };
  issues: string[];
  warnings: string[];
  no_network: true;
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

const warnedDeprecatedModes = new Set<string>();

/**
 * Emit a one-time deprecation warning (to stderr, never stdout) when a caller
 * uses a legacy `remote`/`hybrid` mode value. Deduped per process so JSON
 * output and hot paths are not spammed.
 */
function warnDeprecatedStorageMode(alias: DeprecatedStorageMode): void {
  if (warnedDeprecatedModes.has(alias)) return;
  warnedDeprecatedModes.add(alias);
  process.emitWarning(
    `${MEMENTOS_STORAGE_ENV.mode}="${alias}" is deprecated; use "cloud". ` +
      `"${alias}" now maps to pure-remote cloud storage. The local<->remote ` +
      `sync path is deprecated and is not the fleet cutover path.`,
    { type: "DeprecationWarning", code: "MEMENTOS_STORAGE_MODE_ALIAS" }
  );
}

function normalizeStorageMode(value: string | undefined): StorageMode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "cloud") {
    return normalized;
  }
  if (normalized === "remote" || normalized === "hybrid") {
    warnDeprecatedStorageMode(normalized);
    return "cloud";
  }
  return null;
}

function readConfigFile(): Partial<StorageConfig> {
  if (!existsSync(STORAGE_CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(STORAGE_CONFIG_PATH, "utf-8")) as Partial<StorageConfig>;
  } catch {
    return {};
  }
}

export function getConfigDir(): string {
  return STORAGE_CONFIG_DIR;
}

export function getConfigPath(): string {
  return STORAGE_CONFIG_PATH;
}

export function getStorageDatabaseEnv(): StorageEnv | null {
  for (const env of DATABASE_ENV_NAMES) {
    if (readEnv(env.name)) return env;
  }
  return null;
}

function getStorageEnvName(key: MementosStorageEnvKey): string {
  const canonical = MEMENTOS_STORAGE_ENV[key];
  const fallback = MEMENTOS_STORAGE_FALLBACK_ENV[key];
  return readEnv(canonical) || !readEnv(fallback) ? canonical : fallback;
}

export function getStorageDatabaseUrl(): string | null {
  const env = getStorageDatabaseEnv();
  return env ? readEnv(env.name) : null;
}

export function getStorageDatabaseEnvName(): string {
  return getStorageEnvName("databaseUrl");
}

function getStorageModeOverride(): StorageMode | null {
  for (const env of MODE_ENV_NAMES) {
    const value = normalizeStorageMode(readEnv(env.name) ?? undefined);
    if (value) return value;
  }
  return null;
}

export function getStorageConfig(): StorageConfig {
  const fileConfig = readConfigFile();
  const modeOverride = getStorageModeOverride();
  const envConnectionString = getConfiguredConnectionString();
  const fileMode = normalizeStorageMode(fileConfig.mode);

  const merged: StorageConfig = {
    ...DEFAULT_STORAGE_CONFIG,
    ...fileConfig,
    rds: {
      ...DEFAULT_STORAGE_CONFIG.rds,
      ...(fileConfig.rds ?? {}),
    },
    sync: {
      ...DEFAULT_STORAGE_CONFIG.sync,
      ...(fileConfig.sync ?? {}),
    },
    mode: fileMode ?? DEFAULT_STORAGE_CONFIG.mode,
  };

  if (modeOverride) {
    merged.mode = modeOverride;
  } else if (envConnectionString && merged.mode === "local") {
    // A configured database URL auto-promotes to cloud (pure remote) when no
    // explicit mode is set. Previously this promoted to the deprecated "hybrid".
    merged.mode = "cloud";
  }

  return merged;
}

export function getStorageMode(): StorageMode {
  return getStorageConfig().mode;
}

function redactDatabaseUrl(value: string | null): string | null {
  return value?.replace(/:[^:@/]+@/, ":***@") ?? null;
}

function storageEnvStatus(key: MementosStorageEnvKey): StorageEnvStatus {
  const activeName = getStorageEnvName(key);
  return {
    name: MEMENTOS_STORAGE_ENV[key],
    active_name: activeName,
    configured: readEnv(activeName) !== null,
  };
}

export function getStorageStatus(): NativeStorageStatus {
  const mode = getStorageConfig().mode;
  const databaseUrl = getStorageDatabaseUrl();
  const issues: string[] = [];
  if (mode === "cloud" && !databaseUrl) {
    issues.push(`Missing ${MEMENTOS_STORAGE_ENV.databaseUrl}`);
  }

  return {
    ok: issues.length === 0,
    service: "mementos",
    mode,
    local_default: mode === "local",
    remote_enabled: mode === "cloud",
    database: {
      configured: Boolean(databaseUrl),
      redacted_url: redactDatabaseUrl(databaseUrl),
    },
    tables: MEMENTOS_STORAGE_TABLES,
    env: {
      databaseUrl: storageEnvStatus("databaseUrl"),
      mode: storageEnvStatus("mode"),
    },
    issues,
    warnings: [],
    no_network: true,
  };
}

export const getMementosStorageStatus = getStorageStatus;

export function saveStorageConfig(config: StorageConfig): void {
  mkdirSync(STORAGE_CONFIG_DIR, { recursive: true });
  writeFileSync(STORAGE_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function getConfiguredConnectionString(): string | undefined {
  return getStorageDatabaseUrl() ?? undefined;
}

export function getStorageConnectionString(dbName = "mementos"): string {
  const envConnectionString = getConfiguredConnectionString();
  if (envConnectionString) {
    return envConnectionString;
  }

  const config = getStorageConfig();
  const { host, port, username, password_env, ssl } = config.rds;
  if (!host || !username) {
    throw new Error(
      "Remote storage database is not configured. Set HASNA_MEMENTOS_DATABASE_URL or configure ~/.hasna/mementos/storage/config.json."
    );
  }

  const password = process.env[password_env];
  if (!password) {
    throw new Error(`Remote storage database password is not set. Export ${password_env}.`);
  }

  const sslParam = ssl ? "?sslmode=require" : "";
  return `postgres://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbName}${sslParam}`;
}

export const SYNC_EXCLUDED_TABLE_PATTERNS = [
  /^sqlite_/,
  /_fts$/,
  /_fts_/,
  /^_sync_/,
  /^_pg_migrations$/,
];

export function isSyncExcludedTable(table: string): boolean {
  return SYNC_EXCLUDED_TABLE_PATTERNS.some((pattern) => pattern.test(table));
}

export function listSqliteTables(db: DbAdapter): string[] {
  const rows = db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export interface IncrementalSyncStats {
  table: string;
  total_rows: number;
  synced_rows: number;
  skipped_rows: number;
  errors: string[];
  first_sync: boolean;
}

export interface SyncMeta {
  table_name: string;
  last_synced_at: string;
  last_synced_row_count: number;
  direction: "push" | "pull";
}

export interface IncrementalSyncOptions {
  primaryKey?: string;
  conflictColumn?: string;
  batchSize?: number;
}

const SYNC_META_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _sync_meta (
  table_name TEXT PRIMARY KEY,
  last_synced_at TEXT,
  last_synced_row_count INTEGER DEFAULT 0,
  direction TEXT DEFAULT 'push'
)`;

export function ensureSyncMetaTable(db: DbAdapter): void {
  db.exec(SYNC_META_TABLE_SQL);
}

function getSyncMeta(db: DbAdapter, table: string): SyncMeta | null {
  ensureSyncMetaTable(db);
  return db.get(
    "SELECT table_name, last_synced_at, last_synced_row_count, direction FROM _sync_meta WHERE table_name = ?",
    table
  ) as SyncMeta | null;
}

function upsertSyncMeta(db: DbAdapter, meta: SyncMeta): void {
  ensureSyncMetaTable(db);
  const existing = db.get("SELECT table_name FROM _sync_meta WHERE table_name = ?", meta.table_name);
  if (existing) {
    db.run(
      "UPDATE _sync_meta SET last_synced_at = ?, last_synced_row_count = ?, direction = ? WHERE table_name = ?",
      meta.last_synced_at,
      meta.last_synced_row_count,
      meta.direction,
      meta.table_name
    );
    return;
  }

  db.run(
    "INSERT INTO _sync_meta (table_name, last_synced_at, last_synced_row_count, direction) VALUES (?, ?, ?, ?)",
    meta.table_name,
    meta.last_synced_at,
    meta.last_synced_row_count,
    meta.direction
  );
}

function transferRows(
  target: DbAdapter,
  table: string,
  rows: Array<Record<string, any>>,
  options: IncrementalSyncOptions
): { written: number; skipped: number; errors: string[] } {
  const primaryKey = options.primaryKey ?? "id";
  const conflictColumn = options.conflictColumn ?? "updated_at";
  let written = 0;
  let skipped = 0;
  const errors: string[] = [];

  if (rows.length === 0) {
    return { written, skipped, errors };
  }

  const columns = Object.keys(rows[0] ?? {});
  if (!columns.includes(primaryKey)) {
    return {
      written,
      skipped,
      errors: [`Table "${table}" has no "${primaryKey}" column; skipping`],
    };
  }

  const hasConflictColumn = columns.includes(conflictColumn);

  for (const row of rows) {
    try {
      const existing = target.get(
        `SELECT "${primaryKey}"${hasConflictColumn ? `, "${conflictColumn}"` : ""} FROM "${table}" WHERE "${primaryKey}" = ?`,
        row[primaryKey]
      ) as Record<string, any> | null;

      if (existing) {
        if (hasConflictColumn && existing[conflictColumn] && row[conflictColumn]) {
          const existingTime = Date.parse(String(existing[conflictColumn]));
          const incomingTime = Date.parse(String(row[conflictColumn]));
          if (Number.isFinite(existingTime) && Number.isFinite(incomingTime) && existingTime >= incomingTime) {
            skipped++;
            continue;
          }
        }

        const updateColumns = columns.filter((column) => column !== primaryKey);
        const setClauses = updateColumns.map((column) => `"${column}" = ?`).join(", ");
        target.run(
          `UPDATE "${table}" SET ${setClauses} WHERE "${primaryKey}" = ?`,
          ...updateColumns.map((column) => row[column]),
          row[primaryKey]
        );
      } else {
        const placeholders = columns.map(() => "?").join(", ");
        const columnList = columns.map((column) => `"${column}"`).join(", ");
        target.run(
          `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`,
          ...columns.map((column) => row[column])
        );
      }
      written++;
    } catch (error) {
      errors.push(`Row ${String(row[primaryKey] ?? "unknown")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { written, skipped, errors };
}

export function incrementalSyncPush(
  local: DbAdapter,
  remote: DbAdapter,
  tables: string[],
  options: IncrementalSyncOptions = {}
): IncrementalSyncStats[] {
  return runIncrementalSync("push", local, remote, local, tables, options);
}

export function incrementalSyncPull(
  remote: DbAdapter,
  local: DbAdapter,
  tables: string[],
  options: IncrementalSyncOptions = {}
): IncrementalSyncStats[] {
  return runIncrementalSync("pull", remote, local, local, tables, options);
}

function runIncrementalSync(
  direction: "push" | "pull",
  source: DbAdapter,
  target: DbAdapter,
  metaDb: DbAdapter,
  tables: string[],
  options: IncrementalSyncOptions
): IncrementalSyncStats[] {
  const conflictColumn = options.conflictColumn ?? "updated_at";
  const batchSize = options.batchSize ?? 500;
  const results: IncrementalSyncStats[] = [];

  ensureSyncMetaTable(metaDb);

  for (const table of tables) {
    const stat: IncrementalSyncStats = {
      table,
      total_rows: 0,
      synced_rows: 0,
      skipped_rows: 0,
      errors: [],
      first_sync: false,
    };

    try {
      const countResult = source.get(`SELECT COUNT(*) as cnt FROM "${table}"`) as { cnt?: number } | null;
      stat.total_rows = countResult?.cnt ?? 0;

      const meta = getSyncMeta(metaDb, table);
      let rows: Array<Record<string, any>>;
      if (meta?.last_synced_at) {
        try {
          rows = source.all(
            `SELECT * FROM "${table}" WHERE "${conflictColumn}" > ?`,
            meta.last_synced_at
          ) as Array<Record<string, any>>;
        } catch {
          rows = source.all(`SELECT * FROM "${table}"`) as Array<Record<string, any>>;
          stat.first_sync = true;
        }
      } else {
        rows = source.all(`SELECT * FROM "${table}"`) as Array<Record<string, any>>;
        stat.first_sync = true;
      }

      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        const result = transferRows(target, table, batch, options);
        stat.synced_rows += result.written;
        stat.skipped_rows += result.skipped;
        stat.errors.push(...result.errors);
      }

      if (rows.length === 0) {
        stat.skipped_rows = stat.total_rows;
      }

      upsertSyncMeta(metaDb, {
        table_name: table,
        last_synced_at: new Date().toISOString(),
        last_synced_row_count: stat.synced_rows,
        direction,
      });
    } catch (error) {
      stat.errors.push(`Table "${table}": ${error instanceof Error ? error.message : String(error)}`);
    }

    results.push(stat);
  }

  return results;
}

export function getSyncMetaAll(db: DbAdapter): SyncMeta[] {
  ensureSyncMetaTable(db);
  return db.all(
    "SELECT table_name, last_synced_at, last_synced_row_count, direction FROM _sync_meta ORDER BY table_name"
  ) as SyncMeta[];
}

export function getSyncMetaForTable(db: DbAdapter, table: string): SyncMeta | null {
  return getSyncMeta(db, table);
}

export function resetSyncMeta(db: DbAdapter, table: string): void {
  ensureSyncMetaTable(db);
  db.run("DELETE FROM _sync_meta WHERE table_name = ?", table);
}

export function resetAllSyncMeta(db: DbAdapter): void {
  ensureSyncMetaTable(db);
  db.run("DELETE FROM _sync_meta");
}
