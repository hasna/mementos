/**
 * Embedding generation and cosine similarity for semantic memory search.
 *
 * Uses OpenAI text-embedding-3-small if OPENAI_API_KEY is set,
 * falls back to a simple TF-IDF term frequency vector otherwise.
 */

// ── Cosine similarity ─────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── OpenAI embeddings ─────────────────────────────────────────────────────────

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMENSIONS = 1536;

async function openAIEmbed(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text.slice(0, 8192), // API limit
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`OpenAI embedding API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0]!.embedding;
}

// ── TF-IDF fallback ───────────────────────────────────────────────────────────

/** Simple term-frequency vector (fixed 512-dim hash trick). */
function tfidfVector(text: string): number[] {
  const DIMS = 512;
  const vec = new Float32Array(DIMS);
  const tokens = text.toLowerCase().match(/\b\w+\b/g) ?? [];
  for (const token of tokens) {
    // FNV-1a hash
    let hash = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    vec[hash % DIMS]! += 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMS; i++) vec[i]! /= norm;
  return Array.from(vec);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

/**
 * Generate an embedding for a text string.
 * Uses OpenAI if OPENAI_API_KEY is available, otherwise uses TF-IDF hash trick.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (apiKey) {
    try {
      const embedding = await openAIEmbed(text, apiKey);
      return { embedding, model: EMBED_MODEL, dimensions: EMBED_DIMENSIONS };
    } catch {
      // Fall through to TF-IDF on API failure
    }
  }
  const embedding = tfidfVector(text);
  return { embedding, model: "tfidf-512", dimensions: 512 };
}

export function serializeEmbedding(embedding: number[]): string {
  return JSON.stringify(embedding);
}

export function deserializeEmbedding(raw: string): number[] {
  return JSON.parse(raw) as number[];
}
