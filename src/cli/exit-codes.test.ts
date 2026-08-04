import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertLocalStoreBackend,
  blankLlmProviderEnv,
  isolatedStoreEnv,
} from "../test-support/store-isolation.js";
import { EXIT_USAGE, resolveExitCode } from "./exit-codes.js";
import {
  RECALL_EXIT_FUZZY,
  RECALL_EXIT_NOT_FOUND,
} from "./commands/memory-cmd-recall-exit.js";

// todos 518ad20c — a REJECTED COMMAND LINE must not be reportable as a DATA
// ANSWER. Before the fix, `mementos <typo>` and `mementos get <absent-key>`
// both exited 1, so a verification script branching on the exit code alone read
// its own typo as an authoritative absence and failed open.
//
// THE POINT OF THIS FILE IS THE INEQUALITY, NOT THE MAGNITUDES. A test that
// only asserted "a miss is non-zero" passed BEFORE the fix and proved nothing;
// every subprocess assertion below is therefore paired with an explicit
// `not.toBe` against the other arm, so the suite fails if the two collapse back
// onto one code — whatever that code happens to be.

const DB_PATH = join(tmpdir(), `mementos-exitcodes-test-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

// This suite drives the real CLI and WRITES one record. Pin the child to
// DB_PATH: ambient HASNA_MEMENTOS_API_URL + HASNA_MEMENTOS_API_KEY, exported by
// the operator shell and inherited through tmux, would otherwise route it into
// the shared production store.
const CLI_ENV = isolatedStoreEnv(DB_PATH, { extra: blankLlmProviderEnv() });

const PRESENT_KEY = "contract/exit-codes/present";
// A NEAR-MISS of a key that really is in the store — not an invented string.
// An invented key is far from every record and exercises only the easiest
// branch; a one-character neighbour keeps the lookup on the realistic path.
const NEAR_MISS_KEY = "contract/exit-codes/presentx";

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
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: await proc.exited };
}

beforeAll(async () => {
  // Fail loudly BEFORE any write if the child did not resolve to local SQLite.
  await assertLocalStoreBackend(CLI_PATH, CLI_ENV, DB_PATH);

  const saved = await runCli("save", PRESENT_KEY, "exit-code contract fixture");
  // POSITIVE CONTROL for the whole suite: if the fixture did not land, every
  // "miss" below would be a miss for the wrong reason and the inequalities
  // would pass vacuously.
  expect(saved.exitCode).toBe(0);
  const hit = await runCli("get", PRESENT_KEY);
  expect(hit.exitCode).toBe(0);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
});

describe("resolveExitCode (pure contract)", () => {
  test("command-line rejections map to EXIT_USAGE", () => {
    for (const code of [
      "commander.unknownCommand",
      "commander.unknownOption",
      "commander.missingArgument",
      "commander.optionMissingArgument",
      "commander.missingMandatoryOptionValue",
      "commander.excessArguments",
      "commander.conflictingOption",
      "commander.invalidArgument",
      "commander.help",
    ]) {
      expect(resolveExitCode({ code, exitCode: 1 })).toBe(EXIT_USAGE);
    }
  });

  test("EXIT_USAGE differs from every domain status it must be told apart from", () => {
    expect(EXIT_USAGE).not.toBe(0);
    expect(EXIT_USAGE).not.toBe(RECALL_EXIT_NOT_FOUND);
    expect(EXIT_USAGE).not.toBe(RECALL_EXIT_FUZZY);
  });

  test("a domain error keeps its own status", () => {
    // Command#error() — how command implementations report DOMAIN failures.
    expect(resolveExitCode({ code: "commander.error", exitCode: 1 })).toBe(1);
    expect(resolveExitCode({ code: "commander.error", exitCode: 3 })).toBe(3);
  });

  test("success paths are never turned into failures", () => {
    expect(resolveExitCode({ code: "commander.version", exitCode: 0 })).toBe(0);
    expect(resolveExitCode({ code: "commander.helpDisplayed", exitCode: 0 })).toBe(0);
    // A group invoked with no subcommand arrives as commander.help with a
    // NON-zero exitCode; an explicit --help arrives with 0. Same family, and
    // only the failing one is remapped.
    expect(resolveExitCode({ code: "commander.help", exitCode: 0 })).toBe(0);
  });

  test("an unrecognised code is passed through, not swallowed", () => {
    expect(resolveExitCode({ code: "commander.executeSubCommandAsync", exitCode: 1 })).toBe(1);
    expect(resolveExitCode({})).toBe(1);
  });
});

describe("end-to-end: an unknown verb and a genuine miss are DISTINGUISHABLE", () => {
  test("THE REGRESSION: unknown verb != genuine miss", async () => {
    const unknownVerb = await runCli("zzq-not-a-verb-518ad20c");
    const genuineMiss = await runCli("get", NEAR_MISS_KEY);

    // Both must remain FAILURES, so `if mementos ...` keeps working.
    expect(unknownVerb.exitCode).not.toBe(0);
    expect(genuineMiss.exitCode).not.toBe(0);

    // ...and they must NOT be the same failure. This is the assertion that
    // fails on the pre-fix build, where both were 1.
    expect(unknownVerb.exitCode).not.toBe(genuineMiss.exitCode);

    expect(unknownVerb.exitCode).toBe(EXIT_USAGE);
    expect(genuineMiss.exitCode).toBe(RECALL_EXIT_NOT_FOUND);

    // The messages were already distinct; assert the fix did not eat them.
    expect(unknownVerb.stderr).toContain("unknown command");
    expect(genuineMiss.stderr).toContain("No memory found for key");
  });

  test("unknown OPTION on a real verb is a usage error, not a miss", async () => {
    const badFlag = await runCli("get", PRESENT_KEY, "--zzq-not-a-flag-518ad20c");
    const genuineMiss = await runCli("get", NEAR_MISS_KEY);

    expect(badFlag.exitCode).toBe(EXIT_USAGE);
    expect(badFlag.exitCode).not.toBe(genuineMiss.exitCode);
    expect(badFlag.stderr).toContain("unknown option");
  });

  test("a missing required argument is a usage error, not a miss", async () => {
    const missingArg = await runCli("get");
    const genuineMiss = await runCli("get", NEAR_MISS_KEY);

    expect(missingArg.exitCode).toBe(EXIT_USAGE);
    expect(missingArg.exitCode).not.toBe(genuineMiss.exitCode);
    expect(missingArg.stderr).toContain("missing required argument");
  });

  test("NESTED subcommands inherit the override — the ordering hazard", async () => {
    // Commander copies _exitCallback into a subcommand at .command() time, so
    // installing exitOverride AFTER registerAllCommands() would leave every
    // nested verb exiting 1 while the root correctly returned 64. That mistake
    // is invisible to any root-only assertion, so it is asserted here.
    const nestedUnknown = await runCli("agents", "zzq-not-a-verb-518ad20c");
    expect(nestedUnknown.exitCode).toBe(EXIT_USAGE);
    expect(nestedUnknown.exitCode).not.toBe(RECALL_EXIT_NOT_FOUND);
  });

  test("a command GROUP named with no subcommand is a usage error", async () => {
    // `mementos synthesis` printed its usage and exited 1 — indistinguishable
    // from `mementos synthesis run` failing for a real runtime reason. That
    // exact pair is what the nightly charter loop probes by exit code.
    const bareGroup = await runCli("synthesis");
    expect(bareGroup.exitCode).toBe(EXIT_USAGE);
    expect(bareGroup.exitCode).not.toBe(RECALL_EXIT_NOT_FOUND);
  });
});

describe("statuses that must NOT change", () => {
  test("--version and --help still succeed", async () => {
    expect((await runCli("--version")).exitCode).toBe(0);
    expect((await runCli("--help")).exitCode).toBe(0);
    expect((await runCli("get", "--help")).exitCode).toBe(0);
  });

  test("an exact hit is still 0", async () => {
    expect((await runCli("get", PRESENT_KEY)).exitCode).toBe(0);
  });

  test("--fuzzy substitution is still EXIT 2, and still not the usage code", async () => {
    const fuzzy = await runCli("get", NEAR_MISS_KEY, "--fuzzy");
    expect(fuzzy.exitCode).toBe(RECALL_EXIT_FUZZY);
    expect(fuzzy.exitCode).not.toBe(EXIT_USAGE);
  });
});
