process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { registerMachine, listMachines } from "../db/machines.js";
import { getCloudSyncStatus, pullCloudChanges, pushCloudChanges } from "./cloud-sync.js";

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

describe("cloud machine sync", () => {
  it("pushes locally registered machines to the remote registry", () => {
    const local = freshDb();
    const remote = freshDb();

    const machine = registerMachine("alpha", local as any);
    const result = pushCloudChanges({
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

    const status = getCloudSyncStatus({
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

    const result = pullCloudChanges({
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

    const pushResult = pushCloudChanges({
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
