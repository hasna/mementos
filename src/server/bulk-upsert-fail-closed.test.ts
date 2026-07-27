// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// ============================================================================
// Regression: POST /api/memories/bulk-upsert answered 201 for a batch whose
// rows never landed.
//
// The route is "the cross-machine -> cloud backfill path for the fleet
// self-host cutover". `INSERT OR IGNORE` swallowed the category CHECK, the
// dropped row was counted as `skipped` (the same bucket as an idempotent
// no-op), `errors` came back empty and the status was 201 — so a restore lost
// rows silently and the operator had nothing to act on.
//
// Driven for real against a live server process: the response is asserted, and
// then the store is read back, because a status code alone does not prove what
// is in the table.
// ============================================================================

const PORT = 19700 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;

let serverProc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  // The server under test is the LOCAL SQLite one. Cloud credentials inherited
  // from the developer's shell would engage api mode and every request would
  // die on the split-brain guard instead of reaching a route.
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

async function bulkUpsert(
  memories: unknown[]
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}/api/memories/bulk-upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memories }),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function keysFor(key: string): Promise<number> {
  const res = await fetch(`${BASE}/api/memories?key=${encodeURIComponent(key)}`);
  const body = (await res.json()) as { count: number };
  return body.count;
}

describe("POST /api/memories/bulk-upsert fails closed on rows that do not persist", () => {
  test("FAILING INPUT: a bad category is not reported as a successful backfill", async () => {
    const { status, data } = await bulkUpsert([
      { key: "bulk-b1", value: "ok", category: "fact" },
      { key: "bulk-b2", value: "bad", category: "decision" },
    ]);

    // A write that dropped a row must not answer 2xx.
    expect(status).not.toBe(201);
    expect(status).toBe(400);
    expect(data.inserted).toBe(1);
    expect(data.rejected).toBe(1);
    // The dropped row must not be filed as an idempotent no-op.
    expect(data.skipped).toBe(0);
    expect(data.errors.length).toBe(1);
    expect(String(data.errors[0])).toContain("bulk-b2");
    expect(String(data.errors[0])).toContain("category");
    expect(String(data.error)).toContain("did not persist");

    // Read back: the report has to match the store.
    expect(await keysFor("bulk-b1")).toBe(1);
    expect(await keysFor("bulk-b2")).toBe(0);
  });

  test("a clean batch is still 201 with no errors", async () => {
    const { status, data } = await bulkUpsert([
      { id: "bulk-ok-1", key: "bulk-ok-1", value: "v", category: "knowledge" },
      { id: "bulk-ok-2", key: "bulk-ok-2", value: "v", category: "fact" },
    ]);
    expect(status).toBe(201);
    expect(data).toMatchObject({ inserted: 2, skipped: 0, rejected: 0, total: 2 });
    expect(data.errors).toEqual([]);
    expect(await keysFor("bulk-ok-1")).toBe(1);
  });

  test("a re-run of the same payload is an idempotent 201 with skipped rows", async () => {
    const rows = [
      { id: "bulk-idem", key: "bulk-idem", value: "v", category: "fact" },
    ];
    expect((await bulkUpsert(rows)).status).toBe(201);
    const { status, data } = await bulkUpsert(rows);
    expect(status).toBe(201);
    expect(data).toMatchObject({ inserted: 0, skipped: 1, rejected: 0 });
    expect(await keysFor("bulk-idem")).toBe(1);
  });
});
