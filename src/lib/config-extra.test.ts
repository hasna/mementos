// NOTE: Do NOT set MEMENTOS_DB_PATH here — we need to test paths without it
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDbPath } from "./config.js";

// ============================================================================
// Legacy home-level ~/.mementos must not be auto-selected as the active DB.
// It may be copied to ~/.hasna/mementos during migration, but canonical global
// operation should resolve to ~/.hasna/mementos/mementos.db.
// ============================================================================

const HOME_MEMENTOS_DB = join(homedir(), ".mementos", "mementos.db");

describe("getDbPath - ignores legacy home .mementos during automatic discovery", () => {
  let savedCwd: string;

  afterEach(() => {
    // Restore cwd and env
    if (savedCwd && process.cwd() !== savedCwd) {
      try { process.chdir(savedCwd); } catch { /* ignore */ }
    }
    process.env["MEMENTOS_DB_PATH"] = ":memory:";
    delete process.env["MEMENTOS_DB_SCOPE"];
    delete process.env["HASNA_MEMENTOS_DB_PATH"];
    delete process.env["MEMENTOS_PROFILE"];
  });

  test("falls back to ~/.hasna/mementos when ~/.mementos/mementos.db exists", () => {
    if (!existsSync(HOME_MEMENTOS_DB)) {
      // If the file doesn't exist on this machine, skip gracefully
      expect(true).toBe(true);
      return;
    }

    savedCwd = process.cwd();
    delete process.env["MEMENTOS_DB_PATH"];
    delete process.env["HASNA_MEMENTOS_DB_PATH"];
    delete process.env["MEMENTOS_DB_SCOPE"];
    delete process.env["MEMENTOS_PROFILE"];

    process.chdir(homedir());

    const p = getDbPath();

    expect(p).toBe(join(homedir(), ".hasna", "mementos", "mementos.db"));
    expect(p).not.toBe(HOME_MEMENTOS_DB);
    expect(p).not.toBe(":memory:");
  });

  test("does not walk from a home subdirectory into legacy ~/.mementos", () => {
    if (!existsSync(HOME_MEMENTOS_DB)) {
      expect(true).toBe(true);
      return;
    }

    savedCwd = process.cwd();
    delete process.env["MEMENTOS_DB_PATH"];
    delete process.env["HASNA_MEMENTOS_DB_PATH"];
    delete process.env["MEMENTOS_DB_SCOPE"];
    delete process.env["MEMENTOS_PROFILE"];

    const tmpSubdir = join(homedir(), ".hasna");
    if (existsSync(tmpSubdir)) {
      process.chdir(tmpSubdir);
      const p = getDbPath();
      expect(p).toBe(join(homedir(), ".hasna", "mementos", "mementos.db"));
      expect(p).not.toBe(HOME_MEMENTOS_DB);
    } else {
      // Can't test from this path
      expect(true).toBe(true);
    }
  });
});
