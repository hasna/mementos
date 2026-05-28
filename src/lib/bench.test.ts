process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { runBench } from "./bench.js";

describe("runBench", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("returns latency metrics for save/recall/search/list operations", async () => {
    const db = getDatabase();
    const result = await runBench({ count: 10 }, db);

    expect(result.save_latency_ms).toBeGreaterThan(0);
    expect(result.recall_latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.search_latency_ms).toBeGreaterThan(0);
    expect(result.list_latency_ms).toBeGreaterThan(0);
    expect(result.operations_per_second).toBeGreaterThan(0);
    expect(typeof result.total_memories).toBe("number");
  });

  it("cleans up benchmark memories after run", async () => {
    const db = getDatabase();
    await runBench({ count: 5 }, db);

    const remaining = db
      .query("SELECT COUNT(*) as c FROM memories WHERE key LIKE 'bench-%'")
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});
