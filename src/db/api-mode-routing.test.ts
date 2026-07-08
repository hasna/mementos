import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetDatabase } from "./database.js";
import { isApiMode } from "./api-mode.js";
import { getRelatedEntities } from "./relations.js";
import { listWebhookHooks } from "./webhook_hooks.js";
import { detectProject, resetProjectCache } from "../lib/project-detect.js";

// ============================================================================
// Regression: client paths that previously touched local SQLite directly must
// route through the cloud HTTP API in api mode instead of tripping the
// fail-closed getDatabase() split-brain guard.
//
//   - getRelatedEntities  (mementos entity show)         — was: split-brain crash
//   - detectProject       (MCP stdio startup)            — was: exit-1 crash
//   - listWebhookHooks    (MCP/HTTP loadWebhooksFromDb)  — was: noisy guard hit
//
// We point api mode at an unreachable local port so the HTTP transport fails
// fast; the ONLY thing under test is that the failure is a transport error, not
// the "tried to open a local SQLite database" split-brain guard.
// ============================================================================

const API_URL = "HASNA_MEMENTOS_API_URL";
const API_KEY = "HASNA_MEMENTOS_API_KEY";
const TIMEOUT = "HASNA_MEMENTOS_API_TIMEOUT";
const ALIASES = [
  API_URL,
  API_KEY,
  TIMEOUT,
  "HASNA_MEMENTOS_DATABASE_URL",
  "HASNA_MEMENTOS_STORAGE_MODE",
  "MEMENTOS_API_URL",
  "MEMENTOS_API_KEY",
  "MEMENTOS_DATABASE_URL",
  "MEMENTOS_STORAGE_MODE",
];

const SPLIT_BRAIN = /split-brain|open a local SQLite database/i;

function expectRoutesToApi(fn: () => unknown): void {
  // In api mode against an unreachable server the call must throw a transport
  // error — never the local-SQLite split-brain guard.
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect(String((thrown as Error)?.message ?? thrown)).not.toMatch(SPLIT_BRAIN);
}

describe("api-mode routing — no split-brain guard hit", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ALIASES) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetDatabase();
    resetProjectCache();
    // Unreachable port → fast connection refused.
    process.env[API_URL] = "http://127.0.0.1:1";
    process.env[API_KEY] = "sk-test";
    process.env[TIMEOUT] = "3";
  });

  afterEach(() => {
    for (const k of ALIASES) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetDatabase();
    resetProjectCache();
  });

  test("api mode is active for the fixture", () => {
    expect(isApiMode()).toBe(true);
  });

  test("getRelatedEntities routes to the API (no split-brain guard)", () => {
    expectRoutesToApi(() => getRelatedEntities("entity-123"));
  });

  test("listWebhookHooks routes to the API (no split-brain guard)", () => {
    expectRoutesToApi(() => listWebhookHooks({ enabled: true }));
  });

  test("detectProject routes to the API (no split-brain guard on stdio startup)", () => {
    // Repo root is a git repo, so a project is detected and the lookup/register
    // is attempted over HTTP rather than against a local SQLite island.
    expectRoutesToApi(() => detectProject());
  });
});
