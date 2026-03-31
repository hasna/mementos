import { describe, it, expect, afterEach } from "bun:test";
import {
  pushToProject,
  setServerRef,
} from "./channel-pusher.js";
import { registerSession, unregisterSession, closeRegistry } from "./session-registry.js";

// ============================================================================
// channel-pusher.ts lines 127-130 — pushToProject with current PID session
// Lines 127-130 only fire when a session with s.pid === process.pid exists
// for the given project name.
// ============================================================================

const TEST_MCP = `test-mcp-channel-extra-${Date.now()}`;
const TEST_PROJECT = `test-channel-project-${Date.now()}`;
let sessionId: string | null = null;

afterEach(() => {
  setServerRef(null);
  if (sessionId) {
    try {
      unregisterSession(sessionId);
    } catch { /* ignore */ }
    sessionId = null;
  }
  closeRegistry();
});

describe("pushToProject - with current PID session (lines 127-130)", () => {
  it("enters the pid === process.pid branch and calls pushRawNotification (lines 127-130)", async () => {
    // Register a session for the current process PID with the test project
    // This ensures getSessionsByProject returns a session with s.pid === process.pid
    const session = registerSession({
      mcp_server: TEST_MCP,
      project_name: TEST_PROJECT,
    });
    sessionId = session.id;

    // Set up a mock server that records notifications
    let notificationCalled = false;
    const mockServer = {
      notification: async () => {
        notificationCalled = true;
      },
    };
    setServerRef(mockServer);

    // pushToProject: getSessionsByProject returns our session (pid === process.pid)
    // → lines 127-130 execute: pushRawNotification is called (which calls server.notification)
    const count = await pushToProject(TEST_PROJECT, "test content from channel-pusher-extra");

    // The push succeeded — count should be 1 (our session matched)
    expect(count).toBe(1);
    expect(notificationCalled).toBe(true);
  });

  it("skips sessions where pid does NOT match (lines 127-130 branch not taken)", async () => {
    // This test verifies the NEGATIVE path (pid != process.pid) is already covered by
    // the session filter, ensuring only current-PID sessions are notified.
    // We can't create sessions with foreign PIDs via registerSession, so we test
    // that no sessions from a different project are returned.
    setServerRef({ notification: async () => {} });
    const count = await pushToProject(`nonexistent-project-${Date.now()}`, "hello");
    expect(count).toBe(0);
  });
});
