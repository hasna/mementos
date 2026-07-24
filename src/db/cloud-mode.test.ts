import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDatabase, resetDatabase } from "./database.js";
import { translateSql } from "../storage.js";

const MODE_ENV = "HASNA_MEMENTOS_STORAGE_MODE";
const URL_ENV = "HASNA_MEMENTOS_DATABASE_URL";

describe("Amendment A1 — cloud-mode routing (getDatabase)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [MODE_ENV, URL_ENV, "MEMENTOS_STORAGE_MODE", "MEMENTOS_DATABASE_URL"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetDatabase();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetDatabase();
  });

  test("explicit dbPath always uses local SQLite, even in cloud mode", () => {
    process.env[MODE_ENV] = "cloud";
    process.env[URL_ENV] = "postgres://u:p@127.0.0.1:1/db?sslmode=require";
    // An explicit path must never route to Postgres (tests/tooling/import-export).
    const db = getDatabase(":memory:");
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO t (name) VALUES (?)", "local");
    expect(db.get("SELECT name FROM t WHERE id = 1")).toEqual({ name: "local" });
  });

  test("local mode (default) opens SQLite without a database URL", () => {
    const db = getDatabase(":memory:");
    expect(db).toBeDefined();
    db.run("CREATE TABLE t2 (id INTEGER PRIMARY KEY)");
    expect(db.all("SELECT * FROM t2")).toEqual([]);
  });
});

describe("Amendment A1 — SQLite→Postgres SQL translation", () => {
  test("? placeholders become positional $n", () => {
    expect(translateSql("SELECT * FROM m WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM m WHERE a = $1 AND b = $2"
    );
  });

  test("boolean COALESCE(pinned, 0) becomes COALESCE(pinned, FALSE)", () => {
    expect(translateSql("UPDATE memories SET pinned = COALESCE(pinned, 0)")).toBe(
      "UPDATE memories SET pinned = COALESCE(pinned, FALSE)"
    );
  });

  test("COALESCE(accessed_at, created_at|updated_at) renders the timestamptz fallback as ISO text", () => {
    // archiveStale path
    const created = translateSql(
      "SELECT COUNT(*) FROM memories WHERE COALESCE(accessed_at, created_at) < ?"
    );
    expect(created).toContain("COALESCE(accessed_at, to_char(created_at AT TIME ZONE 'UTC'");
    // deprioritizeStale path (reached by `mementos clean`) — this is the one that 500'd
    const updated = translateSql(
      "SELECT COUNT(*) FROM memories WHERE COALESCE(accessed_at, updated_at) < ?"
    );
    expect(updated).toContain("COALESCE(accessed_at, to_char(updated_at AT TIME ZONE 'UTC'");
    expect(updated).not.toMatch(/COALESCE\(accessed_at,\s*updated_at\)/);
  });

  test("datetime('now') becomes an ISO-8601 UTC text expression (comparable to text & timestamptz columns)", () => {
    const out = translateSql("SELECT * FROM m WHERE expires_at >= datetime('now')");
    expect(out).toContain("to_char(now() AT TIME ZONE 'UTC'");
    expect(out).not.toContain("datetime(");
  });

  test("datetime('now', '-7 days') offset preserved as INTERVAL in ISO text", () => {
    const out = translateSql("SELECT * FROM m WHERE created_at >= datetime('now', '-7 days')");
    expect(out).toContain("now() - INTERVAL '7 days'");
    expect(out).toContain("to_char(");
  });

  test("literal boolean comparisons: pinned = 1/0 become TRUE/FALSE", () => {
    expect(translateSql("SELECT COUNT(*) FROM memories WHERE pinned = 1")).toBe(
      "SELECT COUNT(*) FROM memories WHERE pinned = TRUE"
    );
    expect(translateSql("SELECT * FROM memories WHERE status = 'active' AND pinned = 0")).toBe(
      "SELECT * FROM memories WHERE status = 'active' AND pinned = FALSE"
    );
  });

  test("literal boolean comparisons: success = 1/0 become TRUE/FALSE (tool-insights)", () => {
    // Postgres has no `boolean = integer` operator; the tool-insights
    // `SUM(CASE WHEN success = 1 ...)` 500s without this translation.
    expect(
      translateSql("SELECT SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) FROM tool_events")
    ).toBe("SELECT SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) FROM tool_events");
    expect(
      translateSql("SELECT COUNT(*) FROM tool_events WHERE success = 0")
    ).toBe("SELECT COUNT(*) FROM tool_events WHERE success = FALSE");
  });

  test("literal boolean comparisons: is_primary = 1/0 become TRUE/FALSE (machines)", () => {
    expect(translateSql("SELECT * FROM machines WHERE is_primary = 1 LIMIT 1")).toBe(
      "SELECT * FROM machines WHERE is_primary = TRUE LIMIT 1"
    );
    expect(translateSql("UPDATE machines SET is_primary = 0 WHERE id != ?")).toBe(
      "UPDATE machines SET is_primary = FALSE WHERE id != $1"
    );
  });

  test("parameterized success = ? is left untouched (pg coerces the bound value)", () => {
    expect(translateSql("SELECT * FROM tool_events WHERE success = ?")).toBe(
      "SELECT * FROM tool_events WHERE success = $1"
    );
  });

  test("COALESCE(accessed_at, created_at) casts the timestamptz side to ISO text (stale/health)", () => {
    // accessed_at is `text` (ISO), created_at is `timestamptz`; a bare COALESCE
    // 500s ("types text and timestamp with time zone cannot be matched"). The
    // fallback must be rendered as the same ISO-8601 text so ordering is stable.
    const out = translateSql(
      "SELECT id FROM memories ORDER BY COALESCE(accessed_at, created_at) ASC"
    );
    expect(out).toContain("COALESCE(accessed_at, to_char(created_at AT TIME ZONE 'UTC'");
    expect(out).not.toMatch(/COALESCE\(accessed_at,\s*created_at\)/);
  });

  test("INSTR(haystack, needle) becomes Postgres STRPOS(...) (graph-path recursive CTE)", () => {
    const out = translateSql(
      "SELECT trail FROM path WHERE INSTR(p.trail, x.id) = 0"
    );
    expect(out).toBe("SELECT trail FROM path WHERE STRPOS(p.trail, x.id) = 0");
    expect(out).not.toMatch(/INSTR/i);
  });

  test("parameterized pinned = ? is left untouched (pg coerces the bound value)", () => {
    expect(translateSql("SELECT * FROM memories WHERE pinned = ?")).toBe(
      "SELECT * FROM memories WHERE pinned = $1"
    );
  });

  test("INSERT OR IGNORE becomes INSERT ... ON CONFLICT DO NOTHING", () => {
    expect(translateSql("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)")).toBe(
      "INSERT INTO memory_tags (memory_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING"
    );
  });
});
