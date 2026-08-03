// ============================================================================
// Local-store isolation for subprocess test harnesses.
//
// WHY THIS EXISTS (a measured incident, not a hypothetical):
//
// mementos selects its storage transport by the mere PRESENCE of env vars —
// `isApiMode()` in src/db/api-mode.ts is true whenever an API URL and API key
// are both set and no DSN is. On a fleet machine the operator's shell exports
// HASNA_MEMENTOS_API_URL + HASNA_MEMENTOS_API_KEY, and the tmux server process
// carries them, so EVERY pane and every child process inherits them.
//
// A harness that spawns the CLI with `{ ...process.env, MEMENTOS_DB_PATH: tmp }`
// therefore runs in API mode against the SHARED PRODUCTION store. The redirect
// looks like it worked and does nothing:
//
//   - MEMENTOS_DB_PATH is consulted at src/db/database.ts:157, which is
//     unreachable past the API-mode guard at :142; and
//   - the memory read/write paths route to HTTP in src/db/memories.ts before
//     `getDatabase()` is consulted at all.
//
// The observable signature is that the scratch SQLite file is NEVER CREATED
// while the CLI reports success, and the rows land in the shared cross-agent
// memory layer, indistinguishable from real memories. Because mementos is a
// source of truth other agents read, that pollution silently corrupts the
// inputs to future work.
//
// WHY BLANKING ALONE IS NOT THE FIX: a hand-written list of vars to blank is a
// copy of a list that lives somewhere else. It stops covering the resolver the
// moment a new selector is added, and it fails silently — the harness keeps
// passing while writing to production. So this module does two things instead:
//
//   1. Builds the child env from the key lists the RESOLVER ITSELF reads
//      (exported from src/db/api-mode.ts and src/storage.ts), so the list
//      cannot drift out of sync with the code that consults it.
//   2. ASSERTS, by asking the child process what it resolved, that the backend
//      really is local — and throws loudly if not. A selector nobody thought of
//      then produces a RED SUITE instead of a production write.
//
// Point 2 is the load-bearing half. "I set the variable" is not evidence of
// isolation; "the child says local-sqlite and the scratch file now exists with
// my row in it" is. A prior incident in this workspace destroyed 139 live
// artifacts precisely because a redirect was believed rather than verified in
// the process that performed the write.
// ============================================================================

import { existsSync } from "node:fs";
import {
  API_KEY_ENV_KEYS,
  API_URL_ENV_KEYS,
  DATABASE_URL_ENV_KEYS,
} from "../db/api-mode.js";
import type { StoreBackendReport } from "../db/store-backend.js";
import { MEMENTOS_STORAGE_ENV, MEMENTOS_STORAGE_FALLBACK_ENV } from "../storage.js";

/**
 * Every env var that can move the store off local SQLite, plus the store
 * credential. Derived from the resolver's own exported key lists rather than
 * retyped, so adding a selector in src/db/api-mode.ts or src/storage.ts
 * automatically widens what the harnesses neutralize.
 *
 * `MEMENTOS_DATABASE_PASSWORD` is not a selector but is the store credential;
 * removing it can only make the child more local, never less.
 */
export const STORE_SELECTOR_ENV_KEYS: readonly string[] = Array.from(
  new Set<string>([
    ...API_URL_ENV_KEYS,
    ...API_KEY_ENV_KEYS,
    ...DATABASE_URL_ENV_KEYS,
    MEMENTOS_STORAGE_ENV.databaseUrl,
    MEMENTOS_STORAGE_FALLBACK_ENV.databaseUrl,
    MEMENTOS_STORAGE_ENV.mode,
    MEMENTOS_STORAGE_FALLBACK_ENV.mode,
    "MEMENTOS_DATABASE_PASSWORD",
  ]),
);

/** The two env vars that point the CLI at a specific SQLite file. */
export const DB_PATH_ENV_KEYS = ["MEMENTOS_DB_PATH", "HASNA_MEMENTOS_DB_PATH"] as const;

export interface IsolatedStoreEnvOptions {
  /**
   * Extra vars to set in the child, applied last. Harnesses use this to blank
   * LLM provider keys so no test can make a billed call. Kept opt-in because
   * blanking them changes what commands like `doctor` report.
   */
  extra?: Record<string, string>;
}

/**
 * Build a child-process env that is pinned to a local SQLite file at `dbPath`.
 *
 * Selectors are DELETED rather than set to `""` — the resolver treats empty as
 * unset either way, but deleting leaves no ambiguity for a human reading the
 * child's environment during a postmortem.
 *
 * Building the env is necessary but NOT sufficient: pair it with
 * {@link assertLocalStoreBackend} before the suite performs any write.
 */
export function isolatedStoreEnv(
  dbPath: string,
  options: IsolatedStoreEnvOptions = {},
): Record<string, string> {
  const env = envWithoutStoreSelectors();
  for (const key of DB_PATH_ENV_KEYS) env[key] = dbPath;
  for (const [key, value] of Object.entries(options.extra ?? {})) env[key] = value;
  return env;
}

/** The ambient env with every store selector removed. The shared starting point. */
function envWithoutStoreSelectors(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const key of STORE_SELECTOR_ENV_KEYS) delete env[key];
  return env;
}

export interface StubApiEnvOptions {
  /** Stub bearer token. Never a real credential — the stub does not check it. */
  apiKey?: string;

  // REMOVED 2026-08-03: `dbPath`, documented as "pin the (non-authoritative)
  // local SQLite path too, for belt and braces". It had exactly one caller,
  // which passed nothing. Since precedence 1 landed, a local path is no longer
  // non-authoritative — it OUTRANKS the API selectors — so this option would
  // have silently disabled the very API mode this helper exists to create, and
  // pointed the suite at a SQLite file instead of its stub server. Belt and
  // braces that cuts the belt. Deleted rather than fixed because nothing uses
  // it and a live option is a live hazard.
}

/**
 * Build a child env for a suite that *deliberately* runs in API mode against a
 * local stub server.
 *
 * Such a suite still must not inherit the operator's production API URL or key:
 * it overrides the URL, but if that override were ever empty or renamed, the
 * ambient value would take over and the suite would drive the real store. So
 * start from a fully de-selected env and add back only the stub's own values.
 *
 * @param baseUrl the stub's origin, e.g. `http://127.0.0.1:<port>/<mode>`
 */
export function stubApiEnv(baseUrl: string, options: StubApiEnvOptions = {}): Record<string, string> {
  const env = envWithoutStoreSelectors();
  // An inherited DB_PATH would outrank the stub credentials and send the suite
  // to a SQLite file instead of the stub server (precedence 1), so drop it.
  for (const key of DB_PATH_ENV_KEYS) delete env[key];
  env[API_URL_ENV_KEYS[0]] = baseUrl;
  env[API_KEY_ENV_KEYS[0]] = options.apiKey ?? "stub-key-not-a-secret";
  return env;
}

/**
 * Build a child env that DOES resolve to the cloud API — the negative case the
 * isolation guards are proved against.
 *
 * This exists because of the 2026-08-03 precedence-1 fix. Before it, a cloud
 * case could be built by taking any env and adding an API url+key, and several
 * tests did exactly that on top of {@link isolatedStoreEnv}. An explicit
 * `MEMENTOS_DB_PATH` now DEFEATS the API selectors (see getApiConfig in
 * src/db/api-mode.ts), so that recipe silently produces a LOCAL backend — which
 * would leave the isolation guards' positive controls unable to observe the bad
 * state they exist to detect, and `assertLocalStoreBackend`'s own self-test
 * unable to fail. Both would still be green.
 *
 * So the DB_PATH keys are removed here explicitly, and that removal is the
 * load-bearing line rather than an afterthought: it is the only way to reach the
 * cloud backend now. They are NOT in STORE_SELECTOR_ENV_KEYS because that set
 * means "moves the store OFF local SQLite", and DB_PATH does the opposite.
 *
 * @param baseUrl  point this at a closed loopback port, never a real endpoint
 * @param apiKey   never a real credential
 */
export function cloudSelectingEnv(
  baseUrl: string,
  apiKey = "not-a-real-key",
): Record<string, string> {
  const env = envWithoutStoreSelectors();
  for (const key of DB_PATH_ENV_KEYS) delete env[key];
  env[API_URL_ENV_KEYS[0]] = baseUrl;
  env[API_KEY_ENV_KEYS[0]] = apiKey;
  return env;
}

/** LLM provider keys most harnesses blank so no test can make a billed call. */
export const LLM_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
] as const;

/** `{ ANTHROPIC_API_KEY: "", ... }` — pass as `extra` to blank LLM providers. */
export function blankLlmProviderEnv(): Record<string, string> {
  return Object.fromEntries(LLM_PROVIDER_ENV_KEYS.map((key) => [key, ""]));
}

/**
 * Ask the child process which store it resolved, and THROW if it is not local.
 *
 * This is the guard that turns an unknown future selector into a red suite
 * rather than a silent production write. It asks the CLI itself
 * (`storage mode --json`) rather than recomputing the answer here, so the
 * verdict comes from the same resolution code the writes will use — and it runs
 * as a real child process with the real env, so an env var that fails to cross
 * the process boundary is caught rather than assumed away.
 *
 * `storage mode` opens no database and makes no network request, so this is
 * safe to call even when the ambient env points at production.
 *
 * @param cliPath  path to src/cli/index.tsx
 * @param env      the env produced by {@link isolatedStoreEnv}
 * @param expectedDbPath  when given, also assert the child resolved this path
 */
export async function assertLocalStoreBackend(
  cliPath: string,
  env: Record<string, string>,
  expectedDbPath?: string,
): Promise<StoreBackendReport> {
  const proc = Bun.spawn(["bun", "run", cliPath, "storage", "mode", "--json"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      "store-isolation: REFUSING TO RUN — could not determine the child process's store backend " +
        `(\`storage mode --json\` exited ${exitCode}). Treating an unknown backend as unsafe.\n` +
        `stderr: ${stderr.trim().slice(0, 800)}`,
    );
  }

  let report: StoreBackendReport;
  try {
    report = JSON.parse(stdout) as StoreBackendReport;
  } catch {
    throw new Error(
      "store-isolation: REFUSING TO RUN — `storage mode --json` did not return parseable JSON, " +
        `so the backend is unknown. Treating an unknown backend as unsafe.\nstdout: ${stdout.slice(0, 800)}`,
    );
  }

  if (report.api_mode || report.backend !== "local-sqlite") {
    throw new Error(
      "store-isolation: REFUSING TO RUN — this suite drives the real CLI, and the child process did " +
        "NOT resolve to the local SQLite store. Running it would write test fixtures into the SHARED " +
        "PRODUCTION store, where they are indistinguishable from real memories.\n" +
        `  backend     : ${report.backend}\n` +
        `  api_mode    : ${report.api_mode}\n` +
        `  selected_by : ${report.selected_by}\n` +
        `  storage_mode: ${report.storage_mode}\n` +
        `  db_path     : ${report.db_path}\n` +
        "A store-selecting env var reached the child that STORE_SELECTOR_ENV_KEYS does not cover. " +
        "Add it to src/test-support/store-isolation.ts (and export it from the resolver that reads it).",
    );
  }

  if (expectedDbPath && report.db_path !== expectedDbPath) {
    throw new Error(
      "store-isolation: REFUSING TO RUN — the child resolved a local store at an UNEXPECTED path, so " +
        "the scratch redirect did not survive the process boundary.\n" +
        `  expected: ${expectedDbPath}\n  actual  : ${report.db_path}`,
    );
  }

  return report;
}

/**
 * Assert the scratch SQLite file now exists on disk.
 *
 * This is the second half of the proof and it is not redundant with
 * {@link assertLocalStoreBackend}: the mode report says where the child INTENDS
 * to write, whereas this says a write actually landed there. The reported
 * incident's signature was precisely a correct-looking path with no file ever
 * created, so call this AFTER the suite's first write.
 */
export function assertScratchDbCreated(dbPath: string, context = "after the first write"): void {
  if (!existsSync(dbPath)) {
    throw new Error(
      `store-isolation: the scratch database ${dbPath} does not exist ${context}. The CLI reported ` +
        "success but wrote nothing here, which is the signature of a write that went to a different " +
        "store (see src/test-support/store-isolation.ts).",
    );
  }
}
