import { describe, test, expect, afterAll, beforeAll, setDefaultTimeout } from "bun:test";

// Doctor spawns a child process that checks REST server, MCP, etc. — needs more than 5s
setDefaultTimeout(30_000);
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLocalStoreBackend, isolatedStoreEnv } from "../test-support/store-isolation.js";

const DB_PATH = join(tmpdir(), `mementos-doctor-test-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

// `doctor` writes (it registers a machine) and this suite also drives `save`, so
// the child must be pinned to DB_PATH. Inheriting the ambient env unmodified —
// which is what this harness used to do — put those writes in the shared
// production store. See src/test-support/store-isolation.ts.
const CLI_ENV = isolatedStoreEnv(DB_PATH);

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

describe("doctor command", () => {
  test("runs successfully and shows all check sections", async () => {
    const { stdout, exitCode } = await runCli("doctor");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("mementos doctor");
    expect(stdout).toContain("Version:");
    expect(stdout).toContain("Database connection:");
    expect(stdout).toContain("Config:");
    expect(stdout).toContain("Schema version:");
    expect(stdout).toContain("Memories:");
    expect(stdout).toContain("Agents:");
    expect(stdout).toContain("Projects:");
  });

  test("shows memory scope, expired, and stale info", async () => {
    // Seed a memory first so there's scope data
    await runCli("save", "doctor-test-key", "doctor-test-value");
    const { stdout } = await runCli("doctor");
    expect(stdout).toContain("By scope:");
    expect(stdout).toContain("Expired:");
    expect(stdout).toContain("Stale (14+ days):");
  });

  test("shows DB file size", async () => {
    const { stdout } = await runCli("doctor");
    expect(stdout).toContain("DB file size:");
  });

  test("shows orphaned tags check", async () => {
    const { stdout } = await runCli("doctor");
    expect(stdout).toContain("Orphaned tags:");
  });

  test("shows version info", async () => {
    const { stdout } = await runCli("doctor");
    // Version line should contain a semver-like string
    expect(stdout).toMatch(/Version:\s+\d+\.\d+\.\d+/);
  });

  test("supports --json output", async () => {
    const { stdout, exitCode } = await runCli("--json", "doctor");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("checks");
    expect(parsed).toHaveProperty("healthy");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    // Each check should have name, status, detail
    for (const check of parsed.checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("status");
      expect(check).toHaveProperty("detail");
      expect(["ok", "warn", "fail"]).toContain(check.status);
    }
  });

  test("appears in --help output", async () => {
    const { stdout } = await runCli("--help");
    expect(stdout).toContain("doctor");
  });
});
