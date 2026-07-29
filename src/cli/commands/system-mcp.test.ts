import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = new URL("../index.tsx", import.meta.url).pathname;
const tempHomes: string[] = [];

async function runMcp(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, "mcp", ...args], {
    env: {
      ...process.env,
      HOME: home,
      MEMENTOS_DB_PATH: join(home, "mementos.db"),
      HASNA_MEMENTOS_API_URL: "",
      HASNA_MEMENTOS_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("mcp Cursor configuration", () => {
  test("installs and uninstalls without removing existing servers", async () => {
    const home = mkdtempSync(join(tmpdir(), "mementos-mcp-cursor-"));
    tempHomes.push(home);
    const configDir = join(home, ".cursor");
    const configPath = join(configDir, "mcp.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        "plugin-telegram-telegram": { command: "telegram-mcp", args: [] },
      },
    }));

    const install = await runMcp(home, "--cursor");
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain("Installed into Cursor");

    const installed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(installed.mcpServers["plugin-telegram-telegram"]).toEqual({
      command: "telegram-mcp",
      args: [],
    });
    expect(installed.mcpServers.mementos.command).toEndWith("mementos-mcp");
    expect(installed.mcpServers.mementos.args).toEqual([]);

    const uninstall = await runMcp(home, "--cursor", "--uninstall");
    expect(uninstall.exitCode).toBe(0);
    expect(uninstall.stdout).toContain("Removed from Cursor");

    const removed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(removed.mcpServers.mementos).toBeUndefined();
    expect(removed.mcpServers["plugin-telegram-telegram"]).toBeDefined();
    expect(existsSync(configPath)).toBe(true);
  });

  test("creates the global Cursor config when it does not exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "mementos-mcp-cursor-"));
    tempHomes.push(home);

    const install = await runMcp(home, "--cursor");
    expect(install.exitCode).toBe(0);

    const configPath = join(home, ".cursor", "mcp.json");
    const installed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(installed.mcpServers.mementos).toBeDefined();
  });
});
