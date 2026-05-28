import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { broadcastSharedMemory } from "./memory-broadcast.js";
import type { Memory } from "../types/index.js";

function mockMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: "mem-1",
    key: "shared-fact",
    value: "Use Bun for all scripts",
    category: "fact",
    scope: "shared",
    summary: null,
    tags: [],
    importance: 8,
    source: "agent",
    status: "active",
    pinned: false,
    agent_id: "agent-a",
    project_id: "proj-1",
    session_id: null,
    metadata: {},
    access_count: 0,
    version: 1,
    expires_at: null,
    valid_from: null,
    valid_until: null,
    ingested_at: null,
    created_at: now,
    updated_at: now,
    accessed_at: null,
    ...overrides,
  };
}

describe("broadcastSharedMemory", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns immediately when memory has no project_id", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;

    await broadcastSharedMemory(mockMemory({ project_id: null }), "agent-a");
    expect(called).toBe(false);
  });

  it("notifies other active agents on the project", async () => {
    const requests: { url: string; body?: string }[] = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, body: init?.body as string | undefined });

      if (url.includes("/api/v1/agents")) {
        return Response.json({
          agents: [
            { id: "agent-a", name: "A" },
            { id: "agent-b", name: "B" },
          ],
        });
      }

      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    await broadcastSharedMemory(mockMemory(), "agent-a");

    expect(requests.some((r) => r.url.includes("/api/v1/agents"))).toBe(true);
    expect(requests.some((r) => r.url.includes("/api/v1/messages"))).toBe(true);
    const messageReq = requests.find((r) => r.url.includes("/api/v1/messages"));
    expect(messageReq?.body).toContain("shared-fact");
    expect(messageReq?.body).toContain("agent-b");
    expect(messageReq?.body).not.toContain('"to":"agent-a"');
  });

  it("fails silently when conversations service is unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    await expect(broadcastSharedMemory(mockMemory(), "agent-a")).resolves.toBeUndefined();
  });
});
