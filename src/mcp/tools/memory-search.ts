import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMemories, semanticSearch, indexMemoryEmbedding } from "../../db/memories.js";
import { getDatabase } from "../../db/database.js";
import { resolveProjectId } from "../../lib/focus.js";
import { hybridSearch, searchWithBm25 } from "../../lib/search.js";
import { asmrRecall } from "../../lib/asmr/index.js";
import { ensembleAnswer } from "../../lib/asmr/ensemble.js";
import {
  compactPageHint,
  compactText,
  ensureAutoProject,
  formatAsmrResult,
  formatError,
  formatMemorySummary,
  positiveLimit,
} from "./memory-utils.js";
import type { MemoryFilter } from "../../types/index.js";

export function registerMemorySearchTools(server: McpServer): void {
  server.tool(
    "memory_search",
    "Search memories by keyword across key, value, summary, and tags",
    {
      query: z.string(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      tags: z.array(z.string()).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      session_id: z.string().optional(),
      limit: z.coerce.number().optional(),
      offset: z.coerce.number().optional(),
      verbose: z.boolean().optional().describe("Include wider snippets in compact output."),
    },
    async (args) => {
      try {
        const limit = positiveLimit(args.limit, 10);
        const offset = args.offset ?? 0;
        let effectiveProjectId = args.project_id;
        if (!args.scope && !args.project_id && args.agent_id) {
          effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
        }
        const filter: MemoryFilter = {
          scope: args.scope,
          category: args.category,
          tags: args.tags,
          agent_id: args.agent_id,
          project_id: effectiveProjectId,
          session_id: args.session_id,
          search: args.query,
          limit: limit + 1,
          offset,
        };
        const memories = listMemories(filter);
        if (memories.length === 0) {
          const sugKey = args.query.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
          return { content: [{ type: "text" as const, text: `No memories found matching "${args.query}".\n\n💡 Consider saving relevant information: memory_save(key="${sugKey}", value="...", scope="shared")` }] };
        }
        const hasMore = memories.length > limit;
        const visible = hasMore ? memories.slice(0, limit) : memories;
        const lines = visible.map((m, i) => formatMemorySummary(m, i + 1, args.verbose ? 160 : 100));
        const hint = compactPageHint({
          shown: visible.length,
          limit,
          offset,
          hasMore,
          moreCall: "memory_search",
          detailHint: "use memory_get(id) or memory_recall(key) for details",
        });
        return { content: [{ type: "text" as const, text: `${visible.length}${hasMore ? "+" : ""} result(s) for "${args.query}":\n${lines.join("\n")}${hint}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_search_semantic",
    "Semantic (meaning-based) memory search using vector embeddings. Finds memories by conceptual similarity, not keyword match. Uses OpenAI embeddings if OPENAI_API_KEY is set, otherwise TF-IDF.",
    {
      query: z.string().describe("Natural language query"),
      threshold: z.coerce.number().min(0).max(1).optional().describe("Minimum cosine similarity score (default: 0.5)"),
      limit: z.coerce.number().optional().describe("Max results (default: 10)"),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      index_missing: z.coerce.boolean().optional().describe("If true, index any memories that lack embeddings before searching"),
      verbose: z.boolean().optional().describe("Include wider snippets in compact output."),
    },
    async (args) => {
      try {
        ensureAutoProject();

        if (args.index_missing) {
          const db = getDatabase();
          const unindexed = db.prepare(
            `SELECT id, value, summary, when_to_use FROM memories
             WHERE status = 'active' AND id NOT IN (SELECT memory_id FROM memory_embeddings)
             LIMIT 100`
          ).all() as Array<{ id: string; value: string; summary: string | null; when_to_use: string | null }>;
          await Promise.all(
            unindexed.map((m) =>
              indexMemoryEmbedding(m.id, m.when_to_use || [m.value, m.summary].filter(Boolean).join(" "))
            )
          );
        }

        let effectiveProjectId = args.project_id;
        if (!args.project_id && args.agent_id) {
          effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
        }

        const limit = positiveLimit(args.limit, 10);
        const results = await semanticSearch(args.query, {
          threshold: args.threshold,
          limit,
          scope: args.scope,
          agent_id: args.agent_id,
          project_id: effectiveProjectId,
        });

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No semantically similar memories found for: "${args.query}". Try a lower threshold or call with index_missing:true to generate embeddings first.` }] };
        }

        const lines = results.map((r, i) =>
          `${i + 1}. [score:${r.score.toFixed(3)}] ${formatMemorySummary(r.memory, undefined, args.verbose ? 160 : 100)}`
        );
        return { content: [{ type: "text" as const, text: `${results.length} semantic result(s) for "${args.query}":\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_search_hybrid",
    "Hybrid search combining keyword (FTS5) and semantic (embedding) search using Reciprocal Rank Fusion (RRF). Best of both worlds: keyword precision + semantic recall.",
    {
      query: z.string().describe("Search query (natural language or keywords)"),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      tags: z.array(z.string()).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      semantic_threshold: z.coerce.number().min(0).max(1).optional().describe("Minimum cosine similarity for semantic results (default: 0.3)"),
      limit: z.coerce.number().optional().describe("Max results (default: 10)"),
      verbose: z.boolean().optional().describe("Include wider snippets in compact output."),
    },
    async (args) => {
      try {
        ensureAutoProject();
        let effectiveProjectId = args.project_id;
        if (!args.project_id && args.agent_id) {
          effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
        }
        const filter: MemoryFilter = {
          scope: args.scope,
          category: args.category,
          tags: args.tags,
          agent_id: args.agent_id,
          project_id: effectiveProjectId,
        };
        const limit = positiveLimit(args.limit, 10);
        const results = await hybridSearch(args.query, {
          filter,
          semantic_threshold: args.semantic_threshold,
          limit,
        });
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No memories found for "${args.query}" via hybrid search.` }] };
        }
        const lines = results.map((r, i) => {
          const kw = r.keyword_rank !== null ? `kw:#${r.keyword_rank}` : "kw:—";
          const sem = r.semantic_rank !== null ? `sem:#${r.semantic_rank}` : "sem:—";
          return `${i + 1}. [rrf:${r.score.toFixed(4)}] [${kw} ${sem}] ${formatMemorySummary(r.memory, undefined, args.verbose ? 160 : 100)}`;
        });
        return { content: [{ type: "text" as const, text: `${results.length} hybrid result(s) for "${args.query}":\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_search_bm25",
    "Search memories using FTS5 BM25 ranking. Returns results scored by term frequency, document length, and field weights (key=10, value=5, summary=3).",
    {
      query: z.string().describe("Search query"),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      tags: z.array(z.string()).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      limit: z.coerce.number().optional().describe("Max results (default: 10)"),
      verbose: z.boolean().optional().describe("Include wider snippets in compact output."),
    },
    async (args) => {
      try {
        ensureAutoProject();
        let effectiveProjectId = args.project_id;
        if (!args.project_id && args.agent_id) {
          effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
        }
        const limit = positiveLimit(args.limit, 10);
        const filter: MemoryFilter = {
          scope: args.scope,
          category: args.category,
          tags: args.tags,
          agent_id: args.agent_id,
          project_id: effectiveProjectId,
          limit,
        };
        const results = searchWithBm25(args.query, filter);
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No memories found for "${args.query}" via BM25 search.` }] };
        }
        const lines = results.map((r, i) =>
          `${i + 1}. [bm25:${r.score.toFixed(3)}] ${formatMemorySummary(r.memory, undefined, args.verbose ? 160 : 100)}`
        );
        return { content: [{ type: "text" as const, text: `${results.length} BM25 result(s) for "${args.query}":\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_recall_deep",
    "Deep memory recall using ASMR (Agentic Search and Memory Retrieval) — runs 3 parallel search agents (facts, context, temporal) for high-accuracy retrieval with optional ensemble answering",
    {
      query: z.string().describe("Natural language query"),
      mode: z.enum(["fast", "deep", "auto"]).default("deep").describe("fast=FTS+semantic, deep=ASMR 3-agent, auto=fast then escalate"),
      max_results: z.coerce.number().default(10),
      ensemble: z.coerce.boolean().default(false).describe("Use ensemble answering with majority voting"),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        ensureAutoProject();
        const db = getDatabase();

        const FAST_SCORE_THRESHOLD = 0.6;
        const maxResults = positiveLimit(args.max_results, 10);

        if (args.mode === "fast") {
          const results = await hybridSearch(args.query, {
            filter: { project_id: args.project_id, limit: maxResults },
            limit: maxResults,
          });
          if (results.length === 0) {
            return { content: [{ type: "text" as const, text: `No memories found for "${args.query}" via fast search.` }] };
          }
          const lines = results.map((r, i) =>
            `${i + 1}. [score:${r.score.toFixed(3)}] ${formatMemorySummary(r.memory, undefined, 120)}`,
          );
          return { content: [{ type: "text" as const, text: `[fast] ${results.length} result(s) for "${args.query}":\n${lines.join("\n")}` }] };
        }

        if (args.mode === "deep") {
          const asmrResult = await asmrRecall(db, args.query, {
            max_results: maxResults,
            project_id: args.project_id,
          });

          let text = formatAsmrResult(asmrResult, args.query);

          if (args.ensemble) {
            try {
              const answer = await ensembleAnswer(asmrResult, args.query);
              text += `\n\n--- Ensemble Answer (confidence: ${(answer.confidence * 100).toFixed(0)}%, consensus: ${answer.consensus_reached ? "yes" : "no"}, escalated: ${answer.escalated ? "yes" : "no"}) ---\n${compactText(answer.answer, 800)}\n\nReasoning: ${compactText(answer.reasoning, 400)}`;
            } catch (ensErr) {
              text += `\n\n[Ensemble failed: ${ensErr instanceof Error ? ensErr.message : "unknown error"}]`;
            }
          }

          return { content: [{ type: "text" as const, text }] };
        }

        const fastResults = await hybridSearch(args.query, {
          filter: { project_id: args.project_id, limit: maxResults },
          limit: maxResults,
        });

        const topScore = fastResults.length > 0 ? fastResults[0]!.score : 0;

        if (topScore >= FAST_SCORE_THRESHOLD && fastResults.length >= 3) {
          const lines = fastResults.map((r, i) =>
            `${i + 1}. [score:${r.score.toFixed(3)}] ${formatMemorySummary(r.memory, undefined, 120)}`,
          );
          return { content: [{ type: "text" as const, text: `[auto/fast] ${fastResults.length} result(s) for "${args.query}" (top score ${topScore.toFixed(3)} >= threshold):\n${lines.join("\n")}` }] };
        }

        const asmrResult = await asmrRecall(db, args.query, {
          max_results: maxResults,
          project_id: args.project_id,
        });

        let text = `[auto/escalated] Fast search top score ${topScore.toFixed(3)} < ${FAST_SCORE_THRESHOLD} threshold — escalated to ASMR deep recall.\n\n${formatAsmrResult(asmrResult, args.query)}`;

        if (args.ensemble) {
          try {
            const answer = await ensembleAnswer(asmrResult, args.query);
            text += `\n\n--- Ensemble Answer (confidence: ${(answer.confidence * 100).toFixed(0)}%, consensus: ${answer.consensus_reached ? "yes" : "no"}, escalated: ${answer.escalated ? "yes" : "no"}) ---\n${compactText(answer.answer, 800)}\n\nReasoning: ${compactText(answer.reasoning, 400)}`;
          } catch (ensErr) {
            text += `\n\n[Ensemble failed: ${ensErr instanceof Error ? ensErr.message : "unknown error"}]`;
          }
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    },
  );
}
