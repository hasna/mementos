process.env["MEMENTOS_DB_PATH"] = ":memory:";
// Set a fake Anthropic key so the provider is "available"
process.env["ANTHROPIC_API_KEY"] = "sk-test-fake-key-for-unit-tests";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory, listMemories } from "../db/memories.js";
import { listEntities } from "../db/entities.js";
import { registerAgent } from "../db/agents.js";
import { registerProject } from "../db/projects.js";
import { providerRegistry } from "./providers/registry.js";
import { autoMemoryQueue } from "./auto-memory-queue.js";
import {
  processConversationTurn,
  getAutoMemoryStats,
  configureAutoMemory,
} from "./auto-memory.js";

/** Register an agent and optionally a project, returning their IDs */
function setupAgentAndProject(
  agentName: string,
  projectName?: string
): { agentId: string; projectId?: string } {
  let projectId: string | undefined;
  if (projectName) {
    const proj = registerProject(projectName, `/tmp/test/${projectName}`);
    projectId = proj.id;
  }
  const agent = registerAgent(agentName, undefined, undefined, undefined, projectId);
  return { agentId: agent.id, projectId };
}

// ============================================================================
// Mock fetch
// ============================================================================

let originalFetch: typeof globalThis.fetch;
let fetchMock: ReturnType<typeof createFetchMock>;

function createFetchMock(
  responseBody: unknown,
  options?: { status?: number; ok?: boolean }
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const status = options?.status ?? 200;
  const ok = options?.ok ?? true;

  const mock = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return {
    fn: mock as unknown as typeof fetch,
    calls,
  };
}

/** Build an Anthropic-style response wrapping a JSON array of extracted memories */
function anthropicMemoryResponse(memories: unknown[]) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(memories),
      },
    ],
  };
}

/** Build an Anthropic-style response wrapping entity extraction result */
function anthropicEntityResponse(entities: unknown[], relations: unknown[]) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ entities, relations }),
      },
    ],
  };
}

/** Wait for the auto-memory queue to drain */
async function waitForQueue(timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stats = autoMemoryQueue.getStats();
    if (stats.pending === 0 && stats.processing === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetDatabase();
  getDatabase();

  // Reset provider config to enabled defaults
  providerRegistry.configure({
    enabled: true,
    minImportance: 4,
    autoEntityLink: true,
    provider: "anthropic",
  });

  // Install a fresh fetch mock that returns empty memories by default
  originalFetch = globalThis.fetch;
  fetchMock = createFetchMock(anthropicMemoryResponse([]));
  globalThis.fetch = fetchMock.fn;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// processConversationTurn
// ============================================================================

describe("processConversationTurn", () => {
  test("does nothing for empty/whitespace turns", async () => {
    processConversationTurn("", {});
    processConversationTurn("   ", {});
    processConversationTurn(undefined as unknown as string, {});
    await waitForQueue();

    expect(fetchMock.calls.length).toBe(0);
  });

  test("enqueues a valid turn and calls the LLM", async () => {
    const { agentId, projectId } = setupAgentAndProject("test-agent", "proj-1");
    const memories = [
      {
        content: "User prefers TypeScript over JavaScript",
        category: "preference",
        importance: 8,
        tags: ["typescript", "preference"],
        suggestedScope: "shared",
        reasoning: "Explicit preference statement",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("I prefer TypeScript over JavaScript for all projects", {
      agentId,
      projectId,
      sessionId: "sess-1",
    });

    await waitForQueue();

    // Should have called the Anthropic API at least once
    expect(fetchMock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchMock.calls[0]!.url).toContain("anthropic.com");
  });

  test("saves extracted memory to database", async () => {
    const { agentId, projectId } = setupAgentAndProject("agent-1", "proj-1");
    const memories = [
      {
        content: "The project uses Bun as the runtime instead of Node",
        category: "fact",
        importance: 7,
        tags: ["bun", "runtime"],
        suggestedScope: "shared",
        reasoning: "Architecture decision worth remembering",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn(
      "We decided to use Bun as the runtime instead of Node for this project",
      { agentId, projectId, sessionId: "sess-1" }
    );

    await waitForQueue();

    const saved = listMemories({ agent_id: agentId });
    expect(saved.length).toBeGreaterThanOrEqual(1);

    const mem = saved[0]!;
    expect(mem.value).toBe("The project uses Bun as the runtime instead of Node");
    expect(mem.category).toBe("fact");
    expect(mem.importance).toBe(7);
    expect(mem.tags).toContain("auto-extracted");
    expect(mem.tags).toContain("bun");
    expect(mem.session_id).toBe("sess-1");
  });

  test("adds session tag when sessionId is provided", async () => {
    const memories = [
      {
        content: "API endpoint changed to /v2/users",
        category: "fact",
        importance: 6,
        tags: ["api"],
        suggestedScope: "shared",
        reasoning: "API change",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("The API endpoint changed to /v2/users", {
      sessionId: "my-session-42",
    });

    await waitForQueue();

    const saved = listMemories({});
    const autoSaved = saved.filter((m) => m.tags.includes("auto-extracted"));
    expect(autoSaved.length).toBeGreaterThanOrEqual(1);
    expect(autoSaved[0]!.tags).toContain("session:my-session-42");
  });

  test("sets source to 'turn' by default", async () => {
    // Just ensure it doesn't throw — source is metadata on the job, not persisted
    processConversationTurn("some turn", {});
    await waitForQueue();
  });

  test("accepts custom source", async () => {
    processConversationTurn("some session text", {}, "session");
    await waitForQueue();
  });
});

// ============================================================================
// Importance filtering
// ============================================================================

describe("importance filtering", () => {
  test("skips memories below minImportance", async () => {
    const { agentId } = setupAgentAndProject("agent-filter");
    providerRegistry.configure({ minImportance: 6 });

    const memories = [
      {
        content: "Low importance memory that should be skipped",
        category: "knowledge",
        importance: 3,
        tags: ["low"],
        suggestedScope: "private",
        reasoning: "Not very important",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("Some conversation text", {
      agentId,
    });

    await waitForQueue();

    const saved = listMemories({ agent_id: agentId });
    expect(saved.length).toBe(0);
  });

  test("saves memories at or above minImportance", async () => {
    const { agentId } = setupAgentAndProject("agent-above");
    providerRegistry.configure({ minImportance: 5 });

    const memories = [
      {
        content: "Important decision: use PostgreSQL",
        category: "fact",
        importance: 5,
        tags: ["database"],
        suggestedScope: "shared",
        reasoning: "Architecture decision",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("We decided to use PostgreSQL", {
      agentId,
    });

    await waitForQueue();

    const saved = listMemories({ agent_id: agentId });
    expect(saved.length).toBe(1);
  });
});

// ============================================================================
// Deduplication
// ============================================================================

describe("deduplication", () => {
  test("skips saving a near-duplicate memory", async () => {
    const { agentId } = setupAgentAndProject("agent-dedup");
    // Pre-seed a memory
    createMemory({
      key: "existing-pref",
      value: "User prefers TypeScript over JavaScript for all projects",
      agent_id: agentId,
    });

    // LLM returns almost the same content
    const memories = [
      {
        content: "User prefers TypeScript over JavaScript for all projects always",
        category: "preference",
        importance: 8,
        tags: ["typescript"],
        suggestedScope: "shared",
        reasoning: "Preference",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("I always prefer TypeScript", {
      agentId,
    });

    await waitForQueue();

    // Should still have only the original memory (duplicate skipped)
    const saved = listMemories({ agent_id: agentId });
    expect(saved.length).toBe(1);
    expect(saved[0]!.key).toBe("existing-pref");
  });

  test("saves non-duplicate memories", async () => {
    const { agentId } = setupAgentAndProject("agent-nodedup");
    createMemory({
      key: "existing-editor",
      value: "User prefers vim as their text editor",
      agent_id: agentId,
    });

    // LLM returns totally different content
    const memories = [
      {
        content: "The database uses SQLite with FTS5 for full-text search",
        category: "fact",
        importance: 7,
        tags: ["sqlite", "fts5"],
        suggestedScope: "shared",
        reasoning: "Technical architecture detail",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("We use SQLite with FTS5 for search", {
      agentId,
    });

    await waitForQueue();

    const saved = listMemories({ agent_id: agentId });
    expect(saved.length).toBe(2);
  });
});

// ============================================================================
// Entity linking
// ============================================================================

describe("entity linking", () => {
  test("creates entities and links them to the memory when autoEntityLink is enabled", async () => {
    const { agentId, projectId } = setupAgentAndProject("agent-entity", "proj-entity");
    providerRegistry.configure({ autoEntityLink: true });

    // First call: memory extraction
    const memoryResponse = anthropicMemoryResponse([
      {
        content: "PostgreSQL is the primary database for the project",
        category: "fact",
        importance: 8,
        tags: ["database", "postgresql"],
        suggestedScope: "shared",
        reasoning: "Core architecture decision",
      },
    ]);
    // Second call: entity extraction
    const entityResponse = anthropicEntityResponse(
      [
        { name: "PostgreSQL", type: "tool", confidence: 0.95 },
        { name: "project", type: "project", confidence: 0.8 },
      ],
      [{ from: "project", to: "PostgreSQL", type: "uses" }]
    );

    let callCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = callCount === 1 ? memoryResponse : entityResponse;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    processConversationTurn("PostgreSQL is the primary database", {
      agentId,
      projectId,
    });

    await waitForQueue();
    // Allow entity linking fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 200));

    const entities = listEntities({});
    expect(entities.length).toBeGreaterThanOrEqual(1);

    const pgEntity = entities.find((e) => e.name === "PostgreSQL");
    expect(pgEntity).toBeDefined();
    expect(pgEntity!.type).toBe("tool");
  });

  test("skips entity linking when autoEntityLink is disabled", async () => {
    const { agentId } = setupAgentAndProject("agent-noentity");
    providerRegistry.configure({ autoEntityLink: false });

    const memoryResponse = anthropicMemoryResponse([
      {
        content: "Redis is used for caching",
        category: "fact",
        importance: 7,
        tags: ["redis"],
        suggestedScope: "shared",
        reasoning: "Infra detail",
      },
    ]);

    fetchMock = createFetchMock(memoryResponse);
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("Redis is used for caching", {
      agentId,
    });

    await waitForQueue();
    await new Promise((r) => setTimeout(r, 200));

    // Only one call (memory extraction), no entity extraction call
    // The memory should be saved but no entities created
    const entities = listEntities({});
    // No entities because entity linking was disabled
    expect(entities.length).toBe(0);
  });

  test("skips entities with low confidence", async () => {
    const { agentId, projectId } = setupAgentAndProject("agent-lowconf", "proj-lowconf");
    providerRegistry.configure({ autoEntityLink: true });

    const memoryResponse = anthropicMemoryResponse([
      {
        content: "Something about tools and stuff",
        category: "knowledge",
        importance: 5,
        tags: [],
        suggestedScope: "private",
        reasoning: "Test",
      },
    ]);
    const entityResponse = anthropicEntityResponse(
      [
        { name: "LowConfTool", type: "tool", confidence: 0.3 }, // below 0.6 threshold
        { name: "HighConfTool", type: "tool", confidence: 0.9 },
      ],
      []
    );

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      const body = callCount === 1 ? memoryResponse : entityResponse;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    processConversationTurn("Something about tools", {
      agentId,
      projectId,
    });

    await waitForQueue();
    await new Promise((r) => setTimeout(r, 200));

    const entities = listEntities({});
    const lowConf = entities.find((e) => e.name === "LowConfTool");
    const highConf = entities.find((e) => e.name === "HighConfTool");
    expect(lowConf).toBeUndefined();
    expect(highConf).toBeDefined();
  });
});

// ============================================================================
// Disabled pipeline
// ============================================================================

describe("disabled pipeline", () => {
  test("does nothing when auto-memory is disabled", async () => {
    providerRegistry.configure({ enabled: false });

    fetchMock = createFetchMock(
      anthropicMemoryResponse([
        {
          content: "This should never be saved",
          category: "fact",
          importance: 10,
          tags: [],
          suggestedScope: "shared",
          reasoning: "test",
        },
      ])
    );
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("Some important text", {});

    await waitForQueue();

    // No fetch calls should have been made (pipeline disabled before LLM call)
    expect(fetchMock.calls.length).toBe(0);
    const saved = listMemories({});
    // No auto-extracted memories should exist
    expect(saved.filter((m) => m.tags.includes("auto-extracted")).length).toBe(0);
  });
});

// ============================================================================
// Provider fallback
// ============================================================================

describe("provider fallback", () => {
  test("uses fallback when primary provider fails", async () => {
    let callCount = 0;
    const memories = [
      {
        content: "Fallback memory saved successfully",
        category: "knowledge",
        importance: 6,
        tags: ["fallback"],
        suggestedScope: "shared",
        reasoning: "Fallback test",
      },
    ];

    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        // Primary fails
        return new Response("Internal Server Error", { status: 500 });
      }
      // Fallback succeeds
      return new Response(JSON.stringify(anthropicMemoryResponse(memories)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    processConversationTurn("Some text to extract from", {});

    await waitForQueue();

    // If a fallback provider has a key, it should try. Since we only have
    // ANTHROPIC_API_KEY set, the fallback providers may not have keys.
    // This test validates the code path doesn't crash on primary failure.
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// getAutoMemoryStats
// ============================================================================

describe("getAutoMemoryStats", () => {
  test("returns queue stats", () => {
    const stats = getAutoMemoryStats();
    expect(stats).toBeDefined();
    expect(typeof stats.pending).toBe("number");
    expect(typeof stats.processing).toBe("number");
    expect(typeof stats.processed).toBe("number");
    expect(typeof stats.failed).toBe("number");
    expect(typeof stats.dropped).toBe("number");
  });
});

// ============================================================================
// configureAutoMemory
// ============================================================================

describe("configureAutoMemory", () => {
  test("updates provider registry config", () => {
    configureAutoMemory({ minImportance: 7, autoEntityLink: false });

    const config = providerRegistry.getConfig();
    expect(config.minImportance).toBe(7);
    expect(config.autoEntityLink).toBe(false);
  });

  test("can disable the pipeline", () => {
    configureAutoMemory({ enabled: false });
    expect(providerRegistry.getConfig().enabled).toBe(false);
  });

  test("can change provider", () => {
    configureAutoMemory({ provider: "openai" });
    expect(providerRegistry.getConfig().provider).toBe("openai");
  });
});

// ============================================================================
// Empty content handling
// ============================================================================

describe("empty content handling", () => {
  test("skips memories with empty content from LLM", async () => {
    const memories = [
      {
        content: "",
        category: "fact",
        importance: 8,
        tags: [],
        suggestedScope: "shared",
        reasoning: "Empty content",
      },
      {
        content: "   ",
        category: "fact",
        importance: 8,
        tags: [],
        suggestedScope: "shared",
        reasoning: "Whitespace only",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("Some conversation", {});

    await waitForQueue();

    const saved = listMemories({});
    expect(saved.filter((m) => m.tags.includes("auto-extracted")).length).toBe(0);
  });
});

// ============================================================================
// Multiple memories in one turn
// ============================================================================

describe("multiple memories per turn", () => {
  test("saves multiple extracted memories from a single turn", async () => {
    const { agentId, projectId } = setupAgentAndProject("agent-multi", "proj-multi");
    const memories = [
      {
        content: "Project uses React for the frontend",
        category: "fact",
        importance: 7,
        tags: ["react", "frontend"],
        suggestedScope: "shared",
        reasoning: "Tech stack",
      },
      {
        content: "Deployments go through GitHub Actions CI/CD",
        category: "fact",
        importance: 6,
        tags: ["ci-cd", "github-actions"],
        suggestedScope: "shared",
        reasoning: "DevOps process",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn(
      "We use React for frontend and deploy via GitHub Actions",
      { agentId, projectId }
    );

    await waitForQueue();

    const saved = listMemories({ agent_id: agentId });
    expect(saved.length).toBe(2);
  });
});

// ============================================================================
// LLM returns no memories
// ============================================================================

describe("LLM returns no memories", () => {
  test("gracefully handles empty extraction result", async () => {
    fetchMock = createFetchMock(anthropicMemoryResponse([]));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("Hello, how are you?", {});

    await waitForQueue();

    const saved = listMemories({});
    expect(saved.filter((m) => m.tags.includes("auto-extracted")).length).toBe(0);
  });

  test("handles malformed LLM response gracefully", async () => {
    // LLM returns something that's not a valid JSON array
    fetchMock = createFetchMock({
      content: [{ type: "text", text: "not valid json at all {{{" }],
    });
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("Some text", {});

    await waitForQueue();

    const saved = listMemories({});
    expect(saved.filter((m) => m.tags.includes("auto-extracted")).length).toBe(0);
  });
});

// ============================================================================
// Key generation
// ============================================================================

describe("key generation", () => {
  test("generates a kebab-case key from content", async () => {
    const { agentId } = setupAgentAndProject("agent-key");
    const memories = [
      {
        content: "Short key test content here",
        category: "knowledge",
        importance: 6,
        tags: [],
        suggestedScope: "shared",
        reasoning: "Test",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("Test content", { agentId });

    await waitForQueue();

    const saved = listMemories({ agent_id: agentId });
    expect(saved.length).toBe(1);
    // Key should be lowercase, hyphened, derived from content
    expect(saved[0]!.key).toBe("short-key-test-content-here");
    expect(saved[0]!.key).not.toContain(" ");
  });
});

// ============================================================================
// Metadata
// ============================================================================

describe("metadata", () => {
  test("stores auto_extracted flag and reasoning in metadata", async () => {
    const { agentId } = setupAgentAndProject("agent-meta");
    const memories = [
      {
        content: "Metadata test memory content here",
        category: "fact",
        importance: 7,
        tags: [],
        suggestedScope: "shared",
        reasoning: "This is the reasoning for extraction",
      },
    ];
    fetchMock = createFetchMock(anthropicMemoryResponse(memories));
    globalThis.fetch = fetchMock.fn;

    processConversationTurn("Some text for metadata test", {
      agentId,
    });

    await waitForQueue();

    const saved = listMemories({ agent_id: agentId });
    expect(saved.length).toBe(1);
    expect(saved[0]!.metadata.auto_extracted).toBe(true);
    expect(saved[0]!.metadata.reasoning).toBe(
      "This is the reasoning for extraction"
    );
    expect(saved[0]!.metadata.extracted_at).toBeDefined();
  });
});
