import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedStoreEnv } from "../test-support/store-isolation.js";

const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;
const TEST_HOME = mkdtempSync(join(tmpdir(), "mementos-mcp-cursor-"));
const DB_PATH = join(TEST_HOME, "mementos-test.db");
const CURSOR_DIR = join(TEST_HOME, ".cursor");
const CURSOR_CONFIG = join(CURSOR_DIR, "mcp.json");
const CLI_ENV = isolatedStoreEnv(DB_PATH, {
  extra: {
    HOME: TEST_HOME,
    // `--all` probes the Claude CLI. Keep the child from finding a real one in
    // the operator's PATH; the test invokes Bun by absolute path below.
    PATH: "",
  },
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(CURSOR_DIR, { recursive: true, force: true });
});

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "run", CLI_PATH, ...args], {
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

function readCursorConfig(): {
  mcpServers: Record<string, { command: string; args: string[] }>;
  marker?: string;
} {
  return JSON.parse(readFileSync(CURSOR_CONFIG, "utf-8"));
}

describe("mcp Cursor registration", () => {
  test("--cursor installs mementos without replacing existing servers", async () => {
    mkdirSync(CURSOR_DIR, { recursive: true });
    writeFileSync(CURSOR_CONFIG, JSON.stringify({
      marker: "keep-me",
      mcpServers: {
        telegram: { command: "plugin-telegram", args: ["serve"] },
      },
    }));

    const { stdout, exitCode } = await runCli("mcp", "--cursor");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installed into Cursor");
    const config = readCursorConfig();
    expect(config.marker).toBe("keep-me");
    expect(config.mcpServers.telegram).toEqual({ command: "plugin-telegram", args: ["serve"] });
    expect(config.mcpServers.mementos).toEqual({
      command: join(TEST_HOME, ".bun", "bin", "mementos-mcp"),
      args: [],
    });
  });

  test("--all includes Cursor and creates its global config", async () => {
    const { stdout, exitCode } = await runCli("mcp", "--all");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installed into Cursor");
    expect(existsSync(CURSOR_CONFIG)).toBe(true);
    expect(readCursorConfig().mcpServers.mementos).toBeDefined();
  });

  test("--cursor --uninstall removes only mementos", async () => {
    mkdirSync(CURSOR_DIR, { recursive: true });
    writeFileSync(CURSOR_CONFIG, JSON.stringify({
      mcpServers: {
        mementos: { command: "mementos-mcp", args: [] },
        telegram: { command: "plugin-telegram", args: [] },
      },
    }));

    const { stdout, exitCode } = await runCli("mcp", "--cursor", "--uninstall");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed from Cursor");
    const config = readCursorConfig();
    expect(config.mcpServers.mementos).toBeUndefined();
    expect(config.mcpServers.telegram).toBeDefined();
  });
});
