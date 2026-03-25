import { SqliteAdapter as Database } from "@hasna/cloud";
import type { Memory, MemoryCategory, MementosConfig } from "../types/index.js";
import { listMemories, touchMemory, semanticSearch } from "../db/memories.js";
import { loadConfig } from "./config.js";
import { generateEmbedding, cosineSimilarity, deserializeEmbedding } from "./embeddings.js";
import { computeDecayScore } from "./decay.js";
import { synthesizeProfile } from "./profile-synthesizer.js";
import { getToolStats, getToolLessons } from "../db/tool-events.js";

// ============================================================================
// MemoryInjector — selects and formats memories for context injection
// ============================================================================

export type InjectionStrategy = "default" | "smart" | "smart-pipeline";

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

// ============================================================================
// SmartInjectionOptions — full pipeline with task context + tool awareness
// ============================================================================

export interface SmartInjectionOptions {
  /** Free-text description of what the agent is currently doing */
  task_context: string;
  /** Project to scope memories to */
  project_id?: string;
  /** Agent to scope private memories to */
  agent_id?: string;
  /** Session for working memory */
  session_id?: string;
  /** Max tokens for the entire output (~4 chars/token) */
  max_tokens?: number;
  /** Minimum importance threshold (before decay) */
  min_importance?: number;
  /** Force profile resynthesis even if cached */
  force_profile_refresh?: boolean;
  /** Optional DB handle */
  db?: Database;
}

/** A memory scored by the smart pipeline with its composite relevance */
interface ScoredSmartMemory {
  memory: Memory;
  /** Composite score: activation_match * 0.35 + decay_score * 0.35 + importance * 0.20 + pin_bonus * 0.10 */
  score: number;
  /** Semantic similarity to task_context (0-1), or 0 if no embedding */
  activation: number;
  /** Decay-adjusted importance from forgetting curve */
  decay: number;
}

/** Section labels in output order */
type SmartSection = "Profile" | "Core Facts" | "Tool Guides" | "Procedures" | "Preferences" | "Recent History";

/** Structured result from the smart injection pipeline */
export interface SmartInjectionResult {
  /** Formatted markdown string ready for system prompt */
  output: string;
  /** Token estimate of the output */
  token_estimate: number;
  /** Number of memories included */
  memory_count: number;
  /** Whether the profile was loaded from cache */
  profile_from_cache: boolean;
  /** Tool names detected in task_context */
  detected_tools: string[];
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

// ============================================================================
// Smart Injection Pipeline — activation matching + tool awareness + decay
// ============================================================================

/** Common tool-related keywords to detect in task_context */
const TOOL_KEYWORD_PATTERNS = [
  /\b(mcp|tool|command|cli|server|endpoint|api)\b/i,
  /\b(memory_\w+|entity_\w+|graph_\w+|relation_\w+)\b/i,
  /\b(git|npm|bun|curl|docker|kubectl)\b/i,
  /\bmementos[\s-]?\w*/i,
];

/**
 * Extract tool names mentioned in the task context.
 * Looks for known patterns like `memory_save`, `git commit`, tool-like identifiers.
 */
function detectToolMentions(taskContext: string): string[] {
  const tools = new Set<string>();

  // Match memory_* / entity_* / graph_* / relation_* style tool names
  const mcpToolPattern = /\b(memory_\w+|entity_\w+|graph_\w+|relation_\w+|session_\w+|webhook_\w+|hook_\w+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = mcpToolPattern.exec(taskContext)) !== null) {
    tools.add(match[1]!.toLowerCase());
  }

  // Match common CLI tools
  const cliPattern = /\b(git|npm|bun|curl|docker|kubectl|mementos)\b/gi;
  while ((match = cliPattern.exec(taskContext)) !== null) {
    tools.add(match[1]!.toLowerCase());
  }

  return Array.from(tools);
}

/**
 * Check if the task context mentions tool-related concepts.
 */
function hasToolContext(taskContext: string): boolean {
  return TOOL_KEYWORD_PATTERNS.some((p) => p.test(taskContext));
}

/**
 * Map a memory's category to its smart pipeline section.
 */
function categoryToSection(category: MemoryCategory, key: string): SmartSection {
  // Profile memories (synthesized) go to Profile section
  if (key.startsWith("_profile_")) return "Profile";

  switch (category) {
    case "fact":
      return "Core Facts";
    case "procedural":
      return "Procedures";
    case "preference":
      return "Preferences";
    case "history":
      return "Recent History";
    case "knowledge":
      // Knowledge can be core facts or procedures depending on content
      return "Core Facts";
    case "resource":
      return "Core Facts";
    default:
      return "Core Facts";
  }
}

/**
 * Collect all visible memories for the given scope parameters.
 * Shared logic extracted from MemoryInjector to avoid duplication.
 */
function collectVisibleMemories(
  options: {
    project_id?: string;
    agent_id?: string;
    session_id?: string;
    min_importance?: number;
  },
  db?: Database
): Memory[] {
  const allMemories: Memory[] = [];
  const minImportance = options.min_importance ?? 1;

  // Global memories
  allMemories.push(
    ...listMemories({ scope: "global", min_importance: minImportance, status: "active", limit: 100 }, db)
  );

  // Shared memories (project-scoped)
  if (options.project_id) {
    allMemories.push(
      ...listMemories({
        scope: "shared",
        min_importance: minImportance,
        status: "active",
        project_id: options.project_id,
        limit: 100,
      }, db)
    );
  }

  // Private memories (agent-scoped)
  if (options.agent_id) {
    allMemories.push(
      ...listMemories({
        scope: "private",
        min_importance: minImportance,
        status: "active",
        agent_id: options.agent_id,
        limit: 100,
      }, db)
    );
  }

  // Working memories (session scratchpad)
  if (options.session_id || options.agent_id) {
    allMemories.push(
      ...listMemories({
        scope: "working",
        status: "active",
        ...(options.session_id ? { session_id: options.session_id } : {}),
        ...(options.agent_id ? { agent_id: options.agent_id } : {}),
        ...(options.project_id ? { project_id: options.project_id } : {}),
        limit: 100,
      }, db)
    );
  }

  // Deduplicate
  const seen = new Set<string>();
  return allMemories.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/**
 * Format a single memory line for injection output.
 */
function formatMemoryLine(m: Memory): string {
  const value = m.value.length > 200 ? m.value.slice(0, 197) + "..." : m.value;
  return `- **${m.key}**: ${value}`;
}

/**
 * Smart injection pipeline — the full-featured context injection strategy.
 *
 * Pipeline stages:
 * 1. Parse task context — accept a task_context string describing what the agent is doing
 * 2. Load or synthesize agent/project profile
 * 3. Activation match — semantic search against task_context when embeddings exist
 * 4. Tool guide retrieval — pull tool stats/lessons if task mentions tools
 * 5. Decay scoring — apply forgetting curve to all candidate memories
 * 6. Layer by type — Profile > Core Facts > Tool Guides > Procedural > Preferences > History
 * 7. Token budgeting — fit into max_tokens, trimming lowest-relevance items first
 *
 * Falls back gracefully: no embeddings -> keyword matching, no profile -> skip section,
 * no tool mentions -> skip tool guides.
 */
export async function smartInject(options: SmartInjectionOptions): Promise<SmartInjectionResult> {
  const config = loadConfig();
  const maxTokens = options.max_tokens || config.injection.max_tokens;
  const minImportance = options.min_importance ?? config.injection.min_importance;
  const db = options.db;
  const taskContext = options.task_context;

  // ~4 chars per token estimate
  const totalCharBudget = maxTokens * 4;

  // ── Stage 1: Profile synthesis/retrieval ──────────────────────────────
  let profileText: string | null = null;
  let profileFromCache = false;

  try {
    const profileResult = await synthesizeProfile({
      project_id: options.project_id,
      agent_id: options.agent_id,
      scope: options.project_id ? "project" : options.agent_id ? "agent" : "global",
      force_refresh: options.force_profile_refresh,
    });
    if (profileResult) {
      profileText = profileResult.profile;
      profileFromCache = profileResult.from_cache;
    }
  } catch {
    // Profile synthesis is non-critical — skip on failure
  }

  // ── Stage 2: Collect candidate memories ───────────────────────────────
  const candidates = collectVisibleMemories(
    {
      project_id: options.project_id,
      agent_id: options.agent_id,
      session_id: options.session_id,
      min_importance: minImportance,
    },
    db
  );

  // ── Stage 3: Activation matching via semantic search ──────────────────
  // Try semantic search against task_context; build activation score map
  const activationMap = new Map<string, number>();
  try {
    const semanticResults = await semanticSearch(
      taskContext,
      {
        threshold: 0.25, // Lower threshold to cast a wider net for ranking
        limit: 50,
        project_id: options.project_id,
        agent_id: options.agent_id,
      },
      db
    );
    for (const result of semanticResults) {
      activationMap.set(result.memory.id, result.score);
    }
  } catch {
    // No embeddings or search failed — activation scores remain 0
  }

  // ── Stage 4: Tool guide retrieval ─────────────────────────────────────
  const detectedTools = detectToolMentions(taskContext);
  const includeToolGuides = hasToolContext(taskContext) || detectedTools.length > 0;

  interface ToolGuide {
    tool_name: string;
    stats_line: string;
    lessons: string[];
  }

  const toolGuides: ToolGuide[] = [];
  if (includeToolGuides) {
    for (const toolName of detectedTools.slice(0, 5)) { // Cap at 5 tools
      try {
        const stats = getToolStats(toolName, options.project_id, db);
        const lessons = getToolLessons(toolName, options.project_id, 5, db);

        if (stats.total_calls > 0 || lessons.length > 0) {
          const statsLine = stats.total_calls > 0
            ? `${stats.total_calls} calls, ${Math.round(stats.success_rate * 100)}% success` +
              (stats.avg_latency_ms ? `, ~${Math.round(stats.avg_latency_ms)}ms avg` : "")
            : "no usage data";
          const lessonLines = lessons.map(
            (l) => `  - ${l.lesson}${l.when_to_use ? ` (when: ${l.when_to_use})` : ""}`
          );
          toolGuides.push({ tool_name: toolName, stats_line: statsLine, lessons: lessonLines });
        }
      } catch {
        // Tool stats retrieval is non-critical
      }
    }
  }

  // ── Stage 5: Decay scoring + composite ranking ────────────────────────
  const scored: ScoredSmartMemory[] = candidates.map((m) => {
    const decay = computeDecayScore(m);
    const activation = activationMap.get(m.id) ?? 0;
    const normalizedImportance = m.importance / 10;
    const pinBonus = m.pinned ? 1.0 : 0;

    // Composite: activation_match * 0.35 + decay_normalized * 0.35 + importance * 0.20 + pin * 0.10
    const normalizedDecay = Math.min(decay / 10, 1.0); // Normalize decay to 0-1 range
    const score =
      activation * 0.35 +
      normalizedDecay * 0.35 +
      normalizedImportance * 0.20 +
      pinBonus * 0.10;

    return { memory: m, score, activation, decay };
  });

  // Sort by composite score descending
  scored.sort((a, b) => b.score - a.score);

  // ── Stage 6: Layer by type with token budgeting ───────────────────────
  // Budget allocation: Profile 15%, Core Facts 25%, Tool Guides 15%, Procedures 15%, Preferences 15%, History 15%
  const footer = "Tip: Use memory_search for deeper lookup on specific topics.";
  const headerOverhead = 200; // Section headers, XML tags, footer
  const availableBudget = totalCharBudget - footer.length - headerOverhead;

  // Profile gets a fixed slice
  const profileBudget = profileText ? Math.floor(availableBudget * 0.15) : 0;
  const toolGuideBudget = toolGuides.length > 0 ? Math.floor(availableBudget * 0.15) : 0;
  // Remaining budget goes to memory sections
  const memoryBudget = availableBudget - profileBudget - toolGuideBudget;

  // Section budgets for memory-based sections (proportional)
  const sectionWeights: Record<SmartSection, number> = {
    "Profile": 0, // handled separately
    "Core Facts": 0.30,
    "Tool Guides": 0, // handled separately
    "Procedures": 0.25,
    "Preferences": 0.25,
    "Recent History": 0.20,
  };

  // Bucket memories into sections by category, maintaining score order within each
  const sectionBuckets = new Map<SmartSection, ScoredSmartMemory[]>();
  for (const s of scored) {
    // Skip profile memories from the regular buckets (they go in Profile section)
    if (s.memory.key.startsWith("_profile_")) continue;

    // When a profile was synthesized, exclude preference memories to avoid redundancy
    // (the profile already covers preferences in a synthesized form)
    if (profileText && s.memory.category === "preference") continue;

    const section = categoryToSection(s.memory.category, s.memory.key);
    if (section === "Profile") continue; // double-check

    if (!sectionBuckets.has(section)) {
      sectionBuckets.set(section, []);
    }
    sectionBuckets.get(section)!.push(s);
  }

  // Build each memory section within its budget
  const sectionOutput = new Map<SmartSection, string[]>();
  const injectedIds: string[] = [];
  let totalMemoryCount = 0;

  const memorySections: SmartSection[] = ["Core Facts", "Procedures", "Preferences", "Recent History"];

  for (const sectionName of memorySections) {
    const bucket = sectionBuckets.get(sectionName) || [];
    if (bucket.length === 0) continue;

    const weight = sectionWeights[sectionName];
    const budget = Math.floor(memoryBudget * weight);
    const lines: string[] = [];
    let chars = 0;

    for (const { memory: m } of bucket) {
      const line = formatMemoryLine(m);
      if (chars + line.length > budget) break;
      lines.push(line);
      injectedIds.push(m.id);
      chars += line.length;
      totalMemoryCount++;
    }

    if (lines.length > 0) {
      sectionOutput.set(sectionName, lines);
    }
  }

  // ── Stage 7: Assemble final output ────────────────────────────────────
  const outputSections: string[] = [];

  // 1. Profile section
  if (profileText) {
    const trimmedProfile = profileText.length > profileBudget
      ? profileText.slice(0, profileBudget - 3) + "..."
      : profileText;
    outputSections.push(`## Profile\n${trimmedProfile}`);
  }

  // 2. Core Facts
  if (sectionOutput.has("Core Facts")) {
    outputSections.push(`## Core Facts\n${sectionOutput.get("Core Facts")!.join("\n")}`);
  }

  // 3. Tool Guides
  if (toolGuides.length > 0) {
    const toolLines: string[] = [];
    let toolChars = 0;
    for (const guide of toolGuides) {
      const header = `- **${guide.tool_name}**: ${guide.stats_line}`;
      if (toolChars + header.length > toolGuideBudget) break;
      toolLines.push(header);
      toolChars += header.length;
      for (const lesson of guide.lessons) {
        if (toolChars + lesson.length > toolGuideBudget) break;
        toolLines.push(lesson);
        toolChars += lesson.length;
      }
    }
    if (toolLines.length > 0) {
      outputSections.push(`## Tool Guides\n${toolLines.join("\n")}`);
    }
  }

  // 4. Procedures
  if (sectionOutput.has("Procedures")) {
    outputSections.push(`## Procedures\n${sectionOutput.get("Procedures")!.join("\n")}`);
  }

  // 5. Preferences
  if (sectionOutput.has("Preferences")) {
    outputSections.push(`## Preferences\n${sectionOutput.get("Preferences")!.join("\n")}`);
  }

  // 6. Recent History
  if (sectionOutput.has("Recent History")) {
    outputSections.push(`## Recent History\n${sectionOutput.get("Recent History")!.join("\n")}`);
  }

  // If nothing was produced, return empty
  if (outputSections.length === 0) {
    return {
      output: "",
      token_estimate: 0,
      memory_count: 0,
      profile_from_cache: profileFromCache,
      detected_tools: detectedTools,
    };
  }

  outputSections.push(footer);

  // Touch injected memories to update access timestamps
  for (const id of injectedIds) {
    touchMemory(id, db);
  }

  const output = `<agent-memories>\n${outputSections.join("\n\n")}\n</agent-memories>`;
  const tokenEstimate = Math.ceil(output.length / 4);

  return {
    output,
    token_estimate: tokenEstimate,
    memory_count: totalMemoryCount,
    profile_from_cache: profileFromCache,
    detected_tools: detectedTools,
  };
}
