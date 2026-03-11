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
   * Produces structured output with Key Memories and Recent Context sections.
   * Token-budget aware.
   */
  getInjectionContext(options: InjectionOptions = {}): string {
    const maxTokens = options.max_tokens || this.config.injection.max_tokens;
    const minImportance =
      options.min_importance || this.config.injection.min_importance;
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

    if (unique.length === 0) {
      return "";
    }

    // Token budget allocation (~4 chars per token estimate)
    const totalCharBudget = maxTokens * 4;
    const footer = "Tip: Use memory_search for deeper lookup on specific topics.";
    const footerChars = footer.length;
    // Reserve 10% for footer, 60% for key memories, 30% for recent context
    const keyBudget = Math.floor((totalCharBudget - footerChars) * 0.67); // 60/90
    const recentBudget = Math.floor((totalCharBudget - footerChars) * 0.33); // 30/90

    // --- Key Memories section ---
    // Sort by: pinned first, then importance DESC, then recency
    const keyRanked = [...unique].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    });

    const keyLines: string[] = [];
    const keyIds = new Set<string>();
    let keyChars = 0;

    for (const m of keyRanked) {
      if (this.injectedIds.has(m.id)) continue;

      const line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
      if (keyChars + line.length > keyBudget) break;

      keyLines.push(line);
      keyIds.add(m.id);
      keyChars += line.length;
    }

    // --- Recent Context section ---
    // Sort by accessed_at DESC (most recently used first)
    const recentRanked = [...unique].sort((a, b) => {
      const aTime = a.accessed_at
        ? new Date(a.accessed_at).getTime()
        : 0;
      const bTime = b.accessed_at
        ? new Date(b.accessed_at).getTime()
        : 0;
      return bTime - aTime;
    });

    const recentLines: string[] = [];
    let recentChars = 0;
    const maxRecent = 5;

    for (const m of recentRanked) {
      if (recentLines.length >= maxRecent) break;
      // Deduplicate against Key Memories and previously injected
      if (keyIds.has(m.id)) continue;
      if (this.injectedIds.has(m.id)) continue;

      const line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
      if (recentChars + line.length > recentBudget) break;

      recentLines.push(line);
      recentChars += line.length;
    }

    // If both sections are empty, nothing to inject
    if (keyLines.length === 0 && recentLines.length === 0) {
      return "";
    }

    // Touch all injected memories and track IDs
    const allInjectedMemoryIds = [
      ...keyIds,
      ...recentLines.map((_, i) => {
        // Find the corresponding memory for each recent line
        let idx = 0;
        for (const m of recentRanked) {
          if (keyIds.has(m.id) || this.injectedIds.has(m.id)) continue;
          if (idx === i) return m.id;
          idx++;
        }
        return "";
      }),
    ].filter(Boolean);

    for (const id of allInjectedMemoryIds) {
      this.injectedIds.add(id);
      touchMemory(id, db);
    }

    // Build structured output
    const sections: string[] = [];

    if (keyLines.length > 0) {
      sections.push(`## Key Memories\n${keyLines.join("\n")}`);
    }

    if (recentLines.length > 0) {
      sections.push(`## Recent Context\n${recentLines.join("\n")}`);
    }

    sections.push(footer);

    return `<agent-memories>\n${sections.join("\n\n")}\n</agent-memories>`;
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
