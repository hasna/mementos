import { describe, it, expect } from "bun:test";
import { formatBriefing } from "./channel-pusher.js";
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
    created_at: "2026-03-21T00:00:00Z",
    updated_at: "2026-03-21T00:00:00Z",
    last_accessed_at: null,
    ...overrides,
  };
}

describe("channel-pusher formatting", () => {
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
      // Footer is always present
      expect(result).toContain("memory_recall");
    });

    it("truncates long memory values", () => {
      const longValue = "x".repeat(300);
      const memories = [mockMemory({ value: longValue })];
      const result = formatBriefing({ memories });
      // formatBriefing truncates at 150 chars and appends "..."
      expect(result).toContain("x".repeat(150) + "...");
      expect(result).not.toContain("x".repeat(151));
    });

    it("renders all sections together", () => {
      const result = formatBriefing({
        projectName: "open-mementos",
        profile: "Agent maximus",
        memories: [mockMemory({ key: "stack", value: "Bun + SQLite", category: "fact" })],
        lastSession: "Fixed search indexing",
        flagged: [mockMemory({ key: "stale-config", value: "Old config format", flag: "outdated" })],
      });
      // Verify ordering: header, profile, memories, last session, flagged, footer
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
  });
});
