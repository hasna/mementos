import { describe, test, expect } from "bun:test";

describe("mementos-mcp entrypoint", () => {
  test("prints help and exits without starting server", async () => {
    const proc = Bun.spawn(["bun", "run", "src/mcp/index.ts", "--help"], {
      cwd: new URL("../../", import.meta.url).pathname.replace(/\/$/, ""),
      env: { ...process.env, MEMENTOS_DB_PATH: ":memory:" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: mementos-mcp [options]");
    expect(stdout).toContain("Mementos MCP server");
    expect(stderr).toBe("");
  });

  test("prints version and exits", async () => {
    const proc = Bun.spawn(["bun", "run", "src/mcp/index.ts", "--version"], {
      cwd: new URL("../../", import.meta.url).pathname.replace(/\/$/, ""),
      env: { ...process.env, MEMENTOS_DB_PATH: ":memory:" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = (await new Response(proc.stdout).text()).trim();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/);
    expect(stderr).toBe("");
  });
});
