/**
 * LLM-based procedural memory extractor from session transcripts.
 * Extracts workflow patterns, step sequences, failure lessons, problem-solution pairs.
 * Saves as chained procedural memories with when_to_use and sequence_group.
 */

import { createMemory } from "../db/memories.js";
import { shortUuid } from "../db/database.js";

const SYSTEM_PROMPT = `You extract procedural knowledge from session transcripts — workflows, step sequences, and problem-solution patterns.

For each procedure found, output a JSON array of objects:
{
  "title": "short name for the workflow",
  "steps": [
    {"action": "what to do", "when_to_use": "activation context for this step"},
    {"action": "next step", "when_to_use": "activation context"}
  ],
  "failure_patterns": ["what to avoid and why"],
  "when_to_use": "overall activation context for the whole procedure"
}

Focus on:
1. Multi-step workflows that were completed successfully
2. Step sequences where order matters
3. Failure → recovery patterns (what went wrong, how it was fixed)
4. Problem-solution pairs (when X happens, do Y)

Only extract non-trivial procedures (3+ steps or genuinely useful patterns).
Output ONLY the JSON array.`;

interface ExtractedProcedure {
  title: string;
  steps: { action: string; when_to_use: string }[];
  failure_patterns: string[];
  when_to_use: string;
}

export async function extractProcedures(
  transcript: string,
  options?: {
    agent_id?: string;
    project_id?: string;
    session_id?: string;
  }
): Promise<ExtractedProcedure[]> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return [];

  try {
    const truncated = transcript.length > 8000 ? transcript.slice(0, 8000) + "\n[...truncated]" : transcript;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Extract procedures from this session:\n\n${truncated}` }],
      }),
    });

    if (!response.ok) return [];
    const data = await response.json() as { content: { type: string; text: string }[] };
    const text = data.content?.[0]?.text?.trim();
    if (!text) return [];

    const procedures: ExtractedProcedure[] = JSON.parse(text);
    if (!Array.isArray(procedures)) return [];

    // Save each procedure as a chain of memories
    for (const proc of procedures) {
      if (!proc.title || !proc.steps?.length) continue;

      const sequenceGroup = `proc-${shortUuid()}`;

      // Save each step as a chained procedural memory
      for (let i = 0; i < proc.steps.length; i++) {
        const step = proc.steps[i];
        if (!step) continue;
        try {
          createMemory({
            key: `${sequenceGroup}-step-${i + 1}`,
            value: step.action,
            category: "procedural",
            scope: "shared",
            importance: 7,
            source: "auto",
            tags: ["procedure", "auto-extracted", proc.title.toLowerCase().replace(/\s+/g, "-")],
            when_to_use: step.when_to_use || proc.when_to_use,
            sequence_group: sequenceGroup,
            sequence_order: i + 1,
            agent_id: options?.agent_id,
            project_id: options?.project_id,
            session_id: options?.session_id,
          });
        } catch {
          // Don't fail on individual saves
        }
      }

      // Save failure patterns as separate memories linked to the same group
      for (const pattern of proc.failure_patterns || []) {
        try {
          createMemory({
            key: `${sequenceGroup}-warning-${shortUuid()}`,
            value: `WARNING: ${pattern}`,
            category: "procedural",
            scope: "shared",
            importance: 8,
            source: "auto",
            tags: ["procedure", "failure-pattern", "auto-extracted"],
            when_to_use: proc.when_to_use,
            sequence_group: sequenceGroup,
            sequence_order: 999, // warnings go at end
            agent_id: options?.agent_id,
            project_id: options?.project_id,
            session_id: options?.session_id,
          });
        } catch {
          // Don't fail on individual saves
        }
      }
    }

    return procedures;
  } catch {
    return [];
  }
}
