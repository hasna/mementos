import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedStoreEnv } from "../../test-support/store-isolation.js";

const CLI_PATH = new URL("../index.tsx", import.meta.url).pathname;
let testHome = "";

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "mementos-cursor-mcp-test-"));
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
});

async function runMcpCommand(...args: string[]): Promise<void> {
  const env = isolatedStoreEnv(join(testHome, "mementos.db"), {
    extra: { HOME: testHome },
  });
  const proc = Bun.spawn([process.execPath, "run", CLI_PATH, "mcp", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}

function readCursorConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(testHome, ".cursor", "mcp.json"), "utf-8")) as Record<string, unknown>;
}

describe("mcp --cursor", () => {
  test("installs mementos without replacing existing Cursor MCP settings", async () => {
    const configPath = join(testHome, ".cursor", "mcp.json");
    mkdirSync(join(testHome, ".cursor"));
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { existing: { command: "existing-mcp" } },
      unrelatedSetting: true,
    }));

    await runMcpCommand("--cursor");

    const config = readCursorConfig() as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
      unrelatedSetting: boolean;
    };
    const expectedCommand = process.argv[0]?.includes("bun")
      ? join(testHome, ".bun", "bin", "mementos-mcp")
      : "mementos-mcp";
    expect(config.mcpServers.existing).toEqual({ command: "existing-mcp" });
    expect(config.mcpServers.mementos).toEqual({ command: expectedCommand, args: [] });
    expect(config.unrelatedSetting).toBe(true);
  });

  test("uninstalls only mementos from the Cursor MCP catalog", async () => {
    await runMcpCommand("--cursor");
    const installed = readCursorConfig() as { mcpServers: Record<string, unknown> };
    installed.mcpServers.existing = { command: "existing-mcp" };
    writeFileSync(join(testHome, ".cursor", "mcp.json"), JSON.stringify(installed));

    await runMcpCommand("--cursor", "--uninstall");

    const config = readCursorConfig() as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers.mementos).toBeUndefined();
    expect(config.mcpServers.existing).toEqual({ command: "existing-mcp" });
  });
});
