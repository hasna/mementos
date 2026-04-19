import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createMemory,
  getMemory,
  getMemoryByKey,
  listMemories,
  updateMemory,
  touchMemory,
  semanticSearch,
  parseMemoryRow,
} from "../../db/memories.js";
import { touchAgent } from "../../db/agents.js";
import { resolveProjectId } from "../../lib/focus.js";
import { getDatabase } from "../../db/database.js";
import { getCurrentMachineId } from "../../db/machines.js";
import { searchMemories } from "../../lib/search.js";
import { parseDuration } from "../../lib/duration.js";
import { ensureAutoProject, formatError, resolveId, formatMemory } from "./memory-utils.js";
import type { MemoryFilter, CreateMemoryInput } from "../../types/index.js";

export function registerMemoryCrudTools(server: McpServer): void {
  server.tool(
    "memory_save",
    "Save/upsert a memory. scope: global=all agents, shared=project, private=single agent, working=transient session scratchpad (auto-expires in 1h, excluded from ALMA synthesis). conflict controls what happens when key already exists.",
    {
      key: z.string(),
      value: z.string(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      importance: z.coerce.number().min(1).max(10).optional(),
      tags: z.array(z.string()).optional(),
      summary: z.string().optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      session_id: z.string().optional(),
      ttl_ms: z.union([z.string(), z.number()]).optional(),
      source: z.enum(["user", "agent", "system", "auto", "imported"]).optional(),
      metadata: z.record(z.unknown()).optional(),
      conflict: z.enum(["merge", "overwrite", "error", "version-fork"]).optional()
        .describe("Conflict strategy: merge=upsert(default), overwrite=same as merge, error=fail if key exists, version-fork=always create new"),
      conflict_strategy: z.enum(["last_writer_wins", "reject"]).optional()
        .describe("Vector clock conflict strategy: last_writer_wins (default) proceeds even if diverged, reject returns error on divergence"),
      machine_id: z.string().optional().describe("Machine ID (from register_machine). Set this only for explicitly machine-local memories."),
      when_to_use: z.string().optional().describe("Activation context — describes WHEN this memory should be retrieved. Used for intent-based retrieval. Example: 'when deploying to production' or 'when debugging database issues'. If set, semantic search matches against this instead of the value."),
      sequence_group: z.string().optional().describe("Chain/sequence group ID — links memories into an ordered procedural sequence. Use memory_chain_get to retrieve the full chain."),
      sequence_order: z.coerce.number().optional().describe("Position within the sequence group (1-based). Memories in a chain are returned ordered by this field."),
      dedup_mode: z.enum(["key", "semantic", "llm"]).optional().default("key").describe("Dedup strategy: 'key' = current key-based (default), 'semantic' = skip if >0.92 embedding similarity to existing memory, 'llm' = ask LLM if content is already covered"),
    },
    async (args) => {
      try {
        ensureAutoProject();
        const { conflict, dedup_mode, ...restArgs } = args as typeof args & { conflict?: string; dedup_mode?: string };
        const input = { ...restArgs } as Record<string, unknown>;
        if ((restArgs as Record<string, unknown>).ttl_ms !== undefined) {
          input.ttl_ms = parseDuration((restArgs as Record<string, unknown>).ttl_ms as string | number);
        }
        // Focus mode: auto-set project_id from agent focus if not provided
        if (!input.project_id && input.agent_id) {
          const focusedProject = resolveProjectId(input.agent_id as string, null);
          if (focusedProject) input.project_id = focusedProject;
        }
        const dedupeMode = (conflict as import("../../types/index.js").DedupeMode | undefined) ?? "merge";
        const conflictStrategy = (args as Record<string, unknown>).conflict_strategy as string | undefined ?? "last_writer_wins";

        // Auto-tag with current machine ID if not explicitly set
        if (!input.machine_id) {
          try {
            input.machine_id = getCurrentMachineId();
          } catch {
            // Best-effort — machine not registered yet
          }
        }

        // Vector clock conflict detection
        // Before creating/updating, check if existing memory has a diverged vector clock
        if (conflictStrategy === "reject" && input.agent_id) {
          const db = getDatabase();
          try {
            const existing = db.query(
              `SELECT vector_clock FROM memories WHERE key = ? AND scope = ? AND COALESCE(agent_id, '') = ? AND COALESCE(project_id, '') = ? AND COALESCE(session_id, '') = ? AND status = 'active'`
            ).get(
              input.key as string,
              (input.scope as string) || "private",
              (input.agent_id as string) || "",
              (input.project_id as string) || "",
              (input.session_id as string) || ""
            ) as { vector_clock: string } | null;

            if (existing?.vector_clock) {
              const existingClock = JSON.parse(existing.vector_clock) as Record<string, number>;
              const agentEntry = existingClock[input.agent_id as string] || 0;
              // If another agent has written since our last write, the clock has diverged
              const otherWrites = Object.entries(existingClock).some(
                ([aid, count]) => aid !== input.agent_id && count > 0
              );
              if (otherWrites && agentEntry === 0) {
                return { content: [{ type: "text" as const, text: `Vector clock conflict: memory was modified by another agent. Use conflict_strategy='last_writer_wins' to override.` }], isError: true };
              }
            }
          } catch {
            // vector_clock column may not exist yet — skip check
          }
        }

        // ── Semantic dedup: check embedding similarity before saving ──────────
        if (dedup_mode === "semantic") {
          try {
            const textToEmbed = (input.when_to_use as string) || (input.value as string);
            const results = await semanticSearch(textToEmbed, {
              threshold: 0.3,
              limit: 5,
              scope: input.scope as string | undefined,
              agent_id: input.agent_id as string | undefined,
              project_id: input.project_id as string | undefined,
            });
            const SEMANTIC_THRESHOLD = 0.92;
            for (const result of results) {
              if (result.score >= SEMANTIC_THRESHOLD) {
                return { content: [{ type: "text" as const, text: `Skipped: content similar to existing memory ${result.memory.id.slice(0, 8)} (similarity: ${result.score.toFixed(2)})` }] };
              }
            }
          } catch {
            // Embedding infrastructure unavailable — fall through to normal save
          }
        }

        // ── LLM dedup: ask Haiku if content is already covered ─────────────────
        if (dedup_mode === "llm") {
          try {
            const textToEmbed = (input.when_to_use as string) || (input.value as string);
            const candidates = await semanticSearch(textToEmbed, {
              threshold: 0.3,
              limit: 5,
              scope: input.scope as string | undefined,
              agent_id: input.agent_id as string | undefined,
              project_id: input.project_id as string | undefined,
            });
            if (candidates.length > 0) {
              const anthropicKey = process.env["ANTHROPIC_API_KEY"];
              if (anthropicKey) {
                const existingList = candidates.map((c, i) =>
                  `[${i + 1}] key="${c.memory.key}" value="${c.memory.value}" (similarity: ${c.score.toFixed(2)})`
                ).join("\n");
                const llmPrompt = `New memory to save:\nkey="${input.key}"\nvalue="${input.value}"\n\nExisting similar memories:\n${existingList}\n\nIs the new memory already covered by these existing memories? Reply with JSON only:\n{"action": "skip" | "merge" | "add", "reason": "string", "merge_text": "string if action=merge — the merged content combining new and existing"}`;
                const llmRes = await fetch("https://api.anthropic.com/v1/messages", {
                  method: "POST",
                  headers: {
                    "x-api-key": anthropicKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 300,
                    system: "You are a deduplication assistant. Given a new memory and existing similar memories, decide: skip (already covered), merge (combine with existing), or add (genuinely new). Reply with JSON only.",
                    messages: [{ role: "user", content: llmPrompt }],
                  }),
                  signal: AbortSignal.timeout(15_000),
                });
                if (llmRes.ok) {
                  const llmData = await llmRes.json() as { content: { type: string; text: string }[] };
                  const llmText = llmData.content?.[0]?.text?.trim() ?? "";
                  // Extract JSON from response (handle markdown code fences)
                  const jsonMatch = llmText.match(/\{[\s\S]*\}/);
                  if (jsonMatch) {
                    const decision = JSON.parse(jsonMatch[0]) as { action: string; reason: string; merge_text?: string };
                    if (decision.action === "skip") {
                      return { content: [{ type: "text" as const, text: `Skipped (LLM dedup): ${decision.reason}` }] };
                    }
                    if (decision.action === "merge" && decision.merge_text && candidates[0]) {
                      const target = candidates[0].memory;
                      try {
                        updateMemory(target.id, { value: decision.merge_text, version: target.version });
                        return { content: [{ type: "text" as const, text: JSON.stringify({
                          merged_into: target.id.slice(0, 8),
                          key: target.key,
                          reason: decision.reason,
                        }) }] };
                      } catch {
                        // Merge failed (version conflict etc.) — fall through to normal save
                      }
                    }
                    // action === "add" — fall through to normal save
                  }
                }
              }
            }
          } catch {
            // LLM dedup failed — fall through to normal save
          }
        }

        const memory = createMemory(input as unknown as CreateMemoryInput, dedupeMode);

        // Update vector_clock with agent_id entry incremented
        if (input.agent_id) {
          try {
            const db = getDatabase();
            const row = db.query("SELECT vector_clock FROM memories WHERE id = ?").get(memory.id) as { vector_clock: string } | null;
            const clock = JSON.parse(row?.vector_clock || "{}") as Record<string, number>;
            clock[input.agent_id as string] = (clock[input.agent_id as string] || 0) + 1;
            db.run("UPDATE memories SET vector_clock = ? WHERE id = ?", [JSON.stringify(clock), memory.id]);
          } catch {
            // vector_clock column may not exist in older DBs — ignore
          }
        }

        if (args.agent_id) touchAgent(args.agent_id);

        // Auto-broadcast shared memories to active agents via conversations MCP
        if (memory.scope === 'shared' && memory.project_id && args.agent_id) {
          try {
            const { broadcastSharedMemory } = await import('../memory-broadcast.js');
            broadcastSharedMemory(memory, args.agent_id as string).catch(() => {/* non-blocking */});
          } catch { /* conversations MCP not available */ }
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          saved: memory.key,
          id: memory.id.slice(0, 8),
          version: memory.version,
          conflict_mode: dedupeMode,
        }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_recall",
    "Recall a memory by key. Returns the best matching active memory. Use as_of for temporal queries (what was true at a specific date).",
    {
      key: z.string(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      session_id: z.string().optional(),
      as_of: z.string().optional().describe("ISO8601 date — recall what was known at this point in time (bi-temporal query)"),
    },
    async (args) => {
      try {
        ensureAutoProject();
        // Focus mode: auto-scope if agent is focused and no explicit scope/project_id
        let effectiveProjectId = args.project_id;
        if (!args.scope && !args.project_id && args.agent_id) {
          effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
        }
        const memory = getMemoryByKey(args.key, args.scope, args.agent_id, effectiveProjectId, args.session_id, undefined, args.as_of);
        if (memory) {
          touchMemory(memory.id);
          if (args.agent_id) touchAgent(args.agent_id);
          let text = formatMemory(memory);

          // If memory belongs to a chain, include chain context
          if (memory.sequence_group) {
            try {
              const db = getDatabase();
              const chainRows = db.prepare(
                "SELECT * FROM memories WHERE sequence_group = ? AND status = 'active' ORDER BY sequence_order ASC"
              ).all(memory.sequence_group) as Record<string, unknown>[];
              if (chainRows.length > 1) {
                const steps = chainRows.map(parseMemoryRow);
                const chainLine = steps.map(s => `[${s.sequence_order ?? "?"}] ${s.key}`).join(" → ");
                text += `\n\nChain context: ${chainLine}`;
              }
            } catch {
              // chain lookup non-critical
            }
          }

          return { content: [{ type: "text" as const, text }] };
        }

        // Fuzzy fallback: search for the key and return the top result
        const results = searchMemories(args.key, {
          scope: args.scope,
          agent_id: args.agent_id,
          project_id: effectiveProjectId,
          session_id: args.session_id,
          limit: 1,
        });
        if (results.length > 0) {
          const best = results[0]!;
          touchMemory(best.memory.id);
          return {
            content: [{
              type: "text" as const,
              text: `No exact match for key "${args.key}", showing best result (score: ${best.score.toFixed(2)}, match: ${best.match_type}):\n${formatMemory(best.memory)}`,
            }],
          };
        }

        // Proactive save suggestion when nothing found
        const suggestedKey = args.key.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        const suggestedCategory = suggestedKey.includes("prefer") ? "preference"
          : suggestedKey.includes("how") || suggestedKey.includes("process") || suggestedKey.includes("step") ? "procedural"
          : suggestedKey.includes("stack") || suggestedKey.includes("arch") ? "fact"
          : "knowledge";
        return { content: [{ type: "text" as const, text: `No memory found for key: "${args.key}".\n\n💡 Save suggestion: memory_save(key="${suggestedKey}", value="...", category="${suggestedCategory}", scope="shared")` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_get",
    "Get a single memory by ID.",
    {
      id: z.string(),
    },
    async (args) => {
      try {
        const id = resolveId(args.id);
        const memory = getMemory(id);
        if (!memory) {
          return { content: [{ type: "text" as const, text: `Memory not found: ${args.id}` }] };
        }
        touchMemory(memory.id);
        return { content: [{ type: "text" as const, text: formatMemory(memory) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_list",
    "List memories. Default: compact lines. full=true for complete JSON objects.",
    {
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      tags: z.array(z.string()).optional(),
      min_importance: z.coerce.number().optional(),
      pinned: z.boolean().optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      session_id: z.string().optional(),
      status: z.enum(["active", "archived", "expired"]).optional(),
      as_of: z.string().optional().describe("ISO8601 date — list memories valid at this point in time (bi-temporal query)"),
      limit: z.coerce.number().optional(),
      offset: z.coerce.number().optional(),
      full: z.boolean().optional(),
      fields: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        const { full, fields, ...filterArgs } = args;
        // Focus mode: if agent is focused and no explicit scope/project_id, auto-scope
        let resolvedFilter = { ...filterArgs };
        if (!resolvedFilter.scope && !resolvedFilter.project_id && resolvedFilter.agent_id) {
          const focusedProject = resolveProjectId(resolvedFilter.agent_id, null);
          if (focusedProject) resolvedFilter.project_id = focusedProject;
        }
        const filter: MemoryFilter = {
          ...resolvedFilter,
          limit: resolvedFilter.limit || 10,
        };
        const memories = listMemories(filter);
        if (memories.length === 0) {
          return { content: [{ type: "text" as const, text: "No memories found." }] };
        }
        if (full) {
          // Full mode: complete JSON objects (strip nulls, optionally filter fields)
          const compact = memories.map(m => {
            const obj = Object.fromEntries(
              Object.entries(m).filter(([k, v]) => {
                if (v === null || v === undefined) return false;
                if (fields && fields.length > 0) return fields.includes(k);
                return true;
              })
            );
            return obj;
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(compact, null, 2) }] };
        }
        // Compact mode (default): key+value+scope+importance+id only
        const lines = memories.map((m, i) =>
          `${i + 1}. [${m.scope}/${m.category}] ${m.key} = ${m.value.slice(0, 100)}${m.value.length > 100 ? "..." : ""} (imp:${m.importance} id:${m.id.slice(0, 8)})`
        );
        return { content: [{ type: "text" as const, text: `${memories.length} memories:\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_update",
    "Update a memory's metadata (value, importance, tags, etc.). version is optional — auto-fetched if omitted.",
    {
      id: z.string(),
      value: z.string().optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      importance: z.coerce.number().min(1).max(10).optional(),
      tags: z.array(z.string()).optional(),
      summary: z.string().nullable().optional(),
      pinned: z.boolean().optional(),
      status: z.enum(["active", "archived", "expired"]).optional(),
      metadata: z.record(z.unknown()).optional(),
      expires_at: z.string().nullable().optional(),
      version: z.coerce.number().optional(),
      when_to_use: z.string().optional().describe("Update the activation context for this memory"),
    },
    async (args) => {
      try {
        const id = resolveId(args.id);
        const { id: _id, version, ...updateFields } = args;
        // Auto-fetch version if not provided (eliminates the need for a prior read)
        const resolvedVersion = version ?? getMemory(id)?.version;
        if (resolvedVersion === undefined) {
          return { content: [{ type: "text" as const, text: `Memory not found: ${id}` }] };
        }
        const memory = updateMemory(id, { ...updateFields, version: resolvedVersion });
        return { content: [{ type: "text" as const, text: `Memory updated:\n${formatMemory(memory)}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
