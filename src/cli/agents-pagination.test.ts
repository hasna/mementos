import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database.js";
import { registerAgent } from "../db/agents.js";
import {
  assertLocalStoreBackend,
  isolatedStoreEnv,
} from "../test-support/store-isolation.js";

const DB_PATH = join(tmpdir(), `mementos-agents-pagination-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;
const CLI_ENV = isolatedStoreEnv(DB_PATH);

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
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode: await proc.exited,
  };
}

beforeAll(async () => {
  await assertLocalStoreBackend(CLI_PATH, CLI_ENV, DB_PATH);
  const db = getDatabase(DB_PATH);
  for (let i = 0; i < 501; i++) {
    registerAgent(`pagination-agent-${String(i).padStart(3, "0")}`, undefined, undefined, undefined, undefined, db);
  }
});

afterAll(() => {
  resetDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
});

describe("agents pagination", () => {
  test("JSON output honors limit, cursor, offset, and an empty terminal page", async () => {
    const first = await runCli("--json", "agents", "--limit", "500", "--cursor", "0");
    const second = await runCli("--json", "agents", "--limit", "500", "--cursor", "500");
    const offset = await runCli("--json", "agents", "--limit", "500", "--offset", "500");
    const terminal = await runCli("--json", "agents", "--limit", "500", "--cursor", "501");

    for (const result of [first, second, offset, terminal]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("error:");
    }

    const firstPage = JSON.parse(first.stdout) as Array<{ id: string }>;
    const secondPage = JSON.parse(second.stdout) as Array<{ id: string }>;
    const offsetPage = JSON.parse(offset.stdout) as Array<{ id: string }>;
    const terminalPage = JSON.parse(terminal.stdout) as Array<{ id: string }>;

    expect(firstPage).toHaveLength(500);
    expect(secondPage).toHaveLength(1);
    expect(offsetPage.map((agent) => agent.id)).toEqual(secondPage.map((agent) => agent.id));
    expect(firstPage.some((agent) => agent.id === secondPage[0]!.id)).toBe(false);
    expect(terminalPage).toEqual([]);
  });
});
