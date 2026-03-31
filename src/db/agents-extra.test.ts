process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import { registerAgent } from "./agents.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

// ============================================================================
// registerAgent — conflict window expired path (line 64)
// When an agent exists with a DIFFERENT session_id but last_seen_at is
// MORE than 30 minutes ago — the conflict window has expired, so no throw,
// and the closing brace of the if-block (line 64) executes.
// ============================================================================

describe("registerAgent - conflict window expired (line 64)", () => {
  test("allows re-registration with new session_id when conflict window has expired", () => {
    // 1. Register agent with session-A
    const first = registerAgent("expired-conflict-agent", "session-A");

    // 2. Force last_seen_at to be more than 30 minutes ago
    //    so the conflict window check (nowMs - lastSeenMs < CONFLICT_WINDOW_MS) is FALSE
    const pastTime = new Date(Date.now() - 35 * 60 * 1000).toISOString(); // 35 minutes ago
    const db = getDatabase();
    db.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", [pastTime, first.id]);

    // 3. Re-register with a different session_id.
    //    The conflict window has expired → no AgentConflictError thrown,
    //    the closing `}` of the if-block at line 64 executes,
    //    then the agent is updated to session-B.
    let second: ReturnType<typeof registerAgent> | null = null;
    expect(() => {
      second = registerAgent("expired-conflict-agent", "session-B");
    }).not.toThrow();

    // Agent should now have the new session_id
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first.id);
    expect(second!.name).toBe("expired-conflict-agent");
    expect(second!.session_id).toBe("session-B");
  });
});
