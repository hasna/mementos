/**
 * LLM Provider abstraction for auto-memory formation.
 * Any LLM (Anthropic, OpenAI, Cerebras, Grok) implements LLMProvider.
 * All methods return structured data — providers must output valid JSON.
 */

import type { MemoryCategory, MemoryScope } from "../../types/index.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export type ProviderName = "anthropic" | "openai" | "cerebras" | "grok";

export interface AutoMemoryConfig {
  provider: ProviderName;
  model?: string;
  enabled: boolean;
  minImportance: number; // 0-10, skip memories below this threshold
  autoEntityLink: boolean;
  fallback?: ProviderName[]; // try these if primary fails
}

export const DEFAULT_AUTO_MEMORY_CONFIG: AutoMemoryConfig = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  enabled: true,
  minImportance: 4,
  autoEntityLink: true,
  fallback: ["cerebras", "openai"],
};

// ─── Extraction types ─────────────────────────────────────────────────────────

export interface MemoryExtractionContext {
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  /** Compact summary of existing memories to avoid duplicates */
  existingMemoriesSummary?: string;
  /** Working directory or project name for scope hints */
  projectName?: string;
}

export interface ExtractedMemory {
  content: string;
  category: MemoryCategory;
  importance: number; // 0-10
  tags: string[];
  suggestedScope: MemoryScope;
  /** Why this is worth remembering — used for dedup decisions */
  reasoning?: string;
}

export interface ExtractedEntity {
  name: string;
  /** Maps to EntityType in knowledge graph */
  type:
    | "person"
    | "project"
    | "tool"
    | "concept"
    | "file"
    | "api"
    | "pattern"
    | "organization";
  /** 0-1 confidence score */
  confidence: number;
}

export interface ExtractedRelation {
  from: string; // entity name
  to: string; // entity name
  type:
    | "uses"
    | "knows"
    | "depends_on"
    | "created_by"
    | "related_to"
    | "contradicts"
    | "part_of"
    | "implements";
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface LLMProvider {
  readonly name: ProviderName;
  readonly config: ProviderConfig;

  /**
   * Extract memories worth saving from a conversation turn or session chunk.
   * Must return [] on failure — never throw.
   */
  extractMemories(
    text: string,
    context: MemoryExtractionContext
  ): Promise<ExtractedMemory[]>;

  /**
   * Extract entities and relations from text for knowledge graph linking.
   * Must return empty arrays on failure — never throw.
   */
  extractEntities(text: string): Promise<EntityExtractionResult>;

  /**
   * Score how important a memory is (0-10).
   * Used when we already have the content but need a quality signal.
   * Must return a number on failure — never throw.
   */
  scoreImportance(
    content: string,
    context: MemoryExtractionContext
  ): Promise<number>;
}

// ─── Base class with shared utilities ────────────────────────────────────────

export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: ProviderName;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  abstract extractMemories(
    text: string,
    context: MemoryExtractionContext
  ): Promise<ExtractedMemory[]>;

  abstract extractEntities(text: string): Promise<EntityExtractionResult>;

  abstract scoreImportance(
    content: string,
    context: MemoryExtractionContext
  ): Promise<number>;

  /** Parse JSON from LLM response, stripping markdown code fences if present */
  protected parseJSON<T>(raw: string): T | null {
    try {
      // Strip markdown code fences
      const cleaned = raw
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/\s*```$/m, "")
        .trim();
      return JSON.parse(cleaned) as T;
    } catch {
      return null;
    }
  }

  /** Clamp a number to 0-10 importance range */
  protected clampImportance(value: unknown): number {
    const n = Number(value);
    if (isNaN(n)) return 5;
    return Math.max(0, Math.min(10, Math.round(n)));
  }

  /** Validate and normalise a single extracted memory */
  protected normaliseMemory(raw: unknown): ExtractedMemory | null {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.content !== "string" || !m.content.trim()) return null;

    const validScopes: MemoryScope[] = ["private", "shared", "global"];
    const validCategories: MemoryCategory[] = [
      "preference",
      "fact",
      "knowledge",
      "history",
    ];

    return {
      content: m.content.trim(),
      category: validCategories.includes(m.category as MemoryCategory)
        ? (m.category as MemoryCategory)
        : "knowledge",
      importance: this.clampImportance(m.importance),
      tags: Array.isArray(m.tags)
        ? (m.tags as unknown[])
            .filter((t) => typeof t === "string")
            .map((t) => (t as string).toLowerCase())
        : [],
      suggestedScope: validScopes.includes(m.suggestedScope as MemoryScope)
        ? (m.suggestedScope as MemoryScope)
        : "shared",
      reasoning:
        typeof m.reasoning === "string" ? m.reasoning : undefined,
    };
  }
}

// ─── Extraction prompts (shared across providers) ─────────────────────────────

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = `You are a precise memory extraction engine for an AI agent.
Given text, extract facts worth remembering as structured JSON.
Focus on: decisions made, preferences revealed, corrections, architectural choices, established facts, user preferences.
Ignore: greetings, filler, questions without answers, temporary states.
Output ONLY a JSON array — no markdown, no explanation.`;

export const MEMORY_EXTRACTION_USER_TEMPLATE = (
  text: string,
  context: MemoryExtractionContext
) => `Extract memories from this text.
${context.projectName ? `Project: ${context.projectName}` : ""}
${context.existingMemoriesSummary ? `Existing memories (avoid duplicates):\n${context.existingMemoriesSummary}` : ""}

Text:
${text}

Return a JSON array of objects with these exact fields:
- content: string (the memory, concise and specific)
- category: "preference" | "fact" | "knowledge" | "history"
- importance: number 0-10 (10 = critical, 0 = trivial)
- tags: string[] (lowercase keywords)
- suggestedScope: "private" | "shared" | "global"
- reasoning: string (one sentence why this is worth remembering)

Return [] if nothing is worth remembering.`;

export const ENTITY_EXTRACTION_SYSTEM_PROMPT = `You are a knowledge graph entity extractor.
Given text, identify named entities and their relationships.
Output ONLY valid JSON — no markdown, no explanation.`;

export const ENTITY_EXTRACTION_USER_TEMPLATE = (text: string) => `Extract entities and relations from this text.

Text: ${text}

Return JSON with this exact shape:
{
  "entities": [
    { "name": string, "type": "person"|"project"|"tool"|"concept"|"file"|"api"|"pattern"|"organization", "confidence": 0-1 }
  ],
  "relations": [
    { "from": string, "to": string, "type": "uses"|"knows"|"depends_on"|"created_by"|"related_to"|"contradicts"|"part_of"|"implements" }
  ]
}`;
