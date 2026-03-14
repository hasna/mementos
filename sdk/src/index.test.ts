import { describe, it, expect, beforeEach } from "bun:test";
import { MementosClient, MementosError } from "./index.js";
import type { Memory, Agent, Project, Entity, Relation } from "./index.js";

// ============================================================================
// Mock fetch helper
// ============================================================================

function mockFetch(
  responses: Array<{ status: number; body: unknown }>
): { calls: Array<{ url: string; init: RequestInit | undefined }>; fetch: typeof globalThis.fetch } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const resp = responses[i++] ?? { status: 200, body: {} };
    return new Response(
      resp.status === 204 ? null : JSON.stringify(resp.body),
      { status: resp.status, headers: { "Content-Type": "application/json" } }
    );
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const BASE = "http://localhost:19428";

// ============================================================================
// Helpers
// ============================================================================

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    key: "test-key",
    value: "test value",
    category: "knowledge",
    scope: "shared",
    summary: null,
    tags: [],
    importance: 5,
    source: "agent",
    status: "active",
    pinned: false,
    agent_id: null,
    project_id: null,
    session_id: null,
    metadata: {},
    access_count: 0,
    version: 1,
    expires_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    accessed_at: null,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "galba",
    role: "developer",
    description: null,
    created_at: "2026-01-01T00:00:00Z",
    last_seen_at: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "open-mementos",
    path: "/path/to/project",
    description: null,
    memory_prefix: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: "ent-1",
    name: "TestEntity",
    type: "concept",
    description: null,
    aliases: [],
    metadata: {},
    observation_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRelation(overrides: Partial<Relation> = {}): Relation {
  return {
    id: "rel-1",
    from_entity_id: "ent-1",
    to_entity_id: "ent-2",
    relation_type: "related_to",
    strength: 1,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("MementosClient", () => {
  describe("constructor", () => {
    it("uses default base URL", () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { memories: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      client.listMemories();
      expect(calls[0]!.url).toStartWith("http://localhost:19428");
    });

    it("uses custom base URL", () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { memories: [], count: 0 } }]);
      const client = new MementosClient({ baseUrl: "http://custom:9000", fetch });
      client.listMemories();
      expect(calls[0]!.url).toStartWith("http://custom:9000");
    });

    it("strips trailing slash from baseUrl", () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { memories: [], count: 0 } }]);
      const client = new MementosClient({ baseUrl: "http://custom:9000/", fetch });
      client.listMemories();
      expect(calls[0]!.url).toStartWith("http://custom:9000/api");
    });
  });

  describe("listMemories", () => {
    it("GETs /api/memories with no filter", async () => {
      const mem = makeMemory();
      const { calls, fetch } = mockFetch([{ status: 200, body: { memories: [mem], count: 1 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.listMemories();
      expect(calls[0]!.url).toBe(`${BASE}/api/memories`);
      expect(result.count).toBe(1);
      expect(result.memories[0]!.key).toBe("test-key");
    });

    it("passes filter as query params", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { memories: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      await client.listMemories({ scope: "global", category: "knowledge", min_importance: 7, limit: 10, tags: ["a", "b"] });
      const url = new URL(calls[0]!.url);
      expect(url.searchParams.get("scope")).toBe("global");
      expect(url.searchParams.get("category")).toBe("knowledge");
      expect(url.searchParams.get("min_importance")).toBe("7");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("tags")).toBe("a,b");
    });

    it("passes fields filter", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { memories: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      await client.listMemories({ fields: ["key", "value"] });
      const url = new URL(calls[0]!.url);
      expect(url.searchParams.get("fields")).toBe("key,value");
    });
  });

  describe("getStats", () => {
    it("GETs /api/memories/stats", async () => {
      const stats = {
        total: 42,
        by_scope: { global: 10, shared: 20, private: 12 },
        by_category: { preference: 5, fact: 10, knowledge: 20, history: 7 },
        by_status: { active: 40, archived: 1, expired: 1 },
        by_agent: {},
        pinned_count: 3,
        expired_count: 1,
      };
      const { calls, fetch } = mockFetch([{ status: 200, body: stats }]);
      const client = new MementosClient({ fetch });
      const result = await client.getStats();
      expect(calls[0]!.url).toBe(`${BASE}/api/memories/stats`);
      expect(result.total).toBe(42);
    });
  });

  describe("searchMemories", () => {
    it("POSTs /api/memories/search with string query", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { results: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      await client.searchMemories("my query");
      expect(calls[0]!.url).toBe(`${BASE}/api/memories/search`);
      expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ query: "my query" });
    });

    it("POSTs /api/memories/search with full input", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { results: [], count: 0 } }]);
      const client = new MementosClient({ fetch });
      await client.searchMemories({ query: "test", scope: "shared", limit: 5 });
      const body = JSON.parse(calls[0]!.init?.body as string);
      expect(body.query).toBe("test");
      expect(body.scope).toBe("shared");
      expect(body.limit).toBe(5);
    });
  });

  describe("saveMemory", () => {
    it("POSTs /api/memories", async () => {
      const mem = makeMemory();
      const { calls, fetch } = mockFetch([{ status: 201, body: mem }]);
      const client = new MementosClient({ fetch });
      const result = await client.saveMemory({ key: "test-key", value: "test value" });
      expect(calls[0]!.url).toBe(`${BASE}/api/memories`);
      expect(result.key).toBe("test-key");
    });
  });

  describe("getMemory", () => {
    it("GETs /api/memories/:id", async () => {
      const mem = makeMemory();
      const { calls, fetch } = mockFetch([{ status: 200, body: mem }]);
      const client = new MementosClient({ fetch });
      const result = await client.getMemory("mem-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/memories/mem-1`);
      expect(result.id).toBe("mem-1");
    });
  });

  describe("updateMemory", () => {
    it("PATCHes /api/memories/:id", async () => {
      const mem = makeMemory({ value: "updated" });
      const { calls, fetch } = mockFetch([{ status: 200, body: mem }]);
      const client = new MementosClient({ fetch });
      const result = await client.updateMemory("mem-1", { value: "updated", version: 1 });
      expect(calls[0]!.url).toBe(`${BASE}/api/memories/mem-1`);
      expect(result.value).toBe("updated");
    });
  });

  describe("deleteMemory", () => {
    it("DELETEs /api/memories/:id", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { deleted: true } }]);
      const client = new MementosClient({ fetch });
      const result = await client.deleteMemory("mem-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/memories/mem-1`);
      expect(result.deleted).toBe(true);
    });
  });

  describe("exportMemories / importMemories", () => {
    it("exports memories", async () => {
      const mem = makeMemory();
      const { calls, fetch } = mockFetch([{ status: 200, body: { memories: [mem], count: 1 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.exportMemories({ scope: "shared" });
      expect(calls[0]!.url).toBe(`${BASE}/api/memories/export`);
      expect(result.count).toBe(1);
    });

    it("imports memories", async () => {
      const { calls, fetch } = mockFetch([{ status: 201, body: { imported: 2, errors: [], total: 2 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.importMemories({ memories: [{ key: "k1", value: "v1" }, { key: "k2", value: "v2" }] });
      expect(calls[0]!.url).toBe(`${BASE}/api/memories/import`);
      expect(result.imported).toBe(2);
    });
  });

  describe("cleanExpired", () => {
    it("POSTs /api/memories/clean", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { cleaned: 5 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.cleanExpired();
      expect(calls[0]!.url).toBe(`${BASE}/api/memories/clean`);
      expect(result.cleaned).toBe(5);
    });
  });

  describe("agents", () => {
    it("lists agents", async () => {
      const agent = makeAgent();
      const { calls, fetch } = mockFetch([{ status: 200, body: { agents: [agent] } }]);
      const client = new MementosClient({ fetch });
      const result = await client.listAgents();
      expect(calls[0]!.url).toBe(`${BASE}/api/agents`);
      expect(result.agents[0]!.name).toBe("galba");
    });

    it("registers an agent", async () => {
      const agent = makeAgent();
      const { calls, fetch } = mockFetch([{ status: 201, body: agent }]);
      const client = new MementosClient({ fetch });
      const result = await client.registerAgent({ name: "galba", role: "developer" });
      expect(calls[0]!.url).toBe(`${BASE}/api/agents`);
      expect(result.name).toBe("galba");
    });

    it("gets an agent by id", async () => {
      const agent = makeAgent();
      const { calls, fetch } = mockFetch([{ status: 200, body: agent }]);
      const client = new MementosClient({ fetch });
      const result = await client.getAgent("agent-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/agents/agent-1`);
      expect(result.id).toBe("agent-1");
    });
  });

  describe("projects", () => {
    it("lists projects", async () => {
      const project = makeProject();
      const { calls, fetch } = mockFetch([{ status: 200, body: { projects: [project] } }]);
      const client = new MementosClient({ fetch });
      const result = await client.listProjects();
      expect(calls[0]!.url).toBe(`${BASE}/api/projects`);
      expect(result.projects[0]!.name).toBe("open-mementos");
    });

    it("registers a project", async () => {
      const project = makeProject();
      const { calls, fetch } = mockFetch([{ status: 201, body: project }]);
      const client = new MementosClient({ fetch });
      const result = await client.registerProject({ name: "open-mementos", path: "/path/to/project" });
      expect(calls[0]!.url).toBe(`${BASE}/api/projects`);
      expect(result.name).toBe("open-mementos");
    });
  });

  describe("entities", () => {
    it("lists entities", async () => {
      const entity = makeEntity();
      const { calls, fetch } = mockFetch([{ status: 200, body: { entities: [entity], count: 1 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.listEntities({ type: "concept" });
      expect(calls[0]!.url).toContain("/api/entities");
      expect(result.count).toBe(1);
    });

    it("creates an entity", async () => {
      const entity = makeEntity();
      const { calls, fetch } = mockFetch([{ status: 201, body: entity }]);
      const client = new MementosClient({ fetch });
      const result = await client.createEntity({ name: "TestEntity", type: "concept" });
      expect(calls[0]!.url).toBe(`${BASE}/api/entities`);
      expect(result.name).toBe("TestEntity");
    });

    it("gets an entity", async () => {
      const entity = makeEntity();
      const { calls, fetch } = mockFetch([{ status: 200, body: entity }]);
      const client = new MementosClient({ fetch });
      await client.getEntity("ent-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/entities/ent-1`);
    });

    it("updates an entity", async () => {
      const entity = makeEntity({ description: "updated" });
      const { calls, fetch } = mockFetch([{ status: 200, body: entity }]);
      const client = new MementosClient({ fetch });
      const result = await client.updateEntity("ent-1", { description: "updated" });
      expect(calls[0]!.url).toBe(`${BASE}/api/entities/ent-1`);
      expect(result.description).toBe("updated");
    });

    it("deletes an entity", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { deleted: true } }]);
      const client = new MementosClient({ fetch });
      await client.deleteEntity("ent-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/entities/ent-1`);
    });

    it("gets entity memories", async () => {
      const mem = makeMemory();
      const { calls, fetch } = mockFetch([{ status: 200, body: { memories: [mem], count: 1 } }]);
      const client = new MementosClient({ fetch });
      await client.getEntityMemories("ent-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/entities/ent-1/memories`);
    });

    it("links a memory to an entity", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { linked: true } }]);
      const client = new MementosClient({ fetch });
      await client.linkEntityMemory("ent-1", { memory_id: "mem-1" });
      expect(calls[0]!.url).toBe(`${BASE}/api/entities/ent-1/memories`);
    });

    it("unlinks a memory from an entity", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { unlinked: true } }]);
      const client = new MementosClient({ fetch });
      await client.unlinkEntityMemory("ent-1", "mem-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/entities/ent-1/memories/mem-1`);
    });

    it("merges entities", async () => {
      const entity = makeEntity();
      const { calls, fetch } = mockFetch([{ status: 200, body: entity }]);
      const client = new MementosClient({ fetch });
      await client.mergeEntities({ source_id: "ent-1", target_id: "ent-2" });
      expect(calls[0]!.url).toBe(`${BASE}/api/entities/merge`);
    });
  });

  describe("relations", () => {
    it("creates a relation", async () => {
      const rel = makeRelation();
      const { calls, fetch } = mockFetch([{ status: 201, body: rel }]);
      const client = new MementosClient({ fetch });
      const result = await client.createRelation({
        from_entity_id: "ent-1",
        to_entity_id: "ent-2",
        relation_type: "related_to",
      });
      expect(calls[0]!.url).toBe(`${BASE}/api/relations`);
      expect(result.relation_type).toBe("related_to");
    });

    it("gets a relation", async () => {
      const rel = makeRelation();
      const { calls, fetch } = mockFetch([{ status: 200, body: rel }]);
      const client = new MementosClient({ fetch });
      await client.getRelation("rel-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/relations/rel-1`);
    });

    it("deletes a relation", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { deleted: true } }]);
      const client = new MementosClient({ fetch });
      await client.deleteRelation("rel-1");
      expect(calls[0]!.url).toBe(`${BASE}/api/relations/rel-1`);
    });
  });

  describe("graph", () => {
    it("gets graph for entity", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { nodes: [], edges: [] } }]);
      const client = new MementosClient({ fetch });
      await client.getGraph("ent-1", { depth: 2 });
      expect(calls[0]!.url).toContain("/api/graph/ent-1");
      expect(calls[0]!.url).toContain("depth=2");
    });

    it("finds path between entities", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { path: [], found: false } }]);
      const client = new MementosClient({ fetch });
      await client.findPath("ent-1", "ent-2");
      expect(calls[0]!.url).toContain("/api/graph/path");
      expect(calls[0]!.url).toContain("from=ent-1");
      expect(calls[0]!.url).toContain("to=ent-2");
    });

    it("gets graph stats", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { entity_count: 10, relation_count: 5, by_type: {} } }]);
      const client = new MementosClient({ fetch });
      const result = await client.getGraphStats();
      expect(calls[0]!.url).toBe(`${BASE}/api/graph/stats`);
      expect(result.entity_count).toBe(10);
    });
  });

  describe("getContext", () => {
    it("GETs /api/inject", async () => {
      const { calls, fetch } = mockFetch([{ status: 200, body: { context: "## Memories\n", count: 3 } }]);
      const client = new MementosClient({ fetch });
      const result = await client.getContext({ agent_id: "agent-1", format: "markdown" });
      expect(calls[0]!.url).toContain("/api/inject");
      expect(calls[0]!.url).toContain("agent_id=agent-1");
      expect(result.context).toContain("Memories");
    });
  });

  describe("error handling", () => {
    it("throws MementosError on non-ok response", async () => {
      const { fetch } = mockFetch([{ status: 404, body: { error: "Memory not found" } }]);
      const client = new MementosClient({ fetch });
      await expect(client.getMemory("missing")).rejects.toThrow(MementosError);
    });

    it("MementosError has status and message", async () => {
      const { fetch } = mockFetch([{ status: 404, body: { error: "Memory not found" } }]);
      const client = new MementosClient({ fetch });
      try {
        await client.getMemory("missing");
        expect(false).toBe(true); // should not reach
      } catch (e) {
        expect(e).toBeInstanceOf(MementosError);
        expect((e as MementosError).status).toBe(404);
        expect((e as MementosError).message).toBe("Memory not found");
      }
    });

    it("throws MementosError with fallback message on non-JSON error", async () => {
      const { fetch } = mockFetch([{ status: 500, body: "Internal Server Error" }]);
      const client = new MementosClient({ fetch });
      try {
        await client.listMemories();
        expect(false).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(MementosError);
        expect((e as MementosError).status).toBe(500);
      }
    });
  });
});
