/**
 * Context Extractor — parses session messages and extracts meaningful
 * context strings for memory activation matching.
 */

import type { SessionMessage } from "./session-watcher.js";

export interface ExtractedContext {
  context_text: string;
  tools_mentioned: string[];
  is_significant: boolean;
  source: "user" | "assistant" | "tool_result" | "tool_use";
}

// Rolling window of recent contexts for dedup
const _recentContexts: string[] = [];
const MAX_RECENT = 5;

// Simple similarity check (Jaccard on word sets)
function wordSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

function isDuplicate(text: string): boolean {
  for (const recent of _recentContexts) {
    if (wordSimilarity(text, recent) > 0.9) return true;
  }
  return false;
}

function addToRecent(text: string): void {
  _recentContexts.push(text);
  if (_recentContexts.length > MAX_RECENT) {
    _recentContexts.shift();
  }
}

// Known tool names for detection
const TOOL_NAMES = new Set([
  "bash", "read", "write", "edit", "glob", "grep", "agent",
  "memory_save", "memory_recall", "memory_search", "memory_inject",
  "memory_context", "memory_profile", "memory_save_tool_event",
  "git", "npm", "bun", "docker", "kubectl", "curl",
]);

function detectTools(text: string): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const tool of TOOL_NAMES) {
    if (lower.includes(tool)) found.push(tool);
  }
  return found;
}

export function extractContext(message: SessionMessage): ExtractedContext {
  let contextText = "";
  let source: ExtractedContext["source"] = "user";
  let isSignificant = false;

  if (message.role === "user") {
    // User messages are always significant — they drive the conversation
    if (typeof message.content === "string") {
      contextText = message.content;
    } else if (Array.isArray(message.content)) {
      contextText = message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join(" ");
    }
    source = "user";
    isSignificant = contextText.length > 10; // Skip very short messages
  } else if (message.role === "assistant") {
    if (message.tool_use && message.tool_use.length > 0) {
      // Tool use — extract tool name + key input params
      const parts = message.tool_use.map(tu => {
        const inputSummary = tu.input
          ? Object.entries(tu.input)
              .filter(([k]) => ["command", "pattern", "query", "file_path", "description", "prompt", "key", "value"].includes(k))
              .map(([k, v]) => `${k}=${String(v).slice(0, 100)}`)
              .join(", ")
          : "";
        return `${tu.name}(${inputSummary})`;
      });
      contextText = parts.join("; ");
      source = "tool_use";
      isSignificant = false; // Tool uses are context but not primary triggers
    } else if (typeof message.content === "string") {
      contextText = message.content.slice(0, 500);
      source = "assistant";
      isSignificant = false;
    } else if (Array.isArray(message.content)) {
      contextText = message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => (c.text || "").slice(0, 200))
        .join(" ");
      source = "assistant";
      isSignificant = false;
    }
  }

  // Check for error patterns in tool results — errors are significant
  const errorPatterns = ["error", "failed", "exception", "enoent", "permission denied", "not found", "timeout"];
  if (errorPatterns.some(p => contextText.toLowerCase().includes(p))) {
    isSignificant = true;
  }

  // Dedup check
  if (isSignificant && isDuplicate(contextText)) {
    isSignificant = false;
  }

  if (isSignificant) {
    addToRecent(contextText);
  }

  return {
    context_text: contextText,
    tools_mentioned: detectTools(contextText),
    is_significant: isSignificant,
    source,
  };
}

export function resetContext(): void {
  _recentContexts.length = 0;
}
