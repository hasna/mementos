/**
 * Auto-generates when_to_use activation contexts for memories using LLM.
 * Fires async (non-blocking) after memory save via PostMemorySave hook.
 * Enable with MEMENTOS_AUTO_WHEN_TO_USE=true environment variable.
 */

import { getDatabase } from "../db/database.js";

// LLM provider pattern — copy from auto-memory.ts
// The project uses a simple fetch-based approach to call LLMs (Anthropic Haiku by default)

const SYSTEM_PROMPT = `You generate activation contexts for memory records. Given a memory's key, value, category, and tags, output a 1-2 sentence "when to use" description that describes the SITUATION or CONDITION under which an AI agent should retrieve this memory.

Rules:
- Start with "When" or "If"
- Describe the situation, not the content
- Be specific enough to avoid false matches but general enough to catch relevant scenarios
- Focus on the task/action the agent would be doing, not what the memory contains

Examples:
- Key: "preferred-language", Value: "Always use TypeScript, never JavaScript" → "When choosing a programming language for a new file or project"
- Key: "db-migration-order", Value: "Always run migrations before deploying" → "When deploying or updating database schema"
- Key: "bash-chain-bug", Value: "Bash tool mangles && chains" → "When chaining commands with && in the Bash tool"`;

export async function generateWhenToUse(
  key: string,
  value: string,
  category: string,
  tags: string[]
): Promise<string | null> {
  // Check if enabled
  if (process.env["MEMENTOS_AUTO_WHEN_TO_USE"] !== "true") return null;

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return null;

  try {
    const userMessage = `Key: "${key}"\nValue: "${value}"\nCategory: ${category}\nTags: ${tags.join(", ") || "none"}\n\nGenerate the when_to_use activation context (1-2 sentences):`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) return null;
    const data = await response.json() as { content: { type: string; text: string }[] };
    const text = data.content?.[0]?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * PostMemorySave hook: auto-generate when_to_use if missing.
 * Non-blocking — fires after save, updates memory async.
 */
export async function autoGenerateWhenToUse(ctx: {
  memory: { id: string; key: string; value: string; category: string; tags: string[]; when_to_use?: string | null };
  wasUpdated: boolean;
}): Promise<void> {
  // Skip if already has when_to_use or disabled
  if (ctx.memory.when_to_use) return;
  if (process.env["MEMENTOS_AUTO_WHEN_TO_USE"] !== "true") return;

  try {
    const whenToUse = await generateWhenToUse(
      ctx.memory.key,
      ctx.memory.value,
      ctx.memory.category,
      ctx.memory.tags
    );

    if (whenToUse) {
      const db = getDatabase();
      db.run(
        "UPDATE memories SET when_to_use = ? WHERE id = ? AND when_to_use IS NULL",
        [whenToUse, ctx.memory.id]
      );
    }
  } catch {
    // Never block on failure
  }
}
