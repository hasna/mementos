import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import {
  assertLocalStoreBackend,
  blankLlmProviderEnv,
  isolatedStoreEnv,
} from "../test-support/store-isolation.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Regression cover: `save` silently retargeted the write when a scoping flag
// did not resolve.
//
// `--agent` and `--project` were both resolved with a "look it up, keep it only
// if found" shape:
//
//     const ag = getAgent(globalOpts.agent);
//     resolvedAgentId = ag?.id;              // undefined when unresolvable
//
// The upsert bucket is (key, scope, agent_id, project_id, session_id) collapsed
// through `?? ""` in the CLI fork guard and `COALESCE(agent_id,'')` in
// createMemory. So an UNRESOLVABLE agent produced exactly the bucket that NO
// `--agent` at all produces — the unowned row — and the save landed there as a
// silent upsert, reporting rc=0 "Updated".
//
// Two consequences, and the second is the one an exit code hides:
//   1. an existing unowned row under that key is overwritten;
//   2. the write is misattributed — the caller named an owner, the row got none,
//      and `agent_id`/`created_by_agent` are both NULL either way, so the
//      overwrite is indistinguishable after the fact.
//
// A row owned by a REAL other agent was never at risk: the bucket differs, so
// the fork guard already refused. That refusal is the near-miss negative control
// below — it must keep returning 1, or a "fix" that simply disables the guard
// would pass these tests.
//
// Every assertion reads back through a DIFFERENT verb than the one that wrote.
const DB_PATH = join(tmpdir(), `mementos-unresolvable-flags-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

function testEnv(): Record<string, string> {
  return isolatedStoreEnv(DB_PATH, { extra: blankLlmProviderEnv() });
}

beforeAll(async () => {
  await assertLocalStoreBackend(CLI_PATH, testEnv(), DB_PATH);
});

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

/** Read a memory back through `show` — a different verb than the writer. */
async function show(id: string): Promise<Record<string, unknown>> {
  const r = await runCli("--json", "show", id);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

const BOGUS_AGENT = "zzq-no-such-agent-9f3";

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
});

describe("save refuses an unresolvable scoping flag instead of retargeting the write", () => {
  test("POSITIVE CONTROL: a REAL agent resolves and is stored", async () => {
    // Without this, every assertion below could pass on a build where agent
    // resolution is broken outright — the tests would be measuring nothing.
    const reg = await runCli("register-agent", "alpha");
    expect(reg.exitCode).toBe(0);

    const saved = await runCli("--json", "--agent", "alpha", "save", "ctrlKey", "alpha-row");
    expect(saved.exitCode).toBe(0);
    const id = JSON.parse(saved.stdout).id as string;

    const row = await show(id);
    // The control fires only if a resolved agent is actually persisted.
    expect(row["agent_id"]).toBeTruthy();
  });

  test("an unresolvable --agent is REFUSED, not collapsed into the unowned row", async () => {
    const first = await runCli("--json", "save", "agentKey", "owned-by-nobody");
    expect(first.exitCode).toBe(0);
    const id = JSON.parse(first.stdout).id as string;

    // Pre-fix: rc=0, "Updated", value replaced. Post-fix: rc=1, row untouched.
    const bogus = await runCli("--agent", BOGUS_AGENT, "save", "agentKey", "BOGUS-WROTE-HERE");
    expect(bogus.exitCode).toBe(1);
    expect(bogus.stderr).toContain(BOGUS_AGENT);

    // The exit code alone would not prove the row survived. Read it back.
    const row = await show(id);
    expect(row["value"]).toBe("owned-by-nobody");
  });

  test("the refusal names the remedy, so the failure is self-healing", async () => {
    const r = await runCli("--agent", BOGUS_AGENT, "save", "remedyKey", "v");
    expect(r.exitCode).toBe(1);
    // An agent registered in conversations/todos but not in mementos is a real
    // and common caller here; the message must tell it exactly what to run.
    expect(r.stderr).toContain("register-agent");
  });

  test("NEGATIVE CONTROL (near-miss): a REAL other agent is still refused by the fork guard", async () => {
    // This is the discriminating case. It shares the failure mode — a refused
    // save — but for a DIFFERENT reason. A fix that loosened the fork guard
    // rather than rejecting the unresolvable name would flip this to 0.
    const reg = await runCli("register-agent", "beta");
    expect(reg.exitCode).toBe(0);

    const first = await runCli("--json", "--agent", "alpha", "save", "ownedKey", "alpha-row");
    expect(first.exitCode).toBe(0);
    const id = JSON.parse(first.stdout).id as string;

    const other = await runCli("--agent", "beta", "save", "ownedKey", "beta-tries");
    expect(other.exitCode).toBe(1);
    expect(other.stderr).toContain("Refusing to fork");

    const row = await show(id);
    expect(row["value"]).toBe("alpha-row");
  });

  test("an unresolvable --project is REFUSED (same defect, same function)", async () => {
    const first = await runCli("--json", "save", "projectKey", "no-project");
    expect(first.exitCode).toBe(0);
    const id = JSON.parse(first.stdout).id as string;

    const bogus = await runCli(
      "--project", "/nonexistent/path/zzq-9f3",
      "save", "projectKey", "BOGUS-PROJECT-WROTE-HERE",
    );
    expect(bogus.exitCode).toBe(1);

    const row = await show(id);
    expect(row["value"]).toBe("no-project");
  });

  test("a save with NO scoping flags is unaffected", async () => {
    // The fix must not make the unowned bucket unreachable — writing there
    // deliberately, by passing no flag, stays legal.
    const first = await runCli("--json", "save", "plainKey", "v1");
    expect(first.exitCode).toBe(0);

    const second = await runCli("--json", "save", "plainKey", "v2");
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).outcome).toBe("updated");
  });
});
