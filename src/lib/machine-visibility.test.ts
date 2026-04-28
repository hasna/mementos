process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import {
  resolveVisibleMachineId,
  visibleToMachineFilter,
  isMemoryVisibleToMachine,
} from "./machine-visibility.js";

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
  `);

  return db;
}

// ============================================================================
// resolveVisibleMachineId
// ============================================================================

describe("resolveVisibleMachineId", () => {
  it("returns explicit machineId when provided", () => {
    const db = freshDb();
    expect(resolveVisibleMachineId("explicit-id", db)).toBe("explicit-id");
    expect(resolveVisibleMachineId(null, db)).toBe(null);
    db.close();
  });

  it("returns null when no db and no machineId", () => {
    // resolveVisibleMachineId() tries getCurrentMachineId(db) with no db,
    // which will attempt to open a real DB — if it succeeds, it returns an id.
    // So the only guaranteed null is when we pass null explicitly.
    expect(resolveVisibleMachineId(null)).toBe(null);
  });

  it("auto-registers and returns machine id from db", () => {
    const db = freshDb();
    const id = resolveVisibleMachineId(undefined, db);
    expect(typeof id).toBe("string");
    // Calling again should return same id (idempotent registration)
    const id2 = resolveVisibleMachineId(undefined, db);
    expect(id2).toBe(id);
    db.close();
  });

  it("handles db failure gracefully", () => {
    // Without machines table, getCurrentMachineId will throw
    const db = new Database(":memory:", { create: true });
    expect(resolveVisibleMachineId(undefined, db)).toBe(null);
    db.close();
  });
});

// ============================================================================
// visibleToMachineFilter
// ============================================================================

describe("visibleToMachineFilter", () => {
  it("returns filter with explicit machineId", () => {
    const db = freshDb();
    const filter = visibleToMachineFilter("machine-123", db);
    expect(filter.visible_to_machine_id).toBe("machine-123");
    db.close();
  });

  it("returns filter with null when no machineId", () => {
    const db = freshDb();
    const filter = visibleToMachineFilter(null, db);
    expect(filter.visible_to_machine_id).toBe(null);
    db.close();
  });

  it("auto-detects machineId from db", () => {
    const db = freshDb();
    const filter = visibleToMachineFilter(undefined, db);
    expect(typeof filter.visible_to_machine_id).toBe("string");
    db.close();
  });
});

// ============================================================================
// isMemoryVisibleToMachine
// ============================================================================

describe("isMemoryVisibleToMachine", () => {
  it("memory without machine_id is visible to all", () => {
    const db = freshDb();
    const memory = { machine_id: null } as { machine_id: string | null };
    expect(isMemoryVisibleToMachine(memory, "any-machine", db)).toBe(true);
    expect(isMemoryVisibleToMachine(memory, undefined, db)).toBe(true);
    db.close();
  });

  it("memory with matching machine_id is visible", () => {
    const db = freshDb();
    const id = resolveVisibleMachineId(undefined, db);
    const memory = { machine_id: id } as { machine_id: string | null };
    expect(isMemoryVisibleToMachine(memory, id, db)).toBe(true);
    db.close();
  });

  it("memory with different machine_id is not visible", () => {
    const db = freshDb();
    expect(isMemoryVisibleToMachine({ machine_id: "other-machine" }, "my-machine", db)).toBe(false);
    db.close();
  });

  it("returns false when db can't resolve machineId", () => {
    const db = new Database(":memory:", { create: true });
    const memory = { machine_id: "some-machine" } as { machine_id: string | null };
    expect(isMemoryVisibleToMachine(memory, undefined, db)).toBe(false);
    db.close();
  });

  it("returns false when machineId resolves to null", () => {
    const db = freshDb();
    const memory = { machine_id: "some-machine" } as { machine_id: string | null };
    expect(isMemoryVisibleToMachine(memory, null, db)).toBe(false);
    db.close();
  });
});
