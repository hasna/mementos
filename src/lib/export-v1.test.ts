process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { exportV1, toJsonl, fromJsonl } from "./export-v1.js";

describe("export-v1", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("exports memories with format metadata", () => {
    const db = getDatabase();
    createMemory(
      { key: "stack", value: "Bun + SQLite", scope: "global", category: "fact" },
      "merge",
      db
    );

    const entries = exportV1({ scope: "global" }, db);
    expect(entries).toHaveLength(1);
    expect(entries[0]!._format).toBe("mementos-export-v1");
    expect(entries[0]!.memory.key).toBe("stack");
    expect(entries[0]!.entity_links).toEqual([]);
    expect(entries[0]!._exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("round-trips through JSONL", () => {
    const db = getDatabase();
    createMemory({ key: "a", value: "1", scope: "global" }, "merge", db);
    createMemory({ key: "b", value: "2", scope: "global" }, "merge", db);

    const jsonl = toJsonl(exportV1({ scope: "global" }, db));
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(2);

    const parsed = fromJsonl(jsonl);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.memory.key).sort()).toEqual(["a", "b"]);
  });

  it("ignores blank lines when parsing JSONL", () => {
    const sample = [
      JSON.stringify({
        _format: "mementos-export-v1",
        _exported_at: "2026-01-01T00:00:00.000Z",
        memory: { key: "k", value: "v" },
        entity_links: [],
      }),
      "",
      "   ",
    ].join("\n");

    expect(fromJsonl(sample)).toHaveLength(1);
  });
});
