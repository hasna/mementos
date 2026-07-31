import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDatabase, resetDatabase } from "./database.js";
import { isApiMode } from "./api-mode.js";
import { resetServerContextForTests } from "../storage.js";

// ============================================================================
// Split-brain guard: in API mode, getDatabase() must FAIL CLOSED rather than
// silently open a local SQLite island. This is the structural guarantee that
// no client code path (domain module, MCP tool, CLI command, lib helper) can
// silently read/write a divergent local database while the cloud API transport
// is active. See src/db/database.ts getDatabase().
// ============================================================================

const API_URL = "HASNA_MEMENTOS_API_URL";
const API_KEY = "HASNA_MEMENTOS_API_KEY";
const DSN = "HASNA_MEMENTOS_DATABASE_URL";
const MODE = "HASNA_MEMENTOS_STORAGE_MODE";
const ALIASES = [
  API_URL,
  API_KEY,
  DSN,
  MODE,
  "MEMENTOS_API_URL",
  "MEMENTOS_API_KEY",
  "MEMENTOS_DATABASE_URL",
  "MEMENTOS_STORAGE_MODE",
];

describe("split-brain guard — getDatabase() fail-closed in API mode", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetServerContextForTests();
    for (const k of ALIASES) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetDatabase();
  });

  afterEach(() => {
    for (const k of ALIASES) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetServerContextForTests();
    resetDatabase();
  });

  test("throws when API mode is active and no explicit dbPath is given", () => {
    process.env[API_URL] = "https://mementos.hasna.xyz";
    process.env[API_KEY] = "sk-test";
    expect(isApiMode()).toBe(true);
    expect(() => getDatabase()).toThrow(/API mode/);
  });

  test("explicit dbPath is still honored in API mode (tests/tooling/import-export)", () => {
    process.env[API_URL] = "https://mementos.hasna.xyz";
    process.env[API_KEY] = "sk-test";
    const db = getDatabase(":memory:");
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO t (name) VALUES (?)", "local");
    expect(db.get("SELECT name FROM t WHERE id = 1")).toEqual({ name: "local" });
  });

  test("does NOT fail-closed in local mode (no API env)", () => {
    expect(isApiMode()).toBe(false);
    const db = getDatabase(":memory:");
    expect(db).toBeDefined();
  });

  test("does NOT engage API-mode guard when a client DSN is present (that path is forbidden elsewhere)", () => {
    // A DSN disables API mode (see isApiMode); the guard must not fire here.
    process.env[API_URL] = "https://mementos.hasna.xyz";
    process.env[API_KEY] = "sk-test";
    process.env[DSN] = "postgres://u:p@127.0.0.1:1/db";
    expect(isApiMode()).toBe(false);
    // With a DSN + no explicit mode, storage promotes to cloud; a client cloud
    // open is refused by getCloudDatabase (server-only), NOT by the API guard.
    expect(() => getDatabase()).toThrow(/server-only|API mode/);
  });
});
