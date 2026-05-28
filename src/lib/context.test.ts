process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { assembleContext, formatLayeredContext } from "./context.js";

describe("assembleContext", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("builds sections from memories", () => {
    const db = getDatabase();
    const now = new Date().toISOString();

    createMemory(
      {
        key: "core-fact",
        value: "Use Bun runtime",
        category: "fact",
        scope: "global",
        importance: 9,
      },
      "merge",
      db
    );
    createMemory(
      {
        key: "recent-note",
        value: "Started refactor today",
        category: "history",
        scope: "global",
        importance: 5,
      },
      "merge",
      db
    );
    createMemory(
      {
        key: "searchable",
        value: "SQLite FTS5 powers search",
        category: "knowledge",
        scope: "global",
        importance: 6,
      },
      "merge",
      db
    );

    const ctx = assembleContext({ query: "SQLite", scope: "global" }, db);

    expect(ctx.total_memories).toBeGreaterThan(0);
    expect(ctx.token_estimate).toBeGreaterThan(0);
    expect(ctx.sections.some((s) => s.title === "Core Facts")).toBe(true);
    expect(ctx.sections.some((s) => s.memories.some((m) => m.key === "searchable"))).toBe(true);

    const allIds = ctx.sections.flatMap((s) => s.memories.map((m) => m.id));
    expect(new Set(allIds).size).toBe(allIds.length);

    void now;
  });

  it("formats layered context as markdown", () => {
    const ctx = assembleContext({}, getDatabase());
    const markdown = formatLayeredContext({
      sections: [
        {
          title: "Core Facts",
          memories: [
            {
              id: "1",
              key: "stack",
              value: "Bun + SQLite",
              importance: 9,
            } as any,
          ],
        },
      ],
      total_memories: 1,
      token_estimate: 10,
    });

    expect(markdown).toContain("## Core Facts");
    expect(markdown).toContain("**stack**: Bun + SQLite");
    expect(markdown).toContain("(importance: 9)");
  });

  it("truncates long values in formatted output", () => {
    const longValue = "word ".repeat(50);
    const markdown = formatLayeredContext({
      sections: [
        {
          title: "Core Facts",
          memories: [{ id: "1", key: "long", value: longValue, importance: 5 } as any],
        },
      ],
      total_memories: 1,
      token_estimate: 100,
    });

    expect(markdown).toContain("...");
    expect(markdown.length).toBeLessThan(longValue.length);
  });
});
