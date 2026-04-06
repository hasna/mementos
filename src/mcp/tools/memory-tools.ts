import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createMemory,
  getMemory,
  getMemoryByKey,
  listMemories,
  updateMemory,
  touchMemory,
  getMemoryVersions,
  semanticSearch,
  parseMemoryRow,
} from "../../db/memories.js";
import { touchAgent } from "../../db/agents.js";
import { resolveProjectId } from "../../lib/focus.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { searchMemories } from "../../lib/search.js";
import { hookRegistry } from "../../lib/hooks.js";
import { getCurrentMachineId } from "../../db/machines.js";
import { parseDuration } from "../../lib/duration.js";
import { ensureAutoProject, formatError, resolveId, formatMemory, formatAsmrResult } from "./memory-utils.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryStats,
  MemoryFilter,
  CreateMemoryInput,
} from "../../types/index.js";

export { ensureAutoProject, formatError, resolveId, formatMemory, formatAsmrResult };

export function registerMemoryTools(server: McpServer): void {
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
      machine_id: z.string().optional().describe("Machine ID (from register_machine). If omitted, auto-detected from current hostname."),
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
        // Auto-detect machine_id if not provided
        if (!input.machine_id) {
          try { input.machine_id = getCurrentMachineId(); } catch { /* ignore — machine registry optional */ }
        }
        const dedupeMode = (conflict as import("../../types/index.js").DedupeMode | undefined) ?? "merge";
        const conflictStrategy = (args as Record<string, unknown>).conflict_strategy as string | undefined ?? "last_writer_wins";

        // Vector clock conflict detection (Task 2)
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
    "memory_versions",
    "Get version history for a memory. Shows what changed across updates.",
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
        const versions = getMemoryVersions(id);
        if (versions.length === 0) {
          return { content: [{ type: "text" as const, text: `No version history for "${memory.key}" (current: v${memory.version})` }] };
        }
        const lines = versions.map(v =>
          `v${v.version} [${v.created_at.slice(0, 16)}] scope=${v.scope} importance=${v.importance} status=${v.status}\n  value: ${v.value.slice(0, 120)}${v.value.length > 120 ? "..." : ""}`
        );
        return {
          content: [{
            type: "text" as const,
            text: `Version history for "${memory.key}" (${versions.length} version${versions.length === 1 ? "" : "s"}, current: v${memory.version}):\n\n${lines.join("\n\n")}`,
          }],
        };
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
  server.tool(
    "memory_health",
    "Comprehensive health check for memories. Detects: stale (old + 0 access), high-importance-forgotten (importance>=7 + not accessed in 60d), and possibly-superseded (newer memory with similar key). Returns actionable summary.",
    {
      stale_days: z.coerce.number().optional().describe("Days with no access to consider a memory stale (default: 30)"),
      forgotten_days: z.coerce.number().optional().describe("Days since access for high-importance memories (default: 60)"),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      limit: z.coerce.number().optional().describe("Max per category (default: 10)"),
    },
    async (args) => {
      try {
        const db = getDatabase();
        const staleDays = args.stale_days ?? 30;
        const forgottenDays = args.forgotten_days ?? 60;
        const limit = args.limit ?? 10;
        const extraWhere = [
          ...(args.project_id ? ["project_id = ?"] : []),
          ...(args.agent_id ? ["agent_id = ?"] : []),
        ].join(" AND ");
        const staleCutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
        const forgottenCutoff = new Date(Date.now() - forgottenDays * 86400000).toISOString();
        const extraParams: (string | number)[] = [
          staleCutoff,
          ...(args.project_id ? [args.project_id] : []),
          ...(args.agent_id ? [args.agent_id] : []),
        ];
        const base = `status = 'active' AND pinned = 0${extraWhere ? " AND " + extraWhere : ""}`;

        // 1. Stale: never accessed or not accessed in staleDays, access_count == 0
        const stale = db.prepare(
          `SELECT id, key, value, importance, scope, created_at FROM memories
           WHERE ${base} AND access_count = 0 AND created_at < ?
           ORDER BY created_at ASC LIMIT ?`
        ).all(...extraParams, limit) as Array<{id: string; key: string; value: string; importance: number; scope: string; created_at: string}>;

        const forgottenParams: (string | number)[] = [
          forgottenCutoff,
          ...(args.project_id ? [args.project_id] : []),
          ...(args.agent_id ? [args.agent_id] : []),
        ];
        // 2. High-importance forgotten: importance >= 7, not accessed in forgottenDays
        const forgotten = db.prepare(
          `SELECT id, key, value, importance, scope, accessed_at FROM memories
           WHERE ${base} AND importance >= 7
             AND (accessed_at IS NULL OR accessed_at < ?)
           ORDER BY importance DESC, COALESCE(accessed_at, created_at) ASC LIMIT ?`
        ).all(...forgottenParams, limit) as Array<{id: string; key: string; value: string; importance: number; scope: string; accessed_at: string|null}>;

        // 3. Possibly superseded: multiple active memories with same key prefix (similar key)
        const dupes = db.prepare(
          `SELECT key, COUNT(*) as cnt, MAX(updated_at) as latest, MIN(created_at) as oldest
           FROM memories WHERE ${base}
           GROUP BY key HAVING cnt > 1
           ORDER BY cnt DESC LIMIT ?`
        ).all(...extraParams, limit) as Array<{key: string; cnt: number; latest: string; oldest: string}>;

        const parts: string[] = ["Memory Health Report\n"];

        if (stale.length > 0) {
          parts.push(`⚠️  STALE (${stale.length}) — created ${staleDays}d+ ago, never accessed:`);
          for (const m of stale) {
            parts.push(`  • [${m.importance}] ${m.key} (${m.scope}) — created ${m.created_at.slice(0, 10)}`);
          }
          parts.push("");
        }

        if (forgotten.length > 0) {
          parts.push(`🔔  HIGH-IMPORTANCE FORGOTTEN (${forgotten.length}) — importance≥7, not accessed in ${forgottenDays}d+:`);
          for (const m of forgotten) {
            parts.push(`  • [${m.importance}] ${m.key} (${m.scope}) — last: ${m.accessed_at?.slice(0, 10) || "never"}`);
          }
          parts.push("");
        }

        if (dupes.length > 0) {
          parts.push(`🔄  POSSIBLY SUPERSEDED (${dupes.length}) — same key with multiple versions:`);
          for (const d of dupes) {
            parts.push(`  • ${d.key} × ${d.cnt} copies — newest: ${d.latest.slice(0, 10)}`);
          }
          parts.push("");
        }

        if (stale.length === 0 && forgotten.length === 0 && dupes.length === 0) {
          parts.push("✓ No health issues found. All memories look fresh.");
        } else {
          parts.push(`Summary: ${stale.length} stale, ${forgotten.length} forgotten, ${dupes.length} possibly-superseded.`);
          parts.push("Suggested actions: archive stale memories, review forgotten ones, merge duplicates.");
        }

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_diff",
    "Show what changed between two versions of a memory. Compares value, importance, scope. Omit v1/v2 to diff the two most recent versions.",
    {
      id: z.string().optional().describe("Memory ID or partial ID"),
      key: z.string().optional().describe("Memory key (alternative to id)"),
      v1: z.coerce.number().optional().describe("First version number (default: second-to-last)"),
      v2: z.coerce.number().optional().describe("Second version number (default: current/latest)"),
    },
    async (args) => {
      try {
        let memId: string | undefined;
        if (args.id) {
          memId = resolvePartialId(getDatabase(), "memories", args.id) ?? args.id;
        } else if (args.key) {
          const row = getDatabase().query("SELECT id FROM memories WHERE key = ? LIMIT 1").get(args.key) as { id: string } | null;
          memId = row?.id;
        }
        if (!memId) return { content: [{ type: "text" as const, text: `Memory not found: ${args.id || args.key}` }], isError: true };

        const memory = getMemory(memId);
        if (!memory) return { content: [{ type: "text" as const, text: `Memory not found: ${memId}` }], isError: true };

        const versions = getMemoryVersions(memId);
        // Add current version as a pseudo-version
        const allVersions = [
          ...versions,
          { version: memory.version, value: memory.value, importance: memory.importance, scope: memory.scope, created_at: memory.updated_at, summary: memory.summary },
        ].sort((a, b) => a.version - b.version);

        if (allVersions.length < 2) {
          return { content: [{ type: "text" as const, text: `Only 1 version exists for "${memory.key}". No diff available.` }] };
        }

        const v1Num = args.v1 ?? allVersions[allVersions.length - 2]?.version ?? 1;
        const v2Num = args.v2 ?? allVersions[allVersions.length - 1]?.version ?? memory.version;

        const ver1 = allVersions.find(v => v.version === v1Num);
        const ver2 = allVersions.find(v => v.version === v2Num);

        if (!ver1 || !ver2) {
          return { content: [{ type: "text" as const, text: `Versions not found: v${v1Num}, v${v2Num}. Available: ${allVersions.map(v => `v${v.version}`).join(", ")}` }], isError: true };
        }

        const parts = [`Diff for "${memory.key}" (v${v1Num} → v${v2Num})`];
        parts.push(`Time: ${ver1.created_at?.slice(0, 16)} → ${ver2.created_at?.slice(0, 16)}`);

        if (ver1.value !== ver2.value) {
          parts.push(`\n--- v${v1Num} value ---`);
          parts.push(ver1.value.slice(0, 500) + (ver1.value.length > 500 ? "..." : ""));
          parts.push(`\n+++ v${v2Num} value +++`);
          parts.push(ver2.value.slice(0, 500) + (ver2.value.length > 500 ? "..." : ""));
        } else {
          parts.push("value: unchanged");
        }
        if (ver1.importance !== ver2.importance) parts.push(`importance: ${ver1.importance} → ${ver2.importance}`);
        if (ver1.scope !== ver2.scope) parts.push(`scope: ${ver1.scope} → ${ver2.scope}`);

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_chain_get",
    "Retrieve an ordered memory chain/sequence by group ID. Returns all steps in order.",
    {
      sequence_group: z.string().describe("The chain/sequence group ID to retrieve"),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        ensureAutoProject();
        const db = getDatabase();
        const effectiveProjectId = args.project_id;

        const conditions = ["sequence_group = ?", "status = 'active'"];
        const params: (string | number)[] = [args.sequence_group];

        if (effectiveProjectId) {
          conditions.push("project_id = ?");
          params.push(effectiveProjectId);
        }

        const rows = db.prepare(
          `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY sequence_order ASC`
        ).all(...params) as Record<string, unknown>[];

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `No chain found for sequence_group: "${args.sequence_group}"` }] };
        }

        const memories = rows.map(parseMemoryRow);
        const chainSteps = memories.map((m, i) =>
          `[Step ${m.sequence_order ?? i + 1}] ${m.key}: ${m.value}`
        ).join("\n");

        const header = `Chain "${args.sequence_group}" (${memories.length} steps):\n`;
        return { content: [{ type: "text" as const, text: header + chainSteps }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
  server.tool(
    "memory_check_contradiction",
    "Check if a new memory would contradict existing high-importance facts. Call before saving to detect conflicts. Returns contradiction details if found.",
    {
      key: z.string().describe("Memory key to check"),
      value: z.string().describe("New value to check for contradictions"),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      project_id: z.string().optional(),
      min_importance: z.coerce.number().optional().describe("Only check against memories with importance >= this (default: 7)"),
    },
    async (args) => {
      try {
        const { detectContradiction } = await import("../../lib/contradiction.js");
        const result = await detectContradiction(args.key, args.value, {
          scope: args.scope,
          project_id: args.project_id,
          min_importance: args.min_importance,
        });
        if (result.contradicts) {
          const mem = result.conflicting_memory;
          return { content: [{ type: "text" as const, text: `⚠ CONTRADICTION DETECTED (confidence: ${(result.confidence * 100).toFixed(0)}%)\n${result.reasoning}\n\nExisting memory: [${mem?.scope}/${mem?.category}] ${mem?.key} = ${mem?.value?.slice(0, 200)}\nImportance: ${mem?.importance}\nID: ${mem?.id?.slice(0, 8)}` }] };
        }
        return { content: [{ type: "text" as const, text: `No contradiction detected for key "${args.key}". ${result.reasoning}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_invalidate",
    "Invalidate an existing fact by setting valid_until to now. Use when a contradiction is confirmed and the old fact should be superseded. Optionally link to the new superseding memory.",
    {
      old_memory_id: z.string().describe("ID of the memory to invalidate"),
      new_memory_id: z.string().optional().describe("ID of the new memory that supersedes the old one"),
    },
    async (args) => {
      try {
        const { invalidateFact } = await import("../../lib/contradiction.js");
        const oldId = resolveId(args.old_memory_id);
        const existing = getMemory(oldId);
        if (!existing) {
          return { content: [{ type: "text" as const, text: `Memory not found: ${args.old_memory_id}` }] };
        }
        const result = invalidateFact(oldId, args.new_memory_id);
        return { content: [{ type: "text" as const, text: `Invalidated "${existing.key}" (valid_until: ${result.valid_until})${result.new_memory_id ? ` — superseded by ${result.new_memory_id.slice(0, 8)}` : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_audit_trail",
    "Get the immutable audit trail for a specific memory. Shows all create/update/delete operations with timestamps and agent IDs.",
    {
      memory_id: z.string().describe("Memory ID to get audit trail for"),
      limit: z.coerce.number().optional().describe("Max entries (default: 50)"),
    },
    async (args) => {
      try {
        const { getMemoryAuditTrail } = await import("../../db/audit.js");
        const id = resolveId(args.memory_id);
        const entries = getMemoryAuditTrail(id, args.limit);
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: `No audit entries for memory ${args.memory_id}` }] };
        }
        const lines = entries.map((e) =>
          `[${e.created_at}] ${e.operation} by ${e.agent_id || "system"} — ${JSON.stringify(e.changes)}`
        );
        return { content: [{ type: "text" as const, text: `Audit trail (${entries.length} entries):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_audit_export",
    "Export the full immutable audit log for compliance reporting. Supports date range and operation type filtering.",
    {
      since: z.string().optional().describe("Start date (ISO8601)"),
      until: z.string().optional().describe("End date (ISO8601)"),
      operation: z.enum(["create", "update", "delete", "archive", "restore"]).optional(),
      agent_id: z.string().optional(),
      limit: z.coerce.number().optional().describe("Max entries (default: 1000)"),
    },
    async (args) => {
      try {
        const { exportAuditLog } = await import("../../db/audit.js");
        const entries = exportAuditLog(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_sync_push",
    "Push local memories to a remote mementos-serve instance. Set MEMENTOS_REMOTE_URL or pass url.",
    {
      url: z.string().optional().describe("Remote URL (e.g. http://apple01:19428). Defaults to MEMENTOS_REMOTE_URL env var."),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      limit: z.coerce.number().optional(),
    },
    async (args) => {
      try {
        const { pushToRemote } = await import("../../lib/remote-sync.js");
        const result = await pushToRemote({ remoteUrl: args.url, scope: args.scope, agentId: args.agent_id, projectId: args.project_id, limit: args.limit });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_sync_pull",
    "Pull memories from a remote mementos-serve instance into local DB. Set MEMENTOS_REMOTE_URL or pass url.",
    {
      url: z.string().optional().describe("Remote URL. Defaults to MEMENTOS_REMOTE_URL env var."),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      limit: z.coerce.number().optional(),
      overwrite: z.coerce.boolean().optional().describe("Overwrite existing memories with same key (default: false = keep newer)"),
    },
    async (args) => {
      try {
        const { pullFromRemote } = await import("../../lib/remote-sync.js");
        const result = await pullFromRemote({ remoteUrl: args.url, scope: args.scope, agentId: args.agent_id, projectId: args.project_id, limit: args.limit, overwrite: args.overwrite });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_sync_status",
    "Check if a remote mementos-serve is reachable. Set MEMENTOS_REMOTE_URL or pass url.",
    {
      url: z.string().optional().describe("Remote URL. Defaults to MEMENTOS_REMOTE_URL env var."),
    },
    async (args) => {
      try {
        const { pingRemote } = await import("../../lib/remote-sync.js");
        const result = await pingRemote(args.url);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_stats",
    "Get aggregate statistics about stored memories",
    {},
    async () => {
      try {
        const db = getDatabase();
        const total = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get() as { c: number }).c;
        const byScope = db.query("SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope").all() as { scope: MemoryScope; c: number }[];
        const byCategory = db.query("SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category").all() as { category: MemoryCategory; c: number }[];
        const byStatus = db.query("SELECT status, COUNT(*) as c FROM memories GROUP BY status").all() as { status: string; c: number }[];
        const pinnedCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'").get() as { c: number }).c;
        const expiredCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < datetime('now'))").get() as { c: number }).c;

        const stats: MemoryStats = {
          total,
          by_scope: { global: 0, shared: 0, private: 0, working: 0 },
          by_category: { preference: 0, fact: 0, knowledge: 0, history: 0, procedural: 0, resource: 0 },
          by_status: { active: 0, archived: 0, expired: 0 },
          by_agent: {},
          pinned_count: pinnedCount,
          expired_count: expiredCount,
        };
        for (const row of byScope) stats.by_scope[row.scope] = row.c;
        for (const row of byCategory) stats.by_category[row.category] = row.c;
        for (const row of byStatus) {
          if (row.status in stats.by_status) {
            stats.by_status[row.status as keyof typeof stats.by_status] = row.c;
          }
        }

        const byAgent = db.query("SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL GROUP BY agent_id").all() as { agent_id: string; c: number }[];
        for (const row of byAgent) stats.by_agent[row.agent_id] = row.c;

        const lines = [
          `Total active: ${stats.total}`,
          `By scope: global=${stats.by_scope.global}, shared=${stats.by_scope.shared}, private=${stats.by_scope.private}, working=${stats.by_scope.working}`,
          `By category: preference=${stats.by_category.preference}, fact=${stats.by_category.fact}, knowledge=${stats.by_category.knowledge}, history=${stats.by_category.history}`,
          `Pinned: ${stats.pinned_count}`,
          `Expired: ${stats.expired_count}`,
        ];
        if (Object.keys(stats.by_agent).length > 0) {
          lines.push(`By agent: ${Object.entries(stats.by_agent).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_activity",
    "Get daily memory creation activity over N days.",
    {
      days: z.coerce.number().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const days = Math.min(args.days || 30, 365);
        const db = getDatabase();
        const conditions: string[] = ["status = 'active'"];
        const params: string[] = [];
        if (args.scope) { conditions.push("scope = ?"); params.push(args.scope); }
        if (args.agent_id) { conditions.push("agent_id = ?"); params.push(args.agent_id); }
        if (args.project_id) { conditions.push("project_id = ?"); params.push(args.project_id); }
        const where = conditions.slice(1).map(c => `AND ${c}`).join(" ");

        const rows = db.query(`
          SELECT date(created_at) AS date, COUNT(*) AS memories_created
          FROM memories
          WHERE status = 'active' AND date(created_at) >= date('now', '-${days} days') ${where}
          GROUP BY date(created_at)
          ORDER BY date ASC
        `).all(...params) as { date: string; memories_created: number }[];

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `No memory activity in last ${days} days.` }] };
        }
        const total = rows.reduce((s, r) => s + r.memories_created, 0);
        const lines = rows.map(r => `${r.date}: ${r.memories_created} memor${r.memories_created === 1 ? "y" : "ies"}`);
        return { content: [{ type: "text" as const, text: `Memory activity (last ${days} days — ${total} total):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_report",
    "Get a rich summary report: totals, activity trend, top memories, scope/category breakdown.",
    {
      days: z.coerce.number().optional(),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
    },
    async (args) => {
      try {
        const days = Math.min(args.days || 7, 365);
        const db = getDatabase();
        const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const cond = [args.project_id ? "AND project_id = ?" : "", args.agent_id ? "AND agent_id = ?" : ""].filter(Boolean).join(" ");
        const params: (string | number)[] = [cutoffDate, ...(args.project_id ? [args.project_id] : []), ...(args.agent_id ? [args.agent_id] : [])];

        const total = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' ${cond}`).get(...params.slice(1)) as { c: number }).c;
        const pinned = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1 ${cond}`).get(...params.slice(1)) as { c: number }).c;

        const actRows = db.query(`SELECT date(created_at) AS d, COUNT(*) AS cnt FROM memories WHERE status = 'active' AND date(created_at) >= ? ${cond} GROUP BY d ORDER BY d`).all(...params) as { d: string; cnt: number }[];
        const recentTotal = actRows.reduce((s, r) => s + r.cnt, 0);
        const sparkline = actRows.length > 0 ? actRows.map(r => { const bars = "▁▂▃▄▅▆▇█"; const max = Math.max(...actRows.map(x => x.cnt), 1); return bars[Math.round((r.cnt / max) * 7)] || "▁"; }).join("") : "—";

        const byScopeRows = db.query(`SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' ${cond} GROUP BY scope`).all(...params) as { scope: string; c: number }[];
        const byCatRows = db.query(`SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' ${cond} GROUP BY category`).all(...params) as { category: string; c: number }[];
        const topMems = db.query(`SELECT key, value, importance FROM memories WHERE status = 'active' ${cond} ORDER BY importance DESC, access_count DESC LIMIT 5`).all(...params) as { key: string; value: string; importance: number }[];

        const lines = [
          `Memory Report (last ${days} days)`,
          `Total: ${total} (${pinned} pinned) | Recent: +${recentTotal} | Activity: ${sparkline}`,
          `Scopes: ${byScopeRows.map(r => `${r.scope}=${r.c}`).join(" ")}`,
          `Categories: ${byCatRows.map(r => `${r.category}=${r.c}`).join(" ")}`,
          topMems.length > 0 ? `\nTop memories:\n${topMems.map(m => `  [${m.importance}] ${m.key}: ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`).join("\n")}` : "",
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_export",
    "Export memories. format='json' (default) returns JSON array. format='v1' returns mementos-export-v1 JSONL with entity links.",
    {
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      format: z.enum(["json", "v1"]).optional().describe("Export format: json (default) or v1 (JSONL with entity links)"),
    },
    async (args) => {
      try {
        if (args.format === "v1") {
          const { exportV1, toJsonl } = await import("../../lib/export-v1.js");
          const entries = exportV1({ ...args });
          return { content: [{ type: "text" as const, text: toJsonl(entries) }] };
        }
        const memories = listMemories({ ...args, limit: 10000 });
        return { content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_import",
    "Import memories from JSON array",
    {
      memories: z.array(z.object({
        key: z.string(),
        value: z.string(),
        scope: z.enum(["global", "shared", "private", "working"]).optional(),
        category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
        importance: z.coerce.number().optional(),
        tags: z.array(z.string()).optional(),
        summary: z.string().optional(),
        source: z.enum(["user", "agent", "system", "auto", "imported"]).optional(),
        agent_id: z.string().optional(),
        project_id: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      })),
      overwrite: z.boolean().optional(),
    },
    async (args) => {
      try {
        let imported = 0;
        const dedupeMode = args.overwrite === false ? "create" as const : "merge" as const;
        for (const mem of args.memories) {
          createMemory({ ...mem, source: mem.source || "imported" } as CreateMemoryInput, dedupeMode);
          imported++;
        }
        return { content: [{ type: "text" as const, text: `Imported ${imported} memor${imported === 1 ? "y" : "ies"}.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

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
          const { getDatabase: getDb } = await import("../../db/database.js");
          const d = getDb();
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
