// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const PORT = 19400 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;

let serverProc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  serverProc = Bun.spawn(
    ["bun", "run", "src/server/index.ts", "--port", String(PORT)],
    {
      env: { ...process.env, MEMENTOS_DB_PATH: ":memory:" },
      stdout: "pipe",
      stderr: "pipe",
      cwd: "/Users/hasna/Workspace/hasna/opensource/opensourcedev/open-mementos",
    }
  );
  // Wait for server to start
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) { ready = true; break; }
    } catch { /* not ready yet */ }
    await Bun.sleep(200);
  }
  if (!ready) throw new Error("Server failed to start");
});

afterAll(() => {
  serverProc.kill();
});

// ============================================================================
// Helper
// ============================================================================

async function api(
  path: string,
  options?: RequestInit
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ============================================================================
// Health check
// ============================================================================

describe("Server health", () => {
  test("GET /api/health returns ok", async () => {
    const { status, data } = await api("/api/health");
    expect(status).toBe(200);
    expect(data.status).toBe("ok");
  });
});

// ============================================================================
// POST /api/memories — create memory
// ============================================================================

describe("POST /api/memories", () => {
  test("creates a memory", async () => {
    const { status, data } = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key: "rest-key", value: "rest-value", scope: "global" }),
    });
    expect(status).toBe(201);
    expect(data.key).toBe("rest-key");
    expect(data.value).toBe("rest-value");
    expect(data.id).toBeDefined();
  });

  test("creates a memory with category and importance", async () => {
    const { status, data } = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        key: "fact-key",
        value: "fact-value",
        category: "fact",
        scope: "global",
        importance: 8,
      }),
    });
    expect(status).toBe(201);
    expect(data.category).toBe("fact");
    expect(data.importance).toBe(8);
  });

  test("returns 400 for missing fields", async () => {
    const { status } = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key: "no-value" }),
    });
    expect(status).toBe(400);
  });

  test("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${BASE}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// GET /api/memories — list memories
// ============================================================================

describe("GET /api/memories", () => {
  test("lists memories", async () => {
    const { status, data } = await api("/api/memories");
    expect(status).toBe(200);
    expect(Array.isArray(data.memories)).toBe(true);
    expect(typeof data.count).toBe("number");
  });
});

// ============================================================================
// GET /api/memories/:id — get single memory
// ============================================================================

describe("GET /api/memories/:id", () => {
  test("gets a single memory by ID", async () => {
    const createRes = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key: "get-key", value: "get-value" }),
    });
    const id = createRes.data.id;

    const { status, data } = await api(`/api/memories/${id}`);
    expect(status).toBe(200);
    expect(data.key).toBe("get-key");
  });

  test("returns 404 for non-existent memory", async () => {
    const { status, data } = await api(
      "/api/memories/00000000-0000-0000-0000-000000000000"
    );
    expect(status).toBe(404);
    expect(data.error).toBeDefined();
  });
});

// ============================================================================
// PATCH /api/memories/:id — update memory
// ============================================================================

describe("PATCH /api/memories/:id", () => {
  test("updates a memory", async () => {
    const createRes = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key: "patch-key", value: "old-value" }),
    });
    const id = createRes.data.id;

    const { status, data } = await api(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ value: "new-value", version: 1 }),
    });
    expect(status).toBe(200);
    expect(data.value).toBe("new-value");
    expect(data.version).toBe(2);
  });

  test("returns 400 when version is missing", async () => {
    const createRes = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key: "patch-no-ver", value: "val" }),
    });
    const id = createRes.data.id;

    const { status } = await api(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ value: "new-val" }),
    });
    expect(status).toBe(400);
  });

  test("returns 409 on version conflict", async () => {
    const createRes = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key: "patch-conflict", value: "val" }),
    });
    const id = createRes.data.id;

    // First update succeeds
    await api(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ value: "updated", version: 1 }),
    });

    // Second update with stale version fails
    const { status } = await api(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ value: "conflict", version: 1 }),
    });
    expect(status).toBe(409);
  });
});

// ============================================================================
// DELETE /api/memories/:id — delete memory
// ============================================================================

describe("DELETE /api/memories/:id", () => {
  test("deletes a memory", async () => {
    const createRes = await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key: "delete-key", value: "delete-value" }),
    });
    const id = createRes.data.id;

    const { status, data } = await api(`/api/memories/${id}`, {
      method: "DELETE",
    });
    expect(status).toBe(200);
    expect(data.deleted).toBe(true);

    const getRes = await api(`/api/memories/${id}`);
    expect(getRes.status).toBe(404);
  });

  test("returns 404 when deleting non-existent memory", async () => {
    const { status } = await api(
      "/api/memories/00000000-0000-0000-0000-000000000001",
      { method: "DELETE" }
    );
    expect(status).toBe(404);
  });
});

// ============================================================================
// POST /api/memories/search — search
// ============================================================================

describe("POST /api/memories/search", () => {
  test("returns search results", async () => {
    await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        key: "searchable-srv",
        value: "searchable content",
      }),
    });

    const { status, data } = await api("/api/memories/search", {
      method: "POST",
      body: JSON.stringify({ query: "searchable" }),
    });
    expect(status).toBe(200);
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.count).toBeGreaterThanOrEqual(1);
  });

  test("returns 400 when query is missing", async () => {
    const { status } = await api("/api/memories/search", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
  });
});

// ============================================================================
// GET /api/memories/stats — statistics
// ============================================================================

describe("GET /api/memories/stats", () => {
  test("returns stats object", async () => {
    const { status, data } = await api("/api/memories/stats");
    expect(status).toBe(200);
    expect(typeof data.total).toBe("number");
    expect(data.by_scope).toBeDefined();
    expect(data.by_category).toBeDefined();
    expect(data.by_status).toBeDefined();
    expect(typeof data.pinned_count).toBe("number");
    expect(typeof data.expired_count).toBe("number");
  });
});

// ============================================================================
// POST /api/agents — register agent
// ============================================================================

describe("POST /api/agents", () => {
  test("registers an agent", async () => {
    const { status, data } = await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "rest-agent", description: "test" }),
    });
    expect(status).toBe(201);
    expect(data.name).toBe("rest-agent");
    expect(data.id).toBeDefined();
  });

  test("returns 400 when name is missing", async () => {
    const { status } = await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
  });
});

// ============================================================================
// GET /api/agents — list agents
// ============================================================================

describe("GET /api/agents", () => {
  test("lists agents", async () => {
    const { status, data } = await api("/api/agents");
    expect(status).toBe(200);
    expect(Array.isArray(data.agents)).toBe(true);
    expect(typeof data.count).toBe("number");
  });
});

// ============================================================================
// POST /api/projects — register project
// ============================================================================

describe("POST /api/projects", () => {
  test("registers a project", async () => {
    const { status, data } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "test-project",
        path: "/tmp/test-project-srv",
        description: "A test project",
      }),
    });
    expect(status).toBe(201);
    expect(data.name).toBe("test-project");
  });

  test("returns 400 when name or path is missing", async () => {
    const { status } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "missing-path" }),
    });
    expect(status).toBe(400);
  });
});

// ============================================================================
// POST /api/memories/clean — cleanup
// ============================================================================

describe("POST /api/memories/clean", () => {
  test("runs cleanup", async () => {
    const { status, data } = await api("/api/memories/clean", {
      method: "POST",
    });
    expect(status).toBe(200);
    expect(typeof data.cleaned).toBe("number");
  });
});

// ============================================================================
// Bulk operations
// ============================================================================

describe("POST /api/memories/bulk-forget", () => {
  test("deletes multiple memories", async () => {
    const a = await api("/api/memories", { method: "POST", body: JSON.stringify({ key: "bulk-del-a", value: "val-a" }) });
    const b = await api("/api/memories", { method: "POST", body: JSON.stringify({ key: "bulk-del-b", value: "val-b" }) });
    const { status, data } = await api("/api/memories/bulk-forget", {
      method: "POST",
      body: JSON.stringify({ ids: [a.data.id, b.data.id] }),
    });
    expect(status).toBe(200);
    expect(data.deleted).toBe(2);
    expect(data.total).toBe(2);
  });

  test("returns 400 without ids", async () => {
    const { status } = await api("/api/memories/bulk-forget", { method: "POST", body: JSON.stringify({}) });
    expect(status).toBe(400);
  });
});

describe("POST /api/memories/bulk-update", () => {
  test("updates multiple memories", async () => {
    const a = await api("/api/memories", { method: "POST", body: JSON.stringify({ key: "bulk-upd-a", value: "orig" }) });
    const b = await api("/api/memories", { method: "POST", body: JSON.stringify({ key: "bulk-upd-b", value: "orig" }) });
    const { status, data } = await api("/api/memories/bulk-update", {
      method: "POST",
      body: JSON.stringify({ ids: [a.data.id, b.data.id], importance: 9 }),
    });
    expect(status).toBe(200);
    expect(data.updated).toBe(2);
  });

  test("returns 400 without ids", async () => {
    const { status } = await api("/api/memories/bulk-update", { method: "POST", body: JSON.stringify({}) });
    expect(status).toBe(400);
  });
});

// ============================================================================
// Agent update and project agents
// ============================================================================

describe("PATCH /api/agents/:id", () => {
  test("updates agent role", async () => {
    const { data: agent } = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: "patch-test-agent" }) });
    const { status, data } = await api(`/api/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "senior-developer" }),
    });
    expect(status).toBe(200);
    expect(data.role).toBe("senior-developer");
  });

  test("returns 404 for unknown agent", async () => {
    const { status } = await api("/api/agents/nonexistent-id", { method: "PATCH", body: JSON.stringify({ role: "x" }) });
    expect(status).toBe(404);
  });
});

describe("GET /api/agents?project_id", () => {
  test("filters agents by project", async () => {
    const { data: proj } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "filter-proj", path: "/tmp/filter-proj" }) });
    const { data: agent } = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: "proj-bound-agent" }) });
    await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ active_project_id: proj.id }) });
    const { status, data } = await api(`/api/agents?project_id=${proj.id}`);
    expect(status).toBe(200);
    expect(data.agents.some((a: { name: string }) => a.name === "proj-bound-agent")).toBe(true);
  });
});

describe("GET /api/projects/:id", () => {
  test("gets project by id", async () => {
    const { data: proj } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "get-by-id-proj", path: "/tmp/get-by-id-proj" }) });
    const { status, data } = await api(`/api/projects/${proj.id}`);
    expect(status).toBe(200);
    expect(data.name).toBe("get-by-id-proj");
  });

  test("gets project by name", async () => {
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "get-by-name-proj", path: "/tmp/get-by-name-proj" }) });
    const { status, data } = await api(`/api/projects/get-by-name-proj`);
    expect(status).toBe(200);
    expect(data.name).toBe("get-by-name-proj");
  });

  test("returns 404 for unknown project", async () => {
    const { status } = await api("/api/projects/definitely-does-not-exist");
    expect(status).toBe(404);
  });
});

describe("GET /api/projects/:id/agents", () => {
  test("lists agents active on project", async () => {
    const { data: proj } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "agents-proj", path: "/tmp/agents-proj" }) });
    const { data: agent } = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: "agents-proj-agent" }) });
    await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ active_project_id: proj.id }) });
    const { status, data } = await api(`/api/projects/${proj.id}/agents`);
    expect(status).toBe(200);
    expect(data.agents.some((a: { name: string }) => a.name === "agents-proj-agent")).toBe(true);
  });
});

describe("POST /api/memories/extract", () => {
  test("creates memories from session summary", async () => {
    const { status, data } = await api("/api/memories/extract", {
      method: "POST",
      body: JSON.stringify({
        session_id: "test-session-extract-001",
        title: "Fix auth middleware",
        project: "alumia",
        model: "claude-opus-4-5",
        messages: 100,
        key_topics: ["jwt", "compliance", "middleware"],
        summary: "Rewrote auth to comply with new legal requirements",
      }),
    });
    expect(status).toBe(201);
    expect(data.created).toBeGreaterThan(0);
    expect(data.session_id).toBe("test-session-extract-001");
    expect(Array.isArray(data.memory_ids)).toBe(true);
  });

  test("memories are queryable by session_id", async () => {
    const sessId = "test-session-query-002";
    await api("/api/memories/extract", {
      method: "POST",
      body: JSON.stringify({ session_id: sessId, title: "Query test session" }),
    });
    const { status, data } = await api(`/api/memories?session_id=${sessId}`);
    expect(status).toBe(200);
    expect(data.memories.length).toBeGreaterThan(0);
    expect(data.memories.every((m: { session_id: string }) => m.session_id === sessId)).toBe(true);
  });

  test("accepts custom memories array", async () => {
    const { status, data } = await api("/api/memories/extract", {
      method: "POST",
      body: JSON.stringify({
        session_id: "test-session-custom-003",
        memories: [
          { key: "custom-extract-key", value: "custom value", category: "fact", importance: 8 },
        ],
      }),
    });
    expect(status).toBe(201);
    expect(data.created).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/memories?session_id", () => {
  test("filters memories by session_id", async () => {
    const sessId = "filter-session-test-004";
    await api("/api/memories", {
      method: "POST",
      body: JSON.stringify({ key: "sess-filtered-key", value: "val", session_id: sessId }),
    });
    const { status, data } = await api(`/api/memories?session_id=${sessId}`);
    expect(status).toBe(200);
    expect(data.memories.every((m: { session_id: string }) => m.session_id === sessId)).toBe(true);
  });
});

describe("GET /api/inject format", () => {
  test("returns compact format", async () => {
    await api("/api/memories", { method: "POST", body: JSON.stringify({ key: "fmt-test", value: "hello world", scope: "global", importance: 8 }) });
    const { status, data } = await api("/api/inject?format=compact");
    expect(status).toBe(200);
    expect(typeof data.context).toBe("string");
    if (data.memories_count > 0) {
      expect(data.context).not.toContain("<agent-memories>");
      expect(data.context).not.toContain("##");
    }
  });

  test("returns markdown format", async () => {
    const { data } = await api("/api/inject?format=markdown");
    if (data.memories_count > 0) {
      expect(data.context).toContain("## Agent Memories");
    }
  });

  test("returns xml format by default", async () => {
    const { data } = await api("/api/inject");
    if (data.memories_count > 0) {
      expect(data.context).toContain("<agent-memories>");
    }
  });
});

// ============================================================================
// 404 for unknown routes
// ============================================================================

describe("404 handling", () => {
  test("returns 404 for unknown routes", async () => {
    const { status, data } = await api("/api/nonexistent");
    expect(status).toBe(404);
    expect(data.error).toBe("Not found");
  });
});

// ============================================================================
// Security: path traversal prevention
// ============================================================================

describe("path traversal prevention", () => {
  test("traversal attempt does not return /etc/passwd contents", async () => {
    // URL parser normalizes ../../ before reaching the handler.
    // The response may be 404 (no dashboard) or 200 (SPA index.html) but must NOT be /etc/passwd.
    const res = await fetch(`${BASE}/../../etc/passwd`);
    const text = await res.text();
    // /etc/passwd always starts with "root:" — if we see that, traversal succeeded
    expect(text).not.toContain("root:");
    expect(text).not.toContain("/bin/bash");
  });

  test("encoded traversal attempt does not expose system files", async () => {
    const res = await fetch(`${BASE}/..%2F..%2Fetc%2Fpasswd`);
    const text = await res.text();
    expect(text).not.toContain("root:");
    expect(text).not.toContain("/bin/bash");
  });

  test("health endpoint includes hostname", async () => {
    const { status, data } = await api("/api/health");
    expect(status).toBe(200);
    expect(typeof data.hostname).toBe("string");
  });
});

// ============================================================================
// CORS preflight
// ============================================================================

describe("CORS", () => {
  test("handles OPTIONS preflight", async () => {
    const res = await fetch(`${BASE}/api/memories`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
  });
});
