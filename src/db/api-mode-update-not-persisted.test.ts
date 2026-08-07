import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DB_PATH_ENV_KEYS } from "./api-mode.js";
import { resetDatabase } from "./database.js";
import { updateMemory } from "./memories.js";
import { updateProject } from "./projects.js";

// ============================================================================
// Regression: an api-mode update that the server did not persist must fail
// loudly. Task 3982e7e0.
//
// The client used to return whatever the PATCH answered with, so a server that
// replied 200 with the untouched row produced a success receipt naming the
// field it had not written. Three seats independently lost state to this in one
// night, and none could have detected it without reading the row back.
//
// The check lives on the CLIENT deliberately. The underlying cause was fixed in
// the SQL path too, but a client always talks to whatever image is deployed —
// so this is what protects an operator running against a server that has not
// been redeployed yet. `version` is the discriminator because every update
// bumps it, which makes the probe independent of which field was being set.
//
// The positive control matters as much as the failing case: a stub that moved
// the version on must still be accepted, or the guard would be indistinguishable
// from one that simply refuses all updates.
// ============================================================================

const API_URL = "HASNA_MEMENTOS_API_URL";
const API_KEY = "HASNA_MEMENTOS_API_KEY";
const ENV_KEYS = [
  API_URL,
  API_KEY,
  ...DB_PATH_ENV_KEYS,
  "HASNA_MEMENTOS_API_TIMEOUT",
  "HASNA_MEMENTOS_DATABASE_URL",
  "HASNA_MEMENTOS_STORAGE_MODE",
  "MEMENTOS_API_URL",
  "MEMENTOS_API_KEY",
  "MEMENTOS_DATABASE_URL",
  "MEMENTOS_STORAGE_MODE",
];

let stub: ReturnType<typeof Bun.spawn>;
let stubPort = 0;

function baseFor(mode: string): string {
  return `http://127.0.0.1:${stubPort}/${mode}`;
}

beforeAll(async () => {
  // Separate process on purpose — the api-mode transport is a blocking
  // spawnSync(curl), so an in-process server can never answer.
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

describe("api-mode update must not report a write it did not make", () => {
  test("FAILING INPUT: a 200 whose version did not move is a failed write, not a success", () => {
    process.env[API_URL] = baseFor("stale-patch");
    let thrown: unknown;
    try {
      updateMemory("mem-1", { version: 1, value: "REPLACEMENT" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toMatch(/did not persist/i);
  });

  test("the error says the data was NOT written, so it cannot be read as a warning", () => {
    process.env[API_URL] = baseFor("stale-patch");
    let message = "";
    try {
      updateMemory("mem-1", { version: 1, value: "REPLACEMENT" });
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toMatch(/NOT written/);
  });

  test("POSITIVE CONTROL: a server that did move the version is accepted", () => {
    process.env[API_URL] = baseFor("fresh-patch");
    const updated = updateMemory("mem-1", { version: 1, value: "REPLACEMENT" });
    expect(updated.version).toBe(2);
    expect(updated.value).toBe("REPLACEMENT");
  });
});

describe("api-mode project updates preserve the exact stable ID", () => {
  test("POSITIVE CONTROL: requested fields persisted under the exact ID are accepted", () => {
    process.env[API_URL] = baseFor("project-updated");
    const updated = updateProject("project-1", {
      name: "  Dubai Fraud  ",
      path: "  /home/hasna/.hasna/projects/workspaces/wks-dubai-fraud  ",
      memory_prefix: "dubai_fraud",
    });
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe("project-1");
    expect(updated!.name).toBe("Dubai Fraud");
    expect(updated!.path).toBe(
      "/home/hasna/.hasna/projects/workspaces/wks-dubai-fraud"
    );
  });

  test("a 200 response with stale project fields fails closed", () => {
    process.env[API_URL] = baseFor("project-stale");
    expect(() =>
      updateProject("project-1", {
        name: "Dubai Fraud",
        path: "/home/hasna/.hasna/projects/workspaces/wks-dubai-fraud",
      })
    ).toThrow(/did not persist/i);
  });

  test("a 200 response with a different project ID fails closed", () => {
    process.env[API_URL] = baseFor("project-wrong-id");
    expect(() => updateProject("project-1", { name: "Dubai Fraud" })).toThrow(
      /different stable ID/i
    );
  });

  test("a missing exact project ID returns null", () => {
    process.env[API_URL] = baseFor("not-found");
    expect(updateProject("missing-project", { name: "Dubai Fraud" })).toBeNull();
  });
});
