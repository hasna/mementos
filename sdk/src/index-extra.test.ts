import { describe, it, expect } from "bun:test";
import { MementosClient } from "./index.js";
import type { ResourceLock } from "./index.js";

// ============================================================================
// Mock fetch helper (same pattern as index.test.ts)
// ============================================================================

function mockFetch(
  responses: Array<{ status: number; body: unknown }>
): { calls: Array<{ url: string; method: string; init: RequestInit | undefined }>; fetch: typeof globalThis.fetch } {
  const calls: Array<{ url: string; method: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", init });
    const resp = responses[i++] ?? { status: 200, body: {} };
    return new Response(
      resp.status === 204 ? null : JSON.stringify(resp.body),
      { status: resp.status, headers: { "Content-Type": "application/json" } }
    );
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const BASE = "http://localhost:19428";

function makeLock(overrides: Partial<ResourceLock> = {}): ResourceLock {
  return {
    id: "lock-1",
    resource_type: "memory",
    resource_id: "mem-1",
    agent_id: "agent-1",
    lock_type: "advisory",
    locked_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-01-01T01:00:00Z",
    ...overrides,
  };
}

// ============================================================================
// Resource Locks — lines 625-637, 643-645, 650, 655, 660, 665
// ============================================================================

describe("Resource locks", () => {
  describe("acquireLock", () => {
    it("POSTs /api/locks and returns lock on success", async () => {
      const lock = makeLock();
      const { calls, fetch } = mockFetch([{ status: 200, body: lock }]);
      const client = new MementosClient({ fetch });
      const result = await client.acquireLock({
        agent_id: "agent-1",
        resource_type: "memory",
        resource_id: "mem-1",
        lock_type: "advisory",
        ttl_seconds: 300,
      });
      expect(calls[0]!.url).toBe(`${BASE}/api/locks`);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("lock-1");
    });

    it("returns null on 409 conflict", async () => {
      const { calls, fetch } = mockFetch([{ status: 409, body: { error: "409 Lock conflict" } }]);
      const client = new MementosClient({ fetch });
      const result = await client.acquireLock({
        agent_id: "agent-1",
        resource_type: "memory",
        resource_id: "mem-1",
      });
      expect(calls[0]!.url).toBe(`${BASE}/api/locks`);
      expect(result).toBeNull();
    });

    it("re-throws non-409 errors", async () => {
      const { fetch } = mockFetch([{ status: 500, body: { error: "Server error" } }]);
      const client = new MementosClient({ fetch });
      await expect(
        client.acquireLock({ agent_id: "agent-1", resource_type: "memory", resource_id: "mem-1" })
      ).rejects.toThrow();
    });
  });

  describe("checkLock", () => {
    it("GETs /api/locks with resource_type and resource_id params", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: [makeLock()] }]);
      const client = new MementosClient({ fetch });
      const result = await client.checkLock("memory", "mem-1");
      expect(calls[0]!.url).toContain("/api/locks");
      expect(calls[0]!.url).toContain("resource_type=memory");
      expect(calls[0]!.url).toContain("resource_id=mem-1");
      expect(result).toHaveLength(1);
    });

    it("includes lock_type param when provided", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: [] }]);
      const client = new MementosClient({ fetch });
      await client.checkLock("memory", "mem-1", "exclusive");
      expect(calls[0]!.url).toContain("lock_type=exclusive");
    });
  });

  describe("releaseLock", () => {
    it("DELETEs /api/locks/:id with agent_id in body", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { released: true } }]);
      const client = new MementosClient({ fetch });
      const result = await client.releaseLock("lock-1", "agent-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/locks/lock-1`);
      expect(calls[0]!.method).toBe("DELETE");
      expect(result.released).toBe(true);
    });
  });

  describe("listAgentLocks", () => {
    it("GETs /api/agents/:id/locks", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: [makeLock()] }]);
      const client = new MementosClient({ fetch });
      const result = await client.listAgentLocks("agent-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/agents/agent-1/locks`);
      expect(result).toHaveLength(1);
    });
  });

  describe("releaseAllAgentLocks", () => {
    it("DELETEs /api/agents/:id/locks", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { released: 3 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.releaseAllAgentLocks("agent-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/agents/agent-1/locks`);
      expect(calls[0]!.method).toBe("DELETE");
      expect(result.released).toBe(3);
    });
  });

  describe("cleanExpiredLocks", () => {
    it("POSTs /api/locks/clean", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { cleaned: 2 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.cleanExpiredLocks();
      expect(calls[0]!.url).toBe(`${BASE}/api/locks/clean`);
      expect(result.cleaned).toBe(2);
    });
  });
});

// ============================================================================
// Auto-Memory — lines 690-693, 698-702, 707-709, 714-717
// ============================================================================

describe("Auto-Memory", () => {
  describe("processConversationTurn", () => {
    it("POSTs /api/auto-memory/process with turn string", async () => {
      const { calls, fetch } = mockFetch([{
        status: 200,
        body: { queued: true, queue: { pending: 1, processing: 0, processed: 0, failed: 0, dropped: 0 } },
      }]);
      const client = new MementosClient({ fetch });
      const result = await client.processConversationTurn("User prefers dark mode");
      expect(calls[0]!.url).toBe(`${BASE}/api/auto-memory/process`);
      expect(result.queued).toBe(true);
      expect(result.queue.pending).toBe(1);
    });

    it("includes context in body", async () => {
      const { calls, fetch } = mockFetch([{
        status: 200,
        body: { queued: true, queue: { pending: 1, processing: 0, processed: 0, failed: 0, dropped: 0 } },
      }]);
      const client = new MementosClient({ fetch });
      await client.processConversationTurn("Some turn", {
        agent_id: "galba",
        project_id: "proj-1",
        session_id: "sess-1",
      });
      const body = JSON.parse(calls[0]!.init?.body as string);
      expect(body.turn).toBe("Some turn");
      expect(body.agent_id).toBe("galba");
      expect(body.project_id).toBe("proj-1");
      expect(body.session_id).toBe("sess-1");
    });
  });

  describe("getAutoMemoryStatus", () => {
    it("GETs /api/auto-memory/status", async () => {
      const body = {
        queue: { pending: 0, processing: 0, processed: 5, failed: 0, dropped: 0 },
        config: { provider: "anthropic", enabled: true, minImportance: 6, autoEntityLink: false },
        providers: { anthropic: { available: true, model: "claude-3-haiku" } },
      };
      const { calls, fetch } = mockFetch([{ status: 200, body }]);
      const client = new MementosClient({ fetch });
      const result = await client.getAutoMemoryStatus();
      expect(calls[0]!.url).toBe(`${BASE}/api/auto-memory/status`);
      expect(result.queue.processed).toBe(5);
      expect(result.config.enabled).toBe(true);
    });
  });

  describe("configureAutoMemory", () => {
    it("PATCHes /api/auto-memory/config", async () => {
      const { calls, fetch } = mockFetch([{
        status: 200,
        body: { updated: true, config: { provider: "openai", enabled: false, minImportance: 7, autoEntityLink: true } },
      }]);
      const client = new MementosClient({ fetch });
      const result = await client.configureAutoMemory({ enabled: false, min_importance: 7 });
      expect(calls[0]!.method).toBe("PATCH");
      expect(calls[0]!.url).toBe(`${BASE}/api/auto-memory/config`);
      expect(result.updated).toBe(true);
    });
  });

  describe("testExtraction", () => {
    it("POSTs /api/auto-memory/test", async () => {
      const { calls, fetch } = mockFetch([{
        status: 200,
        body: {
          provider: "anthropic",
          model: "claude-3-haiku",
          extracted: [{ content: "uses TypeScript", category: "fact", importance: 7, tags: [], suggestedScope: "shared" }],
          count: 1,
          note: "test mode",
        },
      }]);
      const client = new MementosClient({ fetch });
      const result = await client.testExtraction("Team uses TypeScript", { provider: "anthropic" });
      expect(calls[0]!.url).toBe(`${BASE}/api/auto-memory/test`);
      expect(result.count).toBe(1);
      expect(result.extracted[0]!.content).toBe("uses TypeScript");
    });
  });
});

// ============================================================================
// Hooks & Webhooks — lines 724-725, 730, 735-739, 744-752, 757, 762-765, 770, 775, 780
// ============================================================================

describe("Hooks", () => {
  describe("listHooks", () => {
    it("GETs /api/hooks", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: [{ id: "h1", type: "PostMemorySave", blocking: false, priority: 5, builtin: true }] }]);
      const client = new MementosClient({ fetch });
      const result = await client.listHooks();
      expect(calls[0]!.url).toBe(`${BASE}/api/hooks`);
      expect(result).toHaveLength(1);
    });

    it("GETs /api/hooks with type filter", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: [] }]);
      const client = new MementosClient({ fetch });
      await client.listHooks("PostMemorySave");
      expect(calls[0]!.url).toContain("type=PostMemorySave");
    });
  });

  describe("getHookStats", () => {
    it("GETs /api/hooks/stats", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { total: 5, byType: { PostMemorySave: 3 }, blocking: 1, nonBlocking: 4 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.getHookStats();
      expect(calls[0]!.url).toBe(`${BASE}/api/hooks/stats`);
      expect(result.total).toBe(5);
    });
  });

  describe("Webhook CRUD", () => {
    const webhookBody = {
      id: "wh-1",
      type: "PostMemorySave",
      handlerUrl: "https://example.com/webhook",
      priority: 5,
      blocking: false,
    };

    it("listWebhooks GETs /api/webhooks", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: [webhookBody] }]);
      const client = new MementosClient({ fetch });
      const result = await client.listWebhooks();
      expect(calls[0]!.url).toBe(`${BASE}/api/webhooks`);
      expect(result).toHaveLength(1);
    });

    it("listWebhooks with filter adds query params", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: [] }]);
      const client = new MementosClient({ fetch });
      await client.listWebhooks({ type: "PostMemorySave", enabled: true });
      expect(calls[0]!.url).toContain("type=PostMemorySave");
      expect(calls[0]!.url).toContain("enabled=true");
    });

    it("createWebhook POSTs /api/webhooks", async () => {
      const { calls, fetch } = mockFetch([{ status: 201, body: webhookBody }]);
      const client = new MementosClient({ fetch });
      const result = await client.createWebhook({
        type: "PostMemorySave",
        handler_url: "https://example.com/webhook",
        priority: 5,
        blocking: false,
      });
      expect(calls[0]!.url).toBe(`${BASE}/api/webhooks`);
      expect(result.id).toBe("wh-1");
    });

    it("getWebhook GETs /api/webhooks/:id", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: webhookBody }]);
      const client = new MementosClient({ fetch });
      await client.getWebhook("wh-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/webhooks/wh-1`);
    });

    it("updateWebhook PATCHes /api/webhooks/:id", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { ...webhookBody, blocking: true } }]);
      const client = new MementosClient({ fetch });
      const result = await client.updateWebhook("wh-1", { blocking: true });
      expect(calls[0]!.method).toBe("PATCH");
      expect(calls[0]!.url).toBe(`${BASE}/api/webhooks/wh-1`);
      expect(result.blocking).toBe(true);
    });

    it("deleteWebhook DELETEs /api/webhooks/:id", async () => {
      const { calls, fetch } = mockFetch([{ status: 204, body: null }]);
      const client = new MementosClient({ fetch });
      await client.deleteWebhook("wh-1");
      expect(calls[0]!.method).toBe("DELETE");
      expect(calls[0]!.url).toBe(`${BASE}/api/webhooks/wh-1`);
    });

    it("enableWebhook calls updateWebhook with enabled: true", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { ...webhookBody, enabled: true } }]);
      const client = new MementosClient({ fetch });
      await client.enableWebhook("wh-1");
      const body = JSON.parse(calls[0]!.init?.body as string);
      expect(body.enabled).toBe(true);
    });

    it("disableWebhook calls updateWebhook with enabled: false", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { ...webhookBody, enabled: false } }]);
      const client = new MementosClient({ fetch });
      await client.disableWebhook("wh-1");
      const body = JSON.parse(calls[0]!.init?.body as string);
      expect(body.enabled).toBe(false);
    });
  });
});

// ============================================================================
// Synthesis — lines 787-793, 798-802, 807-811, 816
// ============================================================================

describe("Synthesis", () => {
  describe("runSynthesis", () => {
    it("POSTs /api/synthesis/run with no options", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { run_id: "run-1", status: "completed", merged: 3, archived: 1, errors: [] } }]);
      const client = new MementosClient({ fetch });
      const result = await client.runSynthesis();
      expect(calls[0]!.url).toBe(`${BASE}/api/synthesis/run`);
      expect(result.run_id).toBe("run-1");
    });

    it("POSTs /api/synthesis/run with options", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { run_id: "run-2", status: "dry_run", merged: 0, archived: 0, errors: [] } }]);
      const client = new MementosClient({ fetch });
      await client.runSynthesis({ dry_run: true, max_proposals: 5, project_id: "proj-1" });
      const body = JSON.parse(calls[0]!.init?.body as string);
      expect(body.dry_run).toBe(true);
      expect(body.max_proposals).toBe(5);
    });
  });

  describe("listSynthesisRuns", () => {
    it("GETs /api/synthesis/runs", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { runs: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      await client.listSynthesisRuns();
      expect(calls[0]!.url).toBe(`${BASE}/api/synthesis/runs`);
    });

    it("includes filter params", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { runs: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      await client.listSynthesisRuns({ project_id: "proj-1", limit: 10 });
      expect(calls[0]!.url).toContain("project_id=proj-1");
      expect(calls[0]!.url).toContain("limit=10");
    });
  });

  describe("getSynthesisStatus", () => {
    it("GETs /api/synthesis/status", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { lastRun: null, recentRuns: [] } }]);
      const client = new MementosClient({ fetch });
      await client.getSynthesisStatus();
      expect(calls[0]!.url).toBe(`${BASE}/api/synthesis/status`);
    });

    it("includes project_id and run_id params", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { lastRun: null, recentRuns: [] } }]);
      const client = new MementosClient({ fetch });
      await client.getSynthesisStatus({ project_id: "proj-1", run_id: "run-1" });
      expect(calls[0]!.url).toContain("project_id=proj-1");
      expect(calls[0]!.url).toContain("run_id=run-1");
    });
  });

  describe("rollbackSynthesis", () => {
    it("POSTs /api/synthesis/rollback/:runId", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { rolled_back: 3, errors: [] } }]);
      const client = new MementosClient({ fetch });
      const result = await client.rollbackSynthesis("run-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/synthesis/rollback/run-1`);
      expect(result.rolled_back).toBe(3);
    });
  });
});

// ============================================================================
// Session ingestion — lines 823-830, 835, 840-846
// ============================================================================

describe("Session ingestion", () => {
  describe("ingestSession", () => {
    it("POSTs /api/sessions/ingest", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { job_id: "job-1", status: "pending", message: "Queued" } }]);
      const client = new MementosClient({ fetch });
      const result = await client.ingestSession({
        transcript: "Hello, world. Agent fixed a bug.",
        session_id: "sess-1",
        agent_id: "galba",
        project_id: "proj-1",
        source: "claude-code",
      });
      expect(calls[0]!.url).toBe(`${BASE}/api/sessions/ingest`);
      expect(result.job_id).toBe("job-1");
    });
  });

  describe("getSessionJob", () => {
    it("GETs /api/sessions/jobs/:jobId", async () => {
      const { calls, fetch } = mockFetch([{
        status: 200,
        body: { id: "job-1", session_id: "sess-1", agent_id: null, project_id: null, source: "manual", status: "completed", transcript: "...", chunk_count: 1, memories_extracted: 3, error: null, metadata: {}, created_at: "2026-01-01T00:00:00Z", started_at: null, completed_at: null },
      }]);
      const client = new MementosClient({ fetch });
      const result = await client.getSessionJob("job-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/sessions/jobs/job-1`);
      expect(result.id).toBe("job-1");
      expect(result.memories_extracted).toBe(3);
    });
  });

  describe("listSessionJobs", () => {
    it("GETs /api/sessions/jobs with no filter", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { jobs: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      await client.listSessionJobs();
      expect(calls[0]!.url).toBe(`${BASE}/api/sessions/jobs`);
    });

    it("includes filter params", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { jobs: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      await client.listSessionJobs({ agent_id: "galba", project_id: "proj-1", status: "completed", limit: 20 });
      expect(calls[0]!.url).toContain("agent_id=galba");
      expect(calls[0]!.url).toContain("project_id=proj-1");
      expect(calls[0]!.url).toContain("status=completed");
      expect(calls[0]!.url).toContain("limit=20");
    });
  });

  describe("getSessionQueueStats", () => {
    it("GETs /api/sessions/queue/stats", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { pending: 0, processing: 1, completed: 50, failed: 2 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.getSessionQueueStats();
      expect(calls[0]!.url).toBe(`${BASE}/api/sessions/queue/stats`);
      expect(result.completed).toBe(50);
    });
  });
});

// ============================================================================
// getEntityRelations — line 583-585
// ============================================================================

describe("getEntityRelations", () => {
  it("GETs /api/entities/:id/relations", async () => {
    const { calls, fetch } = mockFetch([{ status: 200, body: { relations: [] } }]);
    const client = new MementosClient({ fetch });
    await client.getEntityRelations("ent-1");
    expect(calls[0]!.url).toContain("/api/entities/ent-1/relations");
  });

  it("passes filter params", async () => {
    const { calls, fetch } = mockFetch([{ status: 200, body: { relations: [] } }]);
    const client = new MementosClient({ fetch });
    await client.getEntityRelations("ent-1", { relation_type: "related_to", direction: "from" });
    expect(calls[0]!.url).toContain("relation_type=related_to");
    expect(calls[0]!.url).toContain("direction=from");
  });
});

// ============================================================================
// getGraph with relation_types — line 614
// ============================================================================

describe("getGraph with relation_types", () => {
  it("joins relation_types with comma", async () => {
    const { calls, fetch } = mockFetch([{ status: 200, body: { nodes: [], edges: [] } }]);
    const client = new MementosClient({ fetch });
    await client.getGraph("ent-1", { depth: 3, relation_types: ["uses", "related_to"] });
    expect(calls[0]!.url).toContain("relation_types=uses%2Crelated_to");
    expect(calls[0]!.url).toContain("depth=3");
  });
});
