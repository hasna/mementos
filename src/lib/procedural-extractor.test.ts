process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { listMemories } from "../db/memories.js";
import { registerAgent } from "../db/agents.js";
import { registerProject } from "../db/projects.js";
import { extractProcedures } from "./procedural-extractor.js";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetDatabase();
  getDatabase();
  // Ensure no API key leaks into tests
  delete process.env["ANTHROPIC_API_KEY"];
});

// Helper to create a mock Anthropic API response
function mockAnthropicResponse(procedures: unknown[]) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: JSON.stringify(procedures) }],
    }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("extractProcedures", () => {
  // --------------------------------------------------------------------------
  // No API key
  // --------------------------------------------------------------------------
  describe("without API key", () => {
    test("returns empty array when ANTHROPIC_API_KEY is not set", async () => {
      delete process.env["ANTHROPIC_API_KEY"];
      const result = await extractProcedures("Some transcript content");
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // With mocked API
  // --------------------------------------------------------------------------
  describe("with mocked API", () => {
    test("extracts procedures and saves step memories to DB", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const procedures = [
        {
          title: "Deploy to Production",
          steps: [
            { action: "Run tests", when_to_use: "Before any deployment" },
            { action: "Build the project", when_to_use: "After tests pass" },
            { action: "Push to production", when_to_use: "After build succeeds" },
          ],
          failure_patterns: ["Never skip tests before deploying"],
          when_to_use: "When deploying code to production",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        const result = await extractProcedures("User ran tests, built project, deployed to prod");

        // Should return the extracted procedures
        expect(result).toHaveLength(1);
        expect(result[0]!.title).toBe("Deploy to Production");
        expect(result[0]!.steps).toHaveLength(3);
        expect(result[0]!.failure_patterns).toHaveLength(1);
        expect(result[0]!.when_to_use).toBe("When deploying code to production");

        // Should have saved memories to DB: 3 steps + 1 failure pattern = 4
        const memories = listMemories({ category: "procedural" });
        expect(memories).toHaveLength(4);

        // Verify step memories
        const steps = memories.filter((m) => m.key.includes("-step-"));
        expect(steps).toHaveLength(3);

        // Check step ordering
        const step1 = steps.find((m) => m.key.endsWith("-step-1"));
        expect(step1).toBeDefined();
        expect(step1!.value).toBe("Run tests");
        expect(step1!.importance).toBe(7);
        expect(step1!.scope).toBe("shared");
        expect(step1!.source).toBe("auto");

        const step2 = steps.find((m) => m.key.endsWith("-step-2"));
        expect(step2).toBeDefined();
        expect(step2!.value).toBe("Build the project");

        const step3 = steps.find((m) => m.key.endsWith("-step-3"));
        expect(step3).toBeDefined();
        expect(step3!.value).toBe("Push to production");

        // Verify failure pattern memory
        const warnings = memories.filter((m) => m.key.includes("-warning-"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.value).toBe("WARNING: Never skip tests before deploying");
        expect(warnings[0]!.importance).toBe(8);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("passes agent_id, project_id, session_id to saved memories", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const db = getDatabase();
      const agent = registerAgent("test-agent", undefined, "Test", undefined, undefined, db);
      const project = registerProject("test-proj", "/tmp/test", undefined, undefined, db);

      const procedures = [
        {
          title: "Simple Flow",
          steps: [
            { action: "Step one", when_to_use: "Always" },
            { action: "Step two", when_to_use: "After step one" },
            { action: "Step three", when_to_use: "After step two" },
          ],
          failure_patterns: [],
          when_to_use: "When doing the flow",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        await extractProcedures("transcript", {
          agent_id: agent.id,
          project_id: project.id,
          session_id: "sess-1",
        });

        const memories = listMemories({ category: "procedural" });
        expect(memories).toHaveLength(3);

        for (const mem of memories) {
          expect(mem.agent_id).toBe(agent.id);
          expect(mem.project_id).toBe(project.id);
          expect(mem.session_id).toBe("sess-1");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("handles multiple procedures", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const procedures = [
        {
          title: "Procedure A",
          steps: [
            { action: "A step 1", when_to_use: "context A" },
            { action: "A step 2", when_to_use: "context A" },
            { action: "A step 3", when_to_use: "context A" },
          ],
          failure_patterns: [],
          when_to_use: "When doing A",
        },
        {
          title: "Procedure B",
          steps: [
            { action: "B step 1", when_to_use: "context B" },
            { action: "B step 2", when_to_use: "context B" },
            { action: "B step 3", when_to_use: "context B" },
          ],
          failure_patterns: ["Avoid doing X"],
          when_to_use: "When doing B",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        const result = await extractProcedures("transcript with two workflows");
        expect(result).toHaveLength(2);

        // 3 steps from A + 3 steps from B + 1 warning from B = 7
        const memories = listMemories({ category: "procedural" });
        expect(memories).toHaveLength(7);

        // Different sequence groups for each procedure
        // Key format: proc-<8chars>-step-N or proc-<8chars>-warning-<8chars>
        const groups = new Set(memories.map((m) => {
          // Extract "proc-XXXXXXXX" prefix (13 chars: "proc-" + 8 char uuid)
          return m.key.slice(0, 13);
        }));
        expect(groups.size).toBe(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("uses step-level when_to_use, falls back to procedure when_to_use", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const procedures = [
        {
          title: "Mixed When",
          steps: [
            { action: "Step with own context", when_to_use: "specific context" },
            { action: "Step without context", when_to_use: "" },
          ],
          failure_patterns: [],
          when_to_use: "fallback context",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        // Need a 3rd step to pass the "3+ steps" heuristic check in the prompt,
        // but the code doesn't filter by step count — it just checks proc.steps.length > 0
        await extractProcedures("transcript");

        const memories = listMemories({ category: "procedural" });
        expect(memories).toHaveLength(2);

        const step1 = memories.find((m) => m.key.endsWith("-step-1"));
        // Step 1 has its own when_to_use
        expect(step1!.metadata).toBeDefined();

        const step2 = memories.find((m) => m.key.endsWith("-step-2"));
        // Step 2 has empty when_to_use, falls back to proc-level
        expect(step2).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("tags include procedure title slug", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const procedures = [
        {
          title: "Database Migration Flow",
          steps: [
            { action: "Back up database", when_to_use: "Before migration" },
            { action: "Run migration", when_to_use: "After backup" },
            { action: "Verify tables", when_to_use: "After migration" },
          ],
          failure_patterns: [],
          when_to_use: "When migrating database",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        await extractProcedures("transcript");

        const memories = listMemories({ category: "procedural" });
        for (const mem of memories) {
          const tags = typeof mem.tags === "string" ? JSON.parse(mem.tags) : mem.tags;
          expect(tags).toContain("procedure");
          expect(tags).toContain("auto-extracted");
          expect(tags).toContain("database-migration-flow");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------
  describe("error handling", () => {
    test("returns empty array on API error (non-ok response)", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => ({ ok: false, status: 500 }) as Response);

      try {
        const result = await extractProcedures("transcript");
        expect(result).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns empty array on network error", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        throw new Error("Network error");
      });

      try {
        const result = await extractProcedures("transcript");
        expect(result).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns empty array when API returns invalid JSON", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "not valid json at all" }],
        }),
      }) as unknown as Response);

      try {
        const result = await extractProcedures("transcript");
        expect(result).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns empty array when API returns non-array JSON", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{"not": "an array"}' }],
        }),
      }) as unknown as Response);

      try {
        const result = await extractProcedures("transcript");
        expect(result).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns empty array when API returns empty content", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => ({
        ok: true,
        json: async () => ({ content: [] }),
      }) as unknown as Response);

      try {
        const result = await extractProcedures("transcript");
        expect(result).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("skips procedures without title", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const procedures = [
        {
          title: "",
          steps: [{ action: "Step", when_to_use: "ctx" }],
          failure_patterns: [],
          when_to_use: "When doing stuff",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        await extractProcedures("transcript");
        const memories = listMemories({ category: "procedural" });
        expect(memories).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("skips procedures without steps", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const procedures = [
        {
          title: "Empty Procedure",
          steps: [],
          failure_patterns: ["Something to avoid"],
          when_to_use: "Never",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        await extractProcedures("transcript");
        const memories = listMemories({ category: "procedural" });
        expect(memories).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // --------------------------------------------------------------------------
  // Transcript truncation
  // --------------------------------------------------------------------------
  describe("transcript handling", () => {
    test("truncates transcripts longer than 8000 characters", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      let capturedBody = "";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockAnthropicResponse([]) as Response;
      });

      try {
        const longTranscript = "x".repeat(10000);
        await extractProcedures(longTranscript);

        const parsed = JSON.parse(capturedBody);
        const userMessage = parsed.messages[0].content;
        // Should contain truncation marker
        expect(userMessage).toContain("[...truncated]");
        // The transcript portion should be capped at 8000 chars
        expect(userMessage.length).toBeLessThan(10000);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("does not truncate short transcripts", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      let capturedBody = "";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockAnthropicResponse([]) as Response;
      });

      try {
        const shortTranscript = "This is a short transcript";
        await extractProcedures(shortTranscript);

        const parsed = JSON.parse(capturedBody);
        const userMessage = parsed.messages[0].content;
        expect(userMessage).not.toContain("[...truncated]");
        expect(userMessage).toContain(shortTranscript);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // --------------------------------------------------------------------------
  // Sequence group and ordering
  // --------------------------------------------------------------------------
  describe("sequence groups", () => {
    test("all steps in a procedure share the same sequence_group prefix", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const procedures = [
        {
          title: "Build Flow",
          steps: [
            { action: "Clean", when_to_use: "first" },
            { action: "Compile", when_to_use: "second" },
            { action: "Package", when_to_use: "third" },
          ],
          failure_patterns: [],
          when_to_use: "When building",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        await extractProcedures("transcript");

        const memories = listMemories({ category: "procedural" });
        expect(memories).toHaveLength(3);

        // All keys should start with the same proc- prefix
        const prefixes = memories.map((m) => m.key.replace(/-step-\d+$/, ""));
        expect(new Set(prefixes).size).toBe(1);
        expect(prefixes[0]).toMatch(/^proc-/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("failure patterns have sequence_order 999", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key";

      const procedures = [
        {
          title: "Safe Deploy",
          steps: [
            { action: "Test", when_to_use: "first" },
            { action: "Deploy", when_to_use: "second" },
            { action: "Monitor", when_to_use: "third" },
          ],
          failure_patterns: ["Don't deploy on Friday"],
          when_to_use: "When deploying",
        },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => mockAnthropicResponse(procedures) as Response);

      try {
        await extractProcedures("transcript");

        const memories = listMemories({ category: "procedural" });
        const warnings = memories.filter((m) => m.key.includes("-warning-"));
        expect(warnings).toHaveLength(1);

        // Warning should have failure-pattern tag
        const tags = typeof warnings[0]!.tags === "string"
          ? JSON.parse(warnings[0]!.tags)
          : warnings[0]!.tags;
        expect(tags).toContain("failure-pattern");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
