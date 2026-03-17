/**
 * Tests for LLM provider abstraction, registry, queue, and pipeline.
 * ALL external API calls are mocked — no real LLM calls in tests.
 */

process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { CerebrasProvider } from "./cerebras.js";
import { GrokProvider } from "./grok.js";
import { providerRegistry } from "./registry.js";
import { autoMemoryQueue } from "../auto-memory-queue.js";
import { dedup, getDedupStats, resetDedupStats } from "../dedup.js";
import { resetDatabase } from "../../db/database.js";
import type { ExtractedMemory, EntityExtractionResult } from "./base.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_MEMORIES: ExtractedMemory[] = [
  {
    content: "User prefers TypeScript strict mode",
    category: "preference",
    importance: 8,
    tags: ["typescript", "config"],
    suggestedScope: "shared",
    reasoning: "Stated preference for strict TS",
  },
];

const MOCK_ENTITIES: EntityExtractionResult = {
  entities: [
    { name: "TypeScript", type: "tool", confidence: 0.95 },
    { name: "open-mementos", type: "project", confidence: 0.9 },
  ],
  relations: [
    { from: "open-mementos", to: "TypeScript", type: "uses" },
  ],
};

function mockFetchSuccess(body: unknown) {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
}

function mockFetchError(status: number) {
  return mock(() =>
    Promise.resolve(new Response("error", { status }))
  );
}

// ─── Provider interface compliance ───────────────────────────────────────────

describe("AnthropicProvider", () => {
  test("returns [] when no API key", async () => {
    const provider = new AnthropicProvider({ apiKey: "" });
    const result = await provider.extractMemories("test", {});
    expect(result).toEqual([]);
  });

  test("extractMemories parses valid JSON response", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    global.fetch = mockFetchSuccess({
      content: [{ type: "text", text: JSON.stringify(MOCK_MEMORIES) }],
    });
    const result = await provider.extractMemories("User likes TypeScript strict mode", {});
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("User prefers TypeScript strict mode");
    expect(result[0]?.importance).toBe(8);
  });

  test("returns [] on API error, never throws", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    global.fetch = mockFetchError(500);
    const result = await provider.extractMemories("test", {});
    expect(result).toEqual([]);
  });

  test("extractEntities parses valid response", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    global.fetch = mockFetchSuccess({
      content: [{ type: "text", text: JSON.stringify(MOCK_ENTITIES) }],
    });
    const result = await provider.extractEntities("open-mementos uses TypeScript");
    expect(result.entities).toHaveLength(2);
    expect(result.relations).toHaveLength(1);
  });

  test("extractEntities returns empty on error, never throws", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    global.fetch = mockFetchError(429);
    const result = await provider.extractEntities("test");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });

  test("normaliseMemory filters invalid entries", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const badResponse = [
      { content: "", importance: 5, category: "fact", tags: [], suggestedScope: "shared" }, // empty content
      { importance: 5 }, // missing content
      MOCK_MEMORIES[0], // valid
    ];
    global.fetch = mockFetchSuccess({
      content: [{ type: "text", text: JSON.stringify(badResponse) }],
    });
    const result = await provider.extractMemories("test", {});
    expect(result).toHaveLength(1);
  });

  test("strips markdown code fences from response", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    global.fetch = mockFetchSuccess({
      content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(MOCK_MEMORIES)}\n\`\`\`` }],
    });
    const result = await provider.extractMemories("test", {});
    expect(result).toHaveLength(1);
  });
});

describe("OpenAI-compatible providers (OpenAI, Cerebras, Grok)", () => {
  const providers = [
    new OpenAIProvider({ apiKey: "test-key" }),
    new CerebrasProvider({ apiKey: "test-key" }),
    new GrokProvider({ apiKey: "test-key" }),
  ];

  for (const provider of providers) {
    test(`${provider.name}: returns [] with no key`, async () => {
      const p = provider.constructor === OpenAIProvider
        ? new OpenAIProvider({ apiKey: "" })
        : provider.constructor === CerebrasProvider
        ? new CerebrasProvider({ apiKey: "" })
        : new GrokProvider({ apiKey: "" });
      const result = await p.extractMemories("test", {});
      expect(result).toEqual([]);
    });

    test(`${provider.name}: parses valid chat/completions response`, async () => {
      global.fetch = mockFetchSuccess({
        choices: [{ message: { content: JSON.stringify(MOCK_MEMORIES) } }],
      });
      const result = await provider.extractMemories("test", {});
      expect(result).toHaveLength(1);
    });

    test(`${provider.name}: returns [] on 500, never throws`, async () => {
      global.fetch = mockFetchError(500);
      const result = await provider.extractMemories("test", {});
      expect(result).toEqual([]);
    });
  }
});

// ─── Provider registry ───────────────────────────────────────────────────────

describe("ProviderRegistry", () => {
  test("getAvailable returns null when no keys set", () => {
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
    const originalXAIKey = process.env.XAI_API_KEY;

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    delete process.env.XAI_API_KEY;

    // Force re-configure with no keys
    providerRegistry.configure({ provider: "anthropic", fallback: [] });
    const result = providerRegistry.getAvailable();
    expect(result).toBeNull();

    // Restore
    if (originalAnthropicKey) process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalOpenAIKey) process.env.OPENAI_API_KEY = originalOpenAIKey;
    if (originalCerebrasKey) process.env.CEREBRAS_API_KEY = originalCerebrasKey;
    if (originalXAIKey) process.env.XAI_API_KEY = originalXAIKey;
  });

  test("configure updates provider at runtime", () => {
    providerRegistry.configure({ provider: "openai", model: "gpt-4.1-nano" });
    expect(providerRegistry.getConfig().provider).toBe("openai");
    expect(providerRegistry.getConfig().model).toBe("gpt-4.1-nano");
    // Reset
    providerRegistry.configure({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("health returns status for all providers", () => {
    const health = providerRegistry.health();
    expect(health).toHaveProperty("anthropic");
    expect(health).toHaveProperty("openai");
    expect(health).toHaveProperty("cerebras");
    expect(health).toHaveProperty("grok");
    for (const info of Object.values(health)) {
      expect(typeof info.available).toBe("boolean");
      expect(typeof info.model).toBe("string");
    }
  });
});

// ─── Async queue ─────────────────────────────────────────────────────────────

describe("AutoMemoryQueue", () => {
  test("enqueue returns immediately (fire-and-forget)", () => {
    const start = Date.now();
    autoMemoryQueue.enqueue({ turn: "test", timestamp: Date.now() });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50); // should be near-instant
  });

  test("stats includes pending and processed counts", () => {
    const stats = autoMemoryQueue.getStats();
    expect(typeof stats.pending).toBe("number");
    expect(typeof stats.processed).toBe("number");
    expect(typeof stats.failed).toBe("number");
    expect(typeof stats.dropped).toBe("number");
  });

  test("overflow drops oldest job when queue full", () => {
    // Enqueue 102 jobs (max 100) — 2 should be dropped
    const before = autoMemoryQueue.getStats().dropped;
    for (let i = 0; i < 102; i++) {
      autoMemoryQueue.enqueue({ turn: `job-${i}`, timestamp: Date.now() });
    }
    const after = autoMemoryQueue.getStats();
    expect(after.dropped).toBeGreaterThanOrEqual(before + 2);
  });

  test("handler failure increments failed counter, never throws", async () => {
    const failingHandler = mock(async () => {
      throw new Error("Simulated failure");
    });
    autoMemoryQueue.setHandler(failingHandler);
    const before = autoMemoryQueue.getStats().failed;
    autoMemoryQueue.enqueue({ turn: "fail-test", timestamp: Date.now() });
    // Give the queue time to process
    await new Promise((r) => setTimeout(r, 100));
    const after = autoMemoryQueue.getStats();
    expect(after.failed).toBeGreaterThan(before);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────────

describe("Dedup", () => {
  beforeEach(() => {
    resetDatabase();
    resetDedupStats();
  });

  test("returns 'save' for unique content", () => {
    const result = dedup("This is a completely unique memory about TypeScript", {});
    expect(result).toBe("save");
  });

  test("tracks checked count in stats", () => {
    dedup("some content to check", {});
    const stats = getDedupStats();
    expect(stats.checked).toBeGreaterThan(0);
  });

  test("returns 'save' when no existing memories", () => {
    const result = dedup("brand new memory content here", { agent_id: "test-agent" });
    expect(result).toBe("save");
  });
});
