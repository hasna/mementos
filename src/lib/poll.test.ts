process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { SqliteAdapter as Database } from "../storage.js";
import { startPolling } from "./poll.js";

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'knowledge',
      scope TEXT NOT NULL DEFAULT 'private',
      summary TEXT,
      tags TEXT DEFAULT '[]',
      importance INTEGER NOT NULL DEFAULT 5,
      source TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      project_id TEXT,
      session_id TEXT,
      metadata TEXT DEFAULT '{}',
      access_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      valid_from TEXT,
      valid_until TEXT,
      ingested_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT
    );
  `);
  return db;
}

function insertMemory(
  db: Database,
  id: string,
  key: string,
  value: string,
  updatedAt: string
): void {
  db.run(
    `INSERT INTO memories (id, key, value, scope, status, created_at, updated_at)
     VALUES (?, ?, ?, 'global', 'active', ?, ?)`,
    [id, key, value, updatedAt, updatedAt]
  );
}

describe("startPolling", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("delivers newly inserted memories after seed baseline", async () => {
    insertMemory(db, "seed-1", "seed", "baseline", "2026-01-01T00:00:00.000Z");

    const received: string[] = [];
    const handle = startPolling({
      db,
      interval_ms: 50,
      on_memories: (memories) => {
        received.push(...memories.map((m) => m.key));
      },
    });

    insertMemory(db, "new-1", "fresh", "value", "2026-01-02T00:00:00.000Z");

    await Bun.sleep(150);
    handle.stop();

    expect(received).toContain("fresh");
    expect(received).not.toContain("seed");
  });

  it("filters by scope", async () => {
    db.run(
      `INSERT INTO memories (id, key, value, scope, status, created_at, updated_at)
       VALUES ('s1', 'shared', 'v', 'shared', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );

    const received: string[] = [];
    const handle = startPolling({
      db,
      interval_ms: 50,
      scope: "global",
      on_memories: (memories) => {
        received.push(...memories.map((m) => m.key));
      },
    });

    db.run(
      `INSERT INTO memories (id, key, value, scope, status, created_at, updated_at)
       VALUES ('g1', 'global-one', 'v', 'global', 'active', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`
    );
    db.run(
      `INSERT INTO memories (id, key, value, scope, status, created_at, updated_at)
       VALUES ('s2', 'shared-two', 'v', 'shared', 'active', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`
    );

    await Bun.sleep(150);
    handle.stop();

    expect(received).toContain("global-one");
    expect(received).not.toContain("shared-two");
  });

  it("calls on_error when callback throws", async () => {
    insertMemory(db, "base", "base", "v", "2026-01-01T00:00:00.000Z");

    let caught: Error | null = null;
    const handle = startPolling({
      db,
      interval_ms: 50,
      on_memories: () => {
        throw new Error("callback failed");
      },
      on_error: (err) => {
        caught = err;
      },
    });

    insertMemory(db, "trigger", "trigger", "v", "2026-01-02T00:00:00.000Z");
    await Bun.sleep(150);
    handle.stop();

    expect(caught?.message).toBe("callback failed");
  });

  it("stops polling when handle.stop is called", async () => {
    const received: string[] = [];
    const handle = startPolling({
      db,
      interval_ms: 30,
      on_memories: (memories) => {
        received.push(...memories.map((m) => m.key));
      },
    });

    handle.stop();
    insertMemory(db, "after-stop", "after-stop", "v", "2026-01-02T00:00:00.000Z");
    await Bun.sleep(100);

    expect(received).not.toContain("after-stop");
  });
});
