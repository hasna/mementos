// Regression tests: a half-configured API client must FAIL LOUDLY, never fall
// back to the local SQLite store.
//
// The contract this changes was DOCUMENTED AS INTENDED in src/db/api-mode.ts:
//
//   "- API mode is ON  when BOTH HASNA_MEMENTOS_API_URL and HASNA_MEMENTOS_API_KEY
//      are set ...
//    - API mode is OFF when either is missing (-> pure local SQLite, unchanged)."
//
// and was locked in by a passing test named "off when only one of URL/KEY is set".
// That is exactly how a defect survives review. The ruling (2026-07-30) is that the
// contract is wrong: a store that silently serves stale local data where a cloud
// store was expected is indistinguishable, from the caller's side, from a store
// that is working.
//
// Precedent: the same defect was measured in @hasna/conversations on 2026-07-30 —
// a half-configured client served 608 channels instead of 844, data frozen at
// 2026-07-18, at exit 0. And ~/.claude/rules/no-mcps.md records an `emails` MCP
// returning {"email": null} for a mailbox holding 170,609 messages because it had
// resolved to a local store holding 2.
//
// Explicit local use stays fully supported. The defect is the SILENT DOWNGRADE
// from an expected cloud store, not local storage itself.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  API_KEY_ENV_KEYS,
  API_URL_ENV_KEYS,
  DATABASE_URL_ENV_KEYS,
  DB_PATH_ENV_KEYS,
  getApiConfig,
  isApiMode,
  MementosStoreConfigError,
} from "./api-mode.js";
import { getDbPath } from "./database.js";

const URL_VAR = API_URL_ENV_KEYS[0];
const KEY_VAR = API_KEY_ENV_KEYS[0];
const DSN_VAR = DATABASE_URL_ENV_KEYS[0];
const DB_PATH_VAR = DB_PATH_ENV_KEYS[0];

// Enumerate the resolver's own key lists — never a hand-maintained copy, which
// silently stops covering the resolver the moment a key is added.
const STORE_VARS = [
  ...API_URL_ENV_KEYS,
  ...API_KEY_ENV_KEYS,
  ...DATABASE_URL_ENV_KEYS,
  ...DB_PATH_ENV_KEYS,
];

const API_URL = "https://mementos.hasna.xyz";
/** Not a credential: a deliberately invalid stub. */
const FAKE_KEY = ["mementos", "FAKE", "NOT", "A", "REAL", "KEY"].join("_");

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const v of STORE_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of STORE_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("api mode — a half-configured client refuses instead of reading local data", () => {
  test("API URL set + API key missing => throws naming the missing key variable", () => {
    process.env[URL_VAR] = API_URL;

    expect(() => isApiMode()).toThrow(MementosStoreConfigError);
    expect(() => isApiMode()).toThrow(new RegExp(KEY_VAR));
    expect(() => getApiConfig()).toThrow(MementosStoreConfigError);
  });

  test("API key set + API URL missing => throws naming the missing URL variable", () => {
    process.env[KEY_VAR] = FAKE_KEY;

    expect(() => isApiMode()).toThrow(MementosStoreConfigError);
    expect(() => isApiMode()).toThrow(new RegExp(URL_VAR));
  });

  test("the unprefixed aliases are held to the same rule", () => {
    process.env["MEMENTOS_API_URL"] = API_URL;

    expect(() => isApiMode()).toThrow(MementosStoreConfigError);
  });

  test("a mixed prefixed/unprefixed pair is a COMPLETE configuration, not a partial one", () => {
    process.env[URL_VAR] = API_URL;
    process.env["MEMENTOS_API_KEY"] = FAKE_KEY;

    expect(isApiMode()).toBe(true);
  });

  test("it must not answer false — the old contract — for a partial configuration", () => {
    process.env[URL_VAR] = API_URL;

    let answered: boolean | null = null;
    try {
      answered = isApiMode();
    } catch {
      /* expected */
    }
    expect(answered).not.toBe(false);
  });
});

describe("api mode — explicit and unambiguous configurations still work", () => {
  test("nothing configured => local, no error (the documented default)", () => {
    expect(isApiMode()).toBe(false);
    expect(getApiConfig()).toBeNull();
  });

  test("both API URL and key => API mode", () => {
    process.env[URL_VAR] = API_URL;
    process.env[KEY_VAR] = FAKE_KEY;

    expect(isApiMode()).toBe(true);
    expect(getApiConfig()?.baseUrl).toBe("https://mementos.hasna.xyz/v1");
  });

  test("an explicit local DB path selects local even with a stray API URL present", () => {
    // An explicit SQLite path is the narrowest, most specific signal — the same
    // precedence @hasna/conversations settled on. It keeps local dev, tooling and
    // import/export working when a partial credential is exported globally.
    process.env[DB_PATH_VAR] = "/tmp/mementos-no-silent-fallback.db";
    process.env[URL_VAR] = API_URL;

    expect(isApiMode()).toBe(false);
    expect(getApiConfig()).toBeNull();
  });

  // ==========================================================================
  // PRECEDENCE 1, THE FULLY-CONFIGURED CASE (2026-08-03).
  //
  // The test directly above passed for the WRONG REASON before this fix, and
  // that is why the defect survived a test suite that looks like it covers it:
  // with only a URL set, getApiConfig() returned null because the KEY was
  // missing, not because DB_PATH outranked anything. Remove the DB_PATH line and
  // it throws instead — so the assertion was sensitive to DB_PATH, but only via
  // the error suppression, never via a selection.
  //
  // Add the key and the old code routed to the cloud with the explicit local
  // path silently discarded: measured on installed 0.14.73 as a temp store that
  // was never created while reads and writes went to the shared 34MB fleet
  // store. These are the cases that pin the SELECTION.
  // ==========================================================================

  test("PRECEDENCE 1: an explicit local DB path outranks a COMPLETE API configuration", () => {
    process.env[DB_PATH_VAR] = "/tmp/mementos-precedence-1.db";
    process.env[URL_VAR] = API_URL;
    process.env[KEY_VAR] = FAKE_KEY;

    expect(isApiMode()).toBe(false);
    expect(getApiConfig()).toBeNull();
  });

  test("PRECEDENCE 1: the ALIAS db path key outranks it too", () => {
    // Both keys must select, or an operator using the documented alias gets the
    // opposite store from an operator using the primary one.
    process.env[DB_PATH_ENV_KEYS[1]] = "/tmp/mementos-precedence-1-alias.db";
    process.env[URL_VAR] = API_URL;
    process.env[KEY_VAR] = FAKE_KEY;

    expect(isApiMode()).toBe(false);
    expect(getApiConfig()).toBeNull();
  });

  test("PRECEDENCE 1: routing and the actual SQLite path choose the same nonempty alias", () => {
    process.env[URL_VAR] = API_URL;
    process.env[KEY_VAR] = FAKE_KEY;
    process.env[DB_PATH_ENV_KEYS[1]] = "/tmp/mementos-precedence-1-fallback.db";

    for (const ignoredPrimary of ["", "   "]) {
      process.env[DB_PATH_VAR] = ignoredPrimary;

      expect(isApiMode()).toBe(false);
      expect(getApiConfig()).toBeNull();
      expect(getDbPath()).toBe(process.env[DB_PATH_ENV_KEYS[1]]!);
    }
  });

  test("PRECEDENCE 1 does NOT fire on an empty or whitespace DB path", () => {
    // An over-eager guard here would be worse than the defect: a var left as ""
    // by a harness that blanks instead of deletes would silently divert a
    // correctly-configured cloud client to a local file. `firstEnvKey` trims,
    // and this pins that.
    process.env[URL_VAR] = API_URL;
    process.env[KEY_VAR] = FAKE_KEY;

    process.env[DB_PATH_VAR] = "";
    expect(isApiMode()).toBe(true);

    process.env[DB_PATH_VAR] = "   ";
    expect(isApiMode()).toBe(true);
  });

  test("UNCHANGED: a complete API configuration with NO db path still selects cloud", () => {
    // The must-not-change case. If this ever goes false, the guard has widened
    // past DB_PATH and every cloud client on the fleet has silently gone local.
    delete process.env[DB_PATH_VAR];
    delete process.env[DB_PATH_ENV_KEYS[1]];
    process.env[URL_VAR] = API_URL;
    process.env[KEY_VAR] = FAKE_KEY;

    expect(isApiMode()).toBe(true);
    expect(getApiConfig()?.baseUrl).toBe("https://mementos.hasna.xyz/v1");
  });

  test("UNCHANGED: a db path alone, with no API vars at all, is still plain local", () => {
    process.env[DB_PATH_VAR] = "/tmp/mementos-precedence-1-alone.db";

    expect(isApiMode()).toBe(false);
    expect(getApiConfig()).toBeNull();
  });

  test("a client DSN still disables API mode without throwing (unchanged)", () => {
    // Pre-existing behaviour, deliberately NOT changed here — see the separate
    // task filed for the DSN ambiguity. Locking it in so this fix cannot alter it.
    process.env[URL_VAR] = API_URL;
    process.env[KEY_VAR] = FAKE_KEY;
    process.env[DSN_VAR] = "postgres://x";

    expect(isApiMode()).toBe(false);
  });
});

describe("api mode — errors are actionable and leak nothing", () => {
  test("the error never contains the API key value", () => {
    process.env[KEY_VAR] = FAKE_KEY;

    let message = "";
    try {
      isApiMode();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(FAKE_KEY);
  });

  test("the error names the missing variable and the explicit-local escape hatch", () => {
    process.env[URL_VAR] = API_URL;

    let message = "";
    try {
      isApiMode();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(KEY_VAR);
    expect(message).toContain(URL_VAR);
  });
});
