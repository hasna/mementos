import { describe, test, expect } from "bun:test";
import {
  BaseProvider,
  type LLMProvider,
  type ProviderConfig,
  type ProviderName,
  type MemoryExtractionContext,
  type ExtractedMemory,
  type EntityExtractionResult,
  DEFAULT_AUTO_MEMORY_CONFIG,
  MEMORY_EXTRACTION_USER_TEMPLATE,
  ENTITY_EXTRACTION_USER_TEMPLATE,
} from "./base.js";

// Concrete implementation for testing abstract class
class TestProvider extends BaseProvider {
  readonly name: ProviderName = "openai";

  constructor(config?: Partial<ProviderConfig>) {
    super({
      apiKey: "test-key",
      model: "test-model",
      maxTokens: 1024,
      temperature: 0,
      timeoutMs: 15000,
      ...config,
    });
  }

  async extractMemories(_text: string, _context: MemoryExtractionContext): Promise<ExtractedMemory[]> {
    return [];
  }

  async extractEntities(_text: string): Promise<EntityExtractionResult> {
    return { entities: [], relations: [] };
  }

  async scoreImportance(_content: string, _context: MemoryExtractionContext): Promise<number> {
    return 5;
  }
}

describe("parseJSON", () => {
  const provider = new TestProvider();

  test("parses valid JSON", () => {
    const result = (provider as any).parseJSON('{"key":"value"}');
    expect(result).toEqual({ key: "value" });
  });

  test("strips markdown code fences", () => {
    const result = (provider as any).parseJSON('```json\n{"key":"value"}\n```');
    expect(result).toEqual({ key: "value" });
  });

  test("strips code fences without json tag", () => {
    const result = (provider as any).parseJSON('```\n{"key":"value"}\n```');
    expect(result).toEqual({ key: "value" });
  });

  test("parses array JSON", () => {
    const result = (provider as any).parseJSON('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  test("returns null for invalid JSON", () => {
    const result = (provider as any).parseJSON("not json at all");
    expect(result).toBeNull();
  });

  test("returns null for empty string", () => {
    const result = (provider as any).parseJSON("");
    expect(result).toBeNull();
  });
});

describe("clampImportance", () => {
  const provider = new TestProvider();

  test("clamps values above 10 to 10", () => {
    expect((provider as any).clampImportance(15)).toBe(10);
  });

  test("clamps values below 0 to 0", () => {
    expect((provider as any).clampImportance(-5)).toBe(0);
  });

  test("rounds decimal values", () => {
    expect((provider as any).clampImportance(7.8)).toBe(8);
  });

  test("returns 5 for NaN", () => {
    expect((provider as any).clampImportance("not a number")).toBe(5);
  });

  test("returns 5 for undefined", () => {
    expect((provider as any).clampImportance(undefined)).toBe(5);
  });

  test("passes through valid 0-10 values", () => {
    expect((provider as any).clampImportance(0)).toBe(0);
    expect((provider as any).clampImportance(5)).toBe(5);
    expect((provider as any).clampImportance(10)).toBe(10);
  });
});

describe("normaliseMemory", () => {
  const provider = new TestProvider();

  test("validates a well-formed memory", () => {
    const raw = {
      content: "My test memory",
      category: "fact",
      importance: 8,
      tags: ["test", "example"],
      suggestedScope: "shared",
      reasoning: "This is important",
    };
    const result = (provider as any).normaliseMemory(raw);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("My test memory");
    expect(result!.category).toBe("fact");
    expect(result!.importance).toBe(8);
    expect(result!.tags).toEqual(["test", "example"]);
    expect(result!.suggestedScope).toBe("shared");
    expect(result!.reasoning).toBe("This is important");
  });

  test("rejects null input", () => {
    expect((provider as any).normaliseMemory(null)).toBeNull();
  });

  test("rejects non-object input", () => {
    expect((provider as any).normaliseMemory("string")).toBeNull();
  });

  test("rejects empty content", () => {
    const raw = { content: "", category: "fact", importance: 5, tags: [] };
    expect((provider as any).normaliseMemory(raw)).toBeNull();
  });

  test("rejects whitespace-only content", () => {
    const raw = { content: "   ", category: "fact", importance: 5, tags: [] };
    expect((provider as any).normaliseMemory(raw)).toBeNull();
  });

  test("defaults invalid category to 'knowledge'", () => {
    const raw = { content: "test", category: "invalid", importance: 5, tags: [], suggestedScope: "shared" };
    const result = (provider as any).normaliseMemory(raw);
    expect(result!.category).toBe("knowledge");
  });

  test("defaults invalid scope to 'shared'", () => {
    const raw = { content: "test", category: "fact", importance: 5, tags: [], suggestedScope: "invalid" };
    const result = (provider as any).normaliseMemory(raw);
    expect(result!.suggestedScope).toBe("shared");
  });

  test("lowercases tags", () => {
    const raw = {
      content: "test",
      category: "knowledge",
      importance: 5,
      tags: ["UpperCase", "MIXEDCase", "lowercase"],
      suggestedScope: "shared",
    };
    const result = (provider as any).normaliseMemory(raw);
    expect(result!.tags).toEqual(["uppercase", "mixedcase", "lowercase"]);
  });

  test("filters non-string tags", () => {
    const raw = {
      content: "test",
      category: "knowledge",
      importance: 5,
      tags: ["valid", 123, null, "also-valid"],
      suggestedScope: "shared",
    };
    const result = (provider as any).normaliseMemory(raw);
    expect(result!.tags).toEqual(["valid", "also-valid"]);
  });

  test("handles missing reasoning", () => {
    const raw = { content: "test", category: "fact", importance: 5, tags: [], suggestedScope: "global" };
    const result = (provider as any).normaliseMemory(raw);
    expect(result!.reasoning).toBeUndefined();
  });

  test("clamps importance to 0-10", () => {
    const raw = { content: "test", category: "fact", importance: 20, tags: [], suggestedScope: "shared" };
    const result = (provider as any).normaliseMemory(raw);
    expect(result!.importance).toBe(10);
  });
});

describe("DEFAULT_AUTO_MEMORY_CONFIG", () => {
  test("has expected defaults", () => {
    expect(DEFAULT_AUTO_MEMORY_CONFIG.provider).toBe("anthropic");
    expect(DEFAULT_AUTO_MEMORY_CONFIG.enabled).toBe(true);
    expect(DEFAULT_AUTO_MEMORY_CONFIG.minImportance).toBe(4);
    expect(DEFAULT_AUTO_MEMORY_CONFIG.autoEntityLink).toBe(true);
    expect(DEFAULT_AUTO_MEMORY_CONFIG.fallback).toContain("cerebras");
    expect(DEFAULT_AUTO_MEMORY_CONFIG.fallback).toContain("openai");
  });
});

describe("extraction prompt templates", () => {
  test("MEMORY_EXTRACTION_USER_TEMPLATE includes text", () => {
    const result = MEMORY_EXTRACTION_USER_TEMPLATE("hello world", {});
    expect(result).toContain("hello world");
  });

  test("MEMORY_EXTRACTION_USER_TEMPLATE includes project name", () => {
    const result = MEMORY_EXTRACTION_USER_TEMPLATE("hello", { projectName: "my-project" });
    expect(result).toContain("my-project");
  });

  test("MEMORY_EXTRACTION_USER_TEMPLATE includes existing memories summary", () => {
    const result = MEMORY_EXTRACTION_USER_TEMPLATE("hello", { existingMemoriesSummary: "avoid these" });
    expect(result).toContain("avoid these");
  });

  test("ENTITY_EXTRACTION_USER_TEMPLATE includes text", () => {
    const result = ENTITY_EXTRACTION_USER_TEMPLATE("find entities here");
    expect(result).toContain("find entities here");
  });
});
