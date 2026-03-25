/**
 * Matryoshka Embedding Slicing — 2-stage retrieval using variable-dimension embedding slices.
 *
 * Key insight: OpenAI text-embedding-3-small supports native dimension reduction.
 * Halving the dimension keeps quality nearly intact, so a 384-dim slice is 4x faster
 * to compare but nearly as accurate for shortlisting. We use this for a 2-stage search:
 *   Stage 1: 384-dim slice → fast approximate shortlist (3x limit)
 *   Stage 2: Full 1536-dim → precise rerank → top limit results
 */

import { SqliteAdapter as Database } from "@hasna/cloud";
import { generateEmbedding, cosineSimilarity, deserializeEmbedding } from "./embeddings.js";
import { parseMemoryRow } from "../db/memories.js";
import type { Memory } from "../types/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MatryoshkaConfig {
  /** Full embedding dimensions (1536 for text-embedding-3-small) */
  full_dims: number;
  /** Shortlist slice dimensions (1/4 of full for fast approximate search) */
  shortlist_dims: number;
  /** How many extra candidates to fetch in Stage 1 (multiplier of final limit) */
  shortlist_multiplier: number;
}

export interface MatryoshkaSearchResult {
  memory: Memory;
  score: number;
  shortlist_score: number;
}

// ── Default config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MatryoshkaConfig = {
  full_dims: 1536,
  shortlist_dims: 384,
  shortlist_multiplier: 3,
};

// ── Core functions ───────────────────────────────────────────────────────────

/**
 * Slice an embedding to the first `dims` dimensions.
 * Exploits the Matryoshka property of text-embedding-3-small where
 * leading dimensions carry the most information.
 */
export function sliceEmbedding(embedding: number[], dims: number): number[] {
  if (dims >= embedding.length) return embedding;
  return embedding.slice(0, dims);
}

/**
 * L2 (Euclidean) normalize a vector to unit length.
 * Required after slicing to ensure cosine similarity remains valid.
 */
export function l2Normalize(embedding: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) {
    norm += embedding[i]! * embedding[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return embedding;
  const result = new Array<number>(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    result[i] = embedding[i]! / norm;
  }
  return result;
}

/**
 * 2-stage Matryoshka search:
 *   1. Generate query embedding, slice to 384-dim, shortlist top N*3 candidates
 *   2. Rerank shortlisted candidates using full 1536-dim embeddings
 *
 * Returns the top `limit` results ordered by full-dimension similarity.
 */
export async function matryoshkaSearch(
  db: Database,
  query: string,
  opts?: {
    limit?: number;
    project_id?: string;
    agent_id?: string;
    config?: MatryoshkaConfig;
    threshold?: number;
  },
): Promise<MatryoshkaSearchResult[]> {
  const limit = opts?.limit ?? 10;
  const config = opts?.config ?? DEFAULT_CONFIG;
  const threshold = opts?.threshold ?? 0.3;
  const shortlistSize = limit * config.shortlist_multiplier;

  // Generate full query embedding
  const { embedding: queryFull } = await generateEmbedding(query);

  // Create normalized shortlist slice from query
  const querySlice = l2Normalize(sliceEmbedding(queryFull, config.shortlist_dims));

  // Load all memory embeddings with filters
  const conditions: string[] = ["m.status = 'active'", "e.embedding IS NOT NULL"];
  const params: (string | number)[] = [];
  if (opts?.project_id) {
    conditions.push("m.project_id = ?");
    params.push(opts.project_id);
  }
  if (opts?.agent_id) {
    conditions.push("m.agent_id = ?");
    params.push(opts.agent_id);
  }

  const where = conditions.join(" AND ");
  const rows = db.prepare(
    `SELECT m.*, e.embedding FROM memories m
     JOIN memory_embeddings e ON e.memory_id = m.id
     WHERE ${where}`,
  ).all(...params) as Array<Record<string, unknown> & { embedding: string }>;

  if (rows.length === 0) return [];

  // ── Stage 1: Fast approximate search using shortlist-dim slices ─────────

  const stage1: Array<{
    row: Record<string, unknown> & { embedding: string };
    docFull: number[];
    shortlistScore: number;
  }> = [];

  for (const row of rows) {
    try {
      const docFull = deserializeEmbedding(row.embedding);
      const docSlice = l2Normalize(sliceEmbedding(docFull, config.shortlist_dims));
      const shortlistScore = cosineSimilarity(querySlice, docSlice);
      if (shortlistScore >= threshold) {
        stage1.push({ row, docFull, shortlistScore });
      }
    } catch {
      // Skip malformed embeddings
    }
  }

  // Sort by shortlist score and take top N*multiplier
  stage1.sort((a, b) => b.shortlistScore - a.shortlistScore);
  const shortlisted = stage1.slice(0, shortlistSize);

  if (shortlisted.length === 0) return [];

  // ── Stage 2: Precise rerank using full-dimension embeddings ─────────────

  const results: MatryoshkaSearchResult[] = [];

  for (const candidate of shortlisted) {
    const fullScore = cosineSimilarity(queryFull, candidate.docFull);
    if (fullScore >= threshold) {
      const { embedding: _, ...memRow } = candidate.row;
      results.push({
        memory: parseMemoryRow(memRow),
        score: Math.round(fullScore * 1000) / 1000,
        shortlist_score: Math.round(candidate.shortlistScore * 1000) / 1000,
      });
    }
  }

  // Sort by full-dimension score and return top limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
