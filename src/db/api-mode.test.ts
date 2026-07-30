import { afterEach, describe, expect, test } from "bun:test";
import {
  API_KEY_ENV_KEYS,
  API_URL_ENV_KEYS,
  DATABASE_URL_ENV_KEYS,
  DB_PATH_ENV_KEYS,
  getApiConfig,
  isApiMode,
  toQuery,
} from "./api-mode.js";

const SAVED = { ...process.env };

// Enumerate the resolver's OWN key lists rather than restating them. A
// hand-maintained copy silently stops covering the resolver the moment a key is
// added — which is exactly what happened here: this helper predated
// DB_PATH_ENV_KEYS, so a sibling test file that exports HASNA_MEMENTOS_DB_PATH
// (to keep the suite off the live store) left it set and suppressed the store
// guard under a full-directory run while passing in isolation.
function clearEnv(): void {
  for (const k of [
    ...API_URL_ENV_KEYS,
    ...API_KEY_ENV_KEYS,
    ...DATABASE_URL_ENV_KEYS,
    ...DB_PATH_ENV_KEYS,
  ]) {
    delete process.env[k];
  }
}

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

describe("api-mode", () => {
  test("off by default (no env)", () => {
    clearEnv();
    expect(isApiMode()).toBe(false);
    expect(getApiConfig()).toBeNull();
  });

  test("on when API_URL + API_KEY present; normalizes /v1 prefix", () => {
    clearEnv();
    process.env["HASNA_MEMENTOS_API_URL"] = "https://mementos.hasna.xyz";
    process.env["HASNA_MEMENTOS_API_KEY"] = "sk-test";
    expect(isApiMode()).toBe(true);
    expect(getApiConfig()?.baseUrl).toBe("https://mementos.hasna.xyz/v1");
  });

  test("keeps an explicit /v1 or /api suffix as-is; strips trailing slash", () => {
    clearEnv();
    process.env["HASNA_MEMENTOS_API_KEY"] = "k";
    process.env["HASNA_MEMENTOS_API_URL"] = "https://mementos.hasna.xyz/v1/";
    expect(getApiConfig()?.baseUrl).toBe("https://mementos.hasna.xyz/v1");
    process.env["HASNA_MEMENTOS_API_URL"] = "https://mementos.hasna.xyz/api";
    expect(getApiConfig()?.baseUrl).toBe("https://mementos.hasna.xyz/api");
  });

  test("fail-closed: refuses to engage when a client DSN is present", () => {
    clearEnv();
    process.env["HASNA_MEMENTOS_API_URL"] = "https://mementos.hasna.xyz";
    process.env["HASNA_MEMENTOS_API_KEY"] = "k";
    process.env["HASNA_MEMENTOS_DATABASE_URL"] = "postgres://x";
    expect(isApiMode()).toBe(false);
  });

  // CONTRACT CHANGE (2026-07-30). This test previously asserted that a half
  // configured client is "off", i.e. silently reads the local SQLite store. That
  // was the defect, codified as a passing test: a store serving stale local data
  // where a cloud store was expected is indistinguishable, from the caller's
  // side, from a store that is working. It now refuses and names what is missing.
  // Full rationale and precedence table: assertUnambiguousStoreEnv in api-mode.ts.
  test("refuses — does not silently go local — when only one of URL/KEY is set", () => {
    clearEnv();
    process.env["HASNA_MEMENTOS_API_URL"] = "https://mementos.hasna.xyz";
    expect(() => isApiMode()).toThrow(/HASNA_MEMENTOS_API_KEY/);
    clearEnv();
    process.env["HASNA_MEMENTOS_API_KEY"] = "k";
    expect(() => isApiMode()).toThrow(/HASNA_MEMENTOS_API_URL/);
  });

  test("toQuery skips empties, joins arrays, encodes booleans", () => {
    expect(toQuery({ a: 1, b: undefined, c: null, d: "", e: [1, 2], f: true, g: false })).toBe(
      "?a=1&e=1%2C2&f=true&g=false",
    );
    expect(toQuery({})).toBe("");
  });
});
