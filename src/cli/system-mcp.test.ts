import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedStoreEnv } from "../test-support/store-isolation.js";

const TEMP_ROOT = mkdtempSync(join(tmpdir(), "mementos-cursor-mcp-"));
const HOME_PATH = join(TEMP_ROOT, "home");
const DB_PATH = join(TEMP_ROOT, "mementos.db");
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;
const CLI_ENV = isolatedStoreEnv(DB_PATH, { extra: { HOME: HOME_PATH } });

mkdirSync(HOME_PATH, { recursive: true });

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
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

describe("mementos mcp --cursor", () => {
  test("advertises Cursor as a supported MCP target", async () => {
    const { stdout, exitCode } = await runCli("mcp", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--cursor");
    expect(stdout).toContain("~/.cursor/mcp.json");
  });

  test("installs and uninstalls mementos without replacing other Cursor servers", async () => {
    const cursorDir = join(HOME_PATH, ".cursor");
    const configPath = join(cursorDir, "mcp.json");
    const existingServer = { command: "existing-mcp", args: ["--stdio"] };
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { existing: existingServer } }), "utf-8");

    const installed = await runCli("mcp", "--cursor");
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("Installed into Cursor");
    expect(existsSync(configPath)).toBe(true);

    const installedConfig = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(installedConfig.mcpServers.existing).toEqual(existingServer);
    expect(installedConfig.mcpServers.mementos.command).toBe(join(HOME_PATH, ".bun", "bin", "mementos-mcp"));
    expect(installedConfig.mcpServers.mementos.args).toEqual([]);

    const uninstalled = await runCli("mcp", "--cursor", "--uninstall");
    expect(uninstalled.exitCode).toBe(0);
    expect(uninstalled.stdout).toContain("Removed from Cursor");

    const uninstalledConfig = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(uninstalledConfig.mcpServers.existing).toEqual(existingServer);
    expect(uninstalledConfig.mcpServers.mementos).toBeUndefined();
  });
});
