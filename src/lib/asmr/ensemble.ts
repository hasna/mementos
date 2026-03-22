/**
 * Answer ensemble with majority voting for ASMR.
 * Generates N prompt variants from retrieved context, runs in parallel,
 * then aggregates via majority voting with optional escalation.
 */

import type { AsmrResult } from "./types.js";

const DEFAULT_MODEL = "gpt-4.1-mini";
const ESCALATION_MODEL = "gpt-4.1";
const CONSENSUS_THRESHOLD = 0.7;

interface EnsembleOptions {
  variants?: number;
  model?: string;
  escalation_model?: string;
  consensus_threshold?: number;
}

export interface EnsembleAnswer {
  answer: string;
  confidence: number;
  reasoning: string;
  variants_used: number;
  consensus_reached: boolean;
  escalated: boolean;
}

const VARIANT_PROMPTS = [
  "Focus on the most recent and up-to-date facts. If there are contradictions, prefer the newer information.",
  "Focus on factual accuracy. Only use information explicitly stated in the memories. Do not infer.",
  "Focus on relationships and connections between entities. Consider how different facts relate to each other.",
  "Focus on the chronological timeline. Consider when events happened and how the situation evolved over time.",
  "Synthesize all available information into a comprehensive answer. Consider all perspectives and resolve contradictions.",
  "Focus on preferences and personal information. Prioritize what the user has explicitly stated they prefer or want.",
  "Be skeptical. Look for contradictions, outdated information, or facts that might no longer be true.",
  "Focus on the most frequently mentioned and highly-rated facts. These are likely the most important.",
];

function buildContext(result: AsmrResult): string {
  const sections: string[] = [];

  if (result.facts.length > 0) {
    sections.push("Known Facts:\n" + result.facts.map((f) => `- ${f}`).join("\n"));
  }

  if (result.timeline.length > 0) {
    sections.push("Timeline:\n" + result.timeline.map((t) => `- ${t}`).join("\n"));
  }

  const memories = result.memories.slice(0, 30);
  if (memories.length > 0) {
    sections.push(
      "Memory Excerpts:\n" +
        memories
          .map((m) => `[${m.source_agent}] ${m.memory.key}: ${m.verbatim_excerpt.slice(0, 500)}`)
          .join("\n\n")
    );
  }

  return sections.join("\n\n---\n\n");
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  model: string
): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"] ?? process.env["LLM_API_KEY"];
  if (!apiKey) throw new Error("No API key for ensemble LLM calls");

  const baseUrl = process.env["LLM_BASE_URL"] ?? "https://api.openai.com/v1";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`LLM API ${res.status}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

function findMajority(answers: string[]): { answer: string; count: number; total: number } | null {
  if (answers.length === 0) return null;

  // Normalize answers for comparison (lowercase, trim, remove trailing punctuation)
  const normalized = answers.map((a) => a.toLowerCase().trim().replace(/[.!?]+$/, ""));
  const counts = new Map<string, { original: string; count: number }>();

  for (let i = 0; i < normalized.length; i++) {
    const key = normalized[i]!;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { original: answers[i]!, count: 1 });
    }
  }

  // Find the answer with the highest count
  let best: { original: string; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }

  return best ? { answer: best.original, count: best.count, total: answers.length } : null;
}

export async function ensembleAnswer(
  context: AsmrResult,
  query: string,
  opts?: EnsembleOptions
): Promise<EnsembleAnswer> {
  const numVariants = Math.min(opts?.variants ?? 5, VARIANT_PROMPTS.length);
  const model = opts?.model ?? DEFAULT_MODEL;
  const escalationModel = opts?.escalation_model ?? ESCALATION_MODEL;
  const threshold = opts?.consensus_threshold ?? CONSENSUS_THRESHOLD;

  const contextStr = buildContext(context);
  if (!contextStr.trim()) {
    return {
      answer: "No relevant information found in memory.",
      confidence: 0,
      reasoning: "No context available from ASMR search agents.",
      variants_used: 0,
      consensus_reached: false,
      escalated: false,
    };
  }

  // Run N variants in parallel
  const variantPromises = VARIANT_PROMPTS.slice(0, numVariants).map((variantInstruction) =>
    callLLM(
      `You are a memory retrieval assistant. Answer the user's question based ONLY on the provided context.\n\n${variantInstruction}\n\nContext:\n${contextStr}`,
      query,
      model
    ).catch(() => null)
  );

  const results = await Promise.all(variantPromises);
  const answers = results.filter((r): r is string => r !== null && r.trim().length > 0);

  if (answers.length === 0) {
    return {
      answer: "Unable to generate an answer from the available context.",
      confidence: 0,
      reasoning: "All variant prompts failed.",
      variants_used: numVariants,
      consensus_reached: false,
      escalated: false,
    };
  }

  // Check for majority consensus
  const majority = findMajority(answers);
  if (majority && majority.count / majority.total >= threshold) {
    return {
      answer: majority.answer,
      confidence: majority.count / majority.total,
      reasoning: `${majority.count}/${majority.total} variants agreed on this answer.`,
      variants_used: numVariants,
      consensus_reached: true,
      escalated: false,
    };
  }

  // No consensus — escalate to better model for conflict resolution
  try {
    const escalationPrompt = `Multiple analysis variants produced different answers to the question. Review all of them and produce the single best answer.

Question: ${query}

Context:
${contextStr}

Variant answers:
${answers.map((a, i) => `Variant ${i + 1}: ${a}`).join("\n\n")}

Produce the single most accurate answer based on the context. If there are genuine contradictions in the data, acknowledge them.`;

    const finalAnswer = await callLLM(
      "You are an expert arbitrator. Given multiple candidate answers and the original context, determine the most accurate answer.",
      escalationPrompt,
      escalationModel
    );

    return {
      answer: finalAnswer,
      confidence: 0.6,
      reasoning: `No consensus (best: ${majority?.count ?? 0}/${answers.length}). Escalated to ${escalationModel} for conflict resolution.`,
      variants_used: numVariants,
      consensus_reached: false,
      escalated: true,
    };
  } catch {
    // Escalation failed — return the most common answer
    return {
      answer: majority?.answer ?? answers[0]!,
      confidence: (majority?.count ?? 1) / answers.length,
      reasoning: `No consensus, escalation failed. Returning best available answer (${majority?.count ?? 1}/${answers.length} agreement).`,
      variants_used: numVariants,
      consensus_reached: false,
      escalated: false,
    };
  }
}
