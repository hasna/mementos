import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertLocalStoreBackend,
  blankLlmProviderEnv,
  isolatedStoreEnv,
} from "../test-support/store-isolation.js";

// Regression test for bug "json-flag-ignored": several subcommands ignored the
// global `--json` flag and printed human plain text (e.g. "No hooks registered.")
// even when `--json` was requested, breaking programmatic parsing.

const DB_PATH = join(tmpdir(), `mementos-json-flag-test-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

// Pinned to DB_PATH and verified before the suite writes anything — see
// src/test-support/store-isolation.ts.
const CLI_ENV = isolatedStoreEnv(DB_PATH, { extra: blankLlmProviderEnv() });

beforeAll(async () => {
  await assertLocalStoreBackend(CLI_PATH, CLI_ENV, DB_PATH);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
});

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    env: CLI_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("--json flag is honored by all listed subcommands", () => {
  // [args, human plain-text marker that must NOT appear when --json is passed]
  const cases: Array<{ name: string; args: string[]; humanMarker: string }> = [
    { name: "hooks list", args: ["hooks", "list", "--json"], humanMarker: "No hooks registered." },
    { name: "hooks stats", args: ["hooks", "stats", "--json"], humanMarker: "Hook Registry Stats" },
    { name: "synthesis status", args: ["synthesis", "status", "--json"], humanMarker: "No synthesis runs found." },
    { name: "session list", args: ["session", "list", "--json"], humanMarker: "No session jobs found." },
    { name: "profile list", args: ["profile", "list", "--json"], humanMarker: "No profiles yet" },
    { name: "auto-memory status", args: ["auto-memory", "status", "--json"], humanMarker: "Auto-Memory Status" },
    { name: "brains model get", args: ["brains", "model", "get", "--json"], humanMarker: "Active model:" },
    { name: "get-focus", args: ["get-focus", "--agent", "json-test-agent", "--json"], humanMarker: "No focus set." },
  ];

  for (const c of cases) {
    test(`${c.name} --json emits parseable JSON and no human text`, async () => {
      const { stdout, exitCode } = await runCli(...c.args);
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain(c.humanMarker);
      // stdout must be valid JSON (object or array).
      expect(() => JSON.parse(stdout)).not.toThrow();
    });
  }

  test("brains model (default action) also honors --json", async () => {
    const { stdout, exitCode } = await runCli("brains", "model", "--json");
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Active model:");
    const parsed = JSON.parse(stdout) as { activeModel?: string };
    expect(typeof parsed.activeModel).toBe("string");
  });

  test("without --json, human text is still emitted", async () => {
    const { stdout } = await runCli("hooks", "list");
    expect(stdout).toContain("No hooks registered.");
  });
});
