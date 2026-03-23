// Training data gatherer for @hasna/mementos
// Used by open-brains to collect fine-tuning examples from memory data

import type { Memory } from "../types/index.js";
import { listMemories } from "../db/memories.js";

type GatherTrainingDataFn = (options?: {
  limit?: number;
  since?: Date;
}) => Promise<{
  source: string;
  examples: Array<{
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  }>;
  count: number;
}>;

const SYSTEM_PROMPT =
  "You are an AI assistant with persistent memory that recalls and saves information across sessions.";

function memoryToRecallExample(memory: Memory): {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
} {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `What do you remember about "${memory.key}"?`,
      },
      {
        role: "assistant",
        content: memory.summary
          ? `${memory.value}\n\nSummary: ${memory.summary}`
          : memory.value,
      },
    ],
  };
}

function memoryToSaveExample(memory: Memory): {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
} {
  const tags = memory.tags ?? [];
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Remember this for me: ${memory.key} = ${memory.value}${tags.length ? ` (tags: ${tags.join(", ")})` : ""}`,
      },
      {
        role: "assistant",
        content: `Saved to memory: "${memory.key}" with ${memory.category} category, importance ${memory.importance}/10, scope: ${memory.scope}.`,
      },
    ],
  };
}

function memoryToSearchExample(
  memories: Memory[],
  category: string
): {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
} {
  const matched = memories
    .filter((m) => m.category === category && m.status === "active")
    .slice(0, 5);
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `What ${category} memories do you have?` },
      {
        role: "assistant",
        content:
          matched.length > 0
            ? `Here are my ${category} memories:\n${matched
                .map(
                  (m) =>
                    `- ${m.key}: ${m.value.slice(0, 120)}${m.value.length > 120 ? "..." : ""}`
                )
                .join("\n")}`
            : `I don't have any ${category} memories stored yet.`,
      },
    ],
  };
}

export const gatherTrainingData: GatherTrainingDataFn = async (
  options = {}
) => {
  const allMemories = listMemories({ status: "active" });

  // Apply since filter
  const filtered = options.since
    ? allMemories.filter(
        (m) => new Date(m.created_at) >= options.since!
      )
    : allMemories;

  // Sort by importance desc
  const sorted = filtered
    .slice()
    .sort((a, b) => b.importance - a.importance);

  const fetchSet = options.limit
    ? sorted.slice(0, options.limit * 3)
    : sorted;

  const examples: Array<{
    messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
  }> = [];

  for (const memory of fetchSet) {
    examples.push(memoryToRecallExample(memory));
    examples.push(memoryToSaveExample(memory));
  }

  // Category search examples
  const categories = [...new Set(fetchSet.map((m) => m.category))];
  for (const category of categories) {
    examples.push(memoryToSearchExample(fetchSet, category));
  }

  const finalExamples = options.limit
    ? examples.slice(0, options.limit)
    : examples;

  return {
    source: "mementos",
    examples: finalExamples,
    count: finalExamples.length,
  };
};
