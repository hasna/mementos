import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SqliteAdapter as Database } from "@hasna/cloud";
import { join } from "node:path";
import {
  listSessions,
  cleanStaleSessions,
  closeRegistry,
} from "./session-registry.js";

// ============================================================================
// Dead-PID tests for session-registry
// Lines 117 (isProcessAlive returns false), 233-234 (dead session cleanup in listSessions),
// 253-254 (cleanStaleSessions deletes dead sessions)
// ============================================================================

// The registry DB path (mirrors what session-registry.ts uses internally)
const DB_PATH = join(
  process.env["HOME"] || process.env["USERPROFILE"] || "~",
  ".open-sessions-registry.db"
);

// A PID that doesn't exist — signal 0 will throw ESRCH → isProcessAlive returns false
// Use a very high value unlikely to be a real process
const DEAD_PID = 999_999_999;

// Ensure the dead PID is actually dead
function isReallyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false; // PID exists
  } catch {
    return true; // ESRCH = no such process
  }
}

let insertedDeadSessionIds: string[] = [];
let db: Database;

beforeEach(() => {
  insertedDeadSessionIds = [];
  // Open the registry DB directly so we can insert test rows
  db = new Database(DB_PATH, { create: true });
});

afterEach(() => {
  // Clean up any sessions we inserted with dead PIDs
  for (const id of insertedDeadSessionIds) {
    try {
      db.run("DELETE FROM sessions WHERE id = ?", [id]);
    } catch {
      // ignore
    }
  }
  db.close();
  closeRegistry();
});

function insertDeadPidSession(id: string, pid: number): void {
  db.run(
    `INSERT OR IGNORE INTO sessions (id, pid, cwd, mcp_server, registered_at, last_seen_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [id, pid, "/tmp", "test-mcp-dead"]
  );
  insertedDeadSessionIds.push(id);
}

describe("isProcessAlive - returns false for dead PID (line 117)", () => {
  test("listSessions filters out dead-PID sessions (lines 117, 233-234)", () => {
    if (!isReallyDead(DEAD_PID)) {
      // If somehow this PID is alive (very unlikely), skip gracefully
      expect(true).toBe(true);
      return;
    }

    const deadId = `dead-${Date.now()}`;
    insertDeadPidSession(deadId, DEAD_PID);

    // listSessions calls isProcessAlive for each session.
    // For the dead-PID session: isProcessAlive returns false (line 117),
    // then the dead session is deleted (lines 233-234).
    const sessions = listSessions({ mcp_server: "test-mcp-dead" });

    // The dead session should NOT appear in results (it was cleaned up)
    const found = sessions.find(s => s.id === deadId);
    expect(found).toBeUndefined();
  });
});

describe("cleanStaleSessions - deletes dead-PID sessions (lines 253-254)", () => {
  test("cleans up sessions with dead PIDs (lines 253-254)", () => {
    if (!isReallyDead(DEAD_PID)) {
      expect(true).toBe(true);
      return;
    }

    const deadId = `dead-clean-${Date.now()}`;
    insertDeadPidSession(deadId, DEAD_PID);

    // Before clean: verify it's in the DB
    const before = db.query("SELECT id FROM sessions WHERE id = ?").get(deadId) as { id: string } | null;
    expect(before).not.toBeNull();

    // cleanStaleSessions detects dead PIDs (line 252: !isProcessAlive),
    // deletes them (line 253), and increments cleaned (line 254)
    const cleaned = cleanStaleSessions();
    expect(cleaned).toBeGreaterThanOrEqual(1);

    // The dead session should be gone
    const after = db.query("SELECT id FROM sessions WHERE id = ?").get(deadId) as { id: string } | null;
    expect(after).toBeNull();

    // Remove from our cleanup list since it's already deleted
    insertedDeadSessionIds = insertedDeadSessionIds.filter(id => id !== deadId);
  });
});
