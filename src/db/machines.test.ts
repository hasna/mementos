process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import {
  deleteMachine,
  getPrimaryMachine,
  getPrimaryMachineCandidate,
  getPrimaryMachineStartupWarning,
  listMachines,
  registerMachine,
  setPrimaryMachine,
} from "./machines.js";

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
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
    CREATE INDEX IF NOT EXISTS idx_machines_hostname ON machines(hostname);
    CREATE INDEX IF NOT EXISTS idx_machines_primary ON machines(is_primary);
    CREATE TRIGGER IF NOT EXISTS machines_single_primary_insert
    AFTER INSERT ON machines
    WHEN NEW.is_primary = 1
    BEGIN
      UPDATE machines
      SET is_primary = 0,
          last_seen_at = COALESCE(NEW.last_seen_at, datetime('now'))
      WHERE id != NEW.id AND is_primary = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS machines_single_primary_update
    AFTER UPDATE OF is_primary ON machines
    WHEN NEW.is_primary = 1
    BEGIN
      UPDATE machines
      SET is_primary = 0,
          last_seen_at = COALESCE(NEW.last_seen_at, datetime('now'))
      WHERE id != NEW.id AND is_primary = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS machines_prevent_delete_primary
    BEFORE DELETE ON machines
    WHEN OLD.is_primary = 1
    BEGIN
      SELECT RAISE(ABORT, 'Primary machine cannot be deleted');
    END;
  `);

  return db;
}

function seedMachine(
  db: Database,
  id: string,
  name: string,
  hostname: string,
  isPrimary = false,
  createdAt = "2026-04-08T00:00:00.000Z",
  lastSeenAt = createdAt
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
      createdAt,
      lastSeenAt,
    ]
  );
}

describe("machine primary protection", () => {
  it("keeps the first machine as a candidate until a primary is explicitly set", () => {
    const db = freshDb();
    const alpha = registerMachine("alpha", db as any);
    const betaTimestamp = new Date(
      new Date(alpha.created_at).getTime() + 1000
    ).toISOString();
    seedMachine(
      db,
      "machine-beta",
      "beta",
      "beta-host",
      false,
      betaTimestamp,
      betaTimestamp
    );

    expect(getPrimaryMachine(db as any)).toBeNull();
    expect(getPrimaryMachineCandidate(db as any)?.id).toBe(alpha.id);
    expect(getPrimaryMachineStartupWarning(db as any)).toContain("alpha");

    db.close();
  });

  it("marks exactly one machine as primary and surfaces it first in listings", () => {
    const db = freshDb();
    const alpha = registerMachine("alpha", db as any);
    seedMachine(db, "machine-beta", "beta", "beta-host");

    const primary = setPrimaryMachine("machine-beta", db as any);
    expect(primary.id).toBe("machine-beta");
    expect(primary.is_primary).toBe(true);
    expect(getPrimaryMachine(db as any)?.id).toBe("machine-beta");
    expect(listMachines(db as any)[0]?.id).toBe("machine-beta");
    expect(listMachines(db as any).filter((machine) => machine.is_primary)).toHaveLength(1);
    expect(getPrimaryMachineStartupWarning(db as any)).toBeNull();

    setPrimaryMachine(alpha.name, db as any);
    expect(getPrimaryMachine(db as any)?.id).toBe(alpha.id);
    expect(listMachines(db as any).filter((machine) => machine.is_primary)).toHaveLength(1);

    db.close();
  });

  it("prevents deleting the primary machine in both helper and raw SQL paths", () => {
    const db = freshDb();
    const alpha = registerMachine("alpha", db as any);
    seedMachine(db, "machine-beta", "beta", "beta-host");
    setPrimaryMachine(alpha.id, db as any);

    expect(() => deleteMachine(alpha.id, db as any)).toThrow("Primary machine cannot be deleted");
    expect(() => db.run("DELETE FROM machines WHERE id = ?", [alpha.id])).toThrow("Primary machine cannot be deleted");

    deleteMachine("machine-beta", db as any);
    expect(listMachines(db as any).map((machine) => machine.id)).not.toContain("machine-beta");

    db.close();
  });
});
