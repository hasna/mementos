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
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("--help shows all key commands", async () => {
    const { stdout } = await runCli("--help");
    // Core memory commands
    expect(stdout).toContain("save");
    expect(stdout).toContain("recall");
    expect(stdout).toContain("list");
    expect(stdout).toContain("search");
    expect(stdout).toContain("forget");
    expect(stdout).toContain("update");
    expect(stdout).toContain("pin");
    expect(stdout).toContain("archive");
    expect(stdout).toContain("versions");
    expect(stdout).toContain("stale");
    // Agent/project commands
    expect(stdout).toContain("agents");
    expect(stdout).toContain("projects");
    // Utility commands
    expect(stdout).toContain("report");
    expect(stdout).toContain("stats");
    expect(stdout).toContain("profile");
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("inject");
    expect(stdout).toContain("mcp");
  });

  test("save creates a memory", async () => {
    const { stdout, exitCode } = await runCli("save", "cli-test-key", "cli-test-value");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Saved:");
    expect(stdout).toContain("cli-test-key");
  });

  test("save with scope and importance", async () => {
    const { stdout } = await runCli(
      "save", "cli-global", "global-val",
      "--scope", "global",
      "--importance", "9",
      "--category", "fact"
    );
    expect(stdout).toContain("Saved:");
    expect(stdout).toContain("cli-global");
  });

  test("save with tags", async () => {
    const { stdout, exitCode } = await runCli(
      "save", "cli-tagged", "tagged-val",
      "--tags", "alpha,beta,gamma"
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Saved:");
    expect(stdout).toContain("cli-tagged");
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

  test("register-agent registers agent", async () => {
    const { stdout, exitCode } = await runCli("register-agent", "cli-agent");
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

  test("register-agent --json returns agent JSON", async () => {
    const { stdout, exitCode } = await runCli("--json", "register-agent", "json-agent");
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
    expect(stdout).toContain("Saved:");
  });

  test("pin by key", async () => {
    await runCli("save", "pin-test-key", "pin-test-value");
    const { stdout, exitCode } = await runCli("pin", "pin-test-key");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pinned:");
    expect(stdout).toContain("pin-test-key");
  });

  test("unpin by key", async () => {
    await runCli("save", "unpin-test-key", "unpin-test-value");
    // Pin first, then unpin
    await runCli("pin", "unpin-test-key");
    const { stdout, exitCode } = await runCli("unpin", "unpin-test-key");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unpinned:");
    expect(stdout).toContain("unpin-test-key");
  });

  test("pin --json returns full memory object", async () => {
    await runCli("save", "pin-json-key", "pin-json-value");
    const { stdout, exitCode } = await runCli("--json", "pin", "pin-json-key");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.key).toBe("pin-json-key");
    expect(parsed.pinned).toBe(true);
  });

  test("unpin --json returns full memory object", async () => {
    await runCli("save", "unpin-json-key", "unpin-json-value");
    await runCli("pin", "unpin-json-key");
    const { stdout, exitCode } = await runCli("--json", "unpin", "unpin-json-key");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.key).toBe("unpin-json-key");
    expect(parsed.pinned).toBe(false);
  });

  test("pin nonexistent key fails", async () => {
    const { stderr, exitCode } = await runCli("pin", "nonexistent-pin-key-xyz");
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("no memory found");
  });

  test("unpin nonexistent key fails", async () => {
    const { stderr, exitCode } = await runCli("unpin", "nonexistent-unpin-key-xyz");
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("no memory found");
  });

  test("report shows memory summary", async () => {
    await runCli("save", "report-test-key", "report-test-value", "--scope", "global", "--importance", "8");
    const { stdout, exitCode } = await runCli("report", "--days", "7");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Total:");
    expect(stdout).toContain("Recent:");
  });

  test("report --json outputs parseable JSON", async () => {
    // Global --json must come before subcommand in Commander.js
    const { stdout, exitCode } = await runCli("--json", "report");
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(typeof data.total).toBe("number");
    expect(typeof data.pinned).toBe("number");
    expect(typeof data.recent.total).toBe("number");
  });

  test("report --markdown outputs markdown", async () => {
    const { stdout, exitCode } = await runCli("report", "--markdown");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("## Mementos Report");
  });

  test("profile list shows profiles", async () => {
    const { exitCode } = await runCli("profile", "list");
    expect(exitCode).toBe(0);
  });

  test("pin by partial ID", async () => {
    // Save and get the ID from JSON output
    const { stdout: saveOut } = await runCli("--json", "save", "pin-id-key", "pin-id-value");
    const saved = JSON.parse(saveOut);
    const partialId = saved.id.slice(0, 8);
    const { stdout, exitCode } = await runCli("pin", partialId);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pinned:");
  });
});
