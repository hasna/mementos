import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MEMENTOS_STORAGE_ENV,
  MEMENTOS_STORAGE_FALLBACK_ENV,
  getStorageMode,
} from "./storage.js";
import { isolatedStoreEnv } from "./test-support/store-isolation.js";

// ============================================================================
// Regression: an UNRECOGNISED storage mode must fail closed.
//
// MEASURED on the installed CLI at 0.14.69 (station01, clean `env -i`):
//
//   HASNA_MEMENTOS_STORAGE_MODE=local        mementos list --limit 1  -> rc=0, results
//   HASNA_MEMENTOS_STORAGE_MODE=wubbleflurp  mementos list --limit 1  -> rc=0, BYTE-IDENTICAL results
//
// The root cause was not a missing validation but an active mistranslation:
// storage.ts carried its own private `normalizeStorageMode` that RETURNED NULL
// for an unknown value, shadowing the vendored contract kit's version which
// THROWS. `getStorageModeOverride()` then read that null as "no mode was set"
// and `getStorageConfig()` fell through to the `local` default. So a typo'd or
// renamed mode did not merely go unchecked — it was converted into "unset", and
// the process read and WROTE a local SQLite store nobody else sees, at rc=0,
// with no warning. A mistyped mode was indistinguishable from success.
//
// @hasna/knowledge already fails closed here, via the same vendored kit, with a
// message naming the variable AND the offending value. These tests pin mementos
// to that behaviour rather than to a mementos-private third convention.
//
// EVERY rejection assertion below is paired with a POSITIVE CONTROL asserting a
// VALID mode still resolves. That pairing is not ceremony: the obvious wrong fix
// here is one that rejects everything, and a suite that only checked the
// rejection would pass green on a package that can no longer open any store.
//
// SAFETY: the in-process cases call `getStorageMode()`, which reads env and the
// config file only — it opens no database and makes no network request. The CLI
// cases run `storage mode`, which is likewise inert, under `isolatedStoreEnv`
// so no ambient API credential can route a child at the shared production store.
// ============================================================================

const CANONICAL = MEMENTOS_STORAGE_ENV.mode; // HASNA_MEMENTOS_STORAGE_MODE
const FALLBACK = MEMENTOS_STORAGE_FALLBACK_ENV.mode; // MEMENTOS_STORAGE_MODE
const MODE_KEYS = [CANONICAL, FALLBACK];

/** Values a caller can plausibly typo or inherit from a rename. */
const INVALID_MODES = ["wubbleflurp", "clud", "postgres", "sqlite", "remote-api", "LOCALL"];

describe("storage mode validation — unknown values fail closed (in-process)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of MODE_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("POSITIVE CONTROL: every VALID mode still resolves (a fix that rejects everything fails here)", () => {
    process.env[CANONICAL] = "local";
    expect(getStorageMode()).toBe("local");

    process.env[CANONICAL] = "cloud";
    expect(getStorageMode()).toBe("cloud");

    // Case and surrounding whitespace were always tolerated; keep it that way.
    process.env[CANONICAL] = "  CLOUD  ";
    expect(getStorageMode()).toBe("cloud");

    process.env[CANONICAL] = "LOCAL";
    expect(getStorageMode()).toBe("local");
  });

  test("POSITIVE CONTROL: deprecated aliases still normalize to cloud, not to an error", () => {
    // `remote` / `hybrid` / `self_hosted` are dead vocabulary but they are
    // accepted ALIASES in the storage contract, not invalid input. Turning them
    // into hard errors would be a different (breaking) change than this fix.
    for (const alias of ["remote", "hybrid", "self_hosted", "self-hosted"]) {
      process.env[CANONICAL] = alias;
      expect(getStorageMode()).toBe("cloud");
    }
  });

  test("POSITIVE CONTROL: no mode variable set still defaults to local", () => {
    expect(getStorageMode()).toBe("local");
  });

  test("an unrecognised mode THROWS instead of silently resolving to local", () => {
    for (const bad of INVALID_MODES) {
      process.env[CANONICAL] = bad;
      expect(() => getStorageMode()).toThrow();
    }
  });

  test("the error names the offending VARIABLE, the BAD VALUE, and the valid values", () => {
    process.env[CANONICAL] = "wubbleflurp";
    let message = "";
    try {
      getStorageMode();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Without the variable name the operator has to guess which of several env
    // vars to edit; without the value they cannot see the typo they made.
    expect(message).toContain(CANONICAL);
    expect(message).toContain("wubbleflurp");
    // Actionable: the message has to say what IS allowed, not just what is not.
    expect(message).toContain("local");
    expect(message).toContain("cloud");
  });

  test("the fallback env key fails closed too, and names ITSELF rather than the canonical key", () => {
    process.env[FALLBACK] = "wubbleflurp";
    let message = "";
    try {
      getStorageMode();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(FALLBACK);
    expect(message).toContain("wubbleflurp");
  });

  test("a valid canonical key wins over an invalid fallback key (precedence is unchanged)", () => {
    // The canonical key is consulted first and RETURNS; the fallback is never
    // reached, so its garbage cannot fail a correctly-configured process.
    process.env[CANONICAL] = "local";
    process.env[FALLBACK] = "wubbleflurp";
    expect(getStorageMode()).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// CLI level. The in-process tests prove the resolver throws; only a spawned
// process proves the OPERATOR-VISIBLE contract the bug report measured — a
// NON-ZERO exit code. A thrown error that some CLI layer catches and turns back
// into rc=0 would leave the original defect fully intact.
// ---------------------------------------------------------------------------

const CLI_PATH = new URL("./cli/index.tsx", import.meta.url).pathname;
const DB_PATH = join(tmpdir(), `mementos-mode-validation-${Date.now()}.db`);

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_PATH + suffix;
    if (existsSync(f)) try { unlinkSync(f); } catch { /* already gone */ }
  }
});

async function runCli(
  mode: string | null,
  argv: string[] = ["storage", "mode"],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = isolatedStoreEnv(DB_PATH);
  if (mode !== null) env[CANONICAL] = mode;
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...argv], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("storage mode validation — unknown values fail closed (CLI exit code)", () => {
  test("POSITIVE CONTROL: a valid mode exits 0 (proves the probe is not failing for an unrelated reason)", async () => {
    const { exitCode, stdout, stderr } = await runCli("local");
    expect(exitCode).toBe(0);
    expect(`${stdout}${stderr}`).toContain("local");
  }, 30_000);

  test("POSITIVE CONTROL: no mode set exits 0", async () => {
    const { exitCode } = await runCli(null);
    expect(exitCode).toBe(0);
  }, 30_000);

  test("an unrecognised mode exits NON-ZERO and names the variable and the bad value", async () => {
    const { exitCode, stdout, stderr } = await runCli("wubbleflurp");
    expect(exitCode).not.toBe(0);
    const output = `${stdout}${stderr}`;
    expect(output).toContain(CANONICAL);
    expect(output).toContain("wubbleflurp");
  }, 30_000);

  test("the rejection reaches the actual READ path, not only the mode reporter", async () => {
    // `storage mode` is a diagnostic. Guarding only it would leave the defect
    // fully intact where it does damage: a read that silently answers from a
    // local store the caller never asked for. Measured pre-fix: `list` returned
    // rc=0 with real rows under HASNA_MEMENTOS_STORAGE_MODE=wubbleflurp.
    const { exitCode, stdout, stderr } = await runCli("wubbleflurp", ["list", "--limit", "1"]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain(CANONICAL);
  }, 30_000);

  test("the rejection reaches the actual WRITE path — the one that creates an invisible island", async () => {
    // The damaging case: a `save` under a typo'd mode succeeds into a local
    // SQLite file no other agent reads. It must refuse instead.
    const { exitCode, stdout, stderr } = await runCli("wubbleflurp", [
      "save",
      "regression-2004c965",
      "must not be written under an invalid mode",
    ]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain(CANONICAL);
  }, 30_000);

  test("POSITIVE CONTROL: the same read and write succeed under a VALID mode", async () => {
    // Without this, the two assertions above would pass on a build where `list`
    // and `save` are simply broken for every mode.
    const write = await runCli("local", [
      "save",
      "regression-2004c965-control",
      "written under a valid mode",
    ]);
    expect(write.exitCode).toBe(0);
    const read = await runCli("local", ["list", "--limit", "1"]);
    expect(read.exitCode).toBe(0);
  }, 45_000);

  test("--json reports the failure as JSON rather than printing nothing", async () => {
    // The mode reporter's local `outputJson(enabled, value)` takes a GATE as its
    // first argument; passing a success flag there silently prints nothing and
    // hands a JSON consumer an empty stdout with a bare non-zero exit.
    const { exitCode, stdout } = await runCli("wubbleflurp", ["storage", "mode", "--json"]);
    expect(exitCode).not.toBe(0);
    expect(stdout.trim()).not.toBe("");
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain(CANONICAL);
    expect(parsed.error).toContain("wubbleflurp");
  }, 30_000);

  test("no stack trace is dumped for a configuration error", async () => {
    // `storage mode` is the command an operator runs *because* they are unsure
    // which store they are on. A Bun stack trace there buries the one line that
    // names the variable and the bad value.
    const { stdout, stderr } = await runCli("wubbleflurp");
    const output = `${stdout}${stderr}`;
    expect(output).not.toContain("Bun v");
    expect(output).not.toContain("at getStorageMode");
  }, 30_000);
});
