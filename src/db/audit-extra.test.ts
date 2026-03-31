// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import { createMemory, updateMemory } from "./memories.js";
import { exportAuditLog, getAuditStats } from "./audit.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

// ============================================================================
// exportAuditLog filter combinations — lines 68-69, 72-73, 80-81
// ============================================================================

describe("exportAuditLog - filter combinations", () => {
  it("filters by since timestamp", () => {
    const mem = createMemory({ key: "since-test", value: "v1" });

    const future = new Date(Date.now() + 86400000).toISOString();
    const results = exportAuditLog({ since: future });
    expect(results.length).toBe(0);

    // Past since should include entries
    const past = new Date(Date.now() - 86400000).toISOString();
    const historical = exportAuditLog({ since: past });
    expect(historical.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by until timestamp", () => {
    createMemory({ key: "until-test", value: "v1" });

    const past = new Date(Date.now() - 86400000).toISOString();
    const results = exportAuditLog({ until: past });
    // No entries before yesterday
    expect(results.length).toBe(0);

    const future = new Date(Date.now() + 86400000).toISOString();
    const all = exportAuditLog({ until: future });
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by agent_id", () => {
    createMemory({ key: "agent-audit", value: "v1" });

    // Filter by an agent_id that doesn't exist
    const noResults = exportAuditLog({ agent_id: "nonexistent-agent" });
    expect(noResults.length).toBe(0);
  });

  it("combines multiple filters", () => {
    createMemory({ key: "combined-audit", value: "v1" });
    const mem = createMemory({ key: "combined-audit-2", value: "v2" });
    updateMemory(mem.id, { value: "v2-updated", version: mem.version });

    const creates = exportAuditLog({ operation: "create" });
    const updates = exportAuditLog({ operation: "update" });

    expect(creates.every((e) => e.operation === "create")).toBe(true);
    expect(updates.every((e) => e.operation === "update")).toBe(true);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      createMemory({ key: `limit-audit-${i}`, value: "v" });
    }

    const limited = exportAuditLog({ limit: 2 });
    expect(limited.length).toBe(2);
  });

  it("uses default limit when not specified", () => {
    createMemory({ key: "default-limit-audit", value: "v" });
    const results = exportAuditLog();
    expect(Array.isArray(results)).toBe(true);
  });
});

// ============================================================================
// getAuditStats — lines 96-118
// ============================================================================

describe("getAuditStats - additional coverage", () => {
  it("returns by_operation map", () => {
    createMemory({ key: "stat-audit-1", value: "v" });
    createMemory({ key: "stat-audit-2", value: "v" });

    const stats = getAuditStats();
    expect(typeof stats.total_entries).toBe("number");
    expect(typeof stats.by_operation).toBe("object");
    expect(typeof stats.recent_24h).toBe("number");
    expect(stats.total_entries).toBeGreaterThanOrEqual(2);
    expect(stats.by_operation["create"]).toBeGreaterThanOrEqual(2);
  });

  it("recent_24h counts entries from last 24 hours", () => {
    createMemory({ key: "recent-stat", value: "v" });
    const stats = getAuditStats();
    expect(stats.recent_24h).toBeGreaterThanOrEqual(1);
  });

  it("handles empty audit log gracefully", () => {
    const stats = getAuditStats();
    expect(typeof stats.total_entries).toBe("number");
    expect(stats.total_entries).toBeGreaterThanOrEqual(0);
  });
});
