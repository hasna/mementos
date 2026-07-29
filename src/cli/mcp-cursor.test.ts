import { describe, test, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolatedStoreEnv } from "../test-support/store-isolation.js";

const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

async function runMcp(home: string, ...args: string[]) {
  const env = isolatedStoreEnv(join(home, "mementos-test.db"), {
    extra: {
      HOME: home,
      // Keep --all from finding a real Claude CLI on the test host.
      PATH: dirname(process.execPath),
    },
  });
  const proc = Bun.spawn([process.execPath, "run", CLI_PATH, "mcp", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

function readCursorConfig(home: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8"));
}

describe("mcp Cursor setup", () => {
  test("--cursor creates the global config and registers mementos", async () => {
    const home = mkdtempSync(join(tmpdir(), "mementos-cursor-test-"));
    try {
      const result = await runMcp(home, "--cursor");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Installed into Cursor");
      expect(readCursorConfig(home).mcpServers.mementos).toEqual({
        command: join(home, ".bun", "bin", "mementos-mcp"),
        args: [],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--cursor preserves other servers and supports uninstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "mementos-cursor-test-"));
    try {
      const configDir = join(home, ".cursor");
      mkdirSync(configDir);
      writeFileSync(join(configDir, "mcp.json"), JSON.stringify({
        mcpServers: {
          existing: { command: "existing-mcp", args: ["--safe"] },
        },
        setting: true,
      }));

      expect((await runMcp(home, "--cursor")).exitCode).toBe(0);
      let config = readCursorConfig(home);
      expect(config.mcpServers.existing).toEqual({ command: "existing-mcp", args: ["--safe"] });
      expect(config.setting).toBe(true);
      expect(config.mcpServers.mementos).toBeDefined();

      const result = await runMcp(home, "--cursor", "--uninstall");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Removed from Cursor");
      config = readCursorConfig(home);
      expect(config.mcpServers.existing).toEqual({ command: "existing-mcp", args: ["--safe"] });
      expect(config.setting).toBe(true);
      expect(config.mcpServers.mementos).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--all includes Cursor", async () => {
    const home = mkdtempSync(join(tmpdir(), "mementos-cursor-test-"));
    try {
      const result = await runMcp(home, "--all");

      expect(result.exitCode).toBe(0);
      expect(readCursorConfig(home).mcpServers.mementos).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
