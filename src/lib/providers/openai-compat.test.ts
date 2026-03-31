// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { OpenAIProvider } from "./openai.js";
import { CerebrasProvider } from "./cerebras.js";
import { GrokProvider } from "./grok.js";
import type { MemoryExtractionContext } from "./base.js";

// ============================================================================
// OpenAI-compat provider: scoreImportance and retry logic
// ============================================================================

describe("OpenAICompatProvider - scoreImportance", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 5 when no API key", async () => {
    const provider = new OpenAIProvider({ apiKey: "" });
    const score = await provider.scoreImportance("some content", {});
    expect(score).toBe(5);
  });

  test("returns parsed score from LLM response", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "8" } }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const score = await provider.scoreImportance("Very important technical decision", {});
    expect(score).toBe(8);
  });

  test("clamps score to 10 if LLM returns out-of-range value", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "15" } }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const score = await provider.scoreImportance("content", {});
    expect(score).toBeLessThanOrEqual(10);
    expect(score).toBeGreaterThanOrEqual(1);
  });

  test("returns 5 on API error", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response("Server Error", { status: 500 })
    ) as unknown as typeof fetch;

    const score = await provider.scoreImportance("content", {});
    expect(score).toBe(5);
  });

  test("scoreImportance works for Cerebras provider", async () => {
    const provider = new CerebrasProvider({ apiKey: "" });
    const score = await provider.scoreImportance("content", {});
    expect(score).toBe(5);
  });

  test("scoreImportance works for Grok provider", async () => {
    const provider = new GrokProvider({ apiKey: "" });
    const score = await provider.scoreImportance("content", {});
    expect(score).toBe(5);
  });
});

describe("OpenAICompatProvider - extractMemories retry on 429", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("extractMemories returns [] when all retries return 429", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response("Too Many Requests", { status: 429 })
    ) as unknown as typeof fetch;

    // extractMemories catches the error and returns [] — never throws
    const result = await provider.extractMemories("test", {});
    expect(result).toEqual([]);
  }, 15000);
});

describe("OpenAICompatProvider - extractMemories with valid response (lines 39-40)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns extracted memories from valid JSON array response (lines 39-40)", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-4o" });

    const mockMemories = [
      {
        content: "User prefers TypeScript over JavaScript",
        category: "preference",
        importance: 8,
        tags: ["typescript", "javascript"],
        suggestedScope: "shared",
        reasoning: "This is a clear user preference stated explicitly",
      },
      {
        content: "Project uses Bun as the runtime",
        category: "fact",
        importance: 9,
        tags: ["bun", "runtime"],
        suggestedScope: "shared",
      },
    ];

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(mockMemories) } }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const context: MemoryExtractionContext = { agentId: "test-agent", projectName: "test-project" };
    const result = await provider.extractMemories("Test conversation text", context);

    // Lines 39-40: parsed array is mapped through normaliseMemory and filtered
    expect(result.length).toBe(2);
    expect(result[0]!.content).toBe("User prefers TypeScript over JavaScript");
    expect(result[0]!.category).toBe("preference");
    expect(result[0]!.importance).toBe(8);
    expect(result[1]!.content).toBe("Project uses Bun as the runtime");
  });

  test("filters out null entries from normaliseMemory (lines 39-41)", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-4o" });

    // Mix of valid and invalid memory objects
    const mockMemories = [
      { content: "Valid memory", category: "knowledge", importance: 5, tags: [], suggestedScope: "shared" },
      null, // normaliseMemory returns null for null
      { content: "", category: "knowledge", importance: 5, tags: [], suggestedScope: "shared" }, // empty content → null
      "not an object", // normaliseMemory returns null for non-objects
    ];

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(mockMemories) } }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await provider.extractMemories("test text", {});
    // Only the first entry is valid — null/invalid entries are filtered out
    expect(result.length).toBe(1);
    expect(result[0]!.content).toBe("Valid memory");
  });
});

describe("OpenAICompatProvider - extractEntities", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns empty when no API key", async () => {
    const provider = new OpenAIProvider({ apiKey: "" });
    const result = await provider.extractEntities("test");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });

  test("parses entities and relations from valid response", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    const mockData = {
      entities: [
        { name: "TypeScript", type: "tool", confidence: 0.95 },
      ],
      relations: [
        { from: "TypeScript", to: "JavaScript", type: "extends" },
      ],
    };

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(mockData) } }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await provider.extractEntities("TypeScript extends JavaScript");
    expect(result.entities).toHaveLength(1);
    expect(result.relations).toHaveLength(1);
    expect(result.entities[0]?.name).toBe("TypeScript");
  });

  test("returns empty on API error", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response("error", { status: 500 })
    ) as unknown as typeof fetch;

    const result = await provider.extractEntities("test");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });

  test("handles invalid/non-object JSON response gracefully", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await provider.extractEntities("test");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });
});

// ============================================================================
// callAPI: res.text().catch(() => "") on non-ok response when text() throws (line 137)
// ============================================================================

describe("OpenAICompatProvider - callAPI res.text catch fallback (line 137)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("handles res.text() throwing during error body read (line 137 catch)", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-4o" });

    // Return a non-ok response where res.text() throws
    // This triggers the .catch(() => "") fallback at line 137
    globalThis.fetch = mock(async () => {
      const res = new Response("", { status: 503 });
      // Override text() to throw
      const origText = res.text.bind(res);
      Object.defineProperty(res, "text", {
        value: () => Promise.reject(new Error("stream error")),
        writable: true,
      });
      return res;
    }) as unknown as typeof fetch;

    // extractMemories catches the error and returns []
    const result = await provider.extractMemories("test", {});
    expect(result).toEqual([]);
  });
});
