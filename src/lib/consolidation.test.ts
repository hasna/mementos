process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory, getMemory, listMemories } from "../db/memories.js";
import { getMemoryLinks } from "../db/memory-links.js";
import { runConsolidation } from "./consolidation.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

describe("runConsolidation", () => {
  test("dry-run plans duplicate merge, semantic promotion, summary, and decay without mutating memories", async () => {
    const a = createMemory({
      key: "session-bun-test-a",
      value: "In session one, the agent learned this project uses bun test for verification.",
      category: "history",
      scope: "shared",
      importance: 5,
      tags: ["session"],
    });
    const b = createMemory({
      key: "session-bun-test-b",
      value: "In session two, the agent learned this project uses bun test for verification.",
      category: "history",
      scope: "shared",
      importance: 6,
      tags: ["session"],
    });
    const stale = createMemory({
      key: "old-low-value",
      value: "Temporary note from an old task that was never reused.",
      category: "history",
      scope: "shared",
      importance: 1,
    });

    getDatabase(":memory:").run(
      "UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?",
      ["2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", stale.id],
    );

    const result = await runConsolidation({
      dryRun: true,
      scope: "shared",
      duplicateThreshold: 0.7,
      staleDays: 30,
      decayThreshold: 2,
      db: getDatabase(":memory:"),
    });

    expect(result.dryRun).toBe(true);
    expect(result.actions.some((a) => a.type === "merge_duplicate")).toBe(true);
    expect(result.actions.some((a) => a.type === "promote_semantic")).toBe(true);
    expect(result.actions.some((a) => a.type === "summarize_cluster")).toBe(true);
    expect(result.actions.some((a) => a.type === "decay_forget")).toBe(true);

    expect(getMemory(a.id)!.status).toBe("active");
    expect(getMemory(b.id)!.status).toBe("active");
    expect(getMemory(stale.id)!.status).toBe("active");
    expect(listMemories({ tags: ["consolidated"] })).toHaveLength(0);
  });

  test("applies consolidation with archive reasons, source links, and idempotent output", async () => {
    const a = createMemory({
      key: "session-cli-a",
      value: "Session found that CLI and MCP must stay in parity for every command.",
      category: "history",
      scope: "shared",
      importance: 7,
      tags: ["session"],
    });
    const b = createMemory({
      key: "session-cli-b",
      value: "Another session found that CLI and MCP must stay in parity for every command.",
      category: "history",
      scope: "shared",
      importance: 5,
      tags: ["session"],
    });

    const first = await runConsolidation({
      dryRun: false,
      scope: "shared",
      duplicateThreshold: 0.6,
      db: getDatabase(":memory:"),
    });

    expect(first.summary.applied).toBeGreaterThanOrEqual(3);

    const kept = getMemory(a.id)!;
    const archived = getMemory(b.id)!;
    expect(kept.status).toBe("active");
    expect(archived.status).toBe("archived");
    expect(archived.metadata["archive_reason"]).toContain("consolidation");

    const consolidated = listMemories({ tags: ["consolidated"], limit: 20 });
    const summary = consolidated.find((m) => m.tags.includes("summary"));
    const semantic = consolidated.find((m) => m.tags.includes("semantic"));
    expect(summary).toBeDefined();
    expect(semantic).toBeDefined();
    expect(summary!.metadata["source_memory_ids"]).toContain(a.id);
    expect(getMemoryLinks(summary!.id).map((l) => l.target_memory_id)).toContain(a.id);
    expect(getMemoryLinks(semantic!.id).map((l) => l.target_memory_id)).toContain(b.id);

    const second = await runConsolidation({
      dryRun: false,
      scope: "shared",
      duplicateThreshold: 0.6,
      db: getDatabase(":memory:"),
    });

    expect(second.summary.applied).toBe(0);
    expect(listMemories({ tags: ["consolidated"], limit: 20 })).toHaveLength(2);
  });
});
