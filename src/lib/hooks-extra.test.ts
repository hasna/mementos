// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect } from "bun:test";
import { hookRegistry } from "./hooks.js";

// ============================================================================
// hooks.ts line 86 — blocking hook that throws doesn't cancel the operation
// When a blocking hook throws, the error is logged but the operation continues
// ============================================================================

describe("HookRegistry - blocking hook error handling (line 86)", () => {
  test("blocking hook that throws does not cancel the operation (line 86)", async () => {
    // Register a blocking hook that throws an error
    // → lines 85-87 fire: catch block logs error and continues
    const id = hookRegistry.register({
      type: "PreMemorySave",
      blocking: true,
      priority: 99, // Low priority so it runs last
      handler: async () => {
        throw new Error("Test blocking hook error for coverage");
      },
    });

    // runHooks should not cancel (should return true) even though blocking hook threw
    // The error is caught at line 86 (console.error) and the loop continues
    const result = await hookRegistry.runHooks("PreMemorySave", {
      input: { key: "test-key", value: "test-value", category: "knowledge", scope: "global" },
      agentId: "test-agent",
      timestamp: Date.now(),
    });

    // Blocking hook error → log and continue → operation proceeds → returns true
    expect(result).toBe(true);
    hookRegistry.unregister(id);
  });
});

// ============================================================================
// hooks.ts line 93 — non-blocking hook that throws
// Error is caught by the .catch() callback and logged, never propagates
// ============================================================================

describe("HookRegistry - non-blocking hook error handling (line 93)", () => {
  test("non-blocking hook that throws does not cancel the operation (line 93)", async () => {
    // Register a NON-blocking hook that throws an error
    // → line 89: goes to else branch (non-blocking)
    // → line 91-95: fire-and-forget, the .catch on line 93 fires
    const id = hookRegistry.register({
      type: "PostMemorySave",
      blocking: false, // non-blocking
      priority: 99,
      handler: async () => {
        throw new Error("Test non-blocking hook error for coverage line 93");
      },
    });

    // runHooks returns true immediately (fire-and-forget)
    const result = await hookRegistry.runHooks("PostMemorySave", {
      memory: { key: "test-key", value: "test-value", category: "knowledge", scope: "global", id: "mem-1" } as any,
      agentId: "test-agent",
      timestamp: Date.now(),
    });

    // Non-blocking hooks never cancel the operation
    expect(result).toBe(true);

    // Give the async error handler a tick to run (line 93 fires asynchronously)
    await new Promise((r) => setTimeout(r, 10));

    hookRegistry.unregister(id);
  });
});
