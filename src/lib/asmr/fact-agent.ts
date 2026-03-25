import { SqliteAdapter as Database } from "@hasna/cloud";
import type { Memory } from "../../types/index.js";
import { parseMemoryRow } from "../../db/memories.js";
import { computeDecayScore } from "../decay.js";
import type { AsmrOptions, AsmrMemoryResult, SearchAgentResult } from "./types.js";

function escapeFts5Token(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function hasFts5Table(db: Database): boolean {
  try {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get() as { name: string } | null;
    return !!row;
  } catch {
    return false;
  }
}

function buildScopeFilter(opts: AsmrOptions): { conditions: string[]; params: (string | number)[] } {
  const conditions: string[] = [
    "m.status = 'active'",
    "(m.expires_at IS NULL OR m.expires_at >= datetime('now'))",
    "m.category IN ('preference', 'fact', 'knowledge')",
  ];
  const params: (string | number)[] = [];

  if (opts.project_id) {
    conditions.push("m.project_id = ?");
    params.push(opts.project_id);
  }
  if (opts.agent_id) {
    conditions.push("m.agent_id = ?");
    params.push(opts.agent_id);
  }

  return { conditions, params };
}

function scoreFactMemory(memory: Memory, queryLower: string): { score: number; matchField: string } {
  const keyLower = memory.key.toLowerCase();
  const valueLower = memory.value.toLowerCase();

  let score = 0;
  let matchField = "value";

  if (keyLower === queryLower) {
    score = 10;
    matchField = "key (exact)";
  } else if (keyLower.includes(queryLower)) {
    score = 7;
    matchField = "key (partial)";
  } else if (valueLower.includes(queryLower)) {
    score = 3;
    matchField = "value";
  }

  // Token-level matching for multi-word queries
  if (score === 0) {
    const tokens = queryLower.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      let tokenHits = 0;
      for (const token of tokens) {
        if (keyLower.includes(token)) tokenHits += 2;
        else if (valueLower.includes(token)) tokenHits += 1;
      }
      if (tokenHits > 0) {
        score = (tokenHits / tokens.length) * 5;
        matchField = "tokens";
      }
    }
  }

  if (memory.pinned) score *= 1.3;

  const effectiveImportance = computeDecayScore(memory);
  score = (score * effectiveImportance) / 10;

  if (memory.importance >= 7) score *= 1.2;

  return { score, matchField };
}

export async function runFactAgent(db: Database, query: string, opts: AsmrOptions): Promise<SearchAgentResult> {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return { memories: [], reasoning: "Empty query" };

  const { conditions, params } = buildScopeFilter(opts);
  const limit = (opts.max_results ?? 20) * 2;
  let rows: Record<string, unknown>[];

  if (hasFts5Table(db)) {
    const tokens = queryLower.split(/\s+/).filter(Boolean);
    const ftsQuery = tokens.map(escapeFts5Token).join(" ");
    try {
      const ftsCondition = `m.rowid IN (SELECT f.rowid FROM memories_fts f WHERE memories_fts MATCH ?)`;
      const sql = `SELECT m.* FROM memories m WHERE ${ftsCondition} AND ${conditions.join(" AND ")} LIMIT ?`;
      rows = db.query(sql).all(ftsQuery, ...params, limit) as Record<string, unknown>[];
    } catch {
      rows = [];
    }
  } else {
    rows = [];
  }

  // Fallback: LIKE search if FTS5 yielded nothing
  if (rows.length === 0) {
    const likePattern = `%${queryLower}%`;
    const likeSql = `SELECT m.* FROM memories m WHERE (m.key LIKE ? OR m.value LIKE ?) AND ${conditions.join(" AND ")} LIMIT ?`;
    rows = db.query(likeSql).all(likePattern, likePattern, ...params, limit) as Record<string, unknown>[];
  }

  const results: AsmrMemoryResult[] = [];
  for (const row of rows) {
    const memory = parseMemoryRow(row);
    const { score, matchField } = scoreFactMemory(memory, queryLower);
    if (score <= 0) continue;

    results.push({
      memory,
      score,
      source_agent: "facts",
      reasoning: `Direct fact match on ${matchField}`,
      verbatim_excerpt: memory.value,
    });
  }

  results.sort((a, b) => b.score - a.score);
  const trimmed = results.slice(0, opts.max_results ?? 20);

  return {
    memories: trimmed,
    reasoning: `Fact agent searched ${rows.length} candidate memories, returned ${trimmed.length} factual matches`,
  };
}
