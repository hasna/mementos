process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import {
  markAsPushed,
  wasRecentlyPushed,
  resetRecentlyPushed,
  getRecentlyPushedCount,
  findActivatedMemories,
} from "./activation-matcher.js";

describe("activation-matcher dedup", () => {
  beforeEach(() => {
    resetRecentlyPushed();
  });

  it("tracks recently pushed memory ids", () => {
    expect(wasRecentlyPushed("mem-1")).toBe(false);
    markAsPushed(["mem-1", "mem-2"]);
    expect(wasRecentlyPushed("mem-1")).toBe(true);
    expect(wasRecentlyPushed("mem-3")).toBe(false);
    expect(getRecentlyPushedCount()).toBe(2);
  });

  it("clears recently pushed cache", () => {
    markAsPushed(["mem-1"]);
    resetRecentlyPushed();
    expect(getRecentlyPushedCount()).toBe(0);
    expect(wasRecentlyPushed("mem-1")).toBe(false);
  });
});

describe("findActivatedMemories", () => {
  beforeEach(() => {
    resetDatabase();
    resetRecentlyPushed();
  });

  it("returns empty for short context", async () => {
    expect(await findActivatedMemories("short")).toEqual([]);
    expect(await findActivatedMemories("")).toEqual([]);
  });

  it("falls back to keyword match on when_to_use", async () => {
    const db = getDatabase();
    createMemory(
      {
        key: "typescript-pref",
        value: "Always use TypeScript",
        scope: "global",
        when_to_use: "When choosing programming language typescript files",
      },
      "merge",
      db
    );
    createMemory(
      {
        key: "unrelated",
        value: "Something else entirely",
        scope: "global",
        when_to_use: "When discussing database migrations",
      },
      "merge",
      db
    );

    const results = await findActivatedMemories(
      "I need help choosing typescript for my new project files",
      { max_results: 3 }
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m) => m.key === "typescript-pref")).toBe(true);
    expect(results.every((m) => m.status === "active")).toBe(true);
  });

  it("excludes recently pushed memories", async () => {
    const db = getDatabase();
    const memory = createMemory(
      {
        key: "recent",
        value: "Deploy checklist",
        scope: "global",
        when_to_use: "When deploying application servers",
      },
      "merge",
      db
    );

    markAsPushed([memory.id]);

    const results = await findActivatedMemories(
      "Help me deploy application servers to production",
      { max_results: 5 }
    );

    expect(results.find((m) => m.id === memory.id)).toBeUndefined();
  });
});
