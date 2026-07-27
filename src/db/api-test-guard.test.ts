// ============================================================================
// The store guard must hold at the REQUEST boundary, not only at process start.
//
// The `bun test` preload (src/test-support/preload-local-store.ts) clears the
// store selectors once, when the test process starts. That is necessary but it
// is a ONE-SHOT, and two measured gaps get past it:
//
//   1. MODULE SCOPE. The preload runs BEFORE any test module is imported, so a
//      test file that assigns `process.env.HASNA_MEMENTOS_API_URL` at module
//      scope re-arms API mode afterwards. `isApiMode()` is then true, an
//      unpinned `createMemory()` routes to HTTP, and the run stays GREEN. The
//      repo sweep cannot see it either: there is no `Bun.spawn` and no
//      `...process.env` spread to match on.
//   2. CWD. `bunfig.toml` is resolved relative to the current directory and bun
//      does not walk up, so `cd src/db && bun test <file>` runs with NO preload
//      at all — full ambient production credentials, silently.
//
// Both funnel into one place: an outbound cloud request. So the guard belongs
// there. Checking at request time is immune to when the selectors were set, to
// which directory bun was invoked from, and to the preload existing at all.
//
// Loopback is allowed because the suites that deliberately exercise API mode
// drive a local stub server (src/cli/clean-legacy-fallback.test.ts). Only a
// NON-loopback host is refused, since that is the only shape that can reach the
// shared production store.
// ============================================================================

import { describe, test, expect, afterEach } from "bun:test";
import { ALLOW_REMOTE_API_IN_TESTS_ENV, apiJson } from "./api-mode.js";

const URL_KEY = "HASNA_MEMENTOS_API_URL";
const KEY_KEY = "HASNA_MEMENTOS_API_KEY";

/** RFC 5737 TEST-NET-1 — routable-looking, guaranteed not to be a real service. */
const NON_LOOPBACK_URL = "http://192.0.2.1";
const LOOPBACK_URL = "http://127.0.0.1:1";

afterEach(() => {
  delete process.env[URL_KEY];
  delete process.env[KEY_KEY];
  delete process.env[ALLOW_REMOTE_API_IN_TESTS_ENV];
  delete process.env["HASNA_MEMENTOS_API_TIMEOUT"];
});

describe("api request guard under test", () => {
  test("bun test really does set NODE_ENV=test (the guard's premise)", () => {
    // If this ever stops holding, every assertion below would pass vacuously.
    expect(process.env["NODE_ENV"]).toBe("test");
  });

  test("REFUSES a non-loopback cloud request from a test process", () => {
    process.env[URL_KEY] = NON_LOOPBACK_URL;
    process.env[KEY_KEY] = "not-a-real-key";
    expect(() => apiJson("POST", "/memories", { key: "guard.probe", content: "x" })).toThrow(
      /REFUSING/,
    );
  });

  test("the refusal names the host and the override, and never the key", () => {
    process.env[URL_KEY] = NON_LOOPBACK_URL;
    process.env[KEY_KEY] = "super-secret-value";
    let message = "";
    try {
      apiJson("GET", "/memories");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("192.0.2.1");
    expect(message).toContain(ALLOW_REMOTE_API_IN_TESTS_ENV);
    expect(message).not.toContain("super-secret-value");
  });

  test("this guard defeats a MODULE-SCOPE re-arm, which the preload cannot", () => {
    // Exactly the bypass measured in review: set the selectors long after the
    // preload has finished. The preload's clear+abort is over; the request-time
    // check still holds.
    process.env[URL_KEY] = NON_LOOPBACK_URL;
    process.env[KEY_KEY] = "not-a-real-key";
    expect(() => apiJson("POST", "/memories", { key: "k", content: "c" })).toThrow(/REFUSING/);
  });

  test("ALLOWS loopback, so the deliberate stub-server suites still work", () => {
    process.env[URL_KEY] = LOOPBACK_URL;
    process.env[KEY_KEY] = "stub-key-not-a-secret";
    // Nothing listens on port 1, so this must fail as a TRANSPORT error — the
    // point is that it is not the guard's refusal.
    let message = "";
    try {
      apiJson("GET", "/memories");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("REFUSING");
    expect(message).toMatch(/mementos cloud request failed|curl/i);
  });

  test("an explicit opt-in re-enables a non-loopback request", () => {
    process.env[URL_KEY] = NON_LOOPBACK_URL;
    process.env[KEY_KEY] = "not-a-real-key";
    process.env[ALLOW_REMOTE_API_IN_TESTS_ENV] = "1";
    // TEST-NET-1 blackholes rather than refusing, so cap the wait: the assertion
    // is about WHICH error comes back, not how long the socket takes to give up.
    process.env["HASNA_MEMENTOS_API_TIMEOUT"] = "2";
    let message = "";
    try {
      apiJson("GET", "/memories");
    } catch (e) {
      message = (e as Error).message;
    }
    // Guard bypassed: we get a transport failure instead of a refusal.
    expect(message).not.toContain("REFUSING");
  });
});
