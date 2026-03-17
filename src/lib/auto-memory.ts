/**
 * LLM-based auto-memory formation pipeline.
 * NO REGEX — all extraction is done by LLMs.
 * Main export: processConversationTurn(turn, context) — fire and forget.
 * All failures are silently logged and never propagate.
 */

import { createMemory } from "../db/memories.js";
import { searchMemories } from "./search.js";
import { createEntity, getEntityByName } from "../db/entities.js";
import { createRelation } from "../db/relations.js";
import { linkEntityToMemory } from "../db/entity-memories.js";
import { providerRegistry } from "./providers/registry.js";
import { autoMemoryQueue, type ExtractionJob } from "./auto-memory-queue.js";
import type {
  MemoryExtractionContext,
  ExtractedMemory,
} from "./providers/base.js";
import type { CreateMemoryInput } from "../types/index.js";

// ─── Deduplication ───────────────────────────────────────────────────────────

const DEDUP_SIMILARITY_THRESHOLD = 0.85;

/**
 * Check if a memory with similar content already exists.
 * Uses FTS5 to find candidates, then estimates similarity by word overlap.
 * Returns true if a sufficiently similar memory exists (skip saving).
 */
function isDuplicate(
  content: string,
  agentId?: string,
  projectId?: string
): boolean {
  try {
    // Use first 10 meaningful words as search query
    const query = content
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10)
      .join(" ");

    if (!query) return false;

    const results = searchMemories(query, {
      agent_id: agentId,
      project_id: projectId,
      limit: 3,
    });

    if (results.length === 0) return false;

    const contentWords = new Set(
      content.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
    );

    for (const result of results) {
      const existingWords = new Set(
        result.memory.value.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3)
      );
      if (contentWords.size === 0 || existingWords.size === 0) continue;

      // Jaccard similarity
      const intersection = [...contentWords].filter((w) =>
        existingWords.has(w)
      ).length;
      const union = new Set([...contentWords, ...existingWords]).size;
      const similarity = intersection / union;

      if (similarity >= DEDUP_SIMILARITY_THRESHOLD) return true;
    }
    return false;
  } catch {
    return false; // on error, allow saving
  }
}

// ─── Entity linking ──────────────────────────────────────────────────────────

async function linkEntitiesToMemory(
  memoryId: string,
  content: string,
  _agentId?: string,
  projectId?: string
): Promise<void> {
  const provider = providerRegistry.getAvailable();
  if (!provider) return;

  try {
    const { entities, relations } = await provider.extractEntities(content);

    // Create/update entities
    const entityIdMap = new Map<string, string>(); // name -> id

    for (const extracted of entities) {
      if (extracted.confidence < 0.6) continue;
      try {
        // Check if entity already exists
        const existing = getEntityByName(extracted.name);
        const entityId = existing
          ? existing.id
          : createEntity({
              name: extracted.name,
              type: extracted.type,
              project_id: projectId,
            }).id;

        entityIdMap.set(extracted.name, entityId);

        // Link entity to memory (positional args: entityId, memoryId, role)
        linkEntityToMemory(entityId, memoryId, "subject");
      } catch {
        // Entity linking failure is non-fatal
      }
    }

    // Create relations between entities
    for (const rel of relations) {
      const fromId = entityIdMap.get(rel.from);
      const toId = entityIdMap.get(rel.to);
      if (!fromId || !toId) continue;
      try {
        createRelation({
          source_entity_id: fromId,
          target_entity_id: toId,
          relation_type: rel.type,
        });
      } catch {
        // Relation already exists or failed — non-fatal
      }
    }
  } catch (err) {
    console.error("[auto-memory] entity linking failed:", err);
  }
}

// ─── Core save logic ─────────────────────────────────────────────────────────

async function saveExtractedMemory(
  extracted: ExtractedMemory,
  context: MemoryExtractionContext
): Promise<string | null> {
  const minImportance = providerRegistry.getConfig().minImportance;
  if (extracted.importance < minImportance) return null;
  if (!extracted.content.trim()) return null;

  // Dedup check
  if (isDuplicate(extracted.content, context.agentId, context.projectId)) {
    return null;
  }

  try {
    const input: CreateMemoryInput = {
      key: extracted.content.slice(0, 120).replace(/\s+/g, "-").toLowerCase(),
      value: extracted.content,
      category: extracted.category,
      scope: extracted.suggestedScope,
      importance: extracted.importance,
      tags: [
        ...extracted.tags,
        "auto-extracted",
        ...(context.sessionId ? [`session:${context.sessionId}`] : []),
      ],
      agent_id: context.agentId,
      project_id: context.projectId,
      session_id: context.sessionId,
      metadata: {
        reasoning: extracted.reasoning,
        auto_extracted: true,
        extracted_at: new Date().toISOString(),
      },
    };

    const memory = createMemory(input, "merge");
    return memory.id;
  } catch (err) {
    console.error("[auto-memory] saveExtractedMemory failed:", err);
    return null;
  }
}

// ─── Job processor ────────────────────────────────────────────────────────────

async function processJob(job: ExtractionJob): Promise<void> {
  if (!providerRegistry.getConfig().enabled) return;

  const provider = providerRegistry.getAvailable();
  if (!provider) return; // no provider configured — skip silently

  const context: MemoryExtractionContext = {
    agentId: job.agentId,
    projectId: job.projectId,
    sessionId: job.sessionId,
  };

  let extracted: ExtractedMemory[] = [];

  // Try primary provider, then fallbacks
  try {
    extracted = await provider.extractMemories(job.turn, context);
  } catch {
    // Primary failed — try first fallback
    const fallbacks = providerRegistry.getFallbacks();
    for (const fallback of fallbacks) {
      try {
        extracted = await fallback.extractMemories(job.turn, context);
        if (extracted.length > 0) break;
      } catch {
        continue;
      }
    }
  }

  if (extracted.length === 0) return;

  // Save all extracted memories and async link entities
  for (const memory of extracted) {
    const memoryId = await saveExtractedMemory(memory, context);
    if (!memoryId) continue;

    // Entity linking — fire and forget
    if (providerRegistry.getConfig().autoEntityLink) {
      void linkEntitiesToMemory(
        memoryId,
        memory.content,
        job.agentId,
        job.projectId
      );
    }
  }
}

// Register job processor with queue on module load
autoMemoryQueue.setHandler(processJob);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire-and-forget: enqueue a conversation turn for async memory extraction.
 * Returns immediately — never blocks. Never throws.
 */
export function processConversationTurn(
  turn: string,
  context: Omit<ExtractionJob, "turn" | "timestamp">,
  source: ExtractionJob["source"] = "turn"
): void {
  if (!turn?.trim()) return;
  autoMemoryQueue.enqueue({
    ...context,
    turn,
    timestamp: Date.now(),
    source,
  });
}

/** Get current queue stats */
export function getAutoMemoryStats() {
  return autoMemoryQueue.getStats();
}

/** Configure the auto-memory pipeline at runtime */
export function configureAutoMemory(
  config: Parameters<typeof providerRegistry.configure>[0]
): void {
  providerRegistry.configure(config);
}
