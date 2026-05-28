process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory, updateMemory } from "../db/memories.js";
import { registerProject } from "../db/projects.js";
import { pushSessionBriefing } from "./session-start-briefing.js";
import { setServerRef } from "./channel-pusher.js";

describe("pushSessionBriefing", () => {
  const originalApiKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    resetDatabase();
    setServerRef(null);
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    }
  });

  it("returns false without project_id", async () => {
    expect(await pushSessionBriefing({})).toBe(false);
  });

  it("returns false when project has no briefing content", async () => {
    const db = getDatabase();
    const project = registerProject("empty", "/tmp/empty", undefined, undefined, db);

    expect(
      await pushSessionBriefing({
        project_id: project.id,
        project_name: "empty",
      })
    ).toBe(false);
  });

  it("pushes briefing when project has high-importance memories", async () => {
    const db = getDatabase();
    const project = registerProject("active", "/tmp/active", undefined, undefined, db);

    createMemory(
      {
        key: "project-stack",
        value: "Bun + SQLite",
        scope: "shared",
        category: "fact",
        importance: 9,
        project_id: project.id,
      },
      "merge",
      db
    );

    let pushedText = "";
    setServerRef({
      notification: async (msg: { params: { content: string } }) => {
        pushedText = msg.params.content;
      },
    });

    const result = await pushSessionBriefing({
      project_id: project.id,
      project_name: "active",
    });

    expect(result).toBe(true);
    expect(pushedText).toContain("project-stack");
    expect(pushedText).toContain("Bun + SQLite");
  });

  it("includes flagged memories in briefing", async () => {
    const db = getDatabase();
    const project = registerProject("flagged", "/tmp/flagged", undefined, undefined, db);

    const memory = createMemory(
      {
        key: "needs-review",
        value: "Verify migration order",
        scope: "shared",
        category: "knowledge",
        importance: 6,
        project_id: project.id,
      },
      "merge",
      db
    );
    updateMemory(memory.id, { flag: "review", version: memory.version }, db);

    let pushedText = "";
    setServerRef({
      notification: async (msg: { params: { content: string } }) => {
        pushedText = msg.params.content;
      },
    });

    expect(await pushSessionBriefing({ project_id: project.id })).toBe(true);
    expect(pushedText).toContain("needs-review");
    expect(pushedText.toLowerCase()).toContain("needs attention");
    expect(pushedText).toContain("[review]");
  });
});
