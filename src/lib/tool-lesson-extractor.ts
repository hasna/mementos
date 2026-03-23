/**
 * LLM-based tool lesson extraction from session transcripts.
 * Analyzes tool call sequences in a session and extracts:
 * - "Tool X works well for Y with params Z"
 * - "Tool X fails when Y because Z, use alternative A"
 * - "For best results with X, set param Y to Z"
 * - "When X returns error Y, solution is Z"
 *
 * Saves both structured tool_events and qualitative memories.
 */

import { saveToolEvent } from "../db/tool-events.js";
import { createMemory } from "../db/memories.js";

const SYSTEM_PROMPT = `You are a tool usage analyst. Given a session transcript containing tool calls and their results, extract actionable lessons about tool usage.

For each tool lesson, output a JSON array of objects with these fields:
- tool_name: name of the tool
- lesson: the insight (1-2 sentences)
- when_to_use: activation context — when should an agent recall this lesson (start with "When" or "If")
- success: boolean — was the tool call that taught this lesson successful?
- error_type: if failed, one of: timeout, permission, not_found, syntax, rate_limit, other (or null if success)

Focus on:
1. Successful patterns: what worked and why
2. Failure lessons: what went wrong and how to avoid it
3. Parameter insights: optimal settings discovered
4. Alternative tools: when one tool is better than another
5. Error recovery: what to do when a specific error occurs

Only extract genuinely useful, non-obvious lessons. Skip trivial observations.
Output ONLY the JSON array, no markdown or explanation.`;

interface ExtractedLesson {
  tool_name: string;
  lesson: string;
  when_to_use: string;
  success: boolean;
  error_type?: string | null;
}

export async function extractToolLessons(
  transcript: string,
  options?: {
    agent_id?: string;
    project_id?: string;
    session_id?: string;
  }
): Promise<ExtractedLesson[]> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return [];

  try {
    // Truncate transcript to avoid token limits (keep first 8000 chars)
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
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Extract tool lessons from this session transcript:\n\n${truncated}` }],
      }),
    });

    if (!response.ok) return [];
    const data = await response.json() as { content: { type: string; text: string }[] };
    const text = data.content?.[0]?.text?.trim();
    if (!text) return [];

    // Parse JSON response
    const lessons: ExtractedLesson[] = JSON.parse(text);
    if (!Array.isArray(lessons)) return [];

    // Save each lesson as both a tool_event and a memory
    for (const lesson of lessons) {
      if (!lesson.tool_name || !lesson.lesson) continue;

      // Save structured tool event
      try {
        saveToolEvent({
          tool_name: lesson.tool_name,
          success: lesson.success,
          error_type: lesson.error_type as any || undefined,
          lesson: lesson.lesson,
          when_to_use: lesson.when_to_use,
          context: "extracted from session transcript",
          agent_id: options?.agent_id,
          project_id: options?.project_id,
          session_id: options?.session_id,
        });
      } catch {
        // Don't fail on individual saves
      }

      // Save qualitative memory
      try {
        createMemory({
          key: `tool-lesson-${lesson.tool_name}-${Date.now()}`,
          value: lesson.lesson,
          category: "knowledge",
          scope: "shared",
          importance: 7,
          source: "auto",
          tags: ["tool-memory", lesson.tool_name, "auto-extracted"],
          when_to_use: lesson.when_to_use,
          agent_id: options?.agent_id,
          project_id: options?.project_id,
          session_id: options?.session_id,
        });
      } catch {
        // Don't fail on individual saves
      }
    }

    return lessons;
  } catch {
    return [];
  }
}
