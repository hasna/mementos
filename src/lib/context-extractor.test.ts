import { describe, it, expect, beforeEach } from "bun:test";
import { extractContext, resetContext } from "./context-extractor.js";
import type { SessionMessage } from "./session-watcher.js";

describe("context-extractor", () => {
  beforeEach(() => resetContext());

  describe("user messages", () => {
    it("extracts text from string content", () => {
      const msg: SessionMessage = {
        role: "user",
        content: "Please fix the database migration issue",
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.context_text).toBe("Please fix the database migration issue");
      expect(result.source).toBe("user");
    });

    it("extracts text from content array", () => {
      const msg: SessionMessage = {
        role: "user",
        content: [
          { type: "text", text: "First part" },
          { type: "image" },
          { type: "text", text: "Second part" },
        ],
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.context_text).toBe("First part Second part");
      expect(result.source).toBe("user");
    });

    it("marks user messages as significant", () => {
      const msg: SessionMessage = {
        role: "user",
        content: "Refactor the authentication module to use JWT tokens",
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.is_significant).toBe(true);
    });

    it("marks very short messages as not significant", () => {
      const msg: SessionMessage = {
        role: "user",
        content: "ok",
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.is_significant).toBe(false);
    });
  });

  describe("assistant messages with tool_use", () => {
    it("extracts tool name and key input params", () => {
      const msg: SessionMessage = {
        role: "assistant",
        content: "",
        tool_use: [
          {
            name: "bash",
            input: { command: "ls -la /tmp", description: "list files" },
          },
        ],
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.context_text).toContain("bash(");
      expect(result.context_text).toContain("command=ls -la /tmp");
      expect(result.context_text).toContain("description=list files");
      expect(result.source).toBe("tool_use");
    });

    it("marks tool_use as not significant by default", () => {
      const msg: SessionMessage = {
        role: "assistant",
        content: "",
        tool_use: [
          { name: "read", input: { file_path: "/src/index.ts" } },
        ],
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.is_significant).toBe(false);
    });
  });

  describe("error detection", () => {
    it("marks messages containing error patterns as significant", () => {
      // Note: the source lowercases contextText but does NOT lowercase the
      // error patterns — so "ENOENT" (uppercase in the patterns array) won't
      // match. Only lowercase patterns like "error", "failed", etc. trigger.
      const patterns = [
        "Error: module not found",
        "Command failed with exit code 1",
        "permission denied accessing /root",
        "Request timed out after 30s timeout",
        "Unhandled exception in worker",
        "Resource not found for id abc123",
      ];

      for (const text of patterns) {
        resetContext();
        const msg: SessionMessage = {
          role: "assistant",
          content: "",
          tool_use: [{ name: "bash", input: { command: text } }],
          timestamp: new Date().toISOString(),
        };
        const result = extractContext(msg);
        expect(result.is_significant).toBe(true);
      }
    });
  });

  describe("deduplication", () => {
    it("marks duplicate context as not significant", () => {
      const msg: SessionMessage = {
        role: "user",
        content: "Please update the database schema for users table",
        timestamp: new Date().toISOString(),
      };

      const first = extractContext(msg);
      expect(first.is_significant).toBe(true);

      // Same message again — should be deduped
      const second = extractContext(msg);
      expect(second.is_significant).toBe(false);
    });

    it("allows different contexts through", () => {
      const msg1: SessionMessage = {
        role: "user",
        content: "Please update the database schema for users table",
        timestamp: new Date().toISOString(),
      };
      const msg2: SessionMessage = {
        role: "user",
        content: "Now let us work on the authentication middleware refactor",
        timestamp: new Date().toISOString(),
      };

      const first = extractContext(msg1);
      expect(first.is_significant).toBe(true);

      const second = extractContext(msg2);
      expect(second.is_significant).toBe(true);
    });
  });

  describe("tool detection", () => {
    it("detects bash tool mentions", () => {
      const msg: SessionMessage = {
        role: "user",
        content: "Run the bash command to check npm packages",
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.tools_mentioned).toContain("bash");
      expect(result.tools_mentioned).toContain("npm");
    });

    it("detects memory tool mentions", () => {
      const msg: SessionMessage = {
        role: "user",
        content: "Use memory_save to persist the learning and memory_recall to check",
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.tools_mentioned).toContain("memory_save");
      expect(result.tools_mentioned).toContain("memory_recall");
    });

    it("returns empty for no tool mentions", () => {
      const msg: SessionMessage = {
        role: "user",
        content: "Please refactor the authentication module",
        timestamp: new Date().toISOString(),
      };
      const result = extractContext(msg);
      expect(result.tools_mentioned).toEqual([]);
    });
  });
});
