import { describe, it, test, expect, beforeEach } from "bun:test";
import {
  setServerRef,
  hasChannelCapability,
  pushMemoryNotification,
  pushRawNotification,
  pushToAgent,
  pushToProject,
  pushToAll,
  formatBriefing,
} from "./channel-pusher.js";
import type { Memory } from "../types/index.js";

function mockMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-001",
    key: "test-key",
    value: "test value",
    category: "knowledge",
    scope: "shared",
    summary: null,
    tags: [],
    importance: 7,
    source: "agent",
    status: "active",
    pinned: false,
    agent_id: null,
    project_id: null,
    session_id: null,
    flag: null,
    metadata: {},
    access_count: 0,
    version: 1,
    expires_at: null,
    valid_from: null,
    valid_until: null,
    ingested_at: null,
    created_at: "2026-03-21T00:00:00Z",
    updated_at: "2026-03-21T00:00:00Z",
    accessed_at: null,
    ...overrides,
  };
}

// ============================================================================
// setServerRef / hasChannelCapability
// ============================================================================

describe("setServerRef / hasChannelCapability", () => {
  beforeEach(() => {
    setServerRef(null);
  });

  it("returns false when no server ref is set", () => {
    expect(hasChannelCapability()).toBe(false);
  });

  it("returns true after setting a server ref", () => {
    setServerRef({ notification: async () => {} });
    expect(hasChannelCapability()).toBe(true);
  });

  it("returns false after clearing server ref", () => {
    setServerRef({ notification: async () => {} });
    expect(hasChannelCapability()).toBe(true);
    setServerRef(null);
    expect(hasChannelCapability()).toBe(false);
  });
});

// ============================================================================
// pushMemoryNotification
// ============================================================================

describe("pushMemoryNotification", () => {
  beforeEach(() => {
    setServerRef(null);
  });

  it("returns false when no server ref is set", async () => {
    const result = await pushMemoryNotification([mockMemory()], "test context");
    expect(result).toBe(false);
  });

  it("returns false for empty memories array", async () => {
    setServerRef({ notification: async () => {} });
    const result = await pushMemoryNotification([], "test context");
    expect(result).toBe(false);
  });

  it("returns true and calls notification on success", async () => {
    let captured: any = null;
    const fakeServer = {
      notification: async (msg: any) => {
        captured = msg;
      },
    };
    setServerRef(fakeServer);

    const memories = [mockMemory({ key: "my-key", value: "my-value", importance: 5 })];
    const result = await pushMemoryNotification(memories, "some context");
    expect(result).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured.method).toBe("notifications/claude/channel");
    expect(captured.params.meta.source).toBe("mementos");
    expect(captured.params.meta.type).toBe("auto-inject");
    expect(captured.params.meta.memory_count).toBe(1);
    expect(captured.params.content).toContain("my-key");
    expect(captured.params.content).toContain("my-value");
  });

  it("uses the .server property when present (McpServer wrapper)", async () => {
    let called = false;
    const mcpServerWrapper = {
      server: {
        notification: async () => {
          called = true;
        },
      },
    };
    setServerRef(mcpServerWrapper);

    const result = await pushMemoryNotification([mockMemory()], "ctx");
    expect(result).toBe(true);
    expect(called).toBe(true);
  });

  it("passes the correct type parameter", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    await pushMemoryNotification([mockMemory()], "ctx", "session-briefing");
    expect(captured.params.meta.type).toBe("session-briefing");
  });

  it("returns false when notification throws", async () => {
    setServerRef({
      notification: async () => {
        throw new Error("channel not available");
      },
    });

    const result = await pushMemoryNotification([mockMemory()], "ctx");
    expect(result).toBe(false);
  });

  it("truncates context in meta to 200 chars", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    const longContext = "a".repeat(500);
    await pushMemoryNotification([mockMemory()], longContext);
    expect(captured.params.meta.context.length).toBe(200);
  });

  it("formats auto-inject header correctly", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    await pushMemoryNotification([mockMemory()], "my context", "auto-inject");
    expect(captured.params.content).toContain("Mementos activated");
    expect(captured.params.content).toContain("my context");
  });

  it("formats session-briefing header correctly", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    await pushMemoryNotification([mockMemory()], "ctx", "session-briefing");
    expect(captured.params.content).toContain("Mementos Session Briefing");
  });

  it("marks high-importance memories with indicator", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    await pushMemoryNotification(
      [mockMemory({ importance: 9, key: "critical-thing" })],
      "ctx"
    );
    // importance >= 8 gets a marker
    expect(captured.params.content).toContain("critical-thing");
  });

  it("includes flag in formatted output", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    await pushMemoryNotification(
      [mockMemory({ flag: "outdated", key: "old-api" })],
      "ctx"
    );
    expect(captured.params.content).toContain("outdated");
    expect(captured.params.content).toContain("old-api");
  });

  it("adds footer hint when more than 3 memories", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    const memories = [
      mockMemory({ key: "a" }),
      mockMemory({ key: "b" }),
      mockMemory({ key: "c" }),
      mockMemory({ key: "d" }),
    ];
    await pushMemoryNotification(memories, "ctx");
    expect(captured.params.content).toContain("memory_recall");
  });

  it("omits footer hint when 3 or fewer memories", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    const memories = [mockMemory({ key: "a" }), mockMemory({ key: "b" })];
    await pushMemoryNotification(memories, "ctx");
    expect(captured.params.content).not.toContain("memory_recall");
  });

  it("truncates long memory values to 200 chars in formatted output", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    const longValue = "z".repeat(300);
    await pushMemoryNotification([mockMemory({ value: longValue })], "ctx");
    expect(captured.params.content).toContain("z".repeat(200) + "...");
    expect(captured.params.content).not.toContain("z".repeat(201));
  });
});

// ============================================================================
// pushRawNotification
// ============================================================================

describe("pushRawNotification", () => {
  beforeEach(() => {
    setServerRef(null);
  });

  it("returns false when no server ref", async () => {
    const result = await pushRawNotification("hello");
    expect(result).toBe(false);
  });

  it("returns true and sends notification on success", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    const result = await pushRawNotification("hello world", "custom-type");
    expect(result).toBe(true);
    expect(captured.method).toBe("notifications/claude/channel");
    expect(captured.params.content).toBe("hello world");
    expect(captured.params.meta.source).toBe("mementos");
    expect(captured.params.meta.type).toBe("custom-type");
  });

  it("defaults type to info", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    await pushRawNotification("test");
    expect(captured.params.meta.type).toBe("info");
  });

  it("uses .server property when present", async () => {
    let called = false;
    setServerRef({
      server: {
        notification: async () => {
          called = true;
        },
      },
    });

    const result = await pushRawNotification("test");
    expect(result).toBe(true);
    expect(called).toBe(true);
  });

  it("returns false when notification throws", async () => {
    setServerRef({
      notification: async () => {
        throw new Error("fail");
      },
    });

    const result = await pushRawNotification("test");
    expect(result).toBe(false);
  });
});

// ============================================================================
// pushToAgent
// ============================================================================

describe("pushToAgent", () => {
  beforeEach(() => {
    setServerRef(null);
  });

  it("returns false when no matching session for agent", async () => {
    setServerRef({ notification: async () => {} });
    const result = await pushToAgent("nonexistent-agent", "hello");
    expect(result).toBe(false);
  });

  it("returns false when no server ref set", async () => {
    const result = await pushToAgent("any-agent", "hello");
    expect(result).toBe(false);
  });
});

// ============================================================================
// pushToProject
// ============================================================================

describe("pushToProject", () => {
  beforeEach(() => {
    setServerRef(null);
  });

  it("returns 0 when no matching sessions for project", async () => {
    setServerRef({ notification: async () => {} });
    const result = await pushToProject("nonexistent-project", "hello");
    expect(result).toBe(0);
  });

  it("returns 0 when no server ref set", async () => {
    const result = await pushToProject("any-project", "hello");
    expect(result).toBe(0);
  });
});

// ============================================================================
// pushToAll
// ============================================================================

describe("pushToAll", () => {
  beforeEach(() => {
    setServerRef(null);
  });

  it("returns 0 when no server ref set", async () => {
    const result = await pushToAll("broadcast message");
    expect(result).toBe(0);
  });

  it("returns 1 when server ref is set and notification succeeds", async () => {
    setServerRef({ notification: async () => {} });
    const result = await pushToAll("broadcast message");
    expect(result).toBe(1);
  });

  it("returns 0 when notification throws", async () => {
    setServerRef({
      notification: async () => {
        throw new Error("fail");
      },
    });
    const result = await pushToAll("broadcast message");
    expect(result).toBe(0);
  });

  it("passes broadcast as default type", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    await pushToAll("test");
    expect(captured.params.meta.type).toBe("broadcast");
  });

  it("passes custom type", async () => {
    let captured: any = null;
    setServerRef({
      notification: async (msg: any) => {
        captured = msg;
      },
    });

    await pushToAll("test", "alert");
    expect(captured.params.meta.type).toBe("alert");
  });
});

// ============================================================================
// formatBriefing
// ============================================================================

describe("formatBriefing", () => {
  it("includes profile section when provided", () => {
    const result = formatBriefing({
      profile: "Senior TypeScript developer working on mementos",
    });
    expect(result).toContain("## Profile");
    expect(result).toContain("Senior TypeScript developer working on mementos");
  });

  it("includes key memories section", () => {
    const memories = [
      mockMemory({ key: "project-stack", value: "TypeScript + Bun + SQLite", category: "fact" }),
      mockMemory({ key: "learning-fts5", value: "FTS5 requires specific tokenizer config", category: "knowledge" }),
    ];
    const result = formatBriefing({ memories });
    expect(result).toContain("## Key Memories (2)");
    expect(result).toContain("[fact] project-stack: TypeScript + Bun + SQLite");
    expect(result).toContain("[knowledge] learning-fts5: FTS5 requires specific tokenizer config");
  });

  it("includes last session section", () => {
    const result = formatBriefing({
      lastSession: "Completed migration refactor and added 15 new tests",
    });
    expect(result).toContain("## Last Session");
    expect(result).toContain("Completed migration refactor and added 15 new tests");
  });

  it("includes flagged items section", () => {
    const flagged = [
      mockMemory({ key: "old-api-endpoint", value: "The /v1/sync endpoint is deprecated", flag: "outdated" }),
      mockMemory({ key: "schema-issue", value: "Missing index on memories.project_id", flag: "needs-review" }),
    ];
    const result = formatBriefing({ flagged });
    expect(result).toContain("## Needs Attention");
    expect(result).toContain("[outdated] old-api-endpoint: The /v1/sync endpoint is deprecated");
    expect(result).toContain("[needs-review] schema-issue: Missing index on memories.project_id");
  });

  it("includes project name in header", () => {
    const result = formatBriefing({ projectName: "open-mementos" });
    expect(result).toContain("Mementos Session Briefing");
    expect(result).toContain("project: open-mementos");
  });

  it("omits empty sections", () => {
    const result = formatBriefing({});
    expect(result).not.toContain("## Profile");
    expect(result).not.toContain("## Key Memories");
    expect(result).not.toContain("## Last Session");
    expect(result).not.toContain("## Needs Attention");
    expect(result).toContain("memory_recall");
  });

  it("truncates long memory values", () => {
    const longValue = "x".repeat(300);
    const memories = [mockMemory({ value: longValue })];
    const result = formatBriefing({ memories });
    expect(result).toContain("x".repeat(150) + "...");
    expect(result).not.toContain("x".repeat(151));
  });

  it("renders all sections together in correct order", () => {
    const result = formatBriefing({
      projectName: "open-mementos",
      profile: "Agent maximus",
      memories: [mockMemory({ key: "stack", value: "Bun + SQLite", category: "fact" })],
      lastSession: "Fixed search indexing",
      flagged: [mockMemory({ key: "stale-config", value: "Old config format", flag: "outdated" })],
    });
    const headerIdx = result.indexOf("Session Briefing");
    const profileIdx = result.indexOf("## Profile");
    const memoriesIdx = result.indexOf("## Key Memories");
    const sessionIdx = result.indexOf("## Last Session");
    const flaggedIdx = result.indexOf("## Needs Attention");
    const footerIdx = result.indexOf("memory_recall");
    expect(headerIdx).toBeLessThan(profileIdx);
    expect(profileIdx).toBeLessThan(memoriesIdx);
    expect(memoriesIdx).toBeLessThan(sessionIdx);
    expect(sessionIdx).toBeLessThan(flaggedIdx);
    expect(flaggedIdx).toBeLessThan(footerIdx);
  });

  it("omits project name suffix when not provided", () => {
    const result = formatBriefing({});
    expect(result).not.toContain("project:");
    expect(result).toContain("Mementos Session Briefing");
  });

  it("skips memories section for empty memories array", () => {
    const result = formatBriefing({ memories: [] });
    expect(result).not.toContain("## Key Memories");
  });

  it("skips flagged section for empty flagged array", () => {
    const result = formatBriefing({ flagged: [] });
    expect(result).not.toContain("## Needs Attention");
  });
});
