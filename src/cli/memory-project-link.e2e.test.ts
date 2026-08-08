import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLocalStoreBackend,
  blankLlmProviderEnv,
  isolatedStoreEnv,
} from "../test-support/store-isolation.js";

const DB_PATH = join(tmpdir(), `mementos-project-link-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 60_000;

function testEnv(): Record<string, string> {
  return isolatedStoreEnv(DB_PATH, { extra: blankLlmProviderEnv() });
}

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    env: testEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: await proc.exited };
}

let project: Record<string, any>;
let memory: Record<string, any>;

function expectStableMemory(
  actual: Record<string, any>,
  expected: Record<string, any>,
): void {
  expect(actual).toMatchObject({
    id: expected.id,
    key: expected.key,
    value: expected.value,
    category: expected.category,
    scope: expected.scope,
    importance: expected.importance,
    tags: expected.tags,
    metadata: expected.metadata,
    project_id: expected.project_id,
    version: expected.version,
    updated_at: expected.updated_at,
  });
}

beforeAll(async () => {
  await assertLocalStoreBackend(CLI_PATH, testEnv(), DB_PATH);
  const projectResult = await runCli(
    "--json",
    "projects",
    "--add",
    "--name",
    "Dubai CLI",
    "--path",
    "/projects/cli-dubai",
  );
  expect(projectResult.exitCode).toBe(0);
  project = JSON.parse(projectResult.stdout) as Record<string, unknown>;

  const memoryResult = await runCli("--json", "save", "cli-link-memory", "stable evidence");
  expect(memoryResult.exitCode).toBe(0);
  memory = JSON.parse(memoryResult.stdout) as Record<string, unknown>;
}, TEST_TIMEOUT_MS);

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = DB_PATH + suffix;
    if (existsSync(file)) try { unlinkSync(file); } catch {}
  }
});

describe("link-project CLI guarded existing-memory linkage", () => {
  test("dry-run, apply, replay, lookup, and rollback preserve the exact stable memory", async () => {
    const common = [
      "link-project",
      String(memory.id),
      "--project-id",
      String(project.id),
      "--expected-memory-version",
      String(memory.version),
      "--expected-memory-revision",
      String(memory.updated_at),
      "--expected-project-revision",
      String(project.updated_at),
      "--idempotency-key",
      "cli-memory-project-link-request-0001",
      "--operation-id",
      "cli-memory-project-link-operation-v1",
    ];

    const preview = await runCli("--json", ...common, "--dry-run");
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      dry_run: true,
      applied: false,
      receipt: null,
      memory: { id: memory.id, project_id: project.id },
    });
    const afterPreview = await runCli("--json", "show", String(memory.id));
    expectStableMemory(JSON.parse(afterPreview.stdout), memory);

    const accepted = await runCli("--json", ...common);
    expect(accepted.exitCode).toBe(0);
    const acceptedBody = JSON.parse(accepted.stdout) as Record<string, any>;
    expect(acceptedBody).toMatchObject({
      applied: true,
      memory: {
        id: memory.id,
        key: memory.key,
        value: memory.value,
        project_id: project.id,
        version: memory.version,
      },
      receipt: { direction: "forward", target_memory_id: memory.id },
    });
    expect(JSON.parse((await runCli("--json", ...common)).stdout)).toEqual(acceptedBody);

    const lookup = await runCli(
      "--json",
      "link-project",
      String(memory.id),
      "--lookup-receipt",
      String(acceptedBody.receipt.receipt_id),
    );
    expect(lookup.exitCode).toBe(0);
    expect(JSON.parse(lookup.stdout)).toEqual(acceptedBody.receipt);

    const rollback = await runCli(
      "--json",
      "link-project",
      String(memory.id),
      "--rollback-receipt",
      String(acceptedBody.receipt.receipt_id),
      "--expected-memory-version",
      String(acceptedBody.memory.version),
      "--expected-memory-revision",
      String(acceptedBody.memory.updated_at),
      "--idempotency-key",
      "cli-memory-project-link-rollback-0001",
      "--operation-id",
      "cli-memory-project-link-operation-v1",
    );
    expect(rollback.exitCode).toBe(0);
    const rollbackBody = JSON.parse(rollback.stdout) as Record<string, any>;
    expect(rollbackBody).toMatchObject({
      applied: true,
      receipt: {
        direction: "rollback",
        accepted_receipt_id: acceptedBody.receipt.receipt_id,
      },
    });
    expectStableMemory(rollbackBody.memory, memory);
    expectStableMemory(
      JSON.parse((await runCli("--json", "show", String(memory.id))).stdout),
      memory,
    );
  }, TEST_TIMEOUT_MS);

  test("stale project revision fails closed without changing the memory", async () => {
    const before = JSON.parse((await runCli("--json", "show", String(memory.id))).stdout);
    const denied = await runCli(
      "--json",
      "link-project",
      String(memory.id),
      "--project-id",
      String(project.id),
      "--expected-memory-version",
      String(before.version),
      "--expected-memory-revision",
      String(before.updated_at),
      "--expected-project-revision",
      "2026-01-01T00:00:00.000Z",
      "--idempotency-key",
      "cli-memory-project-link-stale-0001",
    );
    expect(denied.exitCode).toBe(1);
    expect(`${denied.stdout}${denied.stderr}`).toContain("Project changed");
    expectStableMemory(
      JSON.parse((await runCli("--json", "show", String(memory.id))).stdout),
      before,
    );
  }, TEST_TIMEOUT_MS);
});
