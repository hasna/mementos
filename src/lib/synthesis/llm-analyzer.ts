import { providerRegistry } from "../providers/registry.js";
import type { AnalysisCorpus } from "./corpus-builder.js";

// ============================================================================
// Types
// ============================================================================

export interface SynthesisAnalysisResult {
  proposals: Array<{
    type: "merge" | "archive" | "promote" | "update_value" | "add_tag" | "remove_duplicate";
    memory_ids: string[];
    target_memory_id?: string;
    proposed_changes: Record<string, unknown>;
    reasoning: string;
    confidence: number;
  }>;
  summary: string;
  analysisDurationMs: number;
}

// ============================================================================
// Prompt builders
// ============================================================================

const SYNTHESIS_SYSTEM_PROMPT =
  "You are a memory synthesizer. Analyze this agent's memory corpus and propose consolidations to improve quality and reduce redundancy. Return ONLY a JSON array of proposal objects.";

function buildCorpusPrompt(
  corpus: AnalysisCorpus,
  maxProposals: number
): string {
  const lines: string[] = [];

  lines.push(`## Memory Corpus Analysis`);
  lines.push(`Project: ${corpus.projectId ?? "(global)"}`);
  lines.push(`Total active memories: ${corpus.totalMemories}`);
  lines.push(`Analysis generated at: ${corpus.generatedAt}`);
  lines.push("");

  // Stale memories section
  if (corpus.staleMemories.length > 0) {
    lines.push(`## Stale Memories (not accessed in 30+ days, importance < 7)`);
    lines.push(`Count: ${corpus.staleMemories.length}`);
    for (const m of corpus.staleMemories.slice(0, 30)) {
      const accessed = m.accessed_at ?? "never";
      lines.push(
        `- id:${m.id} key="${m.key}" importance=${m.importance} lastAccessed=${accessed}`
      );
      lines.push(`  value: ${m.value.slice(0, 120)}`);
    }
    lines.push("");
  }

  // Duplicate candidates section
  if (corpus.duplicateCandidates.length > 0) {
    lines.push(`## Potential Duplicates (term overlap ≥ 50%)`);
    lines.push(`Count: ${corpus.duplicateCandidates.length} pairs`);
    for (const { a, b, similarity } of corpus.duplicateCandidates.slice(0, 20)) {
      lines.push(`- similarity=${similarity.toFixed(2)}`);
      lines.push(`  A id:${a.id} key="${a.key}" importance=${a.importance}: ${a.value.slice(0, 80)}`);
      lines.push(`  B id:${b.id} key="${b.key}" importance=${b.importance}: ${b.value.slice(0, 80)}`);
    }
    lines.push("");
  }

  // Low-importance high-recall (promotion candidates)
  if (corpus.lowImportanceHighRecall.length > 0) {
    lines.push(`## Low Importance But High Recall (candidates for importance promotion)`);
    for (const m of corpus.lowImportanceHighRecall.slice(0, 20)) {
      lines.push(
        `- id:${m.id} key="${m.key}" importance=${m.importance} recall_count=${m.access_count}`
      );
    }
    lines.push("");
  }

  // High-importance zero-recall (worth reviewing)
  if (corpus.highImportanceLowRecall.length > 0) {
    lines.push(`## High Importance But Never Recalled (may need value update)`);
    for (const m of corpus.highImportanceLowRecall.slice(0, 20)) {
      lines.push(
        `- id:${m.id} key="${m.key}" importance=${m.importance}: ${m.value.slice(0, 80)}`
      );
    }
    lines.push("");
  }

  lines.push(`## Instructions`);
  lines.push(
    `Generate up to ${maxProposals} proposals as a JSON array. Each proposal must have:`
  );
  lines.push(`  - type: "merge" | "archive" | "promote" | "update_value" | "add_tag" | "remove_duplicate"`);
  lines.push(`  - memory_ids: string[] (IDs this proposal acts on)`);
  lines.push(`  - target_memory_id: string (optional — used for merge/remove_duplicate)`);
  lines.push(`  - proposed_changes: object (e.g. {new_importance:8} or {new_value:"..."} or {tags:["x"]})`);
  lines.push(`  - reasoning: string (one sentence)`);
  lines.push(`  - confidence: number 0.0-1.0`);
  lines.push("");
  lines.push(`Return ONLY the JSON array. No markdown, no explanation.`);

  return lines.join("\n");
}

// ============================================================================
// Analyzer
// ============================================================================

export async function analyzeCorpus(
  corpus: AnalysisCorpus,
  options?: { provider?: string; maxProposals?: number }
): Promise<SynthesisAnalysisResult> {
  const startMs = Date.now();
  const maxProposals = options?.maxProposals ?? 20;

  const empty: SynthesisAnalysisResult = {
    proposals: [],
    summary: "No LLM provider available.",
    analysisDurationMs: 0,
  };

  // Get provider — never throw if unavailable
  let provider = options?.provider
    ? providerRegistry.getProvider(options.provider as Parameters<typeof providerRegistry.getProvider>[0])
    : providerRegistry.getAvailable();

  if (!provider) {
    return { ...empty, analysisDurationMs: Date.now() - startMs };
  }

  const userPrompt = buildCorpusPrompt(corpus, maxProposals);

  try {
    // Use the provider's underlying HTTP call pattern.
    // LLMProvider interface doesn't have a generic "complete" method,
    // so we use extractMemories with a carefully shaped input to get raw JSON back.
    // Instead, we make a direct fetch call using the same pattern as the provider implementations.
    const rawResponse = await callProviderRaw(provider, SYNTHESIS_SYSTEM_PROMPT, userPrompt);

    if (!rawResponse) {
      return { ...empty, analysisDurationMs: Date.now() - startMs };
    }

    const parsed = parseProposalsResponse(rawResponse);

    const analysisDurationMs = Date.now() - startMs;
    const validProposals = parsed.slice(0, maxProposals);

    return {
      proposals: validProposals,
      summary: buildSummary(corpus, validProposals.length),
      analysisDurationMs,
    };
  } catch {
    // Never throw — return empty on any error
    return { ...empty, analysisDurationMs: Date.now() - startMs };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Make a raw LLM call. We use the provider's config to construct the API call
 * directly, following the same pattern used in each provider implementation.
 * Returns raw text response or null.
 */
async function callProviderRaw(
  provider: ReturnType<typeof providerRegistry.getAvailable>,
  systemPrompt: string,
  userPrompt: string
): Promise<string | null> {
  if (!provider) return null;

  const { config, name } = provider;
  if (!config.apiKey) return null;

  const timeoutMs = config.timeoutMs ?? 30_000;

  try {
    if (name === "anthropic") {
      return await callAnthropic(config.apiKey, config.model, systemPrompt, userPrompt, timeoutMs);
    } else if (name === "openai" || name === "cerebras" || name === "grok") {
      return await callOpenAICompat(name, config.apiKey, config.model, systemPrompt, userPrompt, timeoutMs);
    }
  } catch {
    // Fall through
  }
  return null;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number
): Promise<string | null> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    content?: Array<{ type: string; text: string }>;
  };

  return data.content?.[0]?.text ?? null;
}

function getBaseUrlForProvider(providerName: string): string {
  switch (providerName) {
    case "openai":
      return "https://api.openai.com/v1";
    case "cerebras":
      return "https://api.cerebras.ai/v1";
    case "grok":
      return "https://api.x.ai/v1";
    default:
      return "https://api.openai.com/v1";
  }
}

async function callOpenAICompat(
  providerName: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number
): Promise<string | null> {
  const baseUrl = getBaseUrlForProvider(providerName);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? null;
}

type RawProposal = {
  type: SynthesisAnalysisResult["proposals"][number]["type"];
  memory_ids: string[];
  target_memory_id?: string;
  proposed_changes: Record<string, unknown>;
  reasoning: string;
  confidence: number;
};

function parseProposalsResponse(raw: string): SynthesisAnalysisResult["proposals"] {
  try {
    // Strip markdown fences
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "")
      .trim();

    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return [];

    const validTypes = new Set([
      "merge", "archive", "promote", "update_value", "add_tag", "remove_duplicate",
    ]);

    return (parsed as unknown[])
      .filter((item): item is RawProposal => {
        if (!item || typeof item !== "object") return false;
        const p = item as Record<string, unknown>;
        return (
          typeof p["type"] === "string" &&
          validTypes.has(p["type"]) &&
          Array.isArray(p["memory_ids"]) &&
          typeof p["proposed_changes"] === "object" &&
          typeof p["reasoning"] === "string" &&
          typeof p["confidence"] === "number"
        );
      })
      .map((p) => ({
        type: p.type,
        memory_ids: (p.memory_ids as unknown[]).filter((id): id is string => typeof id === "string"),
        target_memory_id: typeof p.target_memory_id === "string" ? p.target_memory_id : undefined,
        proposed_changes: (p.proposed_changes as Record<string, unknown>) ?? {},
        reasoning: p.reasoning,
        confidence: Math.max(0, Math.min(1, p.confidence)),
      }));
  } catch {
    return [];
  }
}

function buildSummary(corpus: AnalysisCorpus, proposalCount: number): string {
  return (
    `Analyzed ${corpus.totalMemories} memories. ` +
    `Found ${corpus.staleMemories.length} stale, ` +
    `${corpus.duplicateCandidates.length} duplicate pairs. ` +
    `Generated ${proposalCount} proposals.`
  );
}
