// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import { registerAgent } from "./agents.js";
import {
  acquireLock,
  cleanExpiredLocksWithInfo,
  cleanExpiredLocks,
} from "./locks.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

// Helper: format a Date as SQLite datetime string 'YYYY-MM-DD HH:MM:SS'
function sqliteDate(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// ============================================================================
// cleanExpiredLocksWithInfo — lines 220-228
// ============================================================================

describe("cleanExpiredLocksWithInfo", () => {
  test("returns empty array when no expired locks", () => {
    const result = cleanExpiredLocksWithInfo();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test("returns info about cleaned locks", () => {
    const agent = registerAgent("cleanup-agent");

    // Insert a pre-expired lock using SQLite datetime format so comparison works
    const db = getDatabase(":memory:");
    const past = sqliteDate(new Date(Date.now() - 60000));

    db.run(
      `INSERT INTO resource_locks (id, resource_type, resource_id, agent_id, lock_type, locked_at, expires_at)
       VALUES ('expired-lock-1', 'memory', 'mem-expired', ?, 'exclusive', ?, ?)`,
      [agent.id, past, past]
    );

    const result = cleanExpiredLocksWithInfo();
    expect(result.length).toBe(1);
    expect(result[0]!.resource_type).toBe("memory");
    expect(result[0]!.resource_id).toBe("mem-expired");
    expect(result[0]!.agent_id).toBe(agent.id);
    expect(result[0]!.lock_type).toBe("exclusive");
  });

  test("does not clean non-expired locks", () => {
    const agent = registerAgent("active-agent");

    // Valid lock with future expiry (acquireLock uses ISO format, but expires in future)
    acquireLock(agent.id, "memory", "mem-active", "exclusive", 300);

    const result = cleanExpiredLocksWithInfo();
    expect(result.length).toBe(0);
  });

  test("cleanExpiredLocks returns count of removed locks", () => {
    const agent = registerAgent("count-agent");
    const db = getDatabase(":memory:");
    const past = sqliteDate(new Date(Date.now() - 60000));

    db.run(
      `INSERT INTO resource_locks (id, resource_type, resource_id, agent_id, lock_type, locked_at, expires_at)
       VALUES ('exp-lock-a', 'memory', 'mem-a', ?, 'exclusive', ?, ?)`,
      [agent.id, past, past]
    );
    db.run(
      `INSERT INTO resource_locks (id, resource_type, resource_id, agent_id, lock_type, locked_at, expires_at)
       VALUES ('exp-lock-b', 'project', 'proj-b', ?, 'advisory', ?, ?)`,
      [agent.id, past, past]
    );

    const count = cleanExpiredLocks();
    expect(count).toBe(2);
  });
});
