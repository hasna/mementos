import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cloudStoreFor, isCloudMode, resetCloudConfigCache, resolveCloudConfig } from "./cloud-store.js";

const KEYS = [
  "HASNA_MEMENTOS_STORAGE_MODE",
  "HASNA_MEMENTOS_MODE",
  "MEMENTOS_STORAGE_MODE",
  "MEMENTOS_MODE",
  "HASNA_MEMENTOS_API_URL",
  "MEMENTOS_API_URL",
  "HASNA_MEMENTOS_API_KEY",
  "MEMENTOS_API_KEY",
];

function clearEnv(): void {
  for (const k of KEYS) delete process.env[k];
  resetCloudConfigCache();
}

describe("cloud-store resolver (client flip)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test("unset env => local (null)", () => {
    expect(resolveCloudConfig()).toBeNull();
    expect(isCloudMode()).toBe(false);
    expect(cloudStoreFor("memories")).toBeNull();
  });

  test("mode=local => local even with url+key set", () => {
    process.env.HASNA_MEMENTOS_STORAGE_MODE = "local";
    process.env.HASNA_MEMENTOS_API_URL = "https://mementos.hasna.xyz";
    process.env.HASNA_MEMENTOS_API_KEY = "hasna_test_key";
    resetCloudConfigCache();
    expect(resolveCloudConfig()).toBeNull();
    expect(isCloudMode()).toBe(false);
  });

  test("mode=self_hosted + url + key => cloud-http with /v1 base", () => {
    process.env.HASNA_MEMENTOS_STORAGE_MODE = "self_hosted";
    process.env.HASNA_MEMENTOS_API_URL = "https://mementos.hasna.xyz";
    process.env.HASNA_MEMENTOS_API_KEY = "hasna_test_key";
    resetCloudConfigCache();
    const cfg = resolveCloudConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe("https://mementos.hasna.xyz/v1");
    expect(isCloudMode()).toBe(true);
    const store = cloudStoreFor("memories");
    expect(store).not.toBeNull();
    expect(store!.baseUrl).toBe("https://mementos.hasna.xyz/v1");
  });

  test("mode=cloud alias also flips", () => {
    process.env.MEMENTOS_MODE = "cloud";
    process.env.MEMENTOS_API_URL = "https://mementos.hasna.xyz/v1"; // already /v1
    process.env.MEMENTOS_API_KEY = "hasna_test_key";
    resetCloudConfigCache();
    const cfg = resolveCloudConfig();
    expect(cfg!.baseUrl).toBe("https://mementos.hasna.xyz/v1"); // not doubled
  });

  test("cloud requested but no key => throws (fail-closed, no silent local drift)", () => {
    process.env.HASNA_MEMENTOS_STORAGE_MODE = "self_hosted";
    process.env.HASNA_MEMENTOS_API_URL = "https://mementos.hasna.xyz";
    resetCloudConfigCache();
    expect(() => resolveCloudConfig()).toThrow(/API key/);
  });

  test("cloud requested but no url => throws", () => {
    process.env.HASNA_MEMENTOS_STORAGE_MODE = "cloud";
    process.env.HASNA_MEMENTOS_API_KEY = "hasna_test_key";
    resetCloudConfigCache();
    expect(() => resolveCloudConfig()).toThrow(/API URL/);
  });

  test("resolver never exposes the key value in its result", () => {
    process.env.HASNA_MEMENTOS_STORAGE_MODE = "self_hosted";
    process.env.HASNA_MEMENTOS_API_URL = "https://mementos.hasna.xyz";
    process.env.HASNA_MEMENTOS_API_KEY = "hasna_super_secret_value";
    resetCloudConfigCache();
    const store = cloudStoreFor("memories");
    expect(JSON.stringify({ baseUrl: store!.baseUrl, resource: store!.resource })).not.toContain(
      "hasna_super_secret_value",
    );
  });
});
