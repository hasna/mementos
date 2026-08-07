import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import {
  assertLocalStoreBackend,
  blankLlmProviderEnv,
  isolatedStoreEnv,
} from "../test-support/store-isolation.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Regression cover: the READ side accepted `--agent <name>` and matched on it as
// a raw agent ID, so a real registered NAME selected nothing.
//
//     const agentId = (opts.agent as string | undefined) || globalOpts.agent;
//     ... filter.agent_id = agentId          // the raw string, never resolved
//
// Two failures came out of that one line, and the second is the expensive one:
//
//   1. `--agent <registered name>` returned "No memories found." The flag is
//      DECLARED `--agent <name>` and documented "Agent filter", so the CLI's own
//      help promised a name and the code required an id.
//   2. A REAL NAME and a FABRICATED string produced byte-identical output on
//      BOTH stdout and stderr, at rc=0. So an empty result could not be
//      distinguished from a mistyped one, and the compliance check for the
//      mementos-discipline rule reported every seat as non-compliant regardless
//      of truth — a check that CANNOT PASS.
//
// The fix resolves through `getAgent` (id -> case-insensitive name -> unique
// partial id), which is the same resolver the save path uses, and warns on
// stderr when the value resolves to nothing — mirroring `todos list --assigned`.
//
// THE TWO CONTROLS THAT CONSTRAIN THE FIX, without which a broken fix passes:
//
//   - CROSS-AGENT ISOLATION. Simply DROPPING an unresolvable filter would make
//     the "name works" test pass while returning every agent's rows. That is the
//     sibling defect in `search`/`info-stale`, and it is worse than this one:
//     zero rows is a visible failure, other people's rows returned as yours is
//     an invisible one. A fix that makes everything match must FAIL here.
//   - A REAL NAME MUST NOT WARN. An unconditional warning would satisfy every
//     "warns on stderr" assertion while carrying no information at all.
const DB_PATH = join(tmpdir(), `mementos-agent-filter-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

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

// Subprocess budgets, sized to measured cost rather than guessed. One
// `bun run <cli>` spawn costs 353-849ms on station01 (three samples, contended
// box). `beforeAll` performs six spawns, which lands on top of bun's 5000ms
// default and times the hook out before a single assertion runs — the failure
// looks like a broken fixture rather than a slow one. Budgets are set well
// above the measured cost because these numbers were taken while four
// machine-wide test slots were busy, and a budget measured in isolation is not
// a budget that holds under contention.
const SETUP_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;

const AGENT_A = "regressionalpha";
const AGENT_B = "regressionbeta";
const BOGUS_AGENT = "zzq-no-such-agent-9f3";
const KEY_A = "agent-filter-key-alpha";
const KEY_B = "agent-filter-key-beta";

let idA = "";
let idB = "";

beforeAll(async () => {
  // "I set the variable" is not evidence of isolation. Ask the child what it
  // actually resolved, or this suite writes into the shared fleet store.
  await assertLocalStoreBackend(CLI_PATH, testEnv(), DB_PATH);

  const regA = await runCli("register-agent", AGENT_A);
  expect(regA.exitCode).toBe(0);
  const regB = await runCli("register-agent", AGENT_B);
  expect(regB.exitCode).toBe(0);

  // Read the ids back rather than parsing them out of the register output, so
  // the id used below is the stored one.
  const agents = await runCli("--json", "agents", "--limit", "500");
  expect(agents.exitCode).toBe(0);
  const rows = JSON.parse(agents.stdout) as Array<{ id: string; name: string }>;
  idA = rows.find((r) => r.name === AGENT_A)?.id ?? "";
  idB = rows.find((r) => r.name === AGENT_B)?.id ?? "";
  expect(idA).not.toBe("");
  expect(idB).not.toBe("");
  expect(idA).not.toBe(idB);

  expect((await runCli("save", KEY_A, "alpha-owned-value", "--agent", idA)).exitCode).toBe(0);
  expect((await runCli("save", KEY_B, "beta-owned-value", "--agent", idB)).exitCode).toBe(0);
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
});

describe("list --agent resolves a registered NAME, not only an id", () => {
  test("POSITIVE CONTROL: --agent <REAL ID> finds the row", async () => {
    // Without this, every assertion below could pass on a build where the agent
    // filter is broken outright and nothing is ever returned.
    const r = await runCli("list", "--agent", idA);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(KEY_A);
  }, TEST_TIMEOUT_MS);

  test("THE DEFECT: --agent <REAL NAME> finds the same row", async () => {
    const r = await runCli("list", "--agent", AGENT_A);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(KEY_A);
  }, TEST_TIMEOUT_MS);

  test("a NAME and its ID select the same rows", async () => {
    const byId = await runCli("--json", "list", "--agent", idA);
    const byName = await runCli("--json", "list", "--agent", AGENT_A);
    expect(byId.exitCode).toBe(0);
    expect(byName.exitCode).toBe(0);
    const ids = (j: string) => (JSON.parse(j) as Array<{ id: string }>).map((m) => m.id).sort();
    expect(ids(byName.stdout)).toEqual(ids(byId.stdout));
    expect(ids(byName.stdout).length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  test("name resolution is case-insensitive", async () => {
    const r = await runCli("list", "--agent", AGENT_A.toUpperCase());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(KEY_A);
  }, TEST_TIMEOUT_MS);

  test("the global --agent form resolves a name too", async () => {
    // `--agent` exists as a global option as well, and the command merges them.
    // Fixing only the sub-command form would leave the mechanism live here.
    const r = await runCli("--agent", AGENT_A, "list");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(KEY_A);
  }, TEST_TIMEOUT_MS);
});

describe("an unresolvable --agent is announced instead of returning a silent zero", () => {
  test("a bogus agent returns no rows, rc=0, AND warns on stderr", async () => {
    const r = await runCli("list", "--agent", BOGUS_AGENT);
    // rc stays 0: a read filter is not destructive, and ~live call sites treat
    // an empty list as a legitimate scriptable answer. This mirrors the sibling
    // `todos list --assigned <bogus>`, which warns at rc=0. The save path throws
    // instead, and that difference is deliberate: there, rc=0 was illusory
    // because the write landed in a bucket the caller never named.
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain(KEY_A);
    expect(r.stdout).not.toContain(KEY_B);
    expect(r.stderr).toContain(BOGUS_AGENT);
    expect(r.stderr.toLowerCase()).toContain("no agent named");
    expect(r.stderr).toContain("mementos agents");
  }, TEST_TIMEOUT_MS);

  test("NEAR-MISS CONTROL: a REAL name must NOT warn", async () => {
    // An unconditional warning would pass the assertion above while telling the
    // reader nothing. The warning has to discriminate.
    const r = await runCli("list", "--agent", AGENT_A);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toLowerCase()).not.toContain("no agent named");
  }, TEST_TIMEOUT_MS);

  test("a bogus agent leaves --format json parseable, warning on stderr only", async () => {
    const r = await runCli("--json", "list", "--agent", BOGUS_AGENT);
    expect(r.exitCode).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout)).toEqual([]);
    expect(r.stderr.toLowerCase()).toContain("no agent named");
  }, TEST_TIMEOUT_MS);
});

describe("NEGATIVE CONTROL: resolution must not widen the query", () => {
  test("agent A's name does not return agent B's memory", async () => {
    const r = await runCli("list", "--agent", AGENT_A);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(KEY_A);
    expect(r.stdout).not.toContain(KEY_B);
  }, TEST_TIMEOUT_MS);

  test("a bogus agent does not fall back to returning everything", async () => {
    // The failure this guards is `search`/`info-stale`'s drop-on-miss shape:
    // an unresolvable name removes the filter and returns every agent's rows.
    const filtered = await runCli("--json", "list", "--agent", BOGUS_AGENT);
    const unfiltered = await runCli("--json", "list");
    expect(filtered.exitCode).toBe(0);
    expect(unfiltered.exitCode).toBe(0);
    const nFiltered = (JSON.parse(filtered.stdout) as unknown[]).length;
    const nUnfiltered = (JSON.parse(unfiltered.stdout) as unknown[]).length;
    expect(nUnfiltered).toBeGreaterThan(0); // the comparison is meaningful
    expect(nFiltered).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe("the sibling read commands resolve a name through the same helper", () => {
  test("recall --agent <NAME> finds the row", async () => {
    const r = await runCli("recall", KEY_A, "--agent", AGENT_A);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alpha-owned-value");
  }, TEST_TIMEOUT_MS);

  test("recall --agent <BOGUS> warns rather than returning a bare miss", async () => {
    const r = await runCli("recall", KEY_A, "--agent", BOGUS_AGENT);
    expect(r.stderr.toLowerCase()).toContain("no agent named");
  }, TEST_TIMEOUT_MS);
});
