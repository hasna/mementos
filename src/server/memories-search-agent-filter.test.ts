// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// ============================================================================
// Regression: POST /api/memories/search must APPLY agent_id and project_id.
//
// THE DEFECT. The handler for `/api/memories/search` built its MemoryFilter
// from scope, category, tags, session_id, namespace and limit — and never read
// `agent_id` or `project_id` off the request body. Its three siblings in the
// same file (`/search/semantic`, `/search/hybrid`, `/search/bm25`) all read
// both, so this was a dropped field rather than a deliberate omission.
//
// The client was never at fault: `searchBody()` in src/lib/search.ts puts
// agent_id and project_id on the wire, and `searchMemories()` posts that body
// in API mode. The server threw them away on arrival.
//
// WHY THIS DIRECTION IS THE DANGEROUS ONE. An unresolvable filter that NARROWS
// returns zero rows — useless, but visibly so. A filter that is INERT WIDENS:
// `mementos search <q> --agent me` returned every agent's memories, byte-
// identical to no filter at all (measured on the fleet: 2,623 rows across 52
// distinct owners for a single-agent query). A full result set looks exactly
// like a working search, so nothing in the output announces the failure.
//
// Reached through this route in API mode: `mementos search`, `mementos recall
// --fuzzy`, `mementos context`, and the MCP `memory_search` / key-lookup tools.
//
// HOW THIS SUITE AVOIDS PROVING NOTHING. 84.7% of production rows carry a NULL
// agent_id, so a correct filter legitimately returns near-zero for most agents,
// and a test that only asserted "few rows come back" would pass just as well
// against a filter that matched nothing at all. So every narrowing assertion is
// paired with an unfiltered control in the same store proving the query matches
// rows owned by MORE THAN ONE agent. The narrow result is meaningful only
// against that wider one.
//
// Driven for real against a live server process on a :memory: database — this
// suite never touches the shared production store.
// ============================================================================

const PORT = 19700 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;

// A token unique to this suite, so the corpus under test cannot be widened by
// anything else that happens to live in the database.
const TOKEN = "zeugma";

let serverProc: ReturnType<typeof Bun.spawn>;
let alphaId: string;
let betaId: string;

beforeAll(async () => {
  // The server under test is the LOCAL SQLite one. If the operator's shell has
  // cloud credentials exported the child inherits them, api mode engages, and
  // this suite would drive the real store. Strip them.
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

  // Two owners. memories.agent_id carries a FK to agents(id), so these must be
  // real rows rather than invented strings.
  const alpha = await post("/api/agents", { name: `${TOKEN}-alpha` });
  const beta = await post("/api/agents", { name: `${TOKEN}-beta` });
  alphaId = alpha.data.id as string;
  betaId = beta.data.id as string;
  if (!alphaId || !betaId) throw new Error("agent fixture setup failed");

  // Two memories per owner, all matching TOKEN.
  await post("/api/memories", { key: `${TOKEN}-a1`, value: `${TOKEN} alpha one`, agent_id: alphaId, scope: "shared" });
  await post("/api/memories", { key: `${TOKEN}-a2`, value: `${TOKEN} alpha two`, agent_id: alphaId, scope: "shared" });
  await post("/api/memories", { key: `${TOKEN}-b1`, value: `${TOKEN} beta one`, agent_id: betaId, scope: "shared" });
  await post("/api/memories", { key: `${TOKEN}-b2`, value: `${TOKEN} beta two`, agent_id: betaId, scope: "shared" });
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

/** Owners of the memories in a search response. A result row nests the memory. */
function ownersOf(data: any): string[] {
  return (data.results as any[]).map((r) => r.memory.agent_id as string);
}

describe("POST /api/memories/search — agent_id and project_id are applied, not dropped", () => {
  // ------------------------------------------------------------------ control
  // Runs first and is load-bearing: it establishes that the query matches rows
  // owned by BOTH agents. Without it, every "only alpha's rows came back"
  // assertion below would also pass against a filter that matched nothing, and
  // against a store that only ever held alpha's rows.
  test("CONTROL: unfiltered, the query matches rows from BOTH owners", async () => {
    const { status, data } = await post("/api/memories/search", { query: TOKEN });
    expect(status).toBe(200);

    const owners = new Set(ownersOf(data));
    expect(owners.has(alphaId)).toBe(true);
    expect(owners.has(betaId)).toBe(true);
    expect(owners.size).toBe(2);
    expect(data.results.length).toBe(4);
  });

  // ------------------------------------------------------------- the defect
  test("a real agent_id NARROWS to that agent's rows only", async () => {
    const { status, data } = await post("/api/memories/search", {
      query: TOKEN,
      agent_id: alphaId,
    });
    expect(status).toBe(200);

    const owners = ownersOf(data);
    // Every row belongs to alpha — this is the assertion the inert filter fails,
    // because it returned beta's rows too.
    expect(owners.every((o) => o === alphaId)).toBe(true);
    expect(owners).not.toContain(betaId);
    // And the narrowing is real rather than empty: alpha's two rows are present.
    expect(data.results.length).toBe(2);
  });

  test("the other agent_id narrows the other way (not a constant answer)", async () => {
    const { status, data } = await post("/api/memories/search", {
      query: TOKEN,
      agent_id: betaId,
    });
    expect(status).toBe(200);

    const owners = ownersOf(data);
    expect(owners.every((o) => o === betaId)).toBe(true);
    expect(owners).not.toContain(alphaId);
    expect(data.results.length).toBe(2);
  });

  test("an agent_id that owns nothing returns ZERO, not everything", async () => {
    const { status, data } = await post("/api/memories/search", {
      query: TOKEN,
      agent_id: "agent-that-does-not-exist-0000",
    });
    expect(status).toBe(200);
    expect(data.results.length).toBe(0);
  });

  // The whole-defect assertion, stated the way it was measured on the fleet:
  // filtered output was byte-identical to unfiltered output.
  test("a filtered response is NOT identical to the unfiltered one", async () => {
    const unfiltered = await post("/api/memories/search", { query: TOKEN });
    const filtered = await post("/api/memories/search", { query: TOKEN, agent_id: alphaId });

    expect(unfiltered.data.results.length).toBe(4);
    expect(filtered.data.results.length).toBe(2);
    expect(JSON.stringify(filtered.data.results)).not.toBe(JSON.stringify(unfiltered.data.results));
  });

  // --------------------------------------------------- the adjacent dropped field
  // project_id was dropped by the same lines and fails the same way.
  test("project_id is applied too — an unowned project returns ZERO, not everything", async () => {
    const { status, data } = await post("/api/memories/search", {
      query: TOKEN,
      project_id: "project-that-does-not-exist-0000",
    });
    expect(status).toBe(200);
    expect(data.results.length).toBe(0);
  });

  test("agent_id and project_id compose rather than cancelling", async () => {
    // alpha owns rows, but none in this project — the intersection is empty.
    const { status, data } = await post("/api/memories/search", {
      query: TOKEN,
      agent_id: alphaId,
      project_id: "project-that-does-not-exist-0000",
    });
    expect(status).toBe(200);
    expect(data.results.length).toBe(0);
  });
});
