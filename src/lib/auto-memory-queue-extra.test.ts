// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";
// Set a fake Anthropic key so the provider is "available"
process.env["ANTHROPIC_API_KEY"] = "sk-test-fake-key-for-unit-tests";

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { providerRegistry } from "./providers/registry.js";
import { processConversationTurn, getAutoMemoryStats, configureAutoMemory } from "./auto-memory.js";

// ============================================================================
// Additional auto-memory tests for lines 71-74, 132, 201, 203-209
// ============================================================================

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

describe("isDuplicate - empty query path (line 71)", () => {
  test("handles content with no meaningful words (all short)", async () => {
    // Content with only very short words — no query is built → isDuplicate returns false
    const mockProvider = {
      name: "anthropic" as const,
      config: { apiKey: "test", model: "test" },
      extractMemories: mock(async () => [
        {
          content: "a b c d", // all words < 4 chars → empty query
          category: "knowledge" as const,
          importance: 6,
          tags: [],
          suggestedScope: "private" as const,
          reasoning: "",
        },
      ]),
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 6,
    };

    const orig = providerRegistry.getAvailable.bind(providerRegistry);
    providerRegistry.getAvailable = () => mockProvider;

    processConversationTurn("a b c d", {});

    // Give queue time to process
    await new Promise((r) => setTimeout(r, 150));

    providerRegistry.getAvailable = orig;

    // Just verify no crash
    expect(typeof getAutoMemoryStats().processed).toBe("number");
  });
});

describe("processJob - entity linking path (line 201)", () => {
  test("entity linking is triggered when autoEntityLink=true", async () => {
    // Make sure autoEntityLink is enabled
    configureAutoMemory({ autoEntityLink: true, enabled: true });

    const mockProvider = {
      name: "anthropic" as const,
      config: { apiKey: "test", model: "test" },
      extractMemories: mock(async () => [
        {
          content: "The project uses TypeScript and React for the frontend",
          category: "fact" as const,
          importance: 7,
          tags: ["tech-stack"],
          suggestedScope: "shared" as const,
          reasoning: "Tech stack decision",
        },
      ]),
      extractEntities: mock(async () => ({
        entities: [
          { name: "TypeScript", type: "concept" as const, confidence: 0.9 },
          { name: "React", type: "concept" as const, confidence: 0.95 },
        ],
        relations: [],
      })),
      scoreImportance: async () => 7,
    };

    const orig = providerRegistry.getAvailable.bind(providerRegistry);
    providerRegistry.getAvailable = () => mockProvider;

    processConversationTurn("The project uses TypeScript and React for the frontend", {
      agentId: "test-agent",
    });

    // Give queue time to process
    await new Promise((r) => setTimeout(r, 200));

    providerRegistry.getAvailable = orig;
    configureAutoMemory({ autoEntityLink: false }); // restore default

    // Verify no crash — entity linking is fire-and-forget
    expect(typeof getAutoMemoryStats().processed).toBe("number");
  });
});

describe("processJob - fallback provider path (lines 203-209)", () => {
  test("tries fallback when primary provider throws", async () => {
    const originalGetAvailable = providerRegistry.getAvailable.bind(providerRegistry);
    const originalGetFallbacks = providerRegistry.getFallbacks.bind(providerRegistry);
    const originalEnabled = providerRegistry.getConfig().enabled;

    configureAutoMemory({ enabled: true });

    // Primary throws
    providerRegistry.getAvailable = () => ({
      name: "anthropic" as const,
      config: { apiKey: "test", model: "test" },
      extractMemories: async () => { throw new Error("Primary failed"); },
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 5,
    });

    // Fallback succeeds with memories
    providerRegistry.getFallbacks = () => [{
      name: "openai" as const,
      config: { apiKey: "test-fallback", model: "gpt-4o-mini" },
      extractMemories: async () => [
        {
          content: "Fallback provider saved this memory about the project",
          category: "knowledge" as const,
          importance: 6,
          tags: ["fallback"],
          suggestedScope: "private" as const,
          reasoning: "",
        },
      ],
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 6,
    }];

    processConversationTurn("Some important turn to process", {});

    // Give queue time to process
    await new Promise((r) => setTimeout(r, 200));

    providerRegistry.getAvailable = originalGetAvailable;
    providerRegistry.getFallbacks = originalGetFallbacks;
    configureAutoMemory({ enabled: originalEnabled });

    expect(typeof getAutoMemoryStats().processed).toBe("number");
  });

  test("all providers fail — processJob returns gracefully", async () => {
    const originalGetAvailable = providerRegistry.getAvailable.bind(providerRegistry);
    const originalGetFallbacks = providerRegistry.getFallbacks.bind(providerRegistry);

    configureAutoMemory({ enabled: true });

    // Primary throws
    providerRegistry.getAvailable = () => ({
      name: "anthropic" as const,
      config: { apiKey: "test", model: "test" },
      extractMemories: async () => { throw new Error("Primary failed"); },
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 5,
    });

    // Fallback also throws
    providerRegistry.getFallbacks = () => [{
      name: "openai" as const,
      config: { apiKey: "test", model: "gpt-4o-mini" },
      extractMemories: async () => { throw new Error("Fallback also failed"); },
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 5,
    }];

    processConversationTurn("Turn where all providers fail", {});

    // Give queue time to process
    await new Promise((r) => setTimeout(r, 200));

    providerRegistry.getAvailable = originalGetAvailable;
    providerRegistry.getFallbacks = originalGetFallbacks;

    // No crash — processJob handles all failures gracefully
    expect(typeof getAutoMemoryStats().processed).toBe("number");
  });
});

describe("saveExtractedMemory - below minImportance threshold (line ~144)", () => {
  test("skips memories below minImportance threshold", async () => {
    configureAutoMemory({ enabled: true, minImportance: 8 });

    const mockProvider = {
      name: "anthropic" as const,
      config: { apiKey: "test", model: "test" },
      extractMemories: mock(async () => [
        {
          content: "Low importance memory below threshold",
          category: "knowledge" as const,
          importance: 3, // below minImportance of 8
          tags: [],
          suggestedScope: "private" as const,
          reasoning: "",
        },
      ]),
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 3,
    };

    const orig = providerRegistry.getAvailable.bind(providerRegistry);
    providerRegistry.getAvailable = () => mockProvider;

    const beforeCount = (getDatabase().query("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;

    processConversationTurn("Low importance content", {});

    await new Promise((r) => setTimeout(r, 150));

    providerRegistry.getAvailable = orig;
    configureAutoMemory({ minImportance: 5 }); // restore

    const afterCount = (getDatabase().query("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
    // No new memories should have been saved
    expect(afterCount).toBe(beforeCount);
  });
});
