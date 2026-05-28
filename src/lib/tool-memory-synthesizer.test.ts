process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { synthesizeToolMemory, synthesizeAllToolMemories } from "./tool-memory-synthesizer.js";
import { saveToolEvent } from "../db/tool-events.js";

describe("tool-memory-synthesizer", () => {
  const originalApiKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    resetDatabase();
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    }
  });

  it("returns null without API key", async () => {
    const db = getDatabase();
    for (let i = 0; i < 10; i++) {
      saveToolEvent(
        {
          tool_name: "Grep",
          action: "search",
          success: true,
          latency_ms: 10,
        },
        db
      );
    }

    expect(await synthesizeToolMemory("Grep", { min_events: 5 })).toBeNull();
    expect(await synthesizeAllToolMemories({ min_events: 5 })).toEqual([]);
  });

  it("returns null when tool has insufficient events", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const db = getDatabase();

    saveToolEvent({ tool_name: "Read", action: "read", success: true }, db);

    expect(await synthesizeToolMemory("Read", { min_events: 10 })).toBeNull();
  });
});
