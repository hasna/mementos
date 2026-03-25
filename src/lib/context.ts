/**
 * Layered context assembly — structured multi-section memory context.
 *
 * Assembles memories into sections:
 * - Core Facts: high-importance facts and preferences (importance >= 8)
 * - Recent History: memories from the last 24h
 * - Relevant Knowledge: query-matched knowledge (if query provided)
 * - Active Decisions: recent fact-category memories
 */

import { listMemories } from "../db/memories.js";
import type { MemoryFilter, Memory } from "../types/index.js";
import { SqliteAdapter as Database } from "@hasna/cloud";

export interface ContextSection {
  title: string;
  memories: Memory[];
}

export interface LayeredContext {
  sections: ContextSection[];
  total_memories: number;
  token_estimate: number;
}

/**
 * Assemble layered context from memories.
 */
export function assembleContext(
  options: {
    project_id?: string;
    agent_id?: string;
    scope?: string;
    query?: string;
    max_per_section?: number;
  } = {},
  db?: Database
): LayeredContext {
  const { project_id, agent_id, scope, max_per_section = 10 } = options;
  const baseFilter: MemoryFilter = {
    project_id,
    agent_id,
    scope: scope as MemoryFilter["scope"],
  };

  const sections: ContextSection[] = [];

  // Section 1: Core Facts — high-importance facts and preferences
  const coreFacts = listMemories(
    { ...baseFilter, category: ["fact", "preference"], min_importance: 8, limit: max_per_section },
    db
  );
  if (coreFacts.length > 0) {
    sections.push({ title: "Core Facts", memories: coreFacts });
  }

  // Section 2: Recent History — memories from last 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const allRecent = listMemories(
    { ...baseFilter, limit: max_per_section * 3 },
    db
  ).filter((m) => m.created_at > oneDayAgo || (m.accessed_at && m.accessed_at > oneDayAgo));
  const recentSlice = allRecent.slice(0, max_per_section);
  if (recentSlice.length > 0) {
    sections.push({ title: "Recent History", memories: recentSlice });
  }

  // Section 3: Relevant Knowledge — if query provided, search-matched knowledge
  if (options.query) {
    const knowledge = listMemories(
      { ...baseFilter, category: "knowledge", search: options.query, limit: max_per_section },
      db
    );
    if (knowledge.length > 0) {
      sections.push({ title: "Relevant Knowledge", memories: knowledge });
    }
  }

  // Section 4: Active Decisions — recent fact-category memories
  const decisions = listMemories(
    { ...baseFilter, category: "fact", limit: max_per_section },
    db
  );
  // Exclude ones already in Core Facts
  const coreFactIds = new Set(coreFacts.map((m) => m.id));
  const newDecisions = decisions.filter((m) => !coreFactIds.has(m.id));
  if (newDecisions.length > 0) {
    sections.push({ title: "Active Decisions", memories: newDecisions.slice(0, max_per_section) });
  }

  // Deduplicate across sections
  const seen = new Set<string>();
  for (const section of sections) {
    section.memories = section.memories.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  const allMemories = sections.flatMap((s) => s.memories);
  const tokenEstimate = allMemories.reduce((acc, m) => acc + Math.ceil((m.key.length + m.value.length) / 4), 0);

  return {
    sections: sections.filter((s) => s.memories.length > 0),
    total_memories: allMemories.length,
    token_estimate: tokenEstimate,
  };
}

/**
 * Format layered context as markdown.
 */
export function formatLayeredContext(ctx: LayeredContext): string {
  const parts: string[] = [];
  for (const section of ctx.sections) {
    parts.push(`## ${section.title}`);
    for (const m of section.memories) {
      parts.push(`- **${m.key}**: ${m.value.slice(0, 150)}${m.value.length > 150 ? "..." : ""} (importance: ${m.importance})`);
    }
    parts.push("");
  }
  return parts.join("\n");
}
