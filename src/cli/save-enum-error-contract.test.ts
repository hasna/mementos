import { describe, test, expect, afterAll } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MEMORY_CATEGORIES, MEMORY_SCOPES, MEMORY_SOURCES } from "../types/index.js";

// ============================================================================
// Regression: the client-side enum rejection on `save` must use the SAME error
// channel as every other failure in the command.
//
// `save` rejects an out-of-enum --category/--scope/--source before spending a
// round trip. Written as `console.error(chalk.red(msg)); process.exit(1)` that
// short-circuit bypassed makeHandleError, which is the only thing that honours
// `--json` / `--format json`: stdout came back EMPTY and the message went to
// stderr with ANSI colour. Every other error in the same command (e.g. a bad
// --ttl) still emitted `{"error": …}` on stdout, so `mementos --json save … |
// jq -r .error` silently returned nothing for exactly the input the validation
// was added to catch.
//
// The failing inputs are driven end-to-end through the real CLI process.
// ============================================================================

const DB_PATH = join(tmpdir(), `mementos-save-enum-contract-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch { /* already gone */ }
  }
});

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Strip cloud credentials from the child: if the developer's shell exports
  // them, api mode engages and the command fails on the transport instead of
  // on the validation under test.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of [
    "HASNA_MEMENTOS_API_URL",
    "HASNA_MEMENTOS_API_KEY",
    "MEMENTOS_API_URL",
    "MEMENTOS_API_KEY",
    "HASNA_MEMENTOS_DATABASE_URL",
    "MEMENTOS_DATABASE_URL",
    "HASNA_MEMENTOS_STORAGE_MODE",
    "MEMENTOS_STORAGE_MODE",
  ]) {
    delete env[k];
  }
  env["MEMENTOS_DB_PATH"] = DB_PATH;
  env["HASNA_MEMENTOS_DB_PATH"] = DB_PATH;

  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    env,
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

describe("save: enum rejection honours the machine-readable error contract", () => {
  test("FAILING INPUT: --json save --category decision writes {error} to STDOUT", async () => {
    const { stdout, exitCode } = await runCli(
      "--json", "save", "enum-contract-1", "v1", "--category", "decision"
    );
    expect(exitCode).toBe(1);
    // The whole point: stdout is parseable, not empty.
    expect(stdout).not.toBe("");
    const parsed = JSON.parse(stdout) as { error?: string };
    expect(typeof parsed.error).toBe("string");
    const msg = String(parsed.error);
    expect(msg).toContain("category");
    expect(msg).toContain("decision");
    for (const c of MEMORY_CATEGORIES) expect(msg).toContain(c);
    // The template hint must survive the move onto the error channel.
    expect(msg).toContain("--template decision");
    // No ANSI escapes may leak into a JSON payload.
    expect(msg).not.toContain("[");
  });

  test("--format json gets the same contract as --json", async () => {
    const { stdout, exitCode } = await runCli(
      "--format", "json", "save", "enum-contract-2", "v2", "--scope", "public"
    );
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as { error?: string };
    expect(String(parsed.error)).toContain("scope");
    for (const s of MEMORY_SCOPES) expect(String(parsed.error)).toContain(s);
  });

  test("a bad --source is on the same channel", async () => {
    const { stdout, exitCode } = await runCli(
      "--json", "save", "enum-contract-3", "v3", "--source", "robot"
    );
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as { error?: string };
    expect(String(parsed.error)).toContain("source");
    for (const s of MEMORY_SOURCES) expect(String(parsed.error)).toContain(s);
  });

  test("the enum rejection matches the pre-existing --ttl rejection", async () => {
    // Control: an error that always went through handleError. Both must land on
    // stdout as JSON — that equivalence is the contract being defended.
    const bad = await runCli("--json", "save", "enum-contract-4", "v4", "--ttl", "notaduration");
    expect(bad.exitCode).toBe(1);
    expect(typeof (JSON.parse(bad.stdout) as { error?: string }).error).toBe("string");
  });

  test("without --json the human path is unchanged: message on stderr, empty stdout", async () => {
    const { stdout, stderr, exitCode } = await runCli(
      "save", "enum-contract-5", "v5", "--category", "decision"
    );
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Invalid category");
    expect(stderr).toContain("decision");
  });

  test("a valid --category still saves and emits the memory as JSON", async () => {
    const { stdout, exitCode } = await runCli(
      "--json", "save", "enum-contract-ok", "v", "--category", "fact"
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { key?: string; category?: string };
    expect(parsed.key).toBe("enum-contract-ok");
    expect(parsed.category).toBe("fact");
  });
});
