// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { MEMORY_CATEGORIES } from "../types/index.js";

// ============================================================================
// Regression: an out-of-enum column value is a CLIENT error, not a 500.
//
// `mementos save <k> <v> --category decision` used to reach SQLite, trip the
// CHECK constraint on memories.category, and surface through the server's
// blanket catch as a bare `500 Internal server error` that named neither the
// field nor the accepted values. Callers read the 500 as "the memory service is
// down" and an incident was raised for a fleet-wide outage that did not exist.
//
// The failing inputs are driven for real here against a live server process.
// ============================================================================

const PORT = 19600 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;

let serverProc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  // The server under test is the LOCAL SQLite one. If the developer's shell has
  // cloud credentials exported, the child inherits them, api mode engages and
  // every request dies on the split-brain guard instead of reaching a route.
  // Strip them so this test measures the server, not the ambient environment.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(HASNA_)?MEMENTOS_(API_URL|API_KEY|DATABASE_URL|STORAGE_MODE)$/.test(k)) continue;
    childEnv[k] = v;
  }
  childEnv["MEMENTOS_DB_PATH"] = ":memory:";

  serverProc = Bun.spawn(["bun", "run", "src/server/index.ts", "--port", String(PORT)], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    cwd: new URL("../../", import.meta.url).pathname.replace(/\/$/, ""),
  });
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not ready yet */
    }
    await Bun.sleep(200);
  }
  if (!ready) throw new Error("Server failed to start");
});

afterAll(() => {
  serverProc.kill();
});

async function post(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

describe("memories enum validation — client errors are 400, never 500", () => {
  test("FAILING INPUT: --category decision is rejected 400, naming field and allowed set", async () => {
    const { status, data } = await post("/api/memories", {
      key: "enum-test-decision",
      value: "v",
      category: "decision",
    });
    expect(status).toBe(400);
    expect(status).not.toBe(500);
    expect(String(data.error)).toContain("decision");
    expect(String(data.error)).toContain("category");
    // The accepted values must be in the response — that is what makes it actionable.
    for (const c of MEMORY_CATEGORIES) expect(String(data.error)).toContain(c);
    expect(data.details?.field).toBe("category");
  });

  test.each(["pattern", "context", "task", "insight", "lesson", "error", "convention", "rule"])(
    "FAILING INPUT: category %s is 400, not 500",
    async (category) => {
      const { status } = await post("/api/memories", { key: `enum-${category}`, value: "v", category });
      expect(status).toBe(400);
    },
  );

  test("FAILING INPUT: an out-of-enum scope is 400, not 500", async () => {
    const { status, data } = await post("/api/memories", {
      key: "enum-scope",
      value: "v",
      scope: "public",
    });
    expect(status).toBe(400);
    expect(data.details?.field).toBe("scope");
  });

  test("FAILING INPUT: an out-of-enum source is 400, not 500", async () => {
    const { status, data } = await post("/api/memories", {
      key: "enum-source",
      value: "v",
      source: "robot",
    });
    expect(status).toBe(400);
    expect(data.details?.field).toBe("source");
  });

  test("PATCH with an out-of-enum category is 400, not 500", async () => {
    const created = await post("/api/memories", { key: "enum-patch", value: "v" });
    expect(created.status).toBe(201);
    const res = await fetch(`${BASE}/api/memories/${created.data.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "decision" }),
    });
    expect(res.status).toBe(400);
  });

  test.each(MEMORY_CATEGORIES)("every canonical category still persists: %s", async (category) => {
    const { status, data } = await post("/api/memories", {
      key: `enum-ok-${category}`,
      value: "v",
      category,
    });
    expect(status).toBe(201);
    expect(data.category).toBe(category);
    // Read it back — a 201 alone does not prove the row is durable.
    const read = await fetch(`${BASE}/api/memories/${data.id}`);
    expect(read.status).toBe(200);
    expect((await read.json()).category).toBe(category);
  });
});
