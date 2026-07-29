import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER_PATH = new URL("../__fixtures__/system-mcp-runner.ts", import.meta.url).pathname;

let testHome: string;

function runMcpCommand(...args: string[]): void {
  const result = Bun.spawnSync([process.execPath, "run", RUNNER_PATH, "mcp", ...args], {
    env: { ...process.env, HOME: testHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "mementos-cursor-mcp-"));
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe("mcp --cursor", () => {
  test("creates Cursor's global MCP catalog with mementos", () => {
    runMcpCommand("--cursor");

    const configPath = join(testHome, ".cursor", "mcp.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(config.mcpServers.mementos).toEqual({
      command: join(testHome, ".bun", "bin", "mementos-mcp"),
      args: [],
    });
  });

  test("preserves other Cursor servers when uninstalling mementos", () => {
    const configDir = join(testHome, ".cursor");
    const configPath = join(configDir, "mcp.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        mementos: { command: "mementos-mcp", args: [] },
        telegram: { command: "telegram-mcp", args: ["--stdio"] },
      },
    }), "utf-8");

    runMcpCommand("--cursor", "--uninstall");

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.mementos).toBeUndefined();
    expect(config.mcpServers.telegram).toEqual({
      command: "telegram-mcp",
      args: ["--stdio"],
    });
  });
});
