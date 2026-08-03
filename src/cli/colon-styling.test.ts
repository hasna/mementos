// Regression coverage for todos fa88836c: three CLI display sites append a
// literal ":" AFTER a chalk-styled DYNAMIC value instead of INSIDE the styled
// span:
//
//   src/cli/commands/system-tools.ts:114      `${chalk.red(err.error_type)}: ${err.count} times`
//   src/cli/commands/graph.ts:173              `${chalk.cyan(r.relation_type)}: ${r.count}`
//   src/cli/commands/memory-cmd-chain.ts:33    `${chalk.cyan(String(order) + ".")} ${chalk.bold(m.key)}: ${value}`
//
// This mirrors the ALREADY-FIXED defect in system-doctor.ts (todos 8f39d670,
// PR #46, 7615c27): chalk's SGR reset code lands BETWEEN the styled text and
// the literal ":" appended after the closing `)`, so a plain substring match
// for "<value>:" fails whenever the child process resolves colour on
// (FORCE_COLOR set). See src/test-support/strip-ansi.ts for the mechanism.
//
// UNLIKE the doctor case, these three style a DYNAMIC VALUE (an error type, a
// relation type, a memory key) rather than a fixed LABEL. Fixing the source
// so the colon sits inside the styled span makes the colon itself take the
// dynamic value's colour — a small, real, user-visible change. This suite
// exists to (a) prove per-site whether the substring actually breaks under
// colour, and (b) pin the CHOSEN behaviour (colon-inside-span) as a
// regression once a fix lands, exactly as doctor.test.ts's colour regression
// test does for the label case.
//
// Each site gets a value that would legitimately appear in the field being
// styled, so the assertion is a real content check, not a synthetic string
// chosen to make the point.

import { describe, test, expect, afterAll, beforeAll, setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);

import { unlinkSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLocalStoreBackend, isolatedStoreEnv } from "../test-support/store-isolation.js";
import { stripAnsi } from "../test-support/strip-ansi.js";

const DB_PATH = join(tmpdir(), `mementos-colon-styling-test-${Date.now()}.db`);
const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;
const CLI_ENV = isolatedStoreEnv(DB_PATH);

const SEED_SCRIPT_PATH = join(tmpdir(), `mementos-colon-styling-seed-${Date.now()}.ts`);

beforeAll(async () => {
  await assertLocalStoreBackend(CLI_PATH, CLI_ENV, DB_PATH);

  // Seed via a short-lived child process that imports the db layer directly
  // and writes through the SAME MEMENTOS_DB_PATH the CLI will read, then
  // exits (closing its db handle) before any display command runs against
  // the file. `entity create` / `relation create` exist as CLI verbs and are
  // used directly below; `tool-events` and `chain` have no CLI verb that
  // writes them, so those two rows are seeded here instead.
  const seedSrc = `
    import { saveToolEvent } from "${new URL("../db/tool-events.js", import.meta.url).pathname}";
    import { createMemory } from "${new URL("../db/memories.js", import.meta.url).pathname}";

    saveToolEvent({
      tool_name: "colon_styling_probe_tool",
      success: false,
      error_type: "timeout",
    });

    createMemory({
      key: "colon-chain-step-one",
      value: "first step in the probe chain",
      sequence_group: "colon-styling-probe-chain",
      sequence_order: 1,
    });
  `;
  writeFileSync(SEED_SCRIPT_PATH, seedSrc);
  const seedProc = Bun.spawn(["bun", "run", SEED_SCRIPT_PATH], {
    env: CLI_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [seedOut, seedErr] = await Promise.all([
    new Response(seedProc.stdout).text(),
    new Response(seedProc.stderr).text(),
  ]);
  const seedExit = await seedProc.exited;
  if (seedExit !== 0) {
    throw new Error(`seed script failed (exit ${seedExit}):\nstdout: ${seedOut}\nstderr: ${seedErr}`);
  }

  // Seed the graph-stats relation via the real CLI verbs.
  await runCli("entity", "create", "colon-styling-source", "--type", "tool");
  await runCli("entity", "create", "colon-styling-target", "--type", "tool");
  const relResult = await runCli(
    "relation",
    "create",
    "colon-styling-source",
    "colon-styling-target",
    "--type",
    "depends_on",
  );
  if (relResult.exitCode !== 0) {
    throw new Error(`seed relation create failed (exit ${relResult.exitCode}): ${relResult.stderr}`);
  }
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  }
  if (existsSync(SEED_SCRIPT_PATH)) try { rmSync(SEED_SCRIPT_PATH); } catch {}
});

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number; rawStdout: string }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    env: CLI_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stripAnsi(stdout.trim()), stderr: stripAnsi(stderr.trim()), exitCode, rawStdout: stdout.trim() };
}

async function runCliColour(
  ...args: string[]
): Promise<{ stdout: string; rawStdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    env: { ...CLI_ENV, FORCE_COLOR: "3" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const rawStdout = (await new Response(proc.stdout).text()).trim();
  const exitCode = await proc.exited;
  return { stdout: stripAnsi(rawStdout), rawStdout, exitCode };
}

// IMPORTANT: these assertions are against `rawStdout` — the UNSTRIPPED
// child-process output — not the `stdout` field the general suite uses
// elsewhere (which already runs stripAnsi and would make this defect
// invisible: stripping removes exactly the reset code sitting between the
// value and the colon, so a stripped comparison passes regardless of where
// the colon sits relative to the chalk call). A raw literal-substring check
// is what a downstream consumer NOT running through stripAnsi actually sees
// — a human terminal, a naive `| grep "error_type:"`, or any tool that does
// not know to strip SGR codes first. That is the real-world exposure this
// defect class has, exactly as it did for the doctor case before PR #46.
describe("colon-after-styled-value sites (todos fa88836c)", () => {
  // Site 1: src/cli/commands/system-tools.ts:114 — `${chalk.red(err.error_type)}: ${err.count} times`
  test("tool-insights: error_type: literal substring survives colour in RAW output", async () => {
    const { rawStdout, exitCode } = await runCliColour("tool-insights", "colon_styling_probe_tool");
    expect(exitCode).toBe(0);
    // Sanity: this run must actually be coloured, or the assertion below
    // would pass vacuously regardless of whether the source bug exists.
    expect(rawStdout).toContain("\x1b[");
    // The unit that must be contiguous is "<value>:" — the reset code that
    // ends the styled span always sits at the CLOSE of that span, so
    // whatever comes after it (a space, more text) is expected to have a
    // reset between it and the colon. That is normal chalk behaviour, not
    // the defect. The defect was the reset landing BEFORE the colon.
    expect(rawStdout).toContain("timeout:");
  });

  // Site 2: src/cli/commands/graph.ts:173 — `${chalk.cyan(r.relation_type)}: ${r.count}`
  test("graph stats: relation_type: literal substring survives colour in RAW output", async () => {
    const { rawStdout, exitCode } = await runCliColour("graph", "stats");
    expect(exitCode).toBe(0);
    expect(rawStdout).toContain("\x1b[");
    expect(rawStdout).toContain("depends_on:");
  });

  // Site 3: src/cli/commands/memory-cmd-chain.ts:33 — `${chalk.bold(m.key)}: ${value}`
  test("chain: memory key: literal substring survives colour in RAW output", async () => {
    const { rawStdout, exitCode } = await runCliColour("chain", "colon-styling-probe-chain");
    expect(exitCode).toBe(0);
    expect(rawStdout).toContain("\x1b[");
    expect(rawStdout).toContain("colon-chain-step-one:");
  });

  // In-suite POSITIVE CONTROL: an already-correct site in the SAME command
  // (tool-insights, system-tools.ts:132 — `chalk.dim("Hint: ...")`) puts the
  // colon INSIDE the styled call. This must survive the identical raw,
  // coloured-output substring check, proving the check itself can pass and
  // that the failure on the three sites above is about colon placement, not
  // about the check being unable to ever succeed.
  test("positive control: a colon placed INSIDE the styled span survives colour in RAW output", async () => {
    // tool-insights only prints the "Hint:" line when lessons exceed --limit;
    // simpler and equally valid as a positive control: tool-insights' own
    // "Tool: <name>" header, `chalk.bold(\`Tool: ${toolName}\`)`, styles the
    // colon and the label together as ONE call — the correct pattern.
    const { rawStdout, exitCode } = await runCliColour("tool-insights", "colon_styling_probe_tool");
    expect(exitCode).toBe(0);
    expect(rawStdout).toContain("\x1b[");
    expect(rawStdout).toContain("Tool: colon_styling_probe_tool");
  });
});
