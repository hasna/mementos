import { afterEach, describe, expect, test } from "bun:test";
import { getApiConfig, isApiMode, toQuery } from "./api-mode.js";

const SAVED = { ...process.env };

function clearEnv(): void {
  for (const k of [
    "HASNA_MEMENTOS_API_URL",
    "MEMENTOS_API_URL",
    "HASNA_MEMENTOS_API_KEY",
    "MEMENTOS_API_KEY",
    "HASNA_MEMENTOS_DATABASE_URL",
    "MEMENTOS_DATABASE_URL",
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

  test("off when only one of URL/KEY is set", () => {
    clearEnv();
    process.env["HASNA_MEMENTOS_API_URL"] = "https://mementos.hasna.xyz";
    expect(isApiMode()).toBe(false);
    clearEnv();
    process.env["HASNA_MEMENTOS_API_KEY"] = "k";
    expect(isApiMode()).toBe(false);
  });

  test("toQuery skips empties, joins arrays, encodes booleans", () => {
    expect(toQuery({ a: 1, b: undefined, c: null, d: "", e: [1, 2], f: true, g: false })).toBe(
      "?a=1&e=1%2C2&f=true&g=false",
    );
    expect(toQuery({})).toBe("");
  });
});
