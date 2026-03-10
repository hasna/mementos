import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use a temp file DB so all subprocess calls share the same database
const DB_PATH = join(tmpdir(), `mementos-cli-test-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

afterAll(() => {
  // Cleanup temp DB
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
});

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    env: { ...process.env, MEMENTOS_DB_PATH: DB_PATH },
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

describe("CLI", () => {
  test("--version outputs version", async () => {
    const { stdout } = await runCli("--version");
    expect(stdout).toBe("0.1.0");
  });

  test("--help shows help text", async () => {
    const { stdout } = await runCli("--help");
    expect(stdout).toContain("save");
    expect(stdout).toContain("recall");
    expect(stdout).toContain("list");
  });

  test("save creates a memory", async () => {
    const { stdout, exitCode } = await runCli("save", "cli-test-key", "cli-test-value");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Memory saved");
    expect(stdout).toContain("cli-test-key");
  });

  test("save with scope and importance", async () => {
    const { stdout } = await runCli(
      "save", "cli-global", "global-val",
      "--scope", "global",
      "--importance", "9",
      "--category", "fact"
    );
    expect(stdout).toContain("global");
    expect(stdout).toContain("fact");
    expect(stdout).toContain("9/10");
  });

  test("save with tags", async () => {
    const { stdout } = await runCli(
      "save", "cli-tagged", "tagged-val",
      "--tags", "alpha,beta,gamma"
    );
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("beta");
  });

  test("recall retrieves saved memory", async () => {
    const { stdout } = await runCli("recall", "cli-test-key");
    expect(stdout).toContain("cli-test-key");
    expect(stdout).toContain("cli-test-value");
  });

  test("recall shows not found", async () => {
    const { stdout, stderr } = await runCli("recall", "nonexistent-key-xyz");
    const output = (stdout + stderr).toLowerCase();
    expect(output).toContain("no memory found");
  });

  test("list shows memories", async () => {
    const { stdout } = await runCli("list");
    expect(stdout).toContain("cli-test-key");
  });

  test("list --json outputs parseable JSON", async () => {
    const { stdout } = await runCli("list", "--json");
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("search finds matching memories", async () => {
    const { stdout } = await runCli("search", "global-val");
    expect(stdout).toContain("cli-global");
  });

  test("stats shows counts", async () => {
    const { stdout, exitCode } = await runCli("stats");
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("total");
  });

  test("init registers agent", async () => {
    const { stdout, exitCode } = await runCli("init", "cli-agent");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cli-agent");
  });

  test("agents lists registered agents", async () => {
    const { stdout } = await runCli("agents");
    expect(stdout).toContain("cli-agent");
  });

  test("export outputs JSON", async () => {
    const { stdout } = await runCli("export");
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("clean runs without error", async () => {
    const { exitCode } = await runCli("clean");
    expect(exitCode).toBe(0);
  });

  test("inject outputs context", async () => {
    const { stdout } = await runCli("inject");
    // Should have some content since we have global/high-importance memories
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("forget deletes a memory", async () => {
    // Save one to delete
    await runCli("save", "to-delete", "delete-me");
    const { stdout, exitCode } = await runCli("forget", "to-delete");
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toMatch(/delet|forgot|removed/);
  });

  test("projects shows empty or list", async () => {
    const { exitCode } = await runCli("projects");
    expect(exitCode).toBe(0);
  });

  test("save --json returns parseable JSON", async () => {
    const { stdout, exitCode } = await runCli("--json", "save", "json-save-key", "json-save-val");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.key).toBe("json-save-key");
    expect(parsed.value).toBe("json-save-val");
  });

  test("recall --json returns parseable JSON", async () => {
    const { stdout, exitCode } = await runCli("--json", "recall", "json-save-key");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.key).toBe("json-save-key");
  });

  test("stats --json returns parseable JSON", async () => {
    const { stdout, exitCode } = await runCli("--json", "stats");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed.total).toBe("number");
    expect(parsed.by_scope).toBeDefined();
    expect(parsed.by_category).toBeDefined();
  });

  test("search --json returns parseable JSON", async () => {
    const { stdout, exitCode } = await runCli("--json", "search", "cli-test");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("init --json returns agent JSON", async () => {
    const { stdout, exitCode } = await runCli("--json", "init", "json-agent");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe("json-agent");
    expect(parsed.id).toBeDefined();
  });

  test("agents --json returns array", async () => {
    const { stdout, exitCode } = await runCli("--json", "agents");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("forget --json returns deleted id", async () => {
    await runCli("save", "forget-json-key", "forget-json-val");
    const { stdout, exitCode } = await runCli("--json", "forget", "forget-json-key");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.deleted).toBeDefined();
  });

  test("save with summary", async () => {
    const { stdout, exitCode } = await runCli(
      "save", "summary-key", "summary-value",
      "--summary", "A brief summary"
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("A brief summary");
  });
});
