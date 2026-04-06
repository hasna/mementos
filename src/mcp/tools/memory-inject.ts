import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMemories, touchMemory, semanticSearch } from "../../db/memories.js";
import { hookRegistry } from "../../lib/hooks.js";
import { getDatabase } from "../../db/database.js";
import { formatError } from "./memory-utils.js";
import type { Memory, MemoryCategory } from "../../types/index.js";

export function registerMemoryInjectTools(server: McpServer): void {
  server.tool(
    "memory_inject",
    "Get memory context for system prompt injection. Selects by scope, importance, recency. Use strategy='smart' with a query for embedding-based relevance scoring.",
    {
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      session_id: z.string().optional(),
      max_tokens: z.coerce.number().optional(),
      categories: z.array(z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"])).optional(),
      min_importance: z.coerce.number().optional(),
      format: z.enum(["xml", "markdown", "compact", "json"]).optional(),
      raw: z.boolean().optional(),
      strategy: z.enum(["default", "smart"]).optional().describe("Injection strategy: 'default' uses importance+recency, 'smart' uses embedding similarity+importance+recency"),
      query: z.string().optional().describe("Query for smart injection relevance scoring. Required when strategy='smart'."),
      task_context: z.string().optional().describe("What the agent is about to do. When provided, activates intent-based retrieval — matches against when_to_use fields for situationally relevant memories."),
      mode: z.enum(["full", "hints"]).optional().default("full").describe("'full' = inject complete memory content (default), 'hints' = inject lightweight topic summary with counts, saving 60-70% tokens. Agent uses memory_recall to pull details as needed."),
    },
    async (args) => {
      try {
        // Smart strategy: delegate to full smartInject pipeline (skip for hints mode — fall through to hints handler below)
        if (args.strategy === "smart" && args.task_context && args.mode !== "hints") {
          const { smartInject } = await import("../../lib/injector.js");
          const result = await smartInject({
            task_context: args.task_context,
            project_id: args.project_id,
            agent_id: args.agent_id,
            session_id: args.session_id,
            max_tokens: args.max_tokens,
            min_importance: args.min_importance,
          });
          return { content: [{ type: "text" as const, text: result.output }] };
        }

        const maxTokens = args.max_tokens || 500;
        const minImportance = args.min_importance || 3;
        const categories = args.categories || ["preference", "fact", "knowledge"];

        // Collect memories from all visible scopes
        const allMemories: Memory[] = [];

        // Global memories
        const globalMems = listMemories({
          scope: "global",
          category: categories as MemoryCategory[],
          min_importance: minImportance,
          status: "active",
          project_id: args.project_id,
          limit: 50,
        });
        allMemories.push(...globalMems);

        // Shared memories (project-scoped)
        if (args.project_id) {
          const sharedMems = listMemories({
            scope: "shared",
            category: categories as MemoryCategory[],
            min_importance: minImportance,
            status: "active",
            project_id: args.project_id,
            limit: 50,
          });
          allMemories.push(...sharedMems);
        }

        // Private memories (agent-scoped)
        if (args.agent_id) {
          const privateMems = listMemories({
            scope: "private",
            category: categories as MemoryCategory[],
            min_importance: minImportance,
            status: "active",
            agent_id: args.agent_id,
            limit: 50,
          });
          allMemories.push(...privateMems);
        }

        // Working memories (session-scoped transient scratchpad — always relevant to current context)
        if (args.session_id || args.agent_id) {
          const workingMems = listMemories({
            scope: "working",
            status: "active",
            ...(args.session_id ? { session_id: args.session_id } : {}),
            ...(args.agent_id ? { agent_id: args.agent_id } : {}),
            ...(args.project_id ? { project_id: args.project_id } : {}),
            limit: 50,
          });
          allMemories.push(...workingMems);
        }

        // Deduplicate by ID
        const seen = new Set<string>();
        const unique = allMemories.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });

        // task_context activation: semantic search against when_to_use embeddings
        // Activation-matched memories get a +3 importance boost for sorting
        const activationBoostedIds = new Set<string>();
        if (args.task_context) {
          try {
            const activationResults = await semanticSearch(args.task_context, {
              threshold: 0.3,
              limit: 20,
              scope: undefined,
              agent_id: args.agent_id,
              project_id: args.project_id,
            });
            for (const r of activationResults) {
              activationBoostedIds.add(r.memory.id);
              // Merge activation-matched memories not already in unique
              if (!seen.has(r.memory.id)) {
                seen.add(r.memory.id);
                unique.push(r.memory);
              }
            }
          } catch { /* Non-critical: proceed without activation matching if semantic search fails */ }
        }

        // Smart strategy: score by embedding similarity + importance + recency
        if (args.strategy === "smart" && args.query) {
          const { generateEmbedding: genEmb, cosineSimilarity: cosSim, deserializeEmbedding: deserEmb } = await import("../../lib/embeddings.js");
          const d = getDatabase();
          const { embedding: queryEmbedding } = await genEmb(args.query);

          // Load embeddings for candidate memories
          const embeddingMap = new Map<string, number[]>();
          if (unique.length > 0) {
            const rows = d.prepare(
              `SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${unique.map(() => "?").join(",")})`
            ).all(...unique.map((m) => m.id)) as Array<{ memory_id: string; embedding: string }>;
            for (const row of rows) {
              try { embeddingMap.set(row.memory_id, deserEmb(row.embedding)); } catch { /* skip malformed */ }
            }
          }

          if (embeddingMap.size > 0) {
            // Compute recency reference
            const nowMs = Date.now();
            const oldestMs = Math.min(...unique.map((m) => new Date(m.updated_at).getTime()));
            const timeRange = nowMs - oldestMs || 1;

            // Score: similarity * 0.4 + importance/10 * 0.3 + recency * 0.3 + pin bonus + activation boost
            const scores = new Map<string, number>();
            for (const m of unique) {
              const memEmb = embeddingMap.get(m.id);
              const similarity = memEmb ? cosSim(queryEmbedding, memEmb) : 0;
              const importanceScore = (m.importance + (activationBoostedIds.has(m.id) ? 3 : 0)) / 10;
              const recencyScore = (new Date(m.updated_at).getTime() - oldestMs) / timeRange;
              const pinBonus = m.pinned ? 0.5 : 0;
              scores.set(m.id, similarity * 0.4 + importanceScore * 0.3 + recencyScore * 0.3 + pinBonus);
            }
            unique.sort((a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0));
          } else {
            // No embeddings — fall back to default sort with activation boost
            unique.sort((a, b) => {
              const aImp = a.importance + (activationBoostedIds.has(a.id) ? 3 : 0);
              const bImp = b.importance + (activationBoostedIds.has(b.id) ? 3 : 0);
              if (bImp !== aImp) return bImp - aImp;
              return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
            });
          }
        } else {
          // Default strategy: sort by importance DESC (with activation boost), then recency
          unique.sort((a, b) => {
            const aImp = a.importance + (activationBoostedIds.has(a.id) ? 3 : 0);
            const bImp = b.importance + (activationBoostedIds.has(b.id) ? 3 : 0);
            if (bImp !== aImp) return bImp - aImp;
            return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
          });
        }

        // Hints mode: return lightweight topic summary instead of full content
        if (args.mode === "hints") {
          if (unique.length === 0) {
            return { content: [{ type: "text" as const, text: "No relevant memories found." }] };
          }

          // Group memories by category
          const groups = new Map<string, Memory[]>();
          for (const m of unique) {
            const cat = m.category || "knowledge";
            if (!groups.has(cat)) groups.set(cat, []);
            groups.get(cat)!.push(m);
          }

          // Extract topic keywords from memory keys: split on '-', dedupe, take meaningful words
          const stopWords = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "with", "my", "this", "that"]);
          function extractTopics(memories: Memory[], maxTopics: number = 8): string[] {
            const wordCounts = new Map<string, number>();
            for (const m of memories) {
              // Extract words from key
              const keyWords = m.key.split(/[-_\s]+/).filter((w: string) => w.length > 2 && !stopWords.has(w.toLowerCase()));
              for (const w of keyWords) {
                const lower = w.toLowerCase();
                wordCounts.set(lower, (wordCounts.get(lower) || 0) + 1);
              }
              // Extract words from tags
              if (m.tags) {
                const tags = Array.isArray(m.tags) ? m.tags : (typeof m.tags === "string" ? (m.tags as string).split(",") : []);
                for (const t of tags) {
                  const tag = (t as string).trim().toLowerCase();
                  if (tag.length > 2 && !stopWords.has(tag)) {
                    wordCounts.set(tag, (wordCounts.get(tag) || 0) + 1);
                  }
                }
              }
            }
            // Sort by frequency descending, take top N
            return Array.from(wordCounts.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, maxTopics)
              .map(([word]) => word);
          }

          // Category display names
          const categoryLabels: Record<string, string> = {
            fact: "Facts",
            preference: "Preferences",
            knowledge: "Knowledge",
            history: "History",
            procedural: "Procedures",
            resource: "Resources",
          };

          const hintLines: string[] = ["You have relevant memories available:"];
          // Order: fact, knowledge, preference, procedural, history, resource
          const categoryOrder = ["fact", "knowledge", "preference", "procedural", "history", "resource"];
          for (const cat of categoryOrder) {
            const mems = groups.get(cat);
            if (!mems || mems.length === 0) continue;
            const label = categoryLabels[cat] || cat;
            const topics = extractTopics(mems);
            hintLines.push(`- ${label} (${mems.length}): ${topics.join(", ")}`);
          }
          // Include any categories not in the standard order
          for (const [cat, mems] of groups) {
            if (categoryOrder.includes(cat)) continue;
            const topics = extractTopics(mems);
            hintLines.push(`- ${cat} (${mems.length}): ${topics.join(", ")}`);
          }

          hintLines.push("");
          hintLines.push('Use memory_recall(key="...") to access any of these. Use memory_search(query="...") for broader searches.');

          return { content: [{ type: "text" as const, text: hintLines.join("\n") }] };
        }

        // resolve format: new `format` param takes priority, legacy `raw` maps to compact
        const fmt = args.format ?? (args.raw ? "compact" : "xml");

        // PreMemoryInject: blocking hooks can filter/reorder the memories array
        const preCtx = {
          memories: unique,
          format: fmt,
          agentId: args.agent_id,
          projectId: args.project_id,
          sessionId: args.session_id,
          timestamp: Date.now(),
        };
        const shouldProceed = await hookRegistry.runHooks("PreMemoryInject", preCtx);
        if (!shouldProceed) {
          return { content: [{ type: "text" as const, text: "Injection cancelled by hook." }] };
        }

        // Build context within token budget (~4 chars per token estimate)
        const charBudget = maxTokens * 4;
        const lines: string[] = [];
        let totalChars = 0;

        for (const m of preCtx.memories) {
          let line: string;
          if (fmt === "compact") {
            line = `${m.key}: ${m.value}`;
          } else if (fmt === "json") {
            line = JSON.stringify({ key: m.key, value: m.value, scope: m.scope, category: m.category, importance: m.importance });
          } else {
            line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
          }
          if (totalChars + line.length > charBudget) break;
          lines.push(line);
          totalChars += line.length;
          touchMemory(m.id);
        }

        if (lines.length === 0) {
          return { content: [{ type: "text" as const, text: "No relevant memories found for injection." }] };
        }

        let context: string;
        if (fmt === "compact") {
          context = lines.join("\n");
        } else if (fmt === "json") {
          context = `[${lines.join(",")}]`;
        } else if (fmt === "markdown") {
          context = `## Agent Memories\n\n${lines.join("\n")}`;
        } else {
          context = `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;
        }
        // PostMemoryInject: fire-and-forget
        void hookRegistry.runHooks("PostMemoryInject", {
          memoriesCount: lines.length,
          format: fmt,
          contextLength: context.length,
          agentId: args.agent_id,
          projectId: args.project_id,
          sessionId: args.session_id,
          timestamp: Date.now(),
        });

        // Task 6: Check for subscription notifications
        if (args.agent_id) {
          try {
            const db = getDatabase();
            const subs = db.query(
              "SELECT key_pattern, tag_pattern, scope FROM memory_subscriptions WHERE agent_id = ?"
            ).all(args.agent_id) as Array<{ key_pattern: string | null; tag_pattern: string | null; scope: string | null }>;

            if (subs.length > 0) {
              // Find recently changed memories matching subscriptions (last 10 minutes)
              const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
              const changes: string[] = [];
              for (const sub of subs) {
                let sql = "SELECT key, updated_at FROM memories WHERE updated_at > ? AND status = 'active'";
                const params: (string | null)[] = [cutoff];
                if (sub.key_pattern) {
                  const like = sub.key_pattern.replace(/\*/g, "%");
                  sql += " AND key LIKE ?";
                  params.push(like);
                }
                if (sub.scope) {
                  sql += " AND scope = ?";
                  params.push(sub.scope);
                }
                // Exclude agent's own writes
                sql += " AND COALESCE(agent_id, '') != ?";
                params.push(args.agent_id);
                sql += " LIMIT 5";
                const matches = db.query(sql).all(...params) as Array<{ key: string; updated_at: string }>;
                for (const m of matches) {
                  changes.push(`${m.key} (updated ${m.updated_at})`);
                }
              }
              if (changes.length > 0) {
                const changeSection = `\n\n## Changes\n${changes.map((c) => `- ${c}`).join("\n")}`;
                context += changeSection;
              }
            }
          } catch {
            // memory_subscriptions table may not exist — ignore
          }
        }

        return { content: [{ type: "text" as const, text: context }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
