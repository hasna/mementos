import { SqliteAdapter as Database } from "@hasna/cloud";
import type { Memory, MemoryVersion } from "../../types/index.js";
import { parseMemoryRow, getMemoryVersions } from "../../db/memories.js";
import { computeDecayScore } from "../decay.js";
import type { AsmrOptions, AsmrMemoryResult, SearchAgentResult } from "./types.js";

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

function escapeFts5Token(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function queryRelevance(memory: Memory, queryLower: string): number {
  const keyLower = memory.key.toLowerCase();
  const valueLower = memory.value.toLowerCase();

  if (keyLower === queryLower) return 1.0;
  if (keyLower.includes(queryLower)) return 0.8;
  if (valueLower.includes(queryLower)) return 0.5;

  const tokens = queryLower.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    let hits = 0;
    for (const t of tokens) {
      if (keyLower.includes(t) || valueLower.includes(t)) hits++;
    }
    return (hits / tokens.length) * 0.6;
  }

  return 0.1;
}

function formatDate(iso: string | null): string {
  if (!iso) return "unknown";
  return iso.slice(0, 10);
}

export async function runTemporalAgent(db: Database, query: string, opts: AsmrOptions): Promise<SearchAgentResult> {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return { memories: [], reasoning: "Empty query" };

  const maxResults = opts.max_results ?? 20;
  const limit = maxResults * 3;

  // Build base filter conditions
  const conditions: string[] = [
    "(m.expires_at IS NULL OR m.expires_at >= datetime('now'))",
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

  // Search 1: memories with temporal data that match the query
  let temporalRows: Record<string, unknown>[] = [];
  const temporalCondition = "(m.valid_from IS NOT NULL OR m.valid_until IS NOT NULL)";

  if (hasFts5Table(db)) {
    const tokens = queryLower.split(/\s+/).filter(Boolean);
    const ftsQuery = tokens.map(escapeFts5Token).join(" ");
    try {
      const ftsCondition = `m.rowid IN (SELECT f.rowid FROM memories_fts f WHERE memories_fts MATCH ?)`;
      const sql = `SELECT m.* FROM memories m WHERE ${ftsCondition} AND ${temporalCondition} AND ${conditions.join(" AND ")} ORDER BY m.valid_from DESC NULLS LAST LIMIT ?`;
      temporalRows = db.query(sql).all(ftsQuery, ...params, limit) as Record<string, unknown>[];
    } catch {
      temporalRows = [];
    }
  }

  if (temporalRows.length === 0) {
    const likePattern = `%${queryLower}%`;
    const sql = `SELECT m.* FROM memories m WHERE (m.key LIKE ? OR m.value LIKE ?) AND ${temporalCondition} AND ${conditions.join(" AND ")} ORDER BY m.valid_from DESC NULLS LAST LIMIT ?`;
    temporalRows = db.query(sql).all(likePattern, likePattern, ...params, limit) as Record<string, unknown>[];
  }

  // Search 2: superseded/archived memories (contradictions/updates)
  let supersededRows: Record<string, unknown>[] = [];
  try {
    const likePattern = `%${queryLower}%`;
    const sql = `SELECT m.* FROM memories m WHERE (m.key LIKE ? OR m.value LIKE ?) AND (m.status = 'archived' OR m.valid_until IS NOT NULL) ${conditions.length > 0 ? "AND " + conditions.join(" AND ") : ""} ORDER BY m.updated_at DESC LIMIT ?`;
    supersededRows = db.query(sql).all(likePattern, likePattern, ...params, limit) as Record<string, unknown>[];
  } catch {
    // Table structure may not support this query
  }

  // Merge and deduplicate
  const seen = new Map<string, Memory>();
  const allRows = [...temporalRows, ...supersededRows];
  for (const row of allRows) {
    const memory = parseMemoryRow(row);
    if (!seen.has(memory.id)) {
      seen.set(memory.id, memory);
    }
  }

  const memories = Array.from(seen.values());
  const timeline: string[] = [];
  const results: AsmrMemoryResult[] = [];

  for (const memory of memories) {
    const hasTemporal = memory.valid_from !== null || memory.valid_until !== null;
    const isSuperseded = memory.status === "archived";
    const relevance = queryRelevance(memory, queryLower);

    // Check for newer versions
    let versions: MemoryVersion[] = [];
    let newerVersionNote = "";
    try {
      versions = getMemoryVersions(memory.id, db);
      if (versions.length > 1) {
        const latest = versions[versions.length - 1]!;
        if (latest.version > memory.version) {
          newerVersionNote = `, superseded at version ${latest.version}`;
        }
      }
    } catch {
      // Version table may not exist
    }

    // Build timeline entry
    if (hasTemporal || isSuperseded) {
      const from = formatDate(memory.valid_from);
      const until = formatDate(memory.valid_until);
      const status = isSuperseded ? " [superseded]" : "";
      timeline.push(`${from} - ${until}: ${memory.key}${status}`);
    }

    // Scoring: recency * 0.4 + relevance * 0.3 + has_temporal * 0.3
    const recencyMs = memory.valid_from
      ? Date.now() - new Date(memory.valid_from).getTime()
      : Date.now() - new Date(memory.created_at).getTime();
    const daysSince = recencyMs / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1.0 - daysSince / 365);

    const temporalBonus = hasTemporal ? 1.0 : 0.3;
    const effectiveImportance = computeDecayScore(memory) / 10;

    const score = recencyScore * 0.4 + relevance * 0.3 + temporalBonus * 0.3;
    const finalScore = score * effectiveImportance;

    let reasoning: string;
    if (isSuperseded) {
      reasoning = `Superseded memory from ${formatDate(memory.valid_from)}${newerVersionNote}`;
    } else if (memory.valid_until && new Date(memory.valid_until) < new Date()) {
      reasoning = `Expired temporal fact (valid ${formatDate(memory.valid_from)} to ${formatDate(memory.valid_until)})${newerVersionNote}`;
    } else if (hasTemporal) {
      reasoning = `Current as of ${formatDate(memory.valid_from)}${newerVersionNote}`;
    } else {
      reasoning = `Historical record from ${formatDate(memory.created_at)}${newerVersionNote}`;
    }

    results.push({
      memory,
      score: finalScore,
      source_agent: "temporal",
      reasoning,
      verbatim_excerpt: memory.value,
    });
  }

  // Sort timeline chronologically
  timeline.sort();

  results.sort((a, b) => b.score - a.score);
  const trimmed = results.slice(0, maxResults);

  return {
    memories: trimmed,
    reasoning: `Temporal agent found ${temporalRows.length} temporal memories and ${supersededRows.length} superseded records, built ${timeline.length}-entry timeline`,
  };
}
