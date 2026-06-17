import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  test("registers storage tools only", () => {
    const source = readFileSync(join(import.meta.dir, "tools", "storage-tools.ts"), "utf8");
    const entrypoint = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

    expect(source).toContain('"mementos_storage_status"');
    expect(source).toContain('"mementos_storage_push"');
    expect(source).toContain('"mementos_storage_pull"');
    expect(source).toContain('"mementos_storage_sync"');
    expect(entrypoint).toContain("registerMementosStorageTools");

    const oldPrefix = ["mementos", "cloud"].join("_");
    expect(source).not.toContain(`"${oldPrefix}_status"`);
    expect(source).not.toContain(`"${oldPrefix}_push"`);
    expect(source).not.toContain(`"${oldPrefix}_pull"`);
    expect(source).not.toContain(`"${oldPrefix}_sync"`);
  });

  test("registers consolidation and reflection MCP tools", () => {
    const tools = readFileSync(join(import.meta.dir, "tools", "consolidation-tools.ts"), "utf8");
    const entrypoint = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

    expect(tools).toContain('"memory_consolidate"');
    expect(tools).toContain('"memory_reflect"');
    expect(entrypoint).toContain("registerConsolidationTools");
  });
});
