process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory, getMemory } from "../db/memories.js";
import { registerProject } from "../db/projects.js";
import { gdprErase } from "./gdpr.js";

describe("gdprErase", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("dry_run reports matching memories without redacting", () => {
    const db = getDatabase();
    const memory = createMemory(
      {
        key: "user-email",
        value: "Contact alice@example.com for access",
        scope: "global",
        tags: ["alice@example.com"],
        metadata: { owner: "alice@example.com" },
      },
      "merge",
      db
    );

    const result = gdprErase("alice@example.com", { dry_run: true }, db);

    expect(result.erased_count).toBe(1);
    expect(result.memory_ids).toContain(memory.id);

    const unchanged = getMemory(memory.id, db)!;
    expect(unchanged.value).toContain("alice@example.com");
  });

  it("redacts matching memories and clears tags", () => {
    const db = getDatabase();
    const memory = createMemory(
      {
        key: "pii-key-alice",
        value: "alice@example.com uses this account",
        summary: "alice@example.com summary",
        scope: "global",
        tags: ["alice@example.com"],
        metadata: { email: "alice@example.com" },
      },
      "merge",
      db
    );

    db.run("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)", [
      memory.id,
      "pii",
    ]);

    const result = gdprErase("alice@example.com", {}, db);

    expect(result.erased_count).toBe(1);

    const redacted = getMemory(memory.id, db)!;
    expect(redacted.value).toBe("[REDACTED]");
    expect(redacted.summary).toBeNull();
    expect(redacted.tags).toEqual([]);
    expect(redacted.metadata).toEqual({});

    const tagRows = db
      .query("SELECT COUNT(*) as c FROM memory_tags WHERE memory_id = ?")
      .get(memory.id) as { c: number };
    expect(tagRows.c).toBe(0);
  });

  it("respects project_id and agent_id filters", () => {
    const db = getDatabase();
    const project1 = registerProject("proj-one", "/tmp/proj-one", undefined, undefined, db);
    const project2 = registerProject("proj-two", "/tmp/proj-two", undefined, undefined, db);

    createMemory(
      {
        key: "scoped",
        value: "bob@example.com in project",
        scope: "global",
        project_id: project1.id,
      },
      "merge",
      db
    );
    createMemory(
      {
        key: "other",
        value: "bob@example.com elsewhere",
        scope: "global",
        project_id: project2.id,
      },
      "merge",
      db
    );

    const result = gdprErase("bob@example.com", { project_id: project1.id, dry_run: true }, db);
    expect(result.erased_count).toBe(1);
  });

  it("returns zero when identifier matches nothing", () => {
    const db = getDatabase();
    createMemory({ key: "safe", value: "no pii here", scope: "global" }, "merge", db);

    const result = gdprErase("not-found@example.com", {}, db);
    expect(result.erased_count).toBe(0);
    expect(result.memory_ids).toEqual([]);
  });
});
