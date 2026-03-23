/**
 * Tool Memory Synthesizer — periodic LLM consolidation of tool experience.
 * For tools with 10+ events, synthesizes aggregated insights into a single
 * high-importance guide memory. Archives individual low-importance tool memories.
 * ReMe ToolSummarizer equivalent, but runs periodically rather than per-call.
 */

import { getToolStats, getToolLessons, getToolEvents } from "../db/tool-events.js";
import { createMemory } from "../db/memories.js";

const SYNTHESIS_PROMPT = `You are a tool usage expert. Given aggregated statistics and individual lessons about a specific tool, synthesize a comprehensive tool guide.

Output a structured guide with these sections:
1. **Overview**: One-line summary of what this tool is good/bad at
2. **Reliability**: Success rate assessment and when it's most/least reliable
3. **Best Practices**: Dos — what works well (from successful patterns)
4. **Pitfalls**: Don'ts — common failure modes and how to avoid them
5. **Parameters**: Any parameter optimization insights
6. **When to Use**: The ideal situations for this tool vs alternatives

Keep it concise — max 500 words. Be specific and actionable, not generic.`;

interface SynthesisResult {
  tool_name: string;
  guide: string;
  when_to_use: string;
  lessons_consolidated: number;
}

export async function synthesizeToolMemory(
  tool_name: string,
  options?: {
    project_id?: string;
    agent_id?: string;
    min_events?: number;
  }
): Promise<SynthesisResult | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return null;

  const minEvents = options?.min_events || 10;
  const stats = getToolStats(tool_name, options?.project_id);

  if (stats.total_calls < minEvents) return null;

  const lessons = getToolLessons(tool_name, options?.project_id, 30);
  const recentEvents = getToolEvents({
    tool_name,
    project_id: options?.project_id,
    limit: 20,
  });

  // Build context for LLM
  const context = `Tool: ${tool_name}
Stats: ${stats.total_calls} calls, ${(stats.success_rate * 100).toFixed(1)}% success rate
Avg tokens: ${stats.avg_tokens?.toFixed(0) || "N/A"}, Avg latency: ${stats.avg_latency_ms?.toFixed(0) || "N/A"}ms
Common errors: ${stats.common_errors.map(e => `${e.error_type} (${e.count})`).join(", ") || "none"}

Individual lessons (${lessons.length}):
${lessons.map((l, i) => `${i + 1}. ${l.lesson}${l.when_to_use ? ` [when: ${l.when_to_use}]` : ""}`).join("\n")}

Recent events summary:
${recentEvents.slice(0, 10).map(e => `- ${e.action || "call"}: ${e.success ? "✓" : "✗"}${e.error_type ? ` (${e.error_type})` : ""}${e.lesson ? ` — ${e.lesson}` : ""}`).join("\n")}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system: SYNTHESIS_PROMPT,
        messages: [{ role: "user", content: context }],
      }),
    });

    if (!response.ok) return null;
    const data = await response.json() as { content: { type: string; text: string }[] };
    const guide = data.content?.[0]?.text?.trim();
    if (!guide) return null;

    const whenToUse = `When using the ${tool_name} tool or deciding whether to use it`;

    // Save as high-importance pinned memory
    try {
      createMemory({
        key: `tool-guide-${tool_name}`,
        value: guide,
        category: "knowledge",
        scope: "shared",
        importance: 9,
        source: "auto",
        tags: ["tool-guide", tool_name, "synthesized"],
        when_to_use: whenToUse,
        metadata: {
          synthesized_from: stats.total_calls,
          success_rate: stats.success_rate,
          lessons_consolidated: lessons.length,
          synthesized_at: new Date().toISOString(),
        },
        agent_id: options?.agent_id,
        project_id: options?.project_id,
      });
    } catch {
      // Memory save failed — guide still returned
    }

    return {
      tool_name,
      guide,
      when_to_use: whenToUse,
      lessons_consolidated: lessons.length,
    };
  } catch {
    return null;
  }
}

/**
 * Synthesize guides for all tools with enough events.
 * Intended to be called periodically (e.g., by ALMA scheduler).
 */
export async function synthesizeAllToolMemories(
  options?: {
    project_id?: string;
    agent_id?: string;
    min_events?: number;
  }
): Promise<SynthesisResult[]> {
  // Get unique tool names from recent events
  const events = getToolEvents({ project_id: options?.project_id, limit: 200 });
  const toolNames = [...new Set(events.map(e => e.tool_name))];

  const results: SynthesisResult[] = [];
  for (const toolName of toolNames) {
    const result = await synthesizeToolMemory(toolName, options);
    if (result) results.push(result);
  }

  return results;
}
