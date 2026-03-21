import { Database } from "bun:sqlite";
import type { Memory, MemoryCategory, MementosConfig } from "../types/index.js";
import { listMemories, touchMemory } from "../db/memories.js";
import { loadConfig } from "./config.js";
import { generateEmbedding, cosineSimilarity, deserializeEmbedding } from "./embeddings.js";

// ============================================================================
// MemoryInjector — selects and formats memories for context injection
// ============================================================================

export type InjectionStrategy = "default" | "smart";

export interface InjectionOptions {
  agent_id?: string;
  project_id?: string;
  session_id?: string;
  max_tokens?: number;
  categories?: MemoryCategory[];
  min_importance?: number;
  strategy?: InjectionStrategy;
  query?: string; // required when strategy='smart'
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

    // Working memories — transient session scratchpad (always relevant to current context)
    if (options.session_id || options.agent_id) {
      const workingMems = listMemories(
        {
          scope: "working",
          status: "active",
          ...(options.session_id ? { session_id: options.session_id } : {}),
          ...(options.agent_id ? { agent_id: options.agent_id } : {}),
          ...(options.project_id ? { project_id: options.project_id } : {}),
          limit: 100,
        },
        db
      );
      allMemories.push(...workingMems);
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
   * Async smart injection: scores memories by embedding similarity + importance + recency.
   * Falls back to default strategy if no embeddings exist or no query is provided.
   */
  async getSmartInjectionContext(options: InjectionOptions = {}): Promise<string> {
    // Fall back to default if no query provided
    if (!options.query) {
      return this.getInjectionContext(options);
    }

    const maxTokens = options.max_tokens || this.config.injection.max_tokens;
    const minImportance =
      options.min_importance || this.config.injection.min_importance;
    const categories = options.categories || this.config.injection.categories;
    const db = options.db;

    // Collect candidate memories from all visible scopes (same as default)
    const allMemories: Memory[] = [];

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

    // Working memories — transient session scratchpad (always relevant to current context)
    if (options.session_id || options.agent_id) {
      const workingMems = listMemories(
        {
          scope: "working",
          status: "active",
          ...(options.session_id ? { session_id: options.session_id } : {}),
          ...(options.agent_id ? { agent_id: options.agent_id } : {}),
          ...(options.project_id ? { project_id: options.project_id } : {}),
          limit: 100,
        },
        db
      );
      allMemories.push(...workingMems);
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

    // Generate query embedding
    const { embedding: queryEmbedding } = await generateEmbedding(options.query);

    // Load memory embeddings from DB
    const d = db || (await import("../db/database.js")).getDatabase();
    const embeddingRows = d
      .prepare(
        `SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${unique.map(() => "?").join(",")})`
      )
      .all(...unique.map((m) => m.id)) as Array<{ memory_id: string; embedding: string }>;

    const embeddingMap = new Map<string, number[]>();
    for (const row of embeddingRows) {
      try {
        embeddingMap.set(row.memory_id, deserializeEmbedding(row.embedding));
      } catch {
        // Skip malformed embeddings
      }
    }

    // If no embeddings exist at all, fall back to default strategy
    if (embeddingMap.size === 0) {
      return this.getInjectionContext(options);
    }

    // Compute recency reference: newest updated_at among candidates
    const nowMs = Date.now();
    const oldestMs = Math.min(...unique.map((m) => new Date(m.updated_at).getTime()));
    const timeRange = nowMs - oldestMs || 1; // avoid division by zero

    // Score each memory: similarity * 0.4 + importance/10 * 0.3 + recency * 0.3
    interface ScoredMemory {
      memory: Memory;
      score: number;
    }

    const scored: ScoredMemory[] = unique
      .filter((m) => !this.injectedIds.has(m.id))
      .map((m) => {
        const memEmbedding = embeddingMap.get(m.id);
        const similarity = memEmbedding
          ? cosineSimilarity(queryEmbedding, memEmbedding)
          : 0;
        const importanceScore = m.importance / 10;
        const recencyScore =
          (new Date(m.updated_at).getTime() - oldestMs) / timeRange;

        // Pinned memories get a bonus to stay at the top
        const pinBonus = m.pinned ? 0.5 : 0;

        const score =
          similarity * 0.4 +
          importanceScore * 0.3 +
          recencyScore * 0.3 +
          pinBonus;

        return { memory: m, score };
      });

    // Sort by composite score descending
    scored.sort((a, b) => b.score - a.score);

    // Token budget allocation (~4 chars per token estimate)
    const totalCharBudget = maxTokens * 4;
    const footer = "Tip: Use memory_search for deeper lookup on specific topics.";
    const footerChars = footer.length;
    const contentBudget = totalCharBudget - footerChars;

    const lines: string[] = [];
    const injectedIds: string[] = [];
    let totalChars = 0;

    for (const { memory: m } of scored) {
      const line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
      if (totalChars + line.length > contentBudget) break;
      lines.push(line);
      injectedIds.push(m.id);
      totalChars += line.length;
    }

    if (lines.length === 0) {
      return "";
    }

    // Touch and track all injected memories
    for (const id of injectedIds) {
      this.injectedIds.add(id);
      touchMemory(id, db);
    }

    // Build structured output
    const sections: string[] = [];
    sections.push(`## Relevant Memories\n${lines.join("\n")}`);
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
