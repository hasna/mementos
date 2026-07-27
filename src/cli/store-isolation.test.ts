import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  API_KEY_ENV_KEYS,
  API_URL_ENV_KEYS,
  DATABASE_URL_ENV_KEYS,
} from "../db/api-mode.js";
import { MEMENTOS_STORAGE_ENV, MEMENTOS_STORAGE_FALLBACK_ENV } from "../storage.js";
import {
  STORE_SELECTOR_ENV_KEYS,
  assertLocalStoreBackend,
  isolatedStoreEnv,
} from "../test-support/store-isolation.js";
import type { StoreBackendReport } from "../db/store-backend.js";

// ============================================================================
// Guard: a test run must not be able to reach a non-local store.
//
// The defect this locks down was MEASURED, not theorised. The CLI harness built
// its child env as `{ ...process.env, MEMENTOS_DB_PATH: tmp }`. On a machine
// where the operator shell exports HASNA_MEMENTOS_API_URL +
// HASNA_MEMENTOS_API_KEY (inherited by every tmux pane), `isApiMode()` is true,
// so every write went over HTTPS to the SHARED PRODUCTION store while the
// scratch SQLite file was never created. Test fixtures therefore accumulated in
// the cross-agent memory layer, indistinguishable from real memories.
//
// Blanking the offending vars fixes today's instance and nothing else. These
// tests instead assert the PROPERTY: whatever the ambient environment says, a
// harness env resolves to local SQLite — and if it ever does not, the failure is
// loud. The first test is the positive control that proves the probe can see the
// bad state at all; without it, every "we are local" assertion below could be
// passing vacuously.
//
// SAFETY: every child here runs `storage mode`, which opens no database and
// makes no network request. The planted-bad-state cases additionally point at a
// closed loopback port rather than the real endpoint, so even a regression that
// added a network call could not reach production.
// ============================================================================

const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;
const DB_PATH = join(tmpdir(), `mementos-store-isolation-${Date.now()}.db`);

/** A deliberately unreachable endpoint: nothing listens on TCP port 1. */
const UNREACHABLE_API_URL = "http://127.0.0.1:1";
const FAKE_API_KEY = "not-a-real-key";

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch { /* already gone */ }
  }
});

async function reportFor(env: Record<string, string>): Promise<StoreBackendReport> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, "storage", "mode", "--json"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`storage mode exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout) as StoreBackendReport;
}

describe("store-isolation guard", () => {
  test("POSITIVE CONTROL: the pre-fix harness env resolves to the cloud store", async () => {
    // This is the old code, reconstructed exactly: spread the ambient env, set
    // the scratch DB path, blank the DSN and mode vars — and leave the API
    // selectors alone. If this does NOT come back as cloud, the probe is blind
    // and every other assertion in this file is worthless.
    const preFixEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      MEMENTOS_DB_PATH: DB_PATH,
      HASNA_MEMENTOS_DB_PATH: DB_PATH,
      HASNA_MEMENTOS_DATABASE_URL: "",
      MEMENTOS_DATABASE_URL: "",
      HASNA_MEMENTOS_STORAGE_MODE: "",
      MEMENTOS_STORAGE_MODE: "",
      // Stand in for the operator's exported credentials so the control does not
      // depend on this machine's shell — and point somewhere unreachable.
      HASNA_MEMENTOS_API_URL: UNREACHABLE_API_URL,
      HASNA_MEMENTOS_API_KEY: FAKE_API_KEY,
    };

    const report = await reportFor(preFixEnv);
    expect(report.api_mode).toBe(true);
    expect(report.backend).toBe("cloud-api");
    // Blanking the DSN does not merely fail to help — it SATISFIES api mode's
    // "no DATABASE_URL present" precondition, making the flip more certain.
    expect(report.selected_by).toContain("presence");
  });

  test("isolatedStoreEnv neutralizes ambient API credentials", async () => {
    const report = await reportFor(isolatedStoreEnv(DB_PATH));
    expect(report.api_mode).toBe(false);
    expect(report.backend).toBe("local-sqlite");
    expect(report.db_path).toBe(DB_PATH);
    expect(report.api_key_present).toBe(false);
  });

  test("isolatedStoreEnv wins even when the ambient env sets every selector", async () => {
    // Simulate the worst ambient environment we could inherit, then isolate it.
    for (const key of STORE_SELECTOR_ENV_KEYS) process.env[key] = "cloud";
    process.env[API_URL_ENV_KEYS[0]] = UNREACHABLE_API_URL;
    process.env[API_KEY_ENV_KEYS[0]] = FAKE_API_KEY;
    try {
      const report = await reportFor(isolatedStoreEnv(DB_PATH));
      expect(report.api_mode).toBe(false);
      expect(report.backend).toBe("local-sqlite");
    } finally {
      for (const key of STORE_SELECTOR_ENV_KEYS) delete process.env[key];
    }
  });

  test("no single selector can escape isolation on its own", async () => {
    // One at a time, so a key that is silently not covered cannot hide behind
    // another key that is.
    for (const key of STORE_SELECTOR_ENV_KEYS) {
      const value = key.endsWith("_API_URL") ? UNREACHABLE_API_URL : key.endsWith("_MODE") ? "cloud" : "x";
      process.env[key] = value;
      // API mode needs BOTH url and key, so pair them to make the flip possible.
      process.env[API_KEY_ENV_KEYS[0]] = FAKE_API_KEY;
      process.env[API_URL_ENV_KEYS[0]] = UNREACHABLE_API_URL;
      try {
        const report = await reportFor(isolatedStoreEnv(DB_PATH));
        expect(report.backend).toBe("local-sqlite");
        expect(report.api_mode).toBe(false);
      } finally {
        delete process.env[key];
        delete process.env[API_KEY_ENV_KEYS[0]];
        delete process.env[API_URL_ENV_KEYS[0]];
      }
    }
  });

  test("assertLocalStoreBackend THROWS on a non-local child rather than proceeding", async () => {
    const badEnv: Record<string, string> = {
      ...isolatedStoreEnv(DB_PATH),
      [API_URL_ENV_KEYS[0]]: UNREACHABLE_API_URL,
      [API_KEY_ENV_KEYS[0]]: FAKE_API_KEY,
    };
    // Fail loudly, and say enough for an operator to act: which backend, and why.
    await expect(assertLocalStoreBackend(CLI_PATH, badEnv)).rejects.toThrow(/REFUSING TO RUN/);
    await expect(assertLocalStoreBackend(CLI_PATH, badEnv)).rejects.toThrow(/cloud-api/);
  });

  test("assertLocalStoreBackend THROWS when the scratch path did not survive", async () => {
    const env = isolatedStoreEnv(DB_PATH);
    await expect(
      assertLocalStoreBackend(CLI_PATH, env, join(tmpdir(), "a-different-path.db")),
    ).rejects.toThrow(/UNEXPECTED path/);
  });

  test("assertLocalStoreBackend accepts the isolated env", async () => {
    const report = await assertLocalStoreBackend(CLI_PATH, isolatedStoreEnv(DB_PATH), DB_PATH);
    expect(report.backend).toBe("local-sqlite");
  });

  test("STORE_SELECTOR_ENV_KEYS covers every key the resolvers read", () => {
    // Derived from the resolvers' own exported lists, so this fails the moment a
    // new selector is added anywhere without widening the isolation set.
    const required = [
      ...API_URL_ENV_KEYS,
      ...API_KEY_ENV_KEYS,
      ...DATABASE_URL_ENV_KEYS,
      MEMENTOS_STORAGE_ENV.mode,
      MEMENTOS_STORAGE_FALLBACK_ENV.mode,
      MEMENTOS_STORAGE_ENV.databaseUrl,
      MEMENTOS_STORAGE_FALLBACK_ENV.databaseUrl,
    ];
    const missing = required.filter((key) => !STORE_SELECTOR_ENV_KEYS.includes(key));
    expect(missing).toEqual([]);
  });

  test("storage mode neither opens nor creates a database", async () => {
    // The whole point of this command is to be the one probe you can run when you
    // do not yet know which store you are pointed at, so it must have no storage
    // side effects. It also has to hold for `assertScratchDbCreated` to mean
    // anything: that assertion proves a WRITE landed in the scratch file, and it
    // is called after `assertLocalStoreBackend` has already run this command
    // against the same path. If the probe created the file, the later assertion
    // would pass no matter what the write did.
    const freshPath = join(tmpdir(), `mementos-mode-no-side-effect-${Date.now()}-${process.pid}.db`);
    expect(existsSync(freshPath)).toBe(false);
    try {
      const report = await reportFor(isolatedStoreEnv(freshPath));
      // Local mode is the case that would open the file; api mode fails closed.
      expect(report.backend).toBe("local-sqlite");
      expect(report.db_path).toBe(freshPath);
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        expect(existsSync(freshPath + suffix)).toBe(false);
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const f = freshPath + suffix;
        if (existsSync(f)) try { unlinkSync(f); } catch { /* already gone */ }
      }
    }
  });

  test("the mode report never carries a credential value", async () => {
    const env: Record<string, string> = {
      ...isolatedStoreEnv(DB_PATH),
      [API_URL_ENV_KEYS[0]]: UNREACHABLE_API_URL,
      [API_KEY_ENV_KEYS[0]]: FAKE_API_KEY,
    };
    const report = await reportFor(env);
    expect(report.api_mode).toBe(true);
    expect(report.api_key_present).toBe(true);
    // The key must be reported as present, never echoed — this report is printed
    // in terminals and pasted into tickets.
    expect(JSON.stringify(report)).not.toContain(FAKE_API_KEY);
  });
});

// ============================================================================
// Repo sweep: keep new harnesses from reopening the hole.
//
// Reviewing each new test file by eye is exactly what let this defect ship. A
// harness that spreads the ambient env into a spawned child inherits the
// operator's production credentials, so it must build that env through
// src/test-support/store-isolation.ts rather than hand-rolling a blank list.
// ============================================================================

// Every dir whose tests can spawn a mementos process. `server` is included
// because a server spawned with the ambient env routes its own unpinned domain
// writes to the cloud exactly as a CLI child would — the sweep missing it is how
// three server harnesses stayed on the hand-rolled env after the cli/lib/mcp fix.
const CLIENT_TEST_DIRS = ["cli", "db", "lib", "mcp", "server"] as const;
const SRC_DIR = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

function testFilesIn(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      files.push(...testFilesIn(full));
      continue;
    }
    if (/\.test\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("store-isolation sweep", () => {
  test("every client harness that inherits the ambient env builds it via store-isolation", () => {
    const offenders: string[] = [];

    for (const sub of CLIENT_TEST_DIRS) {
      for (const file of testFilesIn(join(SRC_DIR, sub))) {
        const source = readFileSync(file, "utf8");
        const spawns = /Bun\.spawn\(|spawnSync\(/.test(source);
        const inheritsEnv = /\.\.\.\(?process\.env/.test(source);
        if (!spawns || !inheritsEnv) continue;
        // This guard file itself reconstructs bad envs on purpose.
        if (file === new URL(import.meta.url).pathname) continue;
        if (!source.includes("test-support/store-isolation")) {
          offenders.push(relative(SRC_DIR, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
