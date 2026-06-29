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
  shouldUsePgSsl,
  SqliteAdapter as Database,
} from "../storage.js";
import { registerMachine, listMachines } from "../db/machines.js";
import { getStorageSyncStatus, pullStorageChanges, pushStorageChanges } from "./storage-sync.js";

const STORAGE_ENV = [
  "HASNA_MEMENTOS_DATABASE_URL",
  "MEMENTOS_DATABASE_URL",
  "HASNA_MEMENTOS_STORAGE_MODE",
  "MEMENTOS_STORAGE_MODE",
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
    expect(getStorageConfig().mode).toBe("hybrid");
    expect(getStorageMode()).toBe("hybrid");
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
    expect(getStorageConfig().mode).toBe("hybrid");

    process.env["HASNA_MEMENTOS_STORAGE_MODE"] = "remote";
    expect(getStorageConfig().mode).toBe("remote");
  });

  it("publishes stable storage tables, env constants, and redacted status", () => {
    process.env["MEMENTOS_DATABASE_URL"] = "postgres://user:secret@example.test/mementos";

    const status = getStorageStatus();

    expect(STORAGE_TABLES).toEqual(MEMENTOS_STORAGE_TABLES);
    expect(MEMENTOS_STORAGE_FALLBACK_ENV.databaseUrl).toBe("MEMENTOS_DATABASE_URL");
    expect(status.service).toBe("mementos");
    expect(status.tables).toEqual(MEMENTOS_STORAGE_TABLES);
    expect(status.env.databaseUrl.name).toBe("HASNA_MEMENTOS_DATABASE_URL");
    expect(status.env.databaseUrl.active_name).toBe("MEMENTOS_DATABASE_URL");
    expect(status.database.redacted_url).toBe("postgres://user:***@example.test/mementos");
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
