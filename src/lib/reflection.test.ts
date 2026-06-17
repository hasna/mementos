process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory, listMemories } from "../db/memories.js";
import { getMemoryLinks } from "../db/memory-links.js";
import { reflectOnTrajectory, type ReflectionCritic } from "./reflection.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

describe("reflectOnTrajectory", () => {
  const critic: ReflectionCritic = async () => ({
    summary: "The session succeeded by using tests first but lost time on broad file scans.",
    whatWorked: [
      {
        lesson: "Writing focused tests before implementation kept the memory consolidation contract stable.",
        evidence: ["The trajectory included a failing test before implementation."],
        importance: 8,
      },
    ],
    whatFailed: [
      {
        lesson: "Broad repository scans created avoidable noise before the target modules were identified.",
        evidence: ["The trajectory spent time reading unrelated modules."],
        importance: 6,
      },
    ],
    doDifferently: [
      {
        lesson: "Start future feature work by mapping command, storage, and MCP parity boundaries first.",
        evidence: ["The task required CLI and MCP parity."],
        importance: 9,
      },
    ],
  });

  test("dry-run critiques a session without writing memories", async () => {
    createMemory({
      key: "session-a-step",
      value: "The agent wrote a failing test, then implemented the feature.",
      scope: "shared",
      category: "history",
      session_id: "session-a",
    });

    const result = await reflectOnTrajectory({
      on: "session",
      source: "session-a",
      dryRun: true,
      critic,
      db: getDatabase(":memory:"),
    });

    expect(result.dryRun).toBe(true);
    expect(result.lessons).toHaveLength(3);
    expect(result.createdMemories).toHaveLength(0);
    expect(listMemories({ tags: ["reflection"] })).toHaveLength(0);
  });

  test("writes structured linked lessons from critic output", async () => {
    const source = createMemory({
      key: "session-b-step",
      value: "The agent kept CLI and MCP parity visible while adding a feature.",
      scope: "shared",
      category: "history",
      session_id: "session-b",
      importance: 6,
    });

    const result = await reflectOnTrajectory({
      on: "session",
      source: "session-b",
      critic,
      db: getDatabase(":memory:"),
    });

    expect(result.dryRun).toBe(false);
    expect(result.createdMemories).toHaveLength(3);
    expect(result.run.status).toBe("completed");

    const saved = listMemories({ tags: ["reflection"], limit: 10 });
    expect(saved).toHaveLength(3);
    expect(saved.map((m) => m.category).every((category) => category === "knowledge")).toBe(true);
    expect(saved.some((m) => m.tags.includes("worked"))).toBe(true);
    expect(saved.some((m) => m.tags.includes("failed"))).toBe(true);
    expect(saved.some((m) => m.tags.includes("do-differently"))).toBe(true);
    expect(saved[0]!.metadata["reflection_run_id"]).toBe(result.run.id);

    const linkedTargets = saved.flatMap((memory) =>
      getMemoryLinks(memory.id).map((link) => link.target_memory_id),
    );
    expect(linkedTargets).toContain(source.id);
  });
});
