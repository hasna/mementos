/**
 * Topic Clusterer — groups memories into named topics for hints display.
 * LLM-powered with cheap heuristic fallback.
 */

import type { Memory } from "../types/index.js";

export interface TopicCluster {
  name: string;
  memory_ids: string[];
  keywords: string[];
}

/**
 * Heuristic clustering (no LLM needed) — groups by category + tag overlap.
 * Fast, cheap, always available.
 */
export function clusterByHeuristic(memories: Memory[]): TopicCluster[] {
  if (memories.length === 0) return [];

  const groups = new Map<string, Memory[]>();

  for (const m of memories) {
    // Group by category first
    const cat = m.category || "knowledge";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(m);
  }

  const clusters: TopicCluster[] = [];
  for (const [category, mems] of groups) {
    // Within each category, sub-group by tag overlap
    const subGroups = subGroupByTags(mems);
    for (const sub of subGroups) {
      const keywords = extractKeywords(sub);
      clusters.push({
        name: keywords.length > 0 ? keywords.slice(0, 3).join(", ") : category,
        memory_ids: sub.map((m) => m.id),
        keywords,
      });
    }
  }

  return clusters;
}

function subGroupByTags(memories: Memory[]): Memory[][] {
  if (memories.length <= 3) return [memories];

  // Simple tag-overlap grouping
  const used = new Set<string>();
  const groups: Memory[][] = [];

  for (const m of memories) {
    if (used.has(m.id)) continue;

    const group = [m];
    used.add(m.id);

    for (const other of memories) {
      if (used.has(other.id)) continue;
      const overlap = m.tags.filter((t) => other.tags.includes(t));
      if (overlap.length > 0) {
        group.push(other);
        used.add(other.id);
      }
    }

    groups.push(group);
  }

  return groups;
}

function extractKeywords(memories: Memory[]): string[] {
  const words = new Map<string, number>();
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "and",
    "or",
    "not",
    "no",
    "this",
    "that",
  ]);

  for (const m of memories) {
    // Extract from key
    for (const part of m.key.split(/[-_\s]+/)) {
      const w = part.toLowerCase();
      if (w.length > 2 && !stopWords.has(w)) {
        words.set(w, (words.get(w) || 0) + 1);
      }
    }
    // Extract from tags
    for (const tag of m.tags) {
      const w = tag.toLowerCase();
      if (w.length > 2 && !stopWords.has(w)) {
        words.set(w, (words.get(w) || 0) + 1);
      }
    }
  }

  return [...words.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
}

/**
 * LLM clustering — sends memories to Haiku for semantic grouping.
 * Falls back to heuristic if no API key.
 */
export async function clusterByLLM(
  memories: Memory[]
): Promise<TopicCluster[]> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return clusterByHeuristic(memories);

  try {
    const memoryList = memories
      .slice(0, 50)
      .map((m) => `${m.key}: ${m.value.slice(0, 100)}`)
      .join("\n");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system:
          'Group these memories into 3-8 named topics. Output JSON array: [{name: string, indices: number[]}]. Indices are 0-based positions from the input list.',
        messages: [{ role: "user", content: memoryList }],
      }),
    });

    if (!response.ok) return clusterByHeuristic(memories);
    const data = (await response.json()) as {
      content: { type: string; text: string }[];
    };
    const text = data.content?.[0]?.text?.trim();
    if (!text) return clusterByHeuristic(memories);

    const groups = JSON.parse(text) as { name: string; indices: number[] }[];
    return groups.map((g) => ({
      name: g.name,
      memory_ids: g.indices
        .filter((i) => i < memories.length)
        .map((i) => memories[i]!.id),
      keywords: [g.name.toLowerCase()],
    }));
  } catch {
    return clusterByHeuristic(memories);
  }
}
