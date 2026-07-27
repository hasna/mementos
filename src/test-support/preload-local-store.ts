// ============================================================================
// `bun test` preload — no test process may reach the shared cloud store.
//
// Wired up in bunfig.toml (`[test] preload`), so this runs once per test process
// BEFORE any test module is imported.
//
// Per-harness isolation (src/test-support/store-isolation.ts) fixes the harnesses
// that remember to use it. This closes the class, for two reasons the harness fix
// cannot reach on its own:
//
//   1. IN-PROCESS writes. The domain layer routes by mode, not by harness:
//      `src/db/memories.ts:113` is `if (!db && isApiMode())` → HTTP. So any test
//      that calls `createMemory(...)` without an explicit `db` handle writes to
//      the shared cloud store, with no subprocess and no env spread involved.
//      Roughly every domain test is shaped that way.
//   2. INHERITED envs. Children spawned with `{ ...process.env }` inherit what
//      this file has already cleaned, so even a harness that never adopts the
//      helper is safe under `bun test`.
//
// It deletes the selectors rather than setting a mode, because presence is what
// selects the transport (see src/db/api-mode.ts). It deliberately does NOT pin a
// database path: several suites assert the resolved default path
// (src/db/database.test.ts, src/lib/config-extra.test.ts), and overriding it here
// would break them. Suites that must not touch the on-disk local store still set
// `MEMENTOS_DB_PATH` themselves — anything set after this file runs still wins,
// which is also what lets the deliberate API-mode suites
// (src/db/api-mode.test.ts, src/cli/clean-legacy-fallback.test.ts) configure a
// stub endpoint normally.
//
// If a selector somehow survives, this THROWS and takes the whole test process
// down. A red run is the correct outcome: the alternative is a green run that
// quietly wrote test fixtures into the memory layer other agents read.
// ============================================================================

import { getApiModeEnvSources, isApiMode } from "../db/api-mode.js";
import { STORE_SELECTOR_ENV_KEYS } from "./store-isolation.js";

const removed: string[] = [];
for (const key of STORE_SELECTOR_ENV_KEYS) {
  if (process.env[key] !== undefined) {
    removed.push(key);
    delete process.env[key];
  }
}

if (isApiMode()) {
  const sources = getApiModeEnvSources();
  throw new Error(
    "test preload: REFUSING TO RUN THE TEST SUITE — this process still resolves to the cloud API " +
      "store after clearing every known store selector, so writes would land in the SHARED " +
      "PRODUCTION memory store.\n" +
      `  api url from : ${sources.urlKey}\n` +
      `  api key from : ${sources.keyKey}\n` +
      `  cleared      : ${removed.join(", ") || "(nothing)"}\n` +
      "A new store selector exists that STORE_SELECTOR_ENV_KEYS does not cover. Export it from the " +
      "resolver that reads it and add it there (src/test-support/store-isolation.ts).",
  );
}

// Opt-in trace. Silent by default: with `bun test --isolate` this file runs once
// per test file, so announcing unconditionally would bury the actual results.
if (process.env["MEMENTOS_TEST_VERBOSE_ISOLATION"] && removed.length > 0) {
  console.error(`[test preload] cleared store selectors: ${removed.join(", ")}`);
}
