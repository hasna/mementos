import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resetDatabase } from "./database.js";
import { apiJson, ApiRequestError } from "./api-mode.js";
import { createMemory } from "./memories.js";

// ============================================================================
// Regression: a cloud WRITE that did not persist must fail loudly.
//
// apiJson() used to return a success-shaped `{status: 404, data: undefined}`
// for every 404, and createMemory() destructured only `data`. A POST /memories
// that 404'd — client/server version skew, a route the deployment does not
// have, a wrong base URL — therefore returned `undefined` as the created
// Memory, and the CLI printed "Saved:" and exited 0 having written nothing.
//
// These tests drive the failing inputs directly: a server that 404s every
// write, and a server that answers 2xx with an empty body. Both must throw.
// The happy path is asserted too, but only to prove the fail-closed change did
// not simply break writing.
// ============================================================================

const API_URL = "HASNA_MEMENTOS_API_URL";
const API_KEY = "HASNA_MEMENTOS_API_KEY";
const ENV_KEYS = [
  API_URL,
  API_KEY,
  "HASNA_MEMENTOS_API_TIMEOUT",
  "HASNA_MEMENTOS_DATABASE_URL",
  "HASNA_MEMENTOS_STORAGE_MODE",
  "MEMENTOS_API_URL",
  "MEMENTOS_API_KEY",
  "MEMENTOS_DATABASE_URL",
  "MEMENTOS_STORAGE_MODE",
];

/** Behaviour is chosen per-test by pointing the client at a mode path segment. */
type Mode = "not-found" | "empty-2xx" | "created";

let stub: ReturnType<typeof Bun.spawn>;
let stubPort = 0;

/** Base URL that makes the stub answer with `mode`. */
function baseFor(mode: Mode): string {
  return `http://127.0.0.1:${stubPort}/${mode}`;
}

beforeAll(async () => {
  // Separate process on purpose — see the fixture header.
  stub = Bun.spawn(["bun", "run", `${import.meta.dir}/__fixtures__/fail-closed-stub-server.ts`], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = stub.stdout.getReader();
  const deadline = Date.now() + 10_000;
  let buffered = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += new TextDecoder().decode(value);
    const match = buffered.match(/READY (\d+)/);
    if (match) {
      stubPort = Number(match[1]);
      break;
    }
  }
  reader.releaseLock();
  if (!stubPort) throw new Error(`stub server did not start: ${buffered}`);
});

afterAll(() => {
  stub?.kill();
});

describe("api-mode fail-closed writes", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env[API_KEY] = "test-key-not-a-secret";
    resetDatabase();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    resetDatabase();
  });

  test("FAILING INPUT: a 404 on a write throws instead of returning success-shaped data", () => {
    process.env[API_URL] = baseFor("not-found");
    expect(() => apiJson("POST", "/memories", { key: "k", value: "v" })).toThrow(ApiRequestError);
  });

  test("FAILING INPUT: createMemory throws — it must never return undefined as a Memory", () => {
    process.env[API_URL] = baseFor("not-found");
    let thrown: unknown;
    try {
      createMemory({ key: "lost-write", value: "must not be silently dropped" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiRequestError);
    expect((thrown as ApiRequestError).status).toBe(404);
  });

  test("FAILING INPUT: a 2xx with an empty body is a failed write, not a success", () => {
    process.env[API_URL] = baseFor("empty-2xx");
    let thrown: unknown;
    try {
      createMemory({ key: "empty-body", value: "nothing persisted" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiRequestError);
    expect(String((thrown as Error).message)).toMatch(/did not persist/i);
  });

  test("allow404 is still honoured where absent is a real answer (reads)", () => {
    process.env[API_URL] = baseFor("not-found");
    const { status, data } = apiJson("GET", "/memories/does-not-exist", undefined, {
      allow404: true,
    });
    expect(status).toBe(404);
    expect(data).toBeUndefined();
  });

  test("happy path still writes and returns the stored row", () => {
    process.env[API_URL] = baseFor("created");
    const memory = createMemory({ key: "k", value: "v" });
    expect(memory.id).toBe("mem-1");
  });
});
