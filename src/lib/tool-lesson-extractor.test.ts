process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { getToolEvents } from "../db/tool-events.js";
import { listMemories } from "../db/memories.js";
import { registerAgent } from "../db/agents.js";
import { registerProject } from "../db/projects.js";
import { extractToolLessons } from "./tool-lesson-extractor.js";

let originalFetch: typeof globalThis.fetch;
let originalApiKey: string | undefined;

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
  originalFetch = globalThis.fetch;
  originalApiKey = process.env["ANTHROPIC_API_KEY"];
  // Set a fake API key so the function doesn't bail early
  process.env["ANTHROPIC_API_KEY"] = "sk-test-fake-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey !== undefined) {
    process.env["ANTHROPIC_API_KEY"] = originalApiKey;
  } else {
    delete process.env["ANTHROPIC_API_KEY"];
  }
});

function mockFetchResponse(lessons: unknown[], ok = true) {
  globalThis.fetch = (async () => ({
    ok,
    json: async () => ({
      content: [{ type: "text", text: JSON.stringify(lessons) }],
    }),
  })) as any;
}

/**
 * Create agent + project records in the DB so FK constraints pass,
 * then return their IDs.
 */
function setupAgentAndProject(): { agentId: string; projectId: string } {
  const project = registerProject("test-project", "/tmp/test-project");
  const agent = registerAgent("test-agent");
  return { agentId: agent.id, projectId: project.id };
}

// ============================================================================
// extractToolLessons
// ============================================================================

describe("extractToolLessons", () => {
  test("returns empty array when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const result = await extractToolLessons("some transcript");
    expect(result).toEqual([]);
  });

  test("returns empty array when API response is not ok", async () => {
    mockFetchResponse([], false);
    const result = await extractToolLessons("some transcript");
    expect(result).toEqual([]);
  });

  test("returns empty array when API returns empty content", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ content: [] }),
    })) as any;
    const result = await extractToolLessons("some transcript");
    expect(result).toEqual([]);
  });

  test("returns empty array when API returns non-array JSON", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: '{"not": "an array"}' }],
      }),
    })) as any;
    const result = await extractToolLessons("some transcript");
    expect(result).toEqual([]);
  });

  test("returns empty array when API returns invalid JSON", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "not valid json at all" }],
      }),
    })) as any;
    const result = await extractToolLessons("some transcript");
    expect(result).toEqual([]);
  });

  test("returns empty array when fetch throws an error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network error");
    }) as any;
    const result = await extractToolLessons("some transcript");
    expect(result).toEqual([]);
  });

  test("extracts lessons from valid API response", async () => {
    const lessons = [
      {
        tool_name: "Bash",
        lesson: "Use absolute paths to avoid cwd issues",
        when_to_use: "When running file operations via Bash",
        success: true,
        error_type: null,
      },
    ];
    mockFetchResponse(lessons);

    const result = await extractToolLessons("transcript with tool calls");
    expect(result).toHaveLength(1);
    expect(result[0].tool_name).toBe("Bash");
    expect(result[0].lesson).toBe("Use absolute paths to avoid cwd issues");
    expect(result[0].success).toBe(true);
  });

  test("saves tool events to the database", async () => {
    const { agentId, projectId } = setupAgentAndProject();
    const lessons = [
      {
        tool_name: "Read",
        lesson: "Always read before editing",
        when_to_use: "When modifying an existing file",
        success: true,
        error_type: null,
      },
    ];
    mockFetchResponse(lessons);

    const result = await extractToolLessons("transcript", {
      agent_id: agentId,
      project_id: projectId,
      session_id: "sess-1",
    });
    expect(result).toHaveLength(1);

    const events = getToolEvents({ tool_name: "Read" });
    expect(events).toHaveLength(1);
    expect(events[0].tool_name).toBe("Read");
    expect(events[0].lesson).toBe("Always read before editing");
    expect(events[0].when_to_use).toBe("When modifying an existing file");
    expect(events[0].success).toBe(true);
    expect(events[0].agent_id).toBe(agentId);
    expect(events[0].project_id).toBe(projectId);
    expect(events[0].session_id).toBe("sess-1");
    expect(events[0].context).toBe("extracted from session transcript");
  });

  test("saves memories to the database", async () => {
    const { agentId, projectId } = setupAgentAndProject();
    const lessons = [
      {
        tool_name: "Grep",
        lesson: "Use glob filter to narrow search scope",
        when_to_use: "When searching large codebases",
        success: true,
        error_type: null,
      },
    ];
    mockFetchResponse(lessons);

    await extractToolLessons("transcript", {
      agent_id: agentId,
      project_id: projectId,
      session_id: "sess-1",
    });

    const memories = listMemories({});
    const toolMemory = memories.find((m) => m.value === "Use glob filter to narrow search scope");
    expect(toolMemory).toBeDefined();
    expect(toolMemory!.key).toContain("tool-lesson-Grep-");
    expect(toolMemory!.category).toBe("knowledge");
    expect(toolMemory!.scope).toBe("shared");
    expect(toolMemory!.importance).toBe(7);
    expect(toolMemory!.source).toBe("auto");
    expect(toolMemory!.tags).toContain("tool-memory");
    expect(toolMemory!.tags).toContain("Grep");
    expect(toolMemory!.tags).toContain("auto-extracted");
    expect(toolMemory!.when_to_use).toBe("When searching large codebases");
    expect(toolMemory!.agent_id).toBe(agentId);
    expect(toolMemory!.project_id).toBe(projectId);
    expect(toolMemory!.session_id).toBe("sess-1");
  });

  test("handles multiple lessons in a single response", async () => {
    const lessons = [
      {
        tool_name: "Bash",
        lesson: "Quote file paths with spaces",
        when_to_use: "When paths may contain spaces",
        success: true,
        error_type: null,
      },
      {
        tool_name: "Edit",
        lesson: "Provide enough context for unique matching",
        when_to_use: "When old_string is ambiguous",
        success: false,
        error_type: "syntax",
      },
    ];
    mockFetchResponse(lessons);

    const result = await extractToolLessons("transcript");
    expect(result).toHaveLength(2);

    const events = getToolEvents({});
    expect(events).toHaveLength(2);

    const memories = listMemories({});
    expect(memories.length).toBeGreaterThanOrEqual(2);
  });

  test("saves failed tool events with error_type", async () => {
    const lessons = [
      {
        tool_name: "Bash",
        lesson: "Timeout occurs with large git repos",
        when_to_use: "When running git commands on large repos",
        success: false,
        error_type: "timeout",
      },
    ];
    mockFetchResponse(lessons);

    await extractToolLessons("transcript");

    const events = getToolEvents({ tool_name: "Bash" });
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
    expect(events[0].error_type).toBe("timeout");
  });

  test("skips lessons without tool_name or lesson", async () => {
    const lessons = [
      {
        tool_name: "",
        lesson: "Missing tool name",
        when_to_use: "Never",
        success: true,
        error_type: null,
      },
      {
        tool_name: "Bash",
        lesson: "",
        when_to_use: "Never",
        success: true,
        error_type: null,
      },
      {
        tool_name: "Grep",
        lesson: "Valid lesson",
        when_to_use: "When searching",
        success: true,
        error_type: null,
      },
    ];
    mockFetchResponse(lessons);

    const result = await extractToolLessons("transcript");
    // All 3 are returned (the function returns the raw parsed array)
    expect(result).toHaveLength(3);

    // But only the valid one should create a tool event
    const events = getToolEvents({});
    expect(events).toHaveLength(1);
    expect(events[0].tool_name).toBe("Grep");
  });

  test("truncates transcript longer than 8000 characters", async () => {
    let capturedBody: string = "";
    globalThis.fetch = (async (_url: string, init: any) => {
      capturedBody = init.body;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "[]" }],
        }),
      };
    }) as any;

    const longTranscript = "x".repeat(10000);
    await extractToolLessons(longTranscript);

    const parsed = JSON.parse(capturedBody);
    const userMessage = parsed.messages[0].content;
    expect(userMessage).toContain("[...truncated]");
    // The truncated transcript should be 8000 chars + prefix + suffix
    expect(userMessage.length).toBeLessThan(10000 + 100);
  });

  test("does not truncate transcript under 8000 characters", async () => {
    let capturedBody: string = "";
    globalThis.fetch = (async (_url: string, init: any) => {
      capturedBody = init.body;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "[]" }],
        }),
      };
    }) as any;

    const shortTranscript = "x".repeat(5000);
    await extractToolLessons(shortTranscript);

    const parsed = JSON.parse(capturedBody);
    const userMessage = parsed.messages[0].content;
    expect(userMessage).not.toContain("[...truncated]");
  });

  test("passes correct headers and model to the API", async () => {
    let capturedUrl: string = "";
    let capturedInit: any = {};
    globalThis.fetch = (async (url: string, init: any) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "[]" }],
        }),
      };
    }) as any;

    await extractToolLessons("transcript");

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedInit.method).toBe("POST");
    expect(capturedInit.headers["x-api-key"]).toBe("sk-test-fake-key");
    expect(capturedInit.headers["anthropic-version"]).toBe("2023-06-01");
    expect(capturedInit.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(capturedInit.body);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.max_tokens).toBe(1500);
  });

  test("works without options parameter", async () => {
    const lessons = [
      {
        tool_name: "Read",
        lesson: "Check file exists before reading",
        when_to_use: "When file path is uncertain",
        success: true,
        error_type: null,
      },
    ];
    mockFetchResponse(lessons);

    const result = await extractToolLessons("transcript");
    expect(result).toHaveLength(1);

    const events = getToolEvents({ tool_name: "Read" });
    expect(events).toHaveLength(1);
    expect(events[0].agent_id).toBeNull();
    expect(events[0].project_id).toBeNull();
    expect(events[0].session_id).toBeNull();
  });

  test("continues saving remaining lessons when no FK constraints", async () => {
    const lessons = [
      {
        tool_name: "Bash",
        lesson: "First lesson",
        when_to_use: "Context 1",
        success: true,
        error_type: null,
      },
      {
        tool_name: "Grep",
        lesson: "Second lesson",
        when_to_use: "Context 2",
        success: true,
        error_type: null,
      },
    ];
    mockFetchResponse(lessons);

    const result = await extractToolLessons("transcript");
    expect(result).toHaveLength(2);

    const events = getToolEvents({});
    expect(events).toHaveLength(2);
  });

  test("resilient to individual save failures from FK constraints", async () => {
    // Pass non-existent agent_id/project_id — FK constraint will cause
    // saveToolEvent/createMemory to throw, but the function should catch
    // and still return the parsed lessons
    const lessons = [
      {
        tool_name: "Bash",
        lesson: "This lesson will fail to save due to FK",
        when_to_use: "Context",
        success: true,
        error_type: null,
      },
    ];
    mockFetchResponse(lessons);

    const result = await extractToolLessons("transcript", {
      agent_id: "nonexistent-agent",
      project_id: "nonexistent-project",
    });

    // Function should still return parsed lessons even if DB saves fail
    expect(result).toHaveLength(1);
    expect(result[0].tool_name).toBe("Bash");

    // Events should be 0 because FK constraint failed
    const events = getToolEvents({});
    expect(events).toHaveLength(0);
  });

  test("saves with null error_type for successful lessons", async () => {
    const lessons = [
      {
        tool_name: "Write",
        lesson: "Always verify parent directory exists",
        when_to_use: "When creating new files",
        success: true,
        error_type: null,
      },
    ];
    mockFetchResponse(lessons);

    await extractToolLessons("transcript");

    const events = getToolEvents({ tool_name: "Write" });
    expect(events).toHaveLength(1);
    expect(events[0].error_type).toBeNull();
  });
});
