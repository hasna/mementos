process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { afterEach, describe, it, expect } from "bun:test";
import {
  MEMENTOS_STORAGE_FALLBACK_ENV,
  MEMENTOS_STORAGE_TABLES,
  STORAGE_TABLES,
  getStorageConfig,
  getStorageConnectionString,
  getStorageDatabaseEnv,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  getStorageMode,
  getStorageStatus,
  redactDatabaseUrl,
  shouldUsePgSsl,
  markServerContext,
  SqliteAdapter as Database,
  validatePostgresConnectionString,
} from "../storage.js";
import { applyPgMigrations, getPgMigrationDiagnostics } from "../db/pg-migrate.js";

// These tests exercise the server-side storage configuration + DSN builder,
// which is gated to the server process (CLAUDE.md §2). Opt in.
markServerContext();
import { registerMachine, listMachines } from "../db/machines.js";
import { getStorageSyncStatus, pullStorageChanges, pushStorageChanges } from "./storage-sync.js";

const STORAGE_ENV = [
  "HASNA_MEMENTOS_DATABASE_URL",
  "MEMENTOS_DATABASE_URL",
  "HASNA_MEMENTOS_STORAGE_MODE",
  "MEMENTOS_STORAGE_MODE",
  "MEMENTOS_DATABASE_PASSWORD",
] as const;

afterEach(() => {
  for (const key of STORAGE_ENV) delete process.env[key];
});

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      hostname TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'unknown',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedMachine(
  db: Database,
  id: string,
  name: string,
  hostname: string,
  isPrimary = false
): void {
  db.run(
    `INSERT INTO machines (id, name, hostname, platform, is_primary, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      hostname,
      "darwin",
      isPrimary ? 1 : 0,
      "2026-04-08T00:00:00.000Z",
      "2026-04-08T00:00:00.000Z",
    ]
  );
}

describe("mementos storage configuration", () => {
  it("prefers the Hasna namespaced storage database env", () => {
    process.env["MEMENTOS_DATABASE_URL"] = "postgres://fallback";
    process.env["HASNA_MEMENTOS_DATABASE_URL"] = "postgres://canonical";

    expect(getStorageDatabaseEnv()).toEqual({
      name: "HASNA_MEMENTOS_DATABASE_URL",
      deprecated: false,
    });
    expect(getStorageDatabaseEnvName()).toBe("HASNA_MEMENTOS_DATABASE_URL");
    expect(getStorageDatabaseUrl()).toBe("postgres://canonical");
    expect(getStorageConnectionString()).toBe("postgres://canonical");
    expect(getStorageConfig().mode).toBe("cloud");
    expect(getStorageMode()).toBe("cloud");
  });

  it("uses the shorter storage database env as fallback", () => {
    process.env["MEMENTOS_DATABASE_URL"] = "postgres://fallback";

    expect(getStorageDatabaseEnv()).toEqual({
      name: "MEMENTOS_DATABASE_URL",
      deprecated: false,
    });
    expect(getStorageDatabaseEnvName()).toBe("MEMENTOS_DATABASE_URL");
    expect(getStorageDatabaseUrl()).toBe("postgres://fallback");
  });

  it("uses storage mode overrides", () => {
    expect(getStorageConfig().mode).toBe("local");

    process.env["MEMENTOS_DATABASE_URL"] = "postgres://remote";
    expect(getStorageConfig().mode).toBe("cloud");

    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "remote";
    expect(getStorageConfig().mode).toBe("cloud");
  });

  it("treats cloud as canonical and remote/hybrid as deprecated aliases", () => {
    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "cloud";
    expect(getStorageConfig().mode).toBe("cloud");
    expect(getStorageMode()).toBe("cloud");

    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "hybrid";
    expect(getStorageConfig().mode).toBe("cloud");

    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "remote";
    expect(getStorageConfig().mode).toBe("cloud");

    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "local";
    expect(getStorageConfig().mode).toBe("local");
  });

  it("prefers the Hasna namespaced storage mode over fallback mode", () => {
    process.env["MEMENTOS_DATABASE_URL"] = "postgres://fallback";
    process.env["MEMENTOS_STORAGE_MODE"] = "remote";
    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "local";

    expect(getStorageConfig().mode).toBe("local");
    expect(getStorageMode()).toBe("local");
  });

  it("publishes stable storage tables, env constants, and redacted status", () => {
    process.env["MEMENTOS_DATABASE_URL"] =
      "postgres://user:secret@example.test/mementos?sslmode=require&password=query-secret&access_token=access-secret&client_secret=client-secret&aws_secret_access_key=aws-secret";

    const status = getStorageStatus();

    expect(STORAGE_TABLES).toEqual(MEMENTOS_STORAGE_TABLES);
    expect(MEMENTOS_STORAGE_FALLBACK_ENV.databaseUrl).toBe("MEMENTOS_DATABASE_URL");
    expect(status.service).toBe("mementos");
    expect(status.tables).toEqual(MEMENTOS_STORAGE_TABLES);
    expect(status.env.databaseUrl.name).toBe("HASNA_MEMENTOS_DATABASE_URL");
    expect(status.env.databaseUrl.active_name).toBe("MEMENTOS_DATABASE_URL");
    expect(status.database.redacted_url).toBe(
      "postgres://user:***@example.test/mementos?sslmode=require&password=***&access_token=***&client_secret=***&aws_secret_access_key=***"
    );
    expect(status.runtime.kind).toBe("cloud-postgres");
    expect(status.runtime.local.adapter).toBe("sqlite");
    expect(status.runtime.remote.adapter).toBe("postgres");
    expect(status.runtime.remote.source).toBe("env");
    expect(status.runtime.object_storage.s3.supported).toBe(false);
    expect(status.runtime.object_storage.aws.mutation_allowed).toBe(false);
    expect(JSON.stringify(status)).not.toContain("access-secret");
    expect(JSON.stringify(status)).not.toContain("client-secret");
    expect(JSON.stringify(status)).not.toContain("aws-secret");
    expect(JSON.stringify(status)).not.toContain("query-secret");
    expect(JSON.stringify(status)).not.toContain(":secret");
  });

  it("fails closed when remote mode uses a non-PostgreSQL URL", () => {
    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "remote";
    process.env["HASNA_MEMENTOS_DATABASE_URL"] =
      "sqlite:///tmp/mementos.db?access_token=local-secret";

    const status = getStorageStatus();

    expect(status.ok).toBe(false);
    expect(status.database.configured).toBe(false);
    expect(status.database.rds_compatible).toBe(false);
    expect(status.database.redacted_url).toBe("sqlite:///tmp/mementos.db?access_token=***");
    expect(status.runtime.remote.rds_compatible).toBe(false);
    expect(status.runtime.remote.fail_closed).toBe(true);
    expect(status.issues.join("\n")).toContain("postgres:// or postgresql://");
    expect(JSON.stringify(status)).not.toContain("local-secret");
  });

  it("fails closed when remote storage is requested without PostgreSQL config", () => {
    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "remote";

    const status = getStorageStatus();

    expect(status.ok).toBe(false);
    expect(status.remote_enabled).toBe(true);
    expect(status.database.configured).toBe(false);
    expect(status.runtime.fail_closed).toBe(true);
    expect(status.runtime.remote.fail_closed).toBe(true);
    expect(status.runtime.remote.missing).toContain("storage.rds.host");
    expect(status.issues.join("\n")).toContain("Cloud PostgreSQL/RDS storage is requested");
  });

  it("reports safe PostgreSQL/RDS migration diagnostics without networking", () => {
    const diagnostics = getPgMigrationDiagnostics(
      "postgres://user:secret@example.test/mementos?sslmode=require&client_secret=client-secret"
    );

    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.target).toBe("postgres-rds-compatible");
    expect(diagnostics.redacted_connection_string).toBe(
      "postgres://user:***@example.test/mementos?sslmode=require&client_secret=***"
    );
    expect(diagnostics.mutates_remote_on_apply).toBe(true);
    expect(diagnostics.requires_approval_for_live_run).toBe(true);
    expect(diagnostics.no_network).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain(":secret");
    expect(JSON.stringify(diagnostics)).not.toContain("client-secret");
  });

  it("fails PostgreSQL/RDS migration diagnostics closed for non-Postgres URLs", () => {
    const diagnostics = getPgMigrationDiagnostics(
      "sqlite:///tmp/mementos.db?aws_secret_access_key=aws-secret"
    );

    expect(diagnostics.ok).toBe(false);
    expect(diagnostics.configured).toBe(false);
    expect(diagnostics.redacted_connection_string).toBe(
      "sqlite:///tmp/mementos.db?aws_secret_access_key=***"
    );
    expect(diagnostics.issues.join("\n")).toContain("postgres:// or postgresql://");
    expect(JSON.stringify(diagnostics)).not.toContain("aws-secret");
  });

  it("rejects unsafe live PostgreSQL/RDS migration URLs before connecting", async () => {
    let message = "";
    try {
      await applyPgMigrations("sqlite:///tmp/mementos.db?access_token=local-secret");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("postgres:// or postgresql://");
    expect(message).not.toContain("local-secret");
  });

  it("redacts secret-like database URL query parameters", () => {
    expect(
      redactDatabaseUrl(
        "postgres://user:secret@example.test/mementos?access_token=a&client_secret=b&aws_secret_access_key=c&application_name=mementos"
      )
    ).toBe(
      "postgres://user:***@example.test/mementos?access_token=***&client_secret=***&aws_secret_access_key=***&application_name=mementos"
    );
  });

  it("validates PostgreSQL connection string scheme and host", () => {
    expect(validatePostgresConnectionString("postgres://example.test/mementos").ok).toBe(true);
    expect(validatePostgresConnectionString("postgresql://example.test/mementos").ok).toBe(true);
    expect(validatePostgresConnectionString("sqlite:///tmp/mementos.db").ok).toBe(false);
    expect(validatePostgresConnectionString("not a url").ok).toBe(false);
  });

  it("enables pg ssl only from explicit connection query parameters", () => {
    expect(shouldUsePgSsl("postgres://user:pass@example.test/mementos?ssl=true")).toBe(true);
    expect(shouldUsePgSsl("postgres://user:pass@example.test/mementos?ssl=1")).toBe(true);
    expect(shouldUsePgSsl("postgres://user:pass@example.test/mementos?sslmode=require")).toBe(true);
    expect(shouldUsePgSsl("postgres://user:pass@example.test/mementos?sslmode=verify-full")).toBe(true);

    expect(shouldUsePgSsl("postgres://user:sslmode%3Drequire@example.test/mementos")).toBe(false);
    expect(shouldUsePgSsl("postgres://example.test/sslmode=require")).toBe(false);
    expect(shouldUsePgSsl("postgres://example.test/mementos?ssl=false")).toBe(false);
    expect(shouldUsePgSsl("postgres://example.test/mementos?sslmode=prefer")).toBe(false);
  });
});

describe("storage machine sync", () => {
  it("pushes locally registered machines to the remote registry", () => {
    const local = freshDb();
    const remote = freshDb();

    const machine = registerMachine("alpha", local as any);
    const result = pushStorageChanges({
      tables: ["machines"],
      local,
      remote,
      current_machine_id: machine.id,
    });

    expect(result.errors).toEqual([]);
    expect(result.total_synced).toBe(1);

    const remoteMachines = listMachines(remote as any);
    expect(remoteMachines).toHaveLength(1);
    expect(remoteMachines[0]?.name).toBe("alpha");
    expect(remoteMachines[0]?.hostname).toBe(machine.hostname);

    const status = getStorageSyncStatus({
      local,
      current_machine_id: machine.id,
    });
    expect(status.current_machine_id).toBe(machine.id);
    expect(status.generic_sync_meta.some((meta) => meta.table_name === "machines")).toBe(true);

    local.close();
    remote.close();
  });

  it("pulls remotely registered machines into the local registry", () => {
    const local = freshDb();
    const remote = freshDb();

    const localMachine = registerMachine("alpha", local as any);

    remote.run(
      `INSERT INTO machines (id, name, hostname, platform, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      "remote-machine-id",
      "beta",
      "beta-host",
      "darwin",
      "2026-04-08T00:00:00.000Z",
      "2026-04-08T01:00:00.000Z"
    );

    const result = pullStorageChanges({
      tables: ["machines"],
      local,
      remote,
      current_machine_id: localMachine.id,
    });

    expect(result.errors).toEqual([]);

    const machines = listMachines(local as any);
    const names = machines.map((machine) => machine.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");

    local.close();
    remote.close();
  });

  it("syncs primary-machine designation across registries", () => {
    const local = freshDb();
    const remote = freshDb();

    const alpha = registerMachine("alpha", local as any);
    seedMachine(local, "machine-beta", "beta", "beta-host");
    local.run("UPDATE machines SET is_primary = 1, last_seen_at = ? WHERE id = ?", [
      "2026-04-08T02:00:00.000Z",
      "machine-beta",
    ]);

    const pushResult = pushStorageChanges({
      tables: ["machines"],
      local,
      remote,
      current_machine_id: "machine-beta",
    });

    expect(pushResult.errors).toEqual([]);
    const remoteMachines = listMachines(remote as any);
    expect(remoteMachines.find((machine) => machine.id === alpha.id)?.is_primary).toBe(false);
    expect(remoteMachines.find((machine) => machine.id === "machine-beta")?.is_primary).toBe(true);

    local.close();
    remote.close();
  });
});
