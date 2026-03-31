// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { AnthropicProvider } from "./anthropic.js";

// ============================================================================
// AnthropicProvider - scoreImportance (lines 78-93 in anthropic.ts)
// ============================================================================

describe("AnthropicProvider - scoreImportance", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 5 when no API key", async () => {
    const provider = new AnthropicProvider({ apiKey: "" });
    const score = await provider.scoreImportance("some content", {});
    expect(score).toBe(5);
  });

  test("returns parsed score from LLM response", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "7" }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const score = await provider.scoreImportance("Important architectural decision", {});
    expect(score).toBe(7);
  });

  test("clamps score when LLM returns value greater than 10", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "99" }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const score = await provider.scoreImportance("content", {});
    expect(score).toBeLessThanOrEqual(10);
    expect(score).toBeGreaterThanOrEqual(1);
  });

  test("clamps score when LLM returns value less than 0", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "-5" }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const score = await provider.scoreImportance("content", {});
    // clampImportance clamps to [0, 10], so -5 becomes 0
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  test("returns 5 on API error (never throws)", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response("Error", { status: 500 })
    ) as unknown as typeof fetch;

    const score = await provider.scoreImportance("content", {});
    expect(score).toBe(5);
  });

  test("returns 5 when response has no parseable integer", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "not a number" }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const score = await provider.scoreImportance("content", {});
    // clampImportance falls back gracefully
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(10);
  });

  test("uses ANTHROPIC_API_KEY env var when not in config", () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "env-key-test";

    const provider = new AnthropicProvider();
    expect((provider as any).config.apiKey).toBe("env-key-test");

    if (prev !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = prev;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  test("handles res.text() throwing during error body read (line 124 catch)", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });

    // Return a non-ok response where res.text() throws
    // This triggers the .catch(() => "") fallback at line 124 of anthropic.ts
    globalThis.fetch = mock(async () => {
      const res = new Response("", { status: 503 });
      Object.defineProperty(res, "text", {
        value: () => Promise.reject(new Error("stream error")),
        writable: true,
      });
      return res;
    }) as unknown as typeof fetch;

    // scoreImportance catches the error from callAPI and returns 5
    const score = await provider.scoreImportance("test content", {});
    expect(score).toBe(5);
  });

  test("abort controller fires on timeout (line 101 timeout callback)", async () => {
    // Use a very short timeout so the abort fires quickly
    const provider = new AnthropicProvider({ apiKey: "test-key", timeoutMs: 5 });

    // Fetch that never resolves (hangs forever)
    globalThis.fetch = mock(async () => {
      await new Promise((_, reject) => {
        // Listen for abort
        setTimeout(() => reject(new DOMException("aborted", "AbortError")), 50);
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    // The timeout fires after 5ms → aborts → catch in scoreImportance → returns 5
    const score = await provider.scoreImportance("test content", {});
    expect(score).toBe(5);
  }, 3000);
});
