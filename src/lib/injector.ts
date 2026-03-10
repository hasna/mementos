import { Database } from "bun:sqlite";
import type { Memory, MemoryCategory, MementosConfig } from "../types/index.js";
import { listMemories, touchMemory } from "../db/memories.js";
import { loadConfig } from "./config.js";

// ============================================================================
// MemoryInjector — selects and formats memories for context injection
// ============================================================================

export interface InjectionOptions {
  agent_id?: string;
  project_id?: string;
  session_id?: string;
  max_tokens?: number;
  categories?: MemoryCategory[];
  min_importance?: number;
  db?: Database;
}

export class MemoryInjector {
  private config: MementosConfig;
  private injectedIds: Set<string> = new Set();

  constructor(config?: MementosConfig) {
    this.config = config || loadConfig();
  }

  /**
   * Get formatted injection context suitable for system prompt insertion.
   * Selects memories by scope visibility, importance, and category.
   * Token-budget aware.
   */
  getInjectionContext(options: InjectionOptions = {}): string {
    const maxTokens = options.max_tokens || this.config.injection.max_tokens;
    const minImportance = options.min_importance || this.config.injection.min_importance;
    const categories = options.categories || this.config.injection.categories;
    const db = options.db;

    // Collect memories from all visible scopes
    const allMemories: Memory[] = [];

    // Global memories — visible to everyone
    const globalMems = listMemories(
      {
        scope: "global",
        category: categories,
        min_importance: minImportance,
        status: "active",
        limit: 100,
      },
      db
    );
    allMemories.push(...globalMems);

    // Shared memories — project-scoped
    if (options.project_id) {
      const sharedMems = listMemories(
        {
          scope: "shared",
          category: categories,
          min_importance: minImportance,
          status: "active",
          project_id: options.project_id,
          limit: 100,
        },
        db
      );
      allMemories.push(...sharedMems);
    }

    // Private memories — agent-scoped
    if (options.agent_id) {
      const privateMems = listMemories(
        {
          scope: "private",
          category: categories,
          min_importance: minImportance,
          status: "active",
          agent_id: options.agent_id,
          limit: 100,
        },
        db
      );
      allMemories.push(...privateMems);
    }

    // Deduplicate by ID
    const seen = new Set<string>();
    const unique = allMemories.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // Sort by: pinned first, then importance DESC, then recency
    unique.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    });

    // Build context within token budget (~4 chars per token estimate)
    const charBudget = maxTokens * 4;
    const lines: string[] = [];
    let totalChars = 0;

    for (const m of unique) {
      // Skip if already injected in this session (dedup across refresh)
      if (this.injectedIds.has(m.id)) continue;

      const line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
      if (totalChars + line.length > charBudget) break;

      lines.push(line);
      totalChars += line.length;
      this.injectedIds.add(m.id);

      // Update access tracking
      touchMemory(m.id, db);
    }

    if (lines.length === 0) {
      return "";
    }

    return `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;
  }

  /**
   * Reset the deduplication window (call between refresh intervals)
   */
  resetDedup(): void {
    this.injectedIds.clear();
  }

  /**
   * Get count of memories injected so far in this session
   */
  getInjectedCount(): number {
    return this.injectedIds.size;
  }
}
