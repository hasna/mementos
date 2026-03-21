process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import { createMemory, updateMemory, deleteMemory } from "./memories.js";
import { getMemoryAuditTrail, exportAuditLog, getAuditStats } from "./audit.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

describe("audit log", () => {
  it("logs memory creation automatically", () => {
    const mem = createMemory({ key: "test-audit", value: "hello" });
    const trail = getMemoryAuditTrail(mem.id);
    expect(trail.length).toBeGreaterThanOrEqual(1);
    const createEntry = trail.find((e) => e.operation === "create");
    expect(createEntry).toBeTruthy();
    expect(createEntry!.memory_id).toBe(mem.id);
    expect(createEntry!.memory_key).toBe("test-audit");
  });

  it("logs memory update automatically", () => {
    const mem = createMemory({ key: "upd-audit", value: "v1" });
    updateMemory(mem.id, { value: "v2", version: mem.version });

    const trail = getMemoryAuditTrail(mem.id);
    const updateEntries = trail.filter((e) => e.operation === "update");
    expect(updateEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("logs memory deletion automatically", () => {
    const mem = createMemory({ key: "del-audit", value: "bye" });
    const memId = mem.id;
    deleteMemory(memId);

    const trail = getMemoryAuditTrail(memId);
    const deleteEntry = trail.find((e) => e.operation === "delete");
    expect(deleteEntry).toBeTruthy();
  });

  it("audit entries have timestamps", () => {
    const mem = createMemory({ key: "ts-audit", value: "test" });
    const trail = getMemoryAuditTrail(mem.id);
    expect(trail.length).toBeGreaterThanOrEqual(1);
    expect(trail[0]!.created_at).toBeTruthy();
  });

  it("exportAuditLog returns all entries", () => {
    createMemory({ key: "exp-1", value: "a" });
    createMemory({ key: "exp-2", value: "b" });

    const all = exportAuditLog();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("exportAuditLog filters by operation", () => {
    const mem = createMemory({ key: "filt-audit", value: "v1" });
    updateMemory(mem.id, { value: "v2", version: mem.version });

    const creates = exportAuditLog({ operation: "create" });
    const updates = exportAuditLog({ operation: "update" });
    expect(creates.every((e) => e.operation === "create")).toBe(true);
    expect(updates.every((e) => e.operation === "update")).toBe(true);
  });

  it("getAuditStats returns counts", () => {
    createMemory({ key: "stat-1", value: "a" });
    createMemory({ key: "stat-2", value: "b" });

    const stats = getAuditStats();
    expect(stats.total_entries).toBeGreaterThanOrEqual(2);
    expect(stats.by_operation["create"]).toBeGreaterThanOrEqual(2);
  });

  it("audit log is append-only (entries persist after memory deletion)", () => {
    const mem = createMemory({ key: "persist-audit", value: "temp" });
    const memId = mem.id;
    deleteMemory(memId);

    const trail = getMemoryAuditTrail(memId);
    // Should have both create and delete entries even though memory is gone
    expect(trail.length).toBeGreaterThanOrEqual(2);
    const ops = trail.map((e) => e.operation);
    expect(ops).toContain("create");
    expect(ops).toContain("delete");
  });
});
