import { SqliteAdapter as Database } from "@hasna/cloud";
import type { Memory } from "../../types/index.js";
import { semanticSearch } from "../../db/memories.js";
import { listEntities, getEntityByName } from "../../db/entities.js";
import { getMemoriesForEntity, getEntitiesForMemory } from "../../db/entity-memories.js";
import { computeDecayScore } from "../decay.js";
import type { AsmrOptions, AsmrMemoryResult, SearchAgentResult } from "./types.js";

interface ScoredCandidate {
  memory: Memory;
  semanticScore: number;
  entityLinkStrength: number;
  entityName: string | null;
  entityRelation: string | null;
}

function deduplicateCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
  const seen = new Map<string, ScoredCandidate>();
  for (const c of candidates) {
    const existing = seen.get(c.memory.id);
    if (!existing) {
      seen.set(c.memory.id, c);
    } else {
      // Keep the one with higher combined signal
      const existingTotal = existing.semanticScore + existing.entityLinkStrength;
      const currentTotal = c.semanticScore + c.entityLinkStrength;
      if (currentTotal > existingTotal) {
        seen.set(c.memory.id, c);
      }
    }
  }
  return Array.from(seen.values());
}

export async function runContextAgent(db: Database, query: string, opts: AsmrOptions): Promise<SearchAgentResult> {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return { memories: [], reasoning: "Empty query" };

  const maxResults = opts.max_results ?? 20;
  const candidates: ScoredCandidate[] = [];
  let semanticCount = 0;
  let entityQueryCount = 0;

  // Phase 1: semantic search for semantically similar memories
  try {
    const semanticResults = await semanticSearch(query, {
      threshold: 0.3,
      limit: maxResults * 2,
      project_id: opts.project_id,
      agent_id: opts.agent_id,
    }, db);

    for (const sr of semanticResults) {
      candidates.push({
        memory: sr.memory,
        semanticScore: sr.score,
        entityLinkStrength: 0,
        entityName: null,
        entityRelation: null,
      });
    }
    semanticCount = semanticResults.length;
  } catch {
    // Semantic search may fail if no embeddings exist
  }

  // Phase 2: for top semantic results, traverse entity graph
  const topSemantic = candidates.slice(0, 10);
  const entityMemoryIds = new Set<string>();

  for (const candidate of topSemantic) {
    try {
      const entities = getEntitiesForMemory(candidate.memory.id, db);
      for (const entity of entities) {
        const linkedMemories = getMemoriesForEntity(entity.id, db);
        for (const mem of linkedMemories) {
          if (entityMemoryIds.has(mem.id)) continue;
          entityMemoryIds.add(mem.id);

          candidates.push({
            memory: mem,
            semanticScore: 0,
            entityLinkStrength: 1.0,
            entityName: entity.name,
            entityRelation: entity.type,
          });
        }
      }
    } catch {
      // Entity tables might not exist
    }
  }

  // Phase 3: direct entity name search
  try {
    const matchingEntities = listEntities({ search: query, limit: 10, project_id: opts.project_id }, db);
    const exactEntity = getEntityByName(query, undefined, opts.project_id, db);
    if (exactEntity && !matchingEntities.find(e => e.id === exactEntity.id)) {
      matchingEntities.unshift(exactEntity);
    }

    for (const entity of matchingEntities) {
      entityQueryCount++;
      const linkedMemories = getMemoriesForEntity(entity.id, db);
      for (const mem of linkedMemories) {
        if (entityMemoryIds.has(mem.id)) continue;
        entityMemoryIds.add(mem.id);

        const nameMatch = entity.name.toLowerCase() === queryLower ? 1.0 : 0.7;
        candidates.push({
          memory: mem,
          semanticScore: 0,
          entityLinkStrength: nameMatch,
          entityName: entity.name,
          entityRelation: entity.type,
        });
      }
    }
  } catch {
    // Entity tables might not exist
  }

  // Deduplicate and score
  const unique = deduplicateCandidates(candidates);

  const results: AsmrMemoryResult[] = [];
  for (const c of unique) {
    if (opts.project_id && c.memory.project_id && c.memory.project_id !== opts.project_id) continue;
    if (c.memory.status !== "active") continue;

    const effectiveImportance = computeDecayScore(c.memory) / 10;
    const score = c.semanticScore * 0.4 + c.entityLinkStrength * 0.3 + effectiveImportance * 0.3;

    let reasoning: string;
    if (c.entityName) {
      reasoning = `Found via entity ${c.entityName} (relation: ${c.entityRelation})`;
    } else {
      reasoning = `Semantic similarity match (score: ${c.semanticScore.toFixed(3)})`;
    }

    results.push({
      memory: c.memory,
      score,
      source_agent: "context",
      reasoning,
      verbatim_excerpt: c.memory.value,
    });
  }

  results.sort((a, b) => b.score - a.score);
  const trimmed = results.slice(0, maxResults);

  return {
    memories: trimmed,
    reasoning: `Context agent found ${semanticCount} semantic matches, traversed ${entityQueryCount} entities, returned ${trimmed.length} contextual results`,
  };
}
