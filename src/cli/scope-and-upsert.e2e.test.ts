import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import {
  assertLocalStoreBackend,
  blankLlmProviderEnv,
  isolatedStoreEnv,
} from "../test-support/store-isolation.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Regression cover for HC-00149, both halves:
//   1. `update --scope` reported success while changing nothing, and `save -s`
//      silently misrouted the scope value into session_id. Root cause: the
//      subcommand short flag `-s, --scope` is shadowed by the program-level
//      `-s, --session`, so `-s` never reaches scope (commander resolves a
//      post-subcommand `-s` to the parent option).
//   2. `save` "upsert" keys on (key, scope, agent_id, project_id, session_id),
//      so the same key silently forked into a second active row.
//
// Every assertion below is a READ-BACK through a different verb than the one
// that wrote, because the success line is what concealed both defects.
const DB_PATH = join(tmpdir(), `mementos-scope-upsert-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

/**
 * A subprocess env pinned to the temp SQLite DB.
 *
 * HISTORY, kept because it is why this harness is shaped the way it is: until
 * 2026-08-03 `MEMENTOS_DB_PATH` alone did NOT disable cloud routing —
 * `isApiMode()` engaged whenever an API url+key were both present and no
 * DATABASE_URL was set, so on a machine with mementos creds exported these
 * "local" e2e writes went to the live fleet store. An explicit DB_PATH now
 * outranks the API selectors (precedence 1, enforced in getApiConfig).
 *
 * That does NOT make the isolation below redundant, and it must not be
 * simplified away. DB_PATH does not neutralise a `DATABASE_URL` or a storage
 * mode var, `isolatedStoreEnv` is derived from the resolvers' own key lists so
 * it keeps covering selectors added later, and defence here does not depend on
 * a single precedence rule in another module staying as it is today.
 *
 * The selector list is NOT retyped here. It is derived from the resolver's own
 * exported keys by src/test-support/store-isolation.ts, so a selector added to
 * the resolver cannot leave this harness quietly uncovered — which a
 * hand-maintained blank list would. `beforeAll` then proves the child really
 * resolved to local SQLite instead of trusting that it did.
 */
function testEnv(): Record<string, string> {
  return isolatedStoreEnv(DB_PATH, { extra: blankLlmProviderEnv() });
}

beforeAll(async () => {
  // Fail loudly BEFORE any write, rather than discovering afterwards that these
  // e2e writes went to the shared production store.
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

/** Save a memory and return its id. */
async function save(...args: string[]): Promise<{ id: string; exitCode: number; stdout: string; stderr: string }> {
  const r = await runCli("--json", "save", ...args);
  let id = "";
  try { id = JSON.parse(r.stdout).id as string; } catch { /* caller asserts */ }
  return { id, ...r };
}

/**
 * Count ACTIVE rows carrying a key, via `list` — a different read path than the
 * `save` that wrote them. This is what proves a fork did or did not happen;
 * asserting only on an exit code would prove nothing.
 */
async function countActiveRowsWithKey(key: string): Promise<number> {
  const r = await runCli("--json", "list", "--status", "active", "--limit", "500");
  expect(r.exitCode).toBe(0);
  const rows = JSON.parse(r.stdout) as Array<{ key: string }> | { memories: Array<{ key: string }> };
  const list = Array.isArray(rows) ? rows : rows.memories;
  return list.filter((m) => m.key === key).length;
}

/** Read a memory back through `show` — a different verb than the writer. */
async function show(id: string): Promise<Record<string, unknown>> {
  const r = await runCli("--json", "show", id);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
});

describe("scope persistence and save fork (e2e)", () => {
  test("the harness really uses local SQLite, not the live cloud store", async () => {
    // Guards the whole file: if api-mode leaked back in, the temp DB would stay
    // absent and every assertion below would be silently testing production.
    const w = await save("harness-locality-check", "v");
    expect(w.exitCode).toBe(0);
    expect(w.id).not.toBe("");
    expect(existsSync(DB_PATH)).toBe(true);
  });

  // ── defect 1a: scope must persist through `save` ──────────────────────────

  test("save --scope persists the scope (read back through show)", async () => {
    const w = await save("scope-long-form", "v", "--scope", "shared");
    expect(w.exitCode).toBe(0);
    const stored = await show(w.id);
    expect(stored.scope).toBe("shared");
    // The value must NOT have leaked into session_id — that misroute is the bug.
    expect(stored.session_id ?? null).toBeNull();
  });

  test("save does not advertise a -s short flag it cannot honour", async () => {
    // `-s` is claimed by the program-level --session, so a subcommand `-s,
    // --scope` can never receive a value. Advertising it in --help while
    // silently writing the value to session_id is the defect.
    const help = await runCli("save", "--help");
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--scope");
    expect(help.stdout).not.toContain("-s, --scope");
  });

  // ── defect 1b: `update --scope` must persist, and a no-op must be loud ────

  test("update --scope persists the new scope (read back through show)", async () => {
    const w = await save("update-scope-target", "v", "--scope", "private");
    expect(w.exitCode).toBe(0);
    expect((await show(w.id)).scope).toBe("private");

    const u = await runCli("--json", "update", w.id, "--scope", "shared");
    expect(u.exitCode).toBe(0);
    expect((await show(w.id)).scope).toBe("shared");
  });

  test("update reports how many fields it changed instead of a bare 'Updated'", async () => {
    const w = await save("update-count", "v");
    expect(w.exitCode).toBe(0);
    const u = await runCli("update", w.id, "--scope", "shared", "--importance", "9");
    expect(u.exitCode).toBe(0);
    // A write that changes nothing must be distinguishable from one that did.
    expect(u.stdout).toContain("2 field");
  });

  test("update with NO field flags fails loudly instead of printing 'Updated'", async () => {
    const w = await save("update-noop", "v");
    expect(w.exitCode).toBe(0);
    const before = await show(w.id);

    const u = await runCli("update", w.id);
    expect(u.exitCode).toBe(1);
    expect(`${u.stdout}${u.stderr}`).toContain("no fields");

    // Nothing may have moved — not even the version.
    const after = await show(w.id);
    expect(after.version).toBe(before.version);
    expect(after.scope).toBe(before.scope);
  });

  test("update -s (the shadowed short flag) is refused, not silently a no-op", async () => {
    // This is the exact command shape filed in the defect. `-s` is the program's
    // --session, so no field was ever requested; the old code printed "Updated"
    // and bumped only the version.
    const w = await save("update-shadowed-s", "v", "--scope", "private");
    expect(w.exitCode).toBe(0);
    const before = await show(w.id);

    const u = await runCli("update", w.id, "-s", "shared");
    expect(u.exitCode).toBe(1);

    const after = await show(w.id);
    expect(after.scope).toBe("private");
    expect(after.version).toBe(before.version);
  });

  test("setting a field to the value it already has still succeeds (idempotence)", async () => {
    // Do NOT overcorrect: a legitimate no-change write is not a failure.
    const w = await save("update-idempotent", "v", "--scope", "shared");
    expect(w.exitCode).toBe(0);
    const u = await runCli("update", w.id, "--scope", "shared");
    expect(u.exitCode).toBe(0);
    expect((await show(w.id)).scope).toBe("shared");
  });

  test("update --scope with an unknown scope fails loudly and changes nothing", async () => {
    const w = await save("update-bad-scope", "v", "--scope", "private");
    expect(w.exitCode).toBe(0);

    const u = await runCli("update", w.id, "--scope", "not_a_scope");
    expect(u.exitCode).toBe(1);
    expect(`${u.stdout}${u.stderr}`.toLowerCase()).toContain("scope");

    expect((await show(w.id)).scope).toBe("private");
  });

  // ── defect 2: save must not silently fork a key into a second row ─────────

  test("save twice with the same key and same targeting upserts one row", async () => {
    const first = await save("upsert-same-bucket", "v1");
    expect(first.exitCode).toBe(0);
    const second = await save("upsert-same-bucket", "v2");
    expect(second.exitCode).toBe(0);

    // Same id, updated value — a real upsert.
    expect(second.id).toBe(first.id);
    expect((await show(first.id)).value).toBe("v2");
  });

  test("save refuses to fork an existing key into a different scope bucket", async () => {
    const first = await save("fork-guard", "v1", "--scope", "private");
    expect(first.exitCode).toBe(0);

    const second = await save("fork-guard", "v2", "--scope", "shared");
    expect(second.exitCode).toBe(1);
    const out = `${second.stdout}${second.stderr}`;
    expect(out).toContain("fork-guard");
    // The refusal must name the existing row so the operator can act on it.
    expect(out).toContain(first.id.slice(0, 8));

    // And the original must be untouched, with exactly one active row for the
    // key — counted through `list`, a different read path than `save`.
    expect((await show(first.id)).value).toBe("v1");
    expect(await countActiveRowsWithKey("fork-guard")).toBe(1);
  });

  test("--dedupe create is the explicit override that allows a deliberate fork", async () => {
    const first = await save("fork-explicit", "v1", "--scope", "private");
    expect(first.exitCode).toBe(0);

    const second = await save("fork-explicit", "v2", "--scope", "shared", "--dedupe", "create");
    expect(second.exitCode).toBe(0);
    expect(second.id).not.toBe(first.id);

    // Both rows exist, deliberately.
    expect((await show(first.id)).value).toBe("v1");
    expect((await show(second.id)).value).toBe("v2");
    // POSITIVE CONTROL for countActiveRowsWithKey: it must actually be able to
    // see a fork. Without this, the `toBe(1)` in the refusal test above could
    // pass because the counter is broken rather than because nothing forked.
    expect(await countActiveRowsWithKey("fork-explicit")).toBe(2);
  });

  // ── HC-00149's other half: `save` never warned about the -s misroute ──────

  test("save warns when --session is handed a scope word", async () => {
    const w = await save("session-scope-word", "v", "--session", "shared");
    // The write is legal, so this is advice and must NOT change the exit code.
    expect(w.exitCode).toBe(0);
    expect(`${w.stdout}${w.stderr}`).toContain("--scope");

    // And it really did misroute: session carries the scope word, scope did not
    // move. Asserting the warning text alone would not prove the misroute.
    const stored = await show(w.id);
    expect(stored.session_id).toBe("shared");
    expect(stored.scope).toBe("private");
  });

  test("save stays silent when --session carries an ordinary session id", async () => {
    // NEGATIVE CONTROL, deliberately a NEAR-MISS rather than an absurd string:
    // a realistic session id must not trip the warning. Without this the test
    // above could pass on a warning that fires unconditionally, which would
    // train every reader to ignore it.
    const w = await save("session-ordinary", "v", "--session", "sess-2026-08-03-a1");
    expect(w.exitCode).toBe(0);
    expect(`${w.stdout}${w.stderr}`).not.toContain("--scope");
  });

  test("the fork refusal names agent, the bucket column it used to omit", async () => {
    // agent is one of the four columns the bucket compares, but the target
    // descriptor listed only three. When agent is the sole difference the
    // refusal printed matching scope/project/session on both lines and looked
    // self-contradictory.
    const first = await save("fork-descriptor", "v1", "--scope", "private");
    expect(first.exitCode).toBe(0);

    const second = await save("fork-descriptor", "v2", "--scope", "shared");
    expect(second.exitCode).toBe(1);
    const out = `${second.stdout}${second.stderr}`;
    expect(out).toContain("scope/project/session/agent");
    expect(out).toContain("agent=none)");
  });

  test("save reports whether it created a new row or updated an existing one", async () => {
    const first = await runCli("save", "created-vs-updated", "v1");
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toLowerCase()).toContain("created");

    const second = await runCli("save", "created-vs-updated", "v2");
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toLowerCase()).toContain("updated");
  });
});
