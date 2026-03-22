import { Database } from "bun:sqlite";
import { runFactAgent } from "./fact-agent.js";
import { runContextAgent } from "./context-agent.js";
import { runTemporalAgent } from "./temporal-agent.js";
import type { AsmrOptions, AsmrResult, AsmrMemoryResult, SearchAgentResult } from "./types.js";

const DEFAULT_MAX_RESULTS = 20;

function mergeResults(
  agentResults: { agent: AsmrMemoryResult["source_agent"]; result: SearchAgentResult }[]
): AsmrMemoryResult[] {
  const byId = new Map<string, {
    best: AsmrMemoryResult;
    sources: Set<AsmrMemoryResult["source_agent"]>;
    maxScore: number;
  }>();

  for (const { agent, result } of agentResults) {
    for (const mem of result.memories) {
      const existing = byId.get(mem.memory.id);
      if (!existing) {
        byId.set(mem.memory.id, {
          best: mem,
          sources: new Set([agent]),
          maxScore: mem.score,
        });
      } else {
        existing.sources.add(agent);
        if (mem.score > existing.maxScore) {
          existing.best = mem;
          existing.maxScore = mem.score;
        }
      }
    }
  }

  const merged: AsmrMemoryResult[] = [];
  for (const [, entry] of byId) {
    const multiAgentBoost = entry.sources.size > 1 ? 1.5 : 1.0;
    merged.push({
      ...entry.best,
      score: entry.maxScore * multiAgentBoost,
    });
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}

function extractFacts(factResult: SearchAgentResult): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();

  for (const mem of factResult.memories) {
    const statement = `${mem.memory.key}: ${mem.memory.value}`;
    if (!seen.has(mem.memory.id)) {
      seen.add(mem.memory.id);
      facts.push(statement);
    }
  }

  return facts;
}

function extractTimeline(temporalResult: SearchAgentResult): string[] {
  const entries: { date: string; label: string }[] = [];
  const seen = new Set<string>();

  for (const mem of temporalResult.memories) {
    if (seen.has(mem.memory.id)) continue;
    seen.add(mem.memory.id);

    const date = mem.memory.valid_from ?? mem.memory.created_at;
    const status = mem.memory.status === "archived" ? " [superseded]" : "";
    entries.push({
      date,
      label: `${date.slice(0, 10)}: ${mem.memory.key}${status}`,
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries.map(e => e.label);
}

export async function asmrRecall(db: Database, query: string, opts?: AsmrOptions): Promise<AsmrResult> {
  const options: AsmrOptions = {
    max_results: DEFAULT_MAX_RESULTS,
    include_reasoning: true,
    ...opts,
  };

  const start = performance.now();

  const [factResult, contextResult, temporalResult] = await Promise.all([
    runFactAgent(db, query, options),
    runContextAgent(db, query, options),
    runTemporalAgent(db, query, options),
  ]);

  const agentResults: { agent: AsmrMemoryResult["source_agent"]; result: SearchAgentResult }[] = [
    { agent: "facts", result: factResult },
    { agent: "context", result: contextResult },
    { agent: "temporal", result: temporalResult },
  ];

  const merged = mergeResults(agentResults);
  const trimmed = merged.slice(0, options.max_results ?? DEFAULT_MAX_RESULTS);

  const facts = extractFacts(factResult);
  const timeline = extractTimeline(temporalResult);

  const agentsUsed: AsmrMemoryResult["source_agent"][] = [];
  if (factResult.memories.length > 0) agentsUsed.push("facts");
  if (contextResult.memories.length > 0) agentsUsed.push("context");
  if (temporalResult.memories.length > 0) agentsUsed.push("temporal");

  const reasoningParts = [
    factResult.reasoning,
    contextResult.reasoning,
    temporalResult.reasoning,
  ].filter(Boolean);

  const duration = Math.round(performance.now() - start);

  return {
    memories: trimmed,
    facts,
    timeline,
    reasoning: reasoningParts.join(". "),
    agents_used: agentsUsed,
    duration_ms: duration,
  };
}
