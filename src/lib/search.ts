import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Memory, MemoryFilter, MemorySearchResult } from "../types/index.js";
import { getDatabase } from "../db/database.js";
import { listEntities, getEntityByName } from "../db/entities.js";
import { getMemoriesForEntity } from "../db/entity-memories.js";

// ============================================================================
// Helpers
// ============================================================================

function parseMemoryRow(row: Record<string, unknown>): Memory {
  return {
    id: row["id"] as string,
    key: row["key"] as string,
    value: row["value"] as string,
    category: row["category"] as Memory["category"],
    scope: row["scope"] as Memory["scope"],
    summary: (row["summary"] as string) || null,
    tags: JSON.parse((row["tags"] as string) || "[]") as string[],
    importance: row["importance"] as number,
    source: row["source"] as Memory["source"],
    status: row["status"] as Memory["status"],
    pinned: !!(row["pinned"] as number),
    agent_id: (row["agent_id"] as string) || null,
    project_id: (row["project_id"] as string) || null,
    session_id: (row["session_id"] as string) || null,
    metadata: JSON.parse((row["metadata"] as string) || "{}") as Record<
      string,
      unknown
    >,
    access_count: row["access_count"] as number,
    version: row["version"] as number,
    expires_at: (row["expires_at"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    accessed_at: (row["accessed_at"] as string) || null,
  };
}

/**
 * Preprocess a search query: trim, collapse whitespace, normalize unicode.
 */
function preprocessQuery(query: string): string {
  let q = query.trim();
  q = q.replace(/\s+/g, " ");
  q = q.normalize("NFC");
  return q;
}

/**
 * Escape SQL LIKE special characters so they are treated as literals.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Common stop words to filter from multi-word queries.
 * Single-word queries are never filtered. If all tokens are stop words,
 * the original tokens are kept to avoid empty queries.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this', 'it',
]);

/**
 * Remove stop words from a token list. Returns the original list if it has
 * 0-1 tokens or if ALL tokens are stop words (to avoid empty queries).
 */
function removeStopWords(tokens: string[]): string[] {
  if (tokens.length <= 1) return tokens;
  const filtered = tokens.filter(t => !STOP_WORDS.has(t.toLowerCase()));
  return filtered.length > 0 ? filtered : tokens;
}

/**
 * Extract highlight snippets showing which parts of a memory matched the query.
 */
function extractHighlights(
  memory: Memory,
  queryLower: string
): { field: string; snippet: string }[] {
  const highlights: { field: string; snippet: string }[] = [];
  const tokens = queryLower.split(/\s+/).filter(Boolean);

  for (const field of ["key", "value", "summary"] as const) {
    const text = field === "summary" ? memory.summary : memory[field];
    if (!text) continue;
    const textLower = text.toLowerCase();

    // Check full query first, then individual tokens
    const searchTerms = [queryLower, ...tokens].filter(Boolean);
    for (const term of searchTerms) {
      const idx = textLower.indexOf(term);
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + term.length + 30);
        const prefix = start > 0 ? "..." : "";
        const suffix = end < text.length ? "..." : "";
        highlights.push({
          field,
          snippet: prefix + text.slice(start, end) + suffix,
        });
        break; // one highlight per field
      }
    }
  }

  // Tag highlights
  for (const tag of memory.tags) {
    if (
      tag.toLowerCase().includes(queryLower) ||
      tokens.some((t) => tag.toLowerCase().includes(t))
    ) {
      highlights.push({ field: "tag", snippet: tag });
    }
  }

  return highlights;
}

/**
 * Determine the best match_type for a memory given the query and its score breakdown.
 */
function determineMatchType(
  memory: Memory,
  queryLower: string
): MemorySearchResult["match_type"] {
  if (memory.key.toLowerCase() === queryLower) return "exact";
  if (memory.tags.some((t) => t.toLowerCase() === queryLower)) return "tag";
  if (memory.tags.some((t) => t.toLowerCase().includes(queryLower)))
    return "tag";
  return "fuzzy";
}

/**
 * Compute the raw search score for a memory against a query string.
 * Scoring rules (per field):
 *   - Exact key match: 10
 *   - Key contains query: 7
 *   - Tag exact match: 6
 *   - Summary contains query: 4
 *   - Tag partial (substring) match: 3
 *   - Value contains query: 3
 *   - Metadata JSON contains query: 2
 * Uses diminishing returns: 1st field × 1.0, 2nd × 0.5, 3rd × 0.25, 4th+ × 0.15
 */
function computeScore(memory: Memory, queryLower: string): number {
  const fieldScores: number[] = [];

  const keyLower = memory.key.toLowerCase();
  if (keyLower === queryLower) {
    fieldScores.push(10);
  } else if (keyLower.includes(queryLower)) {
    fieldScores.push(7);
  }

  if (memory.tags.some((t) => t.toLowerCase() === queryLower)) {
    fieldScores.push(6);
  } else if (memory.tags.some((t) => t.toLowerCase().includes(queryLower))) {
    // Partial tag match (substring) — only if no exact tag match was found
    fieldScores.push(3);
  }

  if (memory.summary && memory.summary.toLowerCase().includes(queryLower)) {
    fieldScores.push(4);
  }

  if (memory.value.toLowerCase().includes(queryLower)) {
    fieldScores.push(3);
  }

  // Metadata JSON search — lower than value(3)
  const metadataStr = JSON.stringify(memory.metadata).toLowerCase();
  if (metadataStr !== '{}' && metadataStr.includes(queryLower)) {
    fieldScores.push(2);
  }

  // Apply diminishing returns: sort descending, multiply by decreasing weights
  fieldScores.sort((a, b) => b - a);
  const diminishingMultipliers = [1.0, 0.5, 0.25, 0.15, 0.15];
  let score = 0;
  for (let i = 0; i < fieldScores.length; i++) {
    score += fieldScores[i]! * (diminishingMultipliers[i] ?? 0.15);
  }

  // For quoted phrases, check for exact literal match and award bonus
  const { phrases } = extractQuotedPhrases(queryLower);
  for (const phrase of phrases) {
    if (keyLower.includes(phrase)) score += 8;
    if (memory.value.toLowerCase().includes(phrase)) score += 5;
    if (memory.summary && memory.summary.toLowerCase().includes(phrase))
      score += 4;
  }

  // For multi-word queries, always compute token scores as a bonus
  // on top of any full-phrase matches (not just when score === 0)
  const { remainder } = extractQuotedPhrases(queryLower);
  const tokens = removeStopWords(remainder.split(/\s+/).filter(Boolean));
  if (tokens.length > 1) {
    let tokenScore = 0;
    for (const token of tokens) {
      if (keyLower === token) {
        tokenScore += 10 / tokens.length;
      } else if (keyLower.includes(token)) {
        tokenScore += 7 / tokens.length;
      }
      if (memory.tags.some((t) => t.toLowerCase() === token)) {
        tokenScore += 6 / tokens.length;
      } else if (memory.tags.some((t) => t.toLowerCase().includes(token))) {
        tokenScore += 3 / tokens.length;
      }
      if (memory.summary && memory.summary.toLowerCase().includes(token)) {
        tokenScore += 4 / tokens.length;
      }
      if (memory.value.toLowerCase().includes(token)) {
        tokenScore += 3 / tokens.length;
      }
      if (metadataStr !== '{}' && metadataStr.includes(token)) {
        tokenScore += 2 / tokens.length;
      }
    }
    // If we already have a full-phrase score, add token score as a smaller bonus
    // If no full-phrase match, use full token score
    if (score > 0) {
      score += tokenScore * 0.3;
    } else {
      score += tokenScore;
    }
  }

  return score;
}

/**
 * Extract quoted phrases from a query string.
 * Returns { phrases: string[], remainder: string } where remainder
 * has the quoted phrases removed.
 */
function extractQuotedPhrases(query: string): {
  phrases: string[];
  remainder: string;
} {
  const phrases: string[] = [];
  const remainder = query.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    phrases.push(phrase);
    return "";
  });
  return { phrases, remainder: remainder.trim() };
}

/**
 * Escape a query string for safe use in FTS5 MATCH expressions.
 * Wraps each token in double quotes to treat as literal, escaping
 * any internal double quotes. Quoted phrases in the original query
 * are passed through to FTS5 as-is for exact phrase matching.
 */
function escapeFts5Query(query: string): string {
  const { phrases, remainder } = extractQuotedPhrases(query);

  const parts: string[] = [];

  // Pass quoted phrases through for FTS5 exact phrase matching
  for (const phrase of phrases) {
    parts.push(`"${phrase.replace(/"/g, '""')}"`);
  }

  // Split remainder on whitespace into tokens, remove stop words, quote each one
  const tokens = removeStopWords(remainder.split(/\s+/).filter(Boolean));
  for (const t of tokens) {
    parts.push(`"${t.replace(/"/g, '""')}"`);
  }

  return parts.join(" ");
}

/**
 * Check if the FTS5 virtual table exists in the database.
 */
function hasFts5Table(d: Database): boolean {
  try {
    const row = d
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
      )
      .get() as { name: string } | null;
    return !!row;
  } catch {
    return false;
  }
}

// ============================================================================
// Filter helpers (shared between FTS5 and LIKE paths)
// ============================================================================

interface FilterResult {
  conditions: string[];
  params: SQLQueryBindings[];
}

function buildFilterConditions(filter?: MemoryFilter): FilterResult {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  // Must be active and not expired (defaults)
  conditions.push("m.status = 'active'");
  conditions.push(
    "(m.expires_at IS NULL OR m.expires_at >= datetime('now'))"
  );

  if (!filter) return { conditions, params };

  if (filter.scope) {
    if (Array.isArray(filter.scope)) {
      conditions.push(
        `m.scope IN (${filter.scope.map(() => "?").join(",")})`
      );
      params.push(...filter.scope);
    } else {
      conditions.push("m.scope = ?");
      params.push(filter.scope);
    }
  }
  if (filter.category) {
    if (Array.isArray(filter.category)) {
      conditions.push(
        `m.category IN (${filter.category.map(() => "?").join(",")})`
      );
      params.push(...filter.category);
    } else {
      conditions.push("m.category = ?");
      params.push(filter.category);
    }
  }
  if (filter.source) {
    if (Array.isArray(filter.source)) {
      conditions.push(
        `m.source IN (${filter.source.map(() => "?").join(",")})`
      );
      params.push(...filter.source);
    } else {
      conditions.push("m.source = ?");
      params.push(filter.source);
    }
  }
  if (filter.status) {
    // Override the default active-only filter if explicitly specified
    // Remove the first condition we added ("m.status = 'active'")
    conditions.shift();
    if (Array.isArray(filter.status)) {
      conditions.push(
        `m.status IN (${filter.status.map(() => "?").join(",")})`
      );
      params.push(...filter.status);
    } else {
      conditions.push("m.status = ?");
      params.push(filter.status);
    }
  }
  if (filter.project_id) {
    conditions.push("m.project_id = ?");
    params.push(filter.project_id);
  }
  if (filter.agent_id) {
    conditions.push("m.agent_id = ?");
    params.push(filter.agent_id);
  }
  if (filter.session_id) {
    conditions.push("m.session_id = ?");
    params.push(filter.session_id);
  }
  if (filter.min_importance) {
    conditions.push("m.importance >= ?");
    params.push(filter.min_importance);
  }
  if (filter.pinned !== undefined) {
    conditions.push("m.pinned = ?");
    params.push(filter.pinned ? 1 : 0);
  }
  if (filter.tags && filter.tags.length > 0) {
    for (const tag of filter.tags) {
      conditions.push(
        "m.id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)"
      );
      params.push(tag);
    }
  }

  return { conditions, params };
}

// ============================================================================
// FTS5 search path
// ============================================================================

function searchWithFts5(
  d: Database,
  query: string,
  queryLower: string,
  filter?: MemoryFilter,
  graphBoostedIds?: Set<string>
): MemorySearchResult[] | null {
  const ftsQuery = escapeFts5Query(query);
  if (!ftsQuery) return null;

  try {
    const { conditions, params } = buildFilterConditions(filter);

    // FTS5 MATCH finds candidates; also check tag matches via memory_tags
    // and metadata LIKE (neither tags nor metadata are in the FTS5 index)
    const queryParam = `%${query}%`;
    const ftsCondition =
      `(m.rowid IN (SELECT f.rowid FROM memories_fts f WHERE memories_fts MATCH ?) ` +
      `OR m.id IN (SELECT memory_id FROM memory_tags WHERE tag LIKE ?) ` +
      `OR m.metadata LIKE ?)`;
    const allConditions = [ftsCondition, ...conditions];
    const allParams: SQLQueryBindings[] = [ftsQuery, queryParam, queryParam, ...params];

    // We need a different approach: fetch FTS matches and tag-only matches separately,
    // then merge. The JOIN approach won't work for tag-only matches.
    // Instead, use a simpler strategy: use FTS to get candidates + tag candidates,
    // then score them all.

    // Strategy: get all matching memory IDs via FTS + tag LIKE, fetch full rows, score
    const candidateSql = `SELECT m.* FROM memories m WHERE ${allConditions.join(" AND ")}`;
    const rows = d.query(candidateSql).all(...allParams) as Record<string, unknown>[];

    return scoreResults(rows, queryLower, graphBoostedIds);
  } catch {
    // FTS5 MATCH syntax error or table issue — fall back to LIKE
    return null;
  }
}

// ============================================================================
// LIKE search path (fallback)
// ============================================================================

function searchWithLike(
  d: Database,
  query: string,
  queryLower: string,
  filter?: MemoryFilter,
  graphBoostedIds?: Set<string>
): MemorySearchResult[] {
  const { conditions, params } = buildFilterConditions(filter);

  // For multi-word queries, match any individual token (OR) in addition to the full phrase
  const rawTokens = query.trim().split(/\s+/).filter(Boolean);
  const tokens = removeStopWords(rawTokens);
  const escapedQuery = escapeLikePattern(query);
  const likePatterns: string[] = [`%${escapedQuery}%`]; // full phrase
  if (tokens.length > 1) {
    for (const t of tokens) likePatterns.push(`%${escapeLikePattern(t)}%`);
  }

  // Build OR clause: match any pattern in any field (with ESCAPE clause for special chars)
  const fieldClauses: string[] = [];
  for (const pattern of likePatterns) {
    fieldClauses.push("m.key LIKE ? ESCAPE '\\'");
    params.push(pattern);
    fieldClauses.push("m.value LIKE ? ESCAPE '\\'");
    params.push(pattern);
    fieldClauses.push("m.summary LIKE ? ESCAPE '\\'");
    params.push(pattern);
    fieldClauses.push("m.metadata LIKE ? ESCAPE '\\'");
    params.push(pattern);
    fieldClauses.push("m.id IN (SELECT memory_id FROM memory_tags WHERE tag LIKE ? ESCAPE '\\')");
    params.push(pattern);
  }
  conditions.push(`(${fieldClauses.join(" OR ")})`);

  const sql = `SELECT DISTINCT m.* FROM memories m WHERE ${conditions.join(" AND ")}`;
  const rows = d.query(sql).all(...params) as Record<string, unknown>[];

  return scoreResults(rows, queryLower, graphBoostedIds);
}

// ============================================================================
// Trigram fuzzy matching
// ============================================================================

function generateTrigrams(s: string): Set<string> {
  const lower = s.toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.slice(i, i + 3));
  }
  return trigrams;
}

function trigramSimilarity(a: string, b: string): number {
  const triA = generateTrigrams(a);
  const triB = generateTrigrams(b);
  if (triA.size === 0 || triB.size === 0) return 0;
  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }
  const union = triA.size + triB.size - intersection;
  return union === 0 ? 0 : intersection / union; // Jaccard similarity
}

function searchWithFuzzy(
  d: Database,
  query: string,
  filter?: MemoryFilter,
  graphBoostedIds?: Set<string>
): MemorySearchResult[] {
  const { conditions, params } = buildFilterConditions(filter);
  const sql = `SELECT m.* FROM memories m WHERE ${conditions.join(" AND ")}`;
  const rows = d.query(sql).all(...params) as Record<string, unknown>[];

  const MIN_SIMILARITY = 0.3;
  const results: MemorySearchResult[] = [];

  for (const row of rows) {
    const memory = parseMemoryRow(row);
    // Check similarity against key, value (first 200 chars), summary, tags
    let bestSimilarity = 0;
    bestSimilarity = Math.max(bestSimilarity, trigramSimilarity(query, memory.key));
    bestSimilarity = Math.max(bestSimilarity, trigramSimilarity(query, memory.value.slice(0, 200)));
    if (memory.summary) {
      bestSimilarity = Math.max(bestSimilarity, trigramSimilarity(query, memory.summary));
    }
    for (const tag of memory.tags) {
      bestSimilarity = Math.max(bestSimilarity, trigramSimilarity(query, tag));
    }

    if (bestSimilarity >= MIN_SIMILARITY) {
      const graphBoost = graphBoostedIds?.has(memory.id) ? 2.0 : 0;
      const score = ((bestSimilarity * 5 * memory.importance) / 10) + graphBoost; // max 5 raw score for fuzzy
      results.push({ memory, score, match_type: "fuzzy" });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ============================================================================
// Graph-aware search boosting
// ============================================================================

/**
 * Find memory IDs that should receive a graph boost because they are linked
 * to entities matching the search query.
 */
function getGraphBoostedMemoryIds(query: string, d: Database): Set<string> {
  const boostedIds = new Set<string>();
  try {
    // Find entities matching the query
    const matchingEntities = listEntities({ search: query, limit: 10 }, d);
    // Also try exact name match
    const exactMatch = getEntityByName(query, undefined, undefined, d);
    if (exactMatch && !matchingEntities.find(e => e.id === exactMatch.id)) {
      matchingEntities.push(exactMatch);
    }
    // Get memories linked to matching entities
    for (const entity of matchingEntities) {
      const memories = getMemoriesForEntity(entity.id, d);
      for (const mem of memories) {
        boostedIds.add(mem.id);
      }
    }
  } catch {
    // Graph tables might not exist — fail silently
  }
  return boostedIds;
}

// ============================================================================
// Shared scoring
// ============================================================================

/**
 * Compute a recency boost multiplier for a memory.
 * Returns a value between 0 and 1: full boost (1.0) for today,
 * decaying linearly to 0 over 30 days. Pinned memories always get full boost.
 */
function computeRecencyBoost(memory: Memory): number {
  if (memory.pinned) return 1.0;

  const mostRecent = memory.accessed_at || memory.updated_at;
  if (!mostRecent) return 0;

  const daysSinceAccess =
    (Date.now() - Date.parse(mostRecent)) / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - daysSinceAccess / 30);
}

function scoreResults(
  rows: Record<string, unknown>[],
  queryLower: string,
  graphBoostedIds?: Set<string>
): MemorySearchResult[] {
  const scored: MemorySearchResult[] = [];
  for (const row of rows) {
    const memory = parseMemoryRow(row);
    const rawScore = computeScore(memory, queryLower);
    if (rawScore === 0) continue; // safety: skip if no actual match

    // Weight by importance: score * importance / 10
    const weightedScore = (rawScore * memory.importance) / 10;

    // Recency boost: up to 30% bonus for recently accessed memories
    const recencyBoost = computeRecencyBoost(memory);

    // Access count boost: up to 20% bonus for frequently accessed memories
    const accessBoost = Math.min(memory.access_count / 20, 0.2);

    // Graph boost: memories linked to entities matching the query get a bonus
    const graphBoost = graphBoostedIds?.has(memory.id) ? 2.0 : 0;

    const finalScore =
      (weightedScore + graphBoost) * (1 + recencyBoost * 0.3) * (1 + accessBoost);

    const matchType = determineMatchType(memory, queryLower);

    scored.push({
      memory,
      score: finalScore,
      match_type: matchType,
      highlights: extractHighlights(memory, queryLower),
    });
  }

  // Sort by score DESC, then importance DESC
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.memory.importance - a.memory.importance;
  });

  return scored;
}

// ============================================================================
// Search (public API)
// ============================================================================

/**
 * Search memories by query string with relevance scoring.
 *
 * Uses FTS5 full-text search when available, falling back to LIKE queries.
 * Searches across key, value, summary, and tags. Results are scored,
 * weighted by importance, filtered, and sorted by score DESC then
 * importance DESC.
 */
export function searchMemories(
  query: string,
  filter?: MemoryFilter,
  db?: Database
): MemorySearchResult[] {
  const d = db || getDatabase();
  query = preprocessQuery(query);
  if (!query) return []; // empty after trim
  const queryLower = query.toLowerCase();

  // Compute graph-boosted memory IDs from entity graph
  const graphBoostedIds = getGraphBoostedMemoryIds(query, d);

  let scored: MemorySearchResult[];

  // Try FTS5 first if the table exists
  if (hasFts5Table(d)) {
    const ftsResult = searchWithFts5(d, query, queryLower, filter, graphBoostedIds);
    if (ftsResult !== null) {
      scored = ftsResult;
    } else {
      // FTS5 failed (syntax error, empty query, etc.) — fall back to LIKE
      scored = searchWithLike(d, query, queryLower, filter, graphBoostedIds);
    }
  } else {
    // No FTS5 table (old DB without migration) — use LIKE
    scored = searchWithLike(d, query, queryLower, filter, graphBoostedIds);
  }

  // If primary search returned few results, try trigram fuzzy matching
  if (scored.length < 3) {
    const fuzzyResults = searchWithFuzzy(d, query, filter, graphBoostedIds);
    // Merge, deduplicating by memory ID
    const seenIds = new Set(scored.map((r) => r.memory.id));
    for (const fr of fuzzyResults) {
      if (!seenIds.has(fr.memory.id)) {
        scored.push(fr);
        seenIds.add(fr.memory.id);
      }
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.memory.importance - a.memory.importance;
    });
  }

  // Apply limit/offset
  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? scored.length;

  const finalResults = scored.slice(offset, offset + limit);

  // Log search (fire-and-forget)
  logSearchQuery(query, scored.length, filter?.agent_id, filter?.project_id, d);

  return finalResults;
}

// ============================================================================
// Search history
// ============================================================================

export function logSearchQuery(
  query: string,
  resultCount: number,
  agentId?: string,
  projectId?: string,
  db?: Database
): void {
  try {
    const d = db || getDatabase();
    const id = crypto.randomUUID().slice(0, 8);
    d.run(
      "INSERT INTO search_history (id, query, result_count, agent_id, project_id) VALUES (?, ?, ?, ?, ?)",
      [id, query, resultCount, agentId || null, projectId || null]
    );
  } catch {
    // Fire-and-forget — don't fail the search
  }
}

export function getSearchHistory(
  limit: number = 20,
  projectId?: string,
  db?: Database
): { query: string; result_count: number; created_at: string }[] {
  const d = db || getDatabase();
  if (projectId) {
    return d.query(
      "SELECT query, result_count, created_at FROM search_history WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(projectId, limit) as any[];
  }
  return d.query(
    "SELECT query, result_count, created_at FROM search_history ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as any[];
}

export function getPopularSearches(
  limit: number = 10,
  projectId?: string,
  db?: Database
): { query: string; count: number }[] {
  const d = db || getDatabase();
  if (projectId) {
    return d.query(
      "SELECT query, COUNT(*) as count FROM search_history WHERE project_id = ? GROUP BY query ORDER BY count DESC LIMIT ?"
    ).all(projectId, limit) as any[];
  }
  return d.query(
    "SELECT query, COUNT(*) as count FROM search_history GROUP BY query ORDER BY count DESC LIMIT ?"
  ).all(limit) as any[];
}
