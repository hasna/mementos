// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  cosineSimilarity,
  generateEmbedding,
  serializeEmbedding,
  deserializeEmbedding,
} from "./embeddings.js";

describe("cosineSimilarity", () => {
  test("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  test("returns 0 for zero-length vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  test("returns 0 when one vector is all zeros", () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  test("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 5);
  });

  test("returns value between -1 and 1", () => {
    const v1 = [0.5, 0.3, 0.8, 0.1];
    const v2 = [0.2, 0.9, 0.4, 0.7];
    const sim = cosineSimilarity(v1, v2);
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeLessThanOrEqual(1);
  });
});

describe("generateEmbedding", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalKey = process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) {
      process.env["OPENAI_API_KEY"] = originalKey;
    } else {
      delete process.env["OPENAI_API_KEY"];
    }
  });

  test("uses TF-IDF fallback when no API key", async () => {
    delete process.env["OPENAI_API_KEY"];

    const result = await generateEmbedding("hello world test");
    expect(result.model).toBe("tfidf-512");
    expect(result.dimensions).toBe(512);
    expect(result.embedding).toHaveLength(512);
  });

  test("TF-IDF fallback returns normalized vector", async () => {
    delete process.env["OPENAI_API_KEY"];

    const result = await generateEmbedding("typescript programming language");
    const norm = Math.sqrt(result.embedding.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  test("TF-IDF produces non-zero vector for non-empty text", async () => {
    delete process.env["OPENAI_API_KEY"];

    const result = await generateEmbedding("memory management systems");
    const hasNonZero = result.embedding.some((v) => v !== 0);
    expect(hasNonZero).toBe(true);
  });

  test("TF-IDF produces zero vector for empty text", async () => {
    delete process.env["OPENAI_API_KEY"];

    const result = await generateEmbedding("");
    // All zeros since no tokens
    const allZero = result.embedding.every((v) => v === 0);
    expect(allZero).toBe(true);
  });

  test("uses OpenAI when API key is present and returns embedding", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    const fakeEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ data: [{ embedding: fakeEmbedding }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const result = await generateEmbedding("test text");
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.dimensions).toBe(1536);
    expect(result.embedding).toHaveLength(1536);
    expect(result.embedding[0]).toBeCloseTo(0, 4);
  });

  test("falls back to TF-IDF when OpenAI API fails", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    globalThis.fetch = mock(async () =>
      new Response("Internal Server Error", { status: 500 })
    ) as unknown as typeof fetch;

    const result = await generateEmbedding("fallback test");
    expect(result.model).toBe("tfidf-512");
    expect(result.dimensions).toBe(512);
  });

  test("different texts produce different TF-IDF embeddings", async () => {
    delete process.env["OPENAI_API_KEY"];

    const r1 = await generateEmbedding("python programming language");
    const r2 = await generateEmbedding("typescript javascript web development");

    // They should not be identical
    const identical = r1.embedding.every((v, i) => v === r2.embedding[i]);
    expect(identical).toBe(false);
  });
});

describe("serializeEmbedding / deserializeEmbedding", () => {
  test("round-trips an embedding", () => {
    const original = [0.1, 0.2, 0.3, 0.4, 0.5];
    const serialized = serializeEmbedding(original);
    const deserialized = deserializeEmbedding(serialized);
    expect(deserialized).toEqual(original);
  });

  test("serialize returns a JSON string", () => {
    const emb = [1.0, 2.0, 3.0];
    const s = serializeEmbedding(emb);
    expect(typeof s).toBe("string");
    expect(() => JSON.parse(s)).not.toThrow();
  });

  test("deserialize handles large embedding arrays", () => {
    const large = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const s = serializeEmbedding(large);
    const back = deserializeEmbedding(s);
    expect(back).toHaveLength(1536);
    expect(back[0]).toBeCloseTo(large[0]!, 10);
  });
});
